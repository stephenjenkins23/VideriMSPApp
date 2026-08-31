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

/**
 * A group as returned by `rpm /v1/groups`.
 *
 * `parentUuid` is what makes the group list a TREE rather than a flat list — the
 * tenant's 94 groups form a 5-level hierarchy rooted at "Videri Prod", and the
 * depth-1 ancestor of a device's group is the only usable site dimension on this
 * tenant (the CITY metafield is 99.6% one value). See group-hierarchy.ts.
 */
export interface RawGroup {
  uuid: string;
  displayName?: string | null;
  active?: boolean | null;
  /** Parent group's uuid; absent/null on the tree root. */
  parentUuid?: string | null;
}

interface GroupListResponse {
  groups?: RawGroup[];
  meta?: { total?: number; start?: number; count?: number };
}

/**
 * A group list read, with the honesty fields the caller needs to trust the count.
 *
 * `groupsTotal` is what the platform SAYS exists; `groups.length` is what we
 * actually read. When those disagree the read was truncated and says so — a
 * silently short group list would understate every fleet rollup built from it.
 */
export interface GroupListing {
  groups: RawGroup[];
  /** `meta.total` as reported by the platform, or null if it reported none. */
  groupsTotal: number | null;
  /** True when we stopped paging before covering `groupsTotal`. */
  truncated: boolean;
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
  meta: {
    groupsRead: number;
    groupsFailed: number;
    /** What the platform said exists, or null if it said nothing. */
    groupsTotal: number | null;
    /** True when the group LIST itself was cut short — the total below is a floor. */
    truncated: boolean;
  };
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
export function summariseRollups(
  groups: GroupRollup[],
  groupsFailed: number,
  listing: { groupsTotal: number | null; truncated: boolean } = { groupsTotal: null, truncated: false },
): RollupResult {
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
  return {
    fleet,
    groups: sorted,
    meta: {
      groupsRead: groups.length,
      groupsFailed,
      groupsTotal: listing.groupsTotal,
      truncated: listing.truncated,
    },
  };
}

/** Default parallelism for the per-group metrics fan-out. Deliberately modest —
 * no rate limit is documented anywhere in the Videri API (see batching.ts). */
const METRICS_CONCURRENCY = 8;
/**
 * Page width for the group list — a HARD ceiling, not a preference.
 *
 * Measured live against `rpm /v1/groups` on VIDERISALES (2026-08-31):
 *   count=10 / 50 / 100 → 200 OK
 *   count=101 / 110 / 150 / 200 / 500 / 1000 → **400 BadRequestError
 *   "Invalid queries"** — and 400 with `startIndex` present too.
 * So asking for `count = meta.total` (94 today) works only until the tenant
 * crosses 100 groups, at which point the whole rollup would hard-fail. Never
 * exceed this.
 */
const GROUP_PAGE_MAX = 100;

/**
 * Safety bound on the page walk: 25 × 100 = 2,500 groups.
 *
 * `meta.total` is the platform's claim, not ours, so the loop must terminate on
 * our own count rather than trusting it. Hitting the cap is reported as
 * `truncated`, never as a complete list.
 */
const GROUP_PAGE_CALL_CAP = 25;

export class AggregatorService {
  constructor(private readonly http: VideriHttp) {}

  /**
   * Every group in the tenant, read as pages of at most `GROUP_PAGE_MAX`.
   *
   * The pagination trap on `rpm /v1/groups`, measured live 2026-08-31 (each
   * parameter sent alongside `count=10` and the returned window compared):
   *
   *   page, pageNumber, size, limit, offset, skip, from, cursor, after, index
   *     → all SILENTLY IGNORED. Same ten groups back, `meta.start` stays 0.
   *   **startIndex → WORKS.** `meta.start` echoes it, the window moves, and
   *     paging count=40 / count=25 to exhaustion returned all 94 groups with
   *     zero duplicates and zero omissions. `startIndex` past the end returns an
   *     empty list (not an error), which is how the walk terminates safely.
   *
   * So the previous implementation — re-ask with `count = meta.total` — was one
   * group-creation spree from a hard 400: the route rejects any count above 100.
   * We now cap the page at 100 and advance `startIndex`, which is real offset
   * pagination and scales past the ceiling.
   *
   * Dedupe by uuid while walking: at count=40 the paged ORDER differed from the
   * count=100 order (the route does not promise a stable sort), so overlapping
   * windows are possible in principle even though we saw none. Dedupe is cheap;
   * double-counting a group would inflate every fleet total built from this list.
   */
  async listGroupsPaged(): Promise<GroupListing> {
    const groups: RawGroup[] = [];
    const seen = new Set<string>();
    let groupsTotal: number | null = null;
    let startIndex = 0;

    for (let call = 0; call < GROUP_PAGE_CALL_CAP; call++) {
      const page = await this.http.request<GroupListResponse>("rpm", "/v1/groups", {
        query: { count: GROUP_PAGE_MAX, startIndex },
      });
      const batch = page.groups ?? [];
      const reported = page.meta?.total;
      if (typeof reported === "number" && Number.isFinite(reported)) groupsTotal = reported;

      for (const group of batch) {
        if (!group?.uuid || seen.has(group.uuid)) continue;
        seen.add(group.uuid);
        groups.push(group);
      }

      // An empty page is the end of the list (verified: startIndex past the end
      // returns `groups: []`, not an error). A SHORT page is also the last page —
      // the route always fills a page it can fill.
      if (batch.length === 0 || batch.length < GROUP_PAGE_MAX) {
        return { groups, groupsTotal, truncated: false };
      }
      startIndex += batch.length;
      if (groupsTotal !== null && startIndex >= groupsTotal) {
        return { groups, groupsTotal, truncated: false };
      }
    }

    // Call cap reached with the platform still claiming more. Report the honest
    // floor rather than presenting a partial list as the whole tenant.
    return {
      groups,
      groupsTotal,
      truncated: groupsTotal === null || groups.length < groupsTotal,
    };
  }

  /**
   * Convenience: just the groups. Callers that need to know whether the read was
   * complete use `listGroupsPaged()` — a bare array cannot say "there was more".
   */
  async listGroups(): Promise<RawGroup[]> {
    return (await this.listGroupsPaged()).groups;
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
    const listing = await this.listGroupsPaged();
    const settled = await mapSettled(listing.groups, concurrency, async (group) => {
      const raw = await this.fetchGroupMetrics(group.uuid);
      return groupRollupFromMetrics(group, raw);
    });
    // The listing's own truncation travels into the meta: a fleet total summed
    // from a group list we know was cut short is a floor, not a total.
    return summariseRollups(settled.ok, settled.failures.length, {
      groupsTotal: listing.groupsTotal,
      truncated: listing.truncated,
    });
  }
}
