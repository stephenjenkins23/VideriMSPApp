/**
 * `GET /api/incidents` — the alert queue as INCIDENTS rather than transitions
 * (Epic 8.8).
 *
 * `/api/alerts` lists the append-only `alerts` rows, which is the right surface
 * for a drilldown and the wrong one for a work queue: on today's corpus it
 * presents 1,235 transitions where there are roughly 267 distinct real-world
 * conditions. This endpoint collapses them, keyed on (scope, rule), and every one
 * of the underlying rows stays reachable — the collapse is a VIEW, nothing is
 * deleted and nothing is hidden (see `intelligence/incidents.ts` for the
 * measurement that chose the key, and why (device, rule) is the wrong one).
 *
 * TWO THINGS THIS ROUTE OWNS, both of them the honesty of a label:
 *
 *  1. **The grouping axis is named, never assumed.** Site is the depth-1 ancestor
 *     of a device's group and is resolved LIVE from `rpm /v1/groups`; with no
 *     tenant credential there is no tree, and this endpoint then groups by the
 *     device's LEAF group and says so in `data.grouping` and on every incident's
 *     `scope`. Leaf groups are finer than sites (94 against 10 on this tenant),
 *     so that fallback under-collapses and the incident count is an upper bound.
 *     Presenting it as site grouping would overstate the collapse.
 *
 *  2. **Counts describe exactly the set that was filtered.** The incident-level
 *     filters select whole incidents and then the queue is REBUILT from just
 *     those incidents' transitions, so `totals`, `grouping` and `reconciliation`
 *     are always computed by one function over exactly the rows being described.
 *     A count that came from a wider set than the list it heads has shipped here
 *     three times.
 *
 * READ-ONLY. No device write, no control-plane call of its own, and nothing
 * mutated: this endpoint reasons over rows that already exist.
 */

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { envelope } from "../freshness.js";
import { sendConditional } from "../etag.js";
import { COUNT_ONLY_LIMIT, countOnlyMeta, pageMeta } from "../count-only.js";
import {
  deviceSite,
  NO_HIERARCHY_REASON,
  type SiteResolution,
} from "../queries.js";
import {
  buildIncidentQueue,
  incidentIdFor,
  type AlertTransition,
  type Incident,
} from "../../intelligence/incidents.js";
import { correlate, type Finding } from "../../intelligence/correlation.js";
import { GroupSiteCache, withSites } from "../../videri/services/group-hierarchy.js";
import type { ApiContext } from "../server.js";
import type { Severity } from "../../domain/types.js";

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  /** `0` is the count-only sentinel (count-only.ts): a total with no rows. */
  limit: z.coerce.number().int().min(COUNT_ONLY_LIMIT).max(200).default(50),
  /**
   * INCIDENT state, derived: an incident is open while ANY of its transitions is
   * unresolved.
   *
   * Defaults to `all`, and that is deliberate — `/api/alerts` defaults to `open`
   * because a transition is a live fact, but an incident's VALUE is its
   * recurrence count, and the two rows this epic exists for are both fully
   * resolved right now: the Leedy site condition (72 transitions, 14 co-firing
   * occurrences, 0 open) and `Center Spark 5` (81 transitions, 0 open). A default
   * of `open` would have hidden exactly the evidence that chose the design.
   */
  state: z.enum(["open", "resolved", "all"]).default("all"),
  /**
   * Incident severity = the WORST severity across its transitions. Selects whole
   * incidents; it does not strip the other severities out of the ones it keeps,
   * which would silently change every count on the row.
   *
   * `all` is accepted and means unfiltered, matching `/api/alerts`: that is the
   * value a console severity chip holds when nothing is chosen, and reading it as
   * a literal severity would answer "show me everything" with an empty queue.
   */
  severity: z
    .enum(["critical", "high", "medium", "info", "all"])
    .optional()
    .transform((v) => (v === undefined || v === "all" ? undefined : v)),
  /**
   * One rule id. Part of the incident key, so filtering transitions by it and
   * filtering incidents by it are the same set — it is pushed into SQL.
   */
  rule: z
    .string()
    .max(200)
    .optional()
    .transform((v) => {
      const trimmed = v?.trim();
      return !trimmed || trimmed === "all" ? undefined : trimmed;
    }),
  /**
   * Incidents whose device ROSTER contains this device — "what is this screen
   * caught up in". It deliberately does NOT reduce a site incident to that one
   * device's rows: a roster of five is the finding, and narrowing it to one would
   * turn a site event back into a device fault.
   */
  deviceId: z.string().min(1).max(100).optional(),
  /**
   * History window in days, over `opened_at`. The ONE filter that changes what an
   * incident's counts describe — a 1-day window genuinely means "this incident
   * occurred twice in the last day" — so the window travels in the payload.
   * Omitted = all history we hold.
   */
  sinceDays: z.coerce.number().int().min(1).max(365).optional(),
  /**
   * Cross-link live correlation findings onto the incidents they touch. Off by
   * default because it costs the full per-device assembly that `/api/correlation`
   * pays, and a dashboard poll of the queue should not.
   */
  correlate: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => v === "true" || v === "1"),
});

/**
 * Every parameter this endpoint understands, read off the schema so the two
 * cannot drift. Unknown keys are a 400, not a shrug: Zod strips them, so an
 * accepted-and-ignored filter is indistinguishable from one that matched
 * everything — this project's signature failure (`x-tenant_id`).
 */
const KNOWN_PARAMS = new Set(Object.keys(ListQuery.shape));

function unknownParams(query: unknown): string[] {
  if (!query || typeof query !== "object") return [];
  return Object.keys(query as Record<string, unknown>).filter((k) => !KNOWN_PARAMS.has(k));
}

interface TransitionRow {
  id: string;
  device_id: string;
  device_name: string | null;
  group_id: string | null;
  group_name: string | null;
  rule_id: string;
  severity: string;
  title: string;
  opened_at: Date;
  last_fired_at: Date;
  resolved_at: Date | null;
  acknowledged_at: Date | null;
}

/**
 * Every transition in the window, plus its device's group.
 *
 * Retired devices are excluded, matching `/api/alerts` exactly — a queue that
 * disagreed with its own drilldown about which rows exist would be worse than
 * either. Written as NOT EXISTS rather than a `d.retired_at IS NULL` predicate
 * for the reason `queries.alerts` records: an alias-based filter compiles in one
 * statement and raises `missing FROM-clause entry` in the next. How many rows
 * that exclusion removed is COUNTED and published, so 1,235 stays reconcilable
 * from the response rather than quietly becoming 1,222.
 */
async function loadTransitions(
  pool: Pool,
  filters: { rule?: string | undefined; sinceDays?: number | undefined },
): Promise<{ rows: TransitionRow[]; excludedRetired: number; tableTotal: number }> {
  const where: string[] = [
    `NOT EXISTS (SELECT 1 FROM devices rd
                  WHERE rd.id = a.device_id AND rd.retired_at IS NOT NULL)`,
  ];
  const params: unknown[] = [];
  if (filters.rule !== undefined) {
    params.push(filters.rule);
    where.push(`a.rule_id = $${params.length}`);
  }
  if (filters.sinceDays !== undefined) {
    params.push(filters.sinceDays);
    where.push(`a.opened_at >= now() - make_interval(days => $${params.length}::int)`);
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;

  const [rows, retired] = await Promise.all([
    pool.query<TransitionRow>(
      `SELECT a.id, a.device_id, d.name AS device_name, d.group_id, d.group_name,
              a.rule_id, a.severity, a.title,
              a.opened_at, a.last_fired_at, a.resolved_at, a.acknowledged_at
         FROM alerts a
         LEFT JOIN devices d ON d.id = a.device_id
         ${whereSql}
        ORDER BY a.opened_at ASC, a.id ASC`,
      params,
    ),
    // The SAME predicates with the retirement test inverted, so the two numbers
    // add up to the window's real row count and neither is an estimate.
    pool.query<{ excluded: string; total: string }>(
      `SELECT COUNT(*) FILTER (
                WHERE EXISTS (SELECT 1 FROM devices rd
                               WHERE rd.id = a.device_id AND rd.retired_at IS NOT NULL)
              )::text AS excluded,
              COUNT(*)::text AS total
         FROM alerts a
        ${where.length > 1 ? `WHERE ${where.slice(1).join(" AND ")}` : ""}`,
      params,
    ),
  ]);

  return {
    rows: rows.rows,
    excludedRetired: Number(retired.rows[0]?.excluded ?? 0),
    tableTotal: Number(retired.rows[0]?.total ?? 0),
  };
}

/** A DB severity string, defended so an unexpected value cannot corrupt a rank. */
const asSeverity = (raw: string): Severity =>
  raw === "critical" || raw === "high" || raw === "medium" || raw === "info" ? raw : "info";

/** Project a row onto the pure engine's input, with its site resolved upstream. */
const toTransition = (row: TransitionRow, hierarchy: SiteResolution): AlertTransition => ({
  id: row.id,
  deviceId: row.device_id,
  deviceName: row.device_name,
  groupId: row.group_id,
  groupName: row.group_name,
  ruleId: row.rule_id,
  severity: asSeverity(row.severity),
  title: row.title,
  openedAt: row.opened_at.toISOString(),
  lastFiredAt: row.last_fired_at.toISOString(),
  resolvedAt: row.resolved_at?.toISOString() ?? null,
  acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
  site: deviceSite(hierarchy, row.group_id),
});

/** Incident-level selection. Applied to whole incidents, never to their rows. */
function selects(
  incident: Incident,
  filters: {
    state: "open" | "resolved" | "all";
    severity?: Severity | undefined;
    deviceId?: string | undefined;
  },
): boolean {
  if (filters.state !== "all" && incident.state !== filters.state) return false;
  if (filters.severity !== undefined && incident.severity !== filters.severity) return false;
  if (
    filters.deviceId !== undefined &&
    !incident.roster.some((r) => r.deviceId === filters.deviceId)
  ) {
    return false;
  }
  return true;
}

export async function registerIncidentRoutes(
  app: FastifyInstance,
  ctx: ApiContext,
): Promise<void> {
  /**
   * The group tree, cached with a 30-minute TTL — the same instance rationale as
   * `/api/correlation` and `/api/trends`: sites come from `rpm /v1/groups`, and
   * resolving 94 groups on every queue poll would be control-plane traffic for a
   * tree that changes when someone provisions a group. Null when there are no
   * credentials, in which case the incident axis falls back to the leaf group and
   * the payload says so — it never silently calls a group a site.
   */
  const siteCache = ctx.videri ? new GroupSiteCache(ctx.videri) : null;

  app.get("/api/incidents", async (request, reply) => {
    const unknown = unknownParams(request.query);
    if (unknown.length > 0) {
      return reply.code(400).send({
        error: "unknown_parameter",
        message:
          `Unrecognised query parameter(s): ${unknown.join(", ")}. This endpoint ` +
          `refuses rather than ignores them — an ignored filter looks exactly like ` +
          `a filter that matched everything. Accepted: ` +
          `${[...KNOWN_PARAMS].sort().join(", ")}.`,
        unknown,
        accepted: [...KNOWN_PARAMS].sort(),
      });
    }
    const parsed = ListQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "bad_request",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }
    const filters = parsed.data;

    const [loaded, freshness, hierarchyRead] = await Promise.all([
      loadTransitions(ctx.pool, filters),
      ctx.freshness(),
      siteCache?.get() ?? Promise.resolve(null),
    ]);

    // `index: null` is the honest "we could not read the tree" — never an empty
    // index, which would resolve every device to no site and look like a tenant
    // with no groups at all.
    const hierarchy: SiteResolution = {
      index: hierarchyRead?.index ?? null,
      reason: hierarchyRead === null ? NO_HIERARCHY_REASON : hierarchyRead.reason,
    };

    const transitions = loaded.rows.map((row) => toTransition(row, hierarchy));

    // Pass 1: the queue over everything loaded, to decide which incidents match.
    // Pass 2: rebuild from ONLY the selected incidents' transitions, so every
    // published count is computed by one function over exactly the rows it
    // describes. Two passes over ≤ a few thousand rows buys the invariant that
    // the total can never come from a wider set than the list beneath it.
    const all = buildIncidentQueue(transitions, { hierarchyReason: hierarchy.reason });
    const selected = new Set(all.incidents.filter((i) => selects(i, filters)).map((i) => i.id));
    const kept =
      selected.size === all.incidents.length
        ? transitions
        : transitions.filter((t) => selected.has(incidentIdFor(t)));
    const queue =
      selected.size === all.incidents.length
        ? all
        : buildIncidentQueue(kept, { hierarchyReason: hierarchy.reason });

    const offset = (filters.page - 1) * filters.limit;
    const pageRows =
      filters.limit === COUNT_ONLY_LIMIT
        ? []
        : queue.incidents.slice(offset, offset + filters.limit);

    const findings = filters.correlate
      ? await liveFindings(ctx, hierarchyRead?.index ?? null)
      : { available: false as const, reason: CORRELATION_OFF, findings: [] as Finding[] };

    const payload = envelope(
      {
        incidents: pageRows.map((incident) => ({
          ...incident,
          /**
           * Live correlation findings whose affected devices overlap this
           * incident's roster. A CROSS-LINK, not a cause: correlation speaks
           * about the fleet's state right now, an incident about a history of
           * transitions, and the overlap is where the two surfaces are talking
           * about the same screens. Empty when `correlate` was not requested,
           * which `data.correlation.available` distinguishes from "none matched".
           */
          correlationFindings: findings.findings
            .filter((f) => f.affectedDeviceIds.some((id) => incident.roster.some((r) => r.deviceId === id)))
            .map((f) => ({ id: f.id, kind: f.kind, severity: f.severity, summary: f.summary })),
        })),
        grouping: queue.grouping,
        totals: queue.totals,
        reconciliation: queue.reconciliation,
        /**
         * What was READ, against what the table holds — so the published
         * transition count stays reconcilable with `SELECT count(*) FROM alerts`
         * instead of quietly differing by the retired rows.
         */
        corpus: {
          transitionsRead: loaded.rows.length,
          transitionsInWindow: loaded.tableTotal,
          transitionsExcludedRetired: loaded.excludedRetired,
          retirementNote:
            loaded.excludedRetired === 0
              ? "No transitions were excluded for device retirement."
              : `${loaded.excludedRetired} transition(s) in this window belong to retired ` +
                `devices and are excluded, exactly as /api/alerts excludes them. They are ` +
                `not lost: they remain in the alerts table and are reachable there.`,
          windowDays: filters.sinceDays ?? null,
          windowNote:
            filters.sinceDays === undefined
              ? "All history held. Occurrence counts are over the whole retained corpus."
              : `Only transitions opened in the last ${filters.sinceDays} day(s) are counted, ` +
                `so every occurrence count on this page describes that window and not the ` +
                `incident's whole life.`,
          /** Incidents matching the filters, of every incident in the window. */
          incidentsSelected: queue.incidents.length,
          incidentsInWindow: all.incidents.length,
        },
        filters: {
          state: filters.state,
          severity: filters.severity ?? null,
          rule: filters.rule ?? null,
          deviceId: filters.deviceId ?? null,
          sinceDays: filters.sinceDays ?? null,
          note:
            "state, severity and deviceId select whole incidents and never strip rows out " +
            "of the incidents they keep; sinceDays narrows the transitions themselves and " +
            "therefore narrows every count on the page. rule is part of the incident key, " +
            "so the two are the same set.",
        },
        correlation: {
          available: findings.available,
          reason: findings.reason,
          findings: findings.findings.length,
        },
      },
      freshness,
      pageMeta(filters.page, filters.limit, queue.incidents.length),
    );

    const countOnly = countOnlyMeta(filters.limit);
    const body = countOnly
      ? {
          ...payload,
          meta: { ...payload.meta, countOnly: countOnly.countOnly, countNote: countOnly.note },
        }
      : payload;

    // The validator covers every parsed parameter, so it cannot serve one
    // filter's rows for another filter's request (etag.ts).
    return sendConditional(
      request,
      reply,
      { route: "GET /api/incidents", params: filters },
      body,
      freshness,
    );
  });
}

const CORRELATION_OFF =
  "Not requested. Pass correlate=true to cross-link live correlation findings onto the " +
  "incidents whose device rosters they touch.";

/**
 * Live correlation findings, from the SAME assembly `/api/correlation` uses.
 *
 * Reusing that exact call is the point: two surfaces that derived "which devices
 * are failing together at this site" independently would eventually describe the
 * same site differently, and the operator would have no way to tell which was
 * right. A failure here degrades to `available: false` with the reason — the
 * queue is still correct without the cross-link, and an empty findings list must
 * never be readable as "nothing is correlated".
 */
async function liveFindings(
  ctx: ApiContext,
  index: Parameters<typeof withSites>[1] | null,
): Promise<{ available: boolean; reason: string | null; findings: Finding[] }> {
  try {
    const devices = await ctx.queries.remediationDevices();
    const resolved = index != null ? withSites(devices, index).devices : devices;
    const report = correlate(resolved);
    return {
      available: true,
      reason:
        index == null
          ? "Findings were computed WITHOUT the group tree, so no venue cluster can be " +
            "site-scoped; see /api/correlation's notes for what that leaves out."
          : null,
      findings: report.findings,
    };
  } catch (error) {
    return {
      available: false,
      reason: `Correlation could not be computed (${(error as Error).message}).`,
      findings: [],
    };
  }
}
