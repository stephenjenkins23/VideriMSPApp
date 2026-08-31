import type { VideriHttp } from "../http.js";
import { mapSettled } from "../../pipeline/batching.js";

/**
 * Aggregator count-rollups as a fleet-health signal (US-4.6).
 *
 * The platform has no fleet-aggregate route, but the `aggregator` service does
 * expose per-group canvas COUNT rollups — offline-≥30d/≥6mo, no-events,
 * single-content, total — that we otherwise never surface (docs/14 §G). The
 * counts are direct-membership (not roll-up-inclusive), so summing the per-group
 * calls yields a true fleet total rather than double-counting nested groups.
 *
 * IO (list groups, fan out per-group metrics) is orchestrated here; the summation
 * is a pure function so it can be reasoned about and tested without a network.
 */

/** A group as returned by `rpm /v1/groups`. Only these three fields are used. */
export interface RawGroup {
  uuid: string;
  displayName?: string | null;
  active?: boolean | null;
}

interface GroupListResponse {
  groups?: RawGroup[];
  meta?: { total?: number };
}

/**
 * Per-group metrics from `aggregator /api/v1/groups/{uuid}/metrics`.
 *
 * The seven counts nest under `current`; `lastMonth` is null on every group on
 * this tenant (no month-over-month), so it is ignored. `current` itself can be
 * null, hence every count is optional and null-guarded downstream.
 */
export interface GroupMetrics {
  groupUuid?: string;
  current?: {
    thirtyDaysMoreOfflineCanvasesCount?: number | null;
    sixMonthsMoreOfflineCanvasesCount?: number | null;
    scheduleExpiringInSevenDaysCount?: number | null;
    canvasesWithNoEventsCount?: number | null;
    totalCanvasesCount?: number | null;
    totalAccountsCount?: number | null;
    canvasesWithSingleContentCount?: number | null;
  } | null;
  lastMonth?: null;
}

/** One group's contribution to the rollup, plus its identity for drill-down. */
export interface GroupRollup {
  uuid: string;
  name: string | null;
  active: boolean | null;
  totalCanvases: number;
  offline30d: number;
  offline6mo: number;
  noEvents: number;
  singleContent: number;
}

/** The five live counts, summed across every group we could read. */
export interface FleetRollup {
  totalCanvases: number;
  offline30d: number;
  offline6mo: number;
  noEvents: number;
  singleContent: number;
}

export interface RollupResult {
  fleet: FleetRollup;
  /** Per-group drill-down, sorted worst-offline-first. */
  groups: GroupRollup[];
  meta: { groupsRead: number; groupsFailed: number };
}

/**
 * Coerce a count to a number, treating anything non-finite (null, undefined, a
 * stray string) as 0. This is the one place a zero is honest: a group with no
 * offline canvases genuinely contributes zero to the sum. A group whose metrics
 * could not be *read* is a different thing — it is counted in `groupsFailed`,
 * never folded in as zero.
 */
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Pure: turn one group's raw metrics into its rollup contribution.
 *
 * `current` may be null; every nested count may be absent. All of that collapses
 * to 0 rather than propagating NaN into the fleet sum.
 */
export function groupRollupFromMetrics(group: RawGroup, raw: GroupMetrics | null | undefined): GroupRollup {
  const c = raw?.current ?? null;
  return {
    uuid: group.uuid,
    name: group.displayName ?? null,
    active: group.active ?? null,
    totalCanvases: count(c?.totalCanvasesCount),
    offline30d: count(c?.thirtyDaysMoreOfflineCanvasesCount),
    offline6mo: count(c?.sixMonthsMoreOfflineCanvasesCount),
    noEvents: count(c?.canvasesWithNoEventsCount),
    singleContent: count(c?.canvasesWithSingleContentCount),
  };
}

/**
 * Pure: sum the per-group rollups into a fleet total and order the drill-down
 * worst-offline-first (most 30-day-offline canvases at the top, then 6-month,
 * then name for a stable tiebreak). `groupsFailed` is passed through so a partial
 * fan-out reports honestly — the caller can tell a total of 200 built from 94/94
 * groups apart from the same total built from 60/94.
 */
export function summariseRollups(groups: GroupRollup[], groupsFailed: number): RollupResult {
  const fleet: FleetRollup = {
    totalCanvases: 0,
    offline30d: 0,
    offline6mo: 0,
    noEvents: 0,
    singleContent: 0,
  };
  for (const g of groups) {
    fleet.totalCanvases += g.totalCanvases;
    fleet.offline30d += g.offline30d;
    fleet.offline6mo += g.offline6mo;
    fleet.noEvents += g.noEvents;
    fleet.singleContent += g.singleContent;
  }
  const sorted = [...groups].sort(
    (a, b) =>
      b.offline30d - a.offline30d ||
      b.offline6mo - a.offline6mo ||
      (a.name ?? a.uuid).localeCompare(b.name ?? b.uuid),
  );
  return { fleet, groups: sorted, meta: { groupsRead: groups.length, groupsFailed } };
}

/** Default parallelism for the per-group metrics fan-out. Deliberately modest —
 * no rate limit is documented anywhere in the Videri API (see batching.ts). */
const METRICS_CONCURRENCY = 8;
/** First-page width for the group list. ~94 groups on this tenant fit in one page. */
const GROUP_LIST_COUNT = 100;

export class AggregatorService {
  constructor(private readonly http: VideriHttp) {}

  /**
   * Every group in the tenant.
   *
   * The trap on `rpm /v1/groups`: only `count` paginates — `page`, `size` and
   * `offset` are silently ignored, and the default returns ~10 groups. So we ask
   * for a wide first page and, if the reported total exceeds what came back,
   * re-ask for exactly that many. Two calls at most.
   */
  async listGroups(): Promise<RawGroup[]> {
    const first = await this.http.request<GroupListResponse>("rpm", "/v1/groups", {
      query: { count: GROUP_LIST_COUNT },
    });
    const groups = first.groups ?? [];
    const total = first.meta?.total ?? groups.length;
    if (total <= groups.length) return groups;
    const full = await this.http.request<GroupListResponse>("rpm", "/v1/groups", {
      query: { count: total },
    });
    return full.groups ?? [];
  }

  /** One group's raw count rollups. */
  async fetchGroupMetrics(uuid: string): Promise<GroupMetrics> {
    return this.http.request<GroupMetrics>(
      "aggregator",
      `/api/v1/groups/${encodeURIComponent(uuid)}/metrics`,
    );
  }

  /**
   * List groups, fan out per-group metrics at bounded concurrency, and sum.
   *
   * A group whose metrics call throws is collected as a failure — counted in
   * `groupsFailed`, not silently dropped and not summed as zero.
   */
  async fleetRollups(concurrency: number = METRICS_CONCURRENCY): Promise<RollupResult> {
    const groups = await this.listGroups();
    const settled = await mapSettled(groups, concurrency, async (group) => {
      const raw = await this.fetchGroupMetrics(group.uuid);
      return groupRollupFromMetrics(group, raw);
    });
    return summariseRollups(settled.ok, settled.failures.length);
  }
}
