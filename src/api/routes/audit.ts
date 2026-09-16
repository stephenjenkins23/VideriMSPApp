/**
 * The audit trail — what VFI did, not what the platform told us.
 *
 * Twenty-one tables recorded the fleet's state; none recorded our own writes.
 * VFI fires real device commands — a brightness write with a
 * preflight → verify → rollback cycle — and until now the only trace was a
 * transient banner in the console drawer, lost on the next render. "What did we
 * change on this screen last week, and who asked for it?" had no answer, and
 * `GET /api/commands` is a capability CATALOGUE, not a log.
 *
 * For an MSP acting on a customer's estate that is a trust and dispute problem.
 * It is built BEFORE the bulk-write work on purpose, so the write surface never
 * grows unlogged.
 *
 * This endpoint is READ-ONLY and answers the four questions that actually get
 * asked — everything we did to device X, everything in this window, everything
 * that failed, everything a given actor did — each backed by its own index (see
 * migrations/009-device-action-log.sql).
 *
 * The pure helpers below (`resolveActor`, `auditOutcomeForBrightness`) live here
 * rather than in the routes that use them so that the outcome vocabulary and the
 * writers of it sit in one file: the CHECK constraint on the table is only as
 * good as the single mapper the app funnels through.
 */

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { ApiContext } from "../server.js";
import { envelope } from "../freshness.js";
import {
  AUDIT_RETAIN_DAYS,
  DEVICE_ACTION_OUTCOMES,
  type DeviceActionFilters,
  type DeviceActionOutcome,
  type DeviceActionRow,
} from "../../db/repository.js";
import type { BrightnessState } from "../../videri/brightness.js";

/**
 * Map a brightness cycle's internal state onto the audit vocabulary.
 *
 * Pure and exhaustive on purpose: `outcome` is CHECKed in the database and
 * filtered on by this endpoint, so a state the mapper does not know must be a
 * compile error here rather than a rejected INSERT at write time (which the
 * write path would swallow, per "a logging failure never breaks the operation" —
 * leaving a silent hole in the audit exactly when a write misbehaved).
 *
 * `preflight_blocked` is `refused`, not `failed`: we declined to write because
 * the original value was unreadable, and the panel was never touched.
 * `write_rejected` is `failed`: we did write, and the device said no.
 */
export function auditOutcomeForBrightness(state: BrightnessState): DeviceActionOutcome {
  switch (state) {
    case "verified": return "verified";
    case "no_change": return "no_change";
    case "preflight_blocked": return "refused";
    case "write_rejected": return "failed";
    case "unconfirmed_rolled_back": return "rolled_back";
    case "unconfirmed_rollback_failed": return "rollback_failed";
  }
}

/**
 * Who or what initiated an action.
 *
 * There is NO user model: auth is a single shared bearer token (api/auth.ts), so
 * inventing a user id here would be fabricating provenance in the one table
 * whose entire value is that it does not. So this reports exactly what we know:
 *
 *   api:<name>     — the caller identified itself via `X-VFI-Actor`. Trusted no
 *                    further than the token is: it is a claim, and it is
 *                    recorded as a claim, which is still better provenance than
 *                    none while it is the only identity the console can offer.
 *   api:token      — a caller holding the shared token, unnamed.
 *   api:anonymous  — the server was started with --allow-anonymous (local dev).
 *
 * Pollers pass their own `poller:<lane>` string and never go through this.
 *
 * The header is trimmed and length-capped: an actor is an index key and a log
 * line, not a place to store a kilobyte.
 */
export function resolveActor(input: {
  actorHeader?: string | undefined;
  authorization?: string | undefined;
  allowAnonymous: boolean;
}): string {
  const named = input.actorHeader?.trim().slice(0, 120);
  if (named) return `api:${named}`;
  if (input.authorization) return "api:token";
  return input.allowAnonymous ? "api:anonymous" : "api:token";
}

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  deviceId: z.string().min(1).max(100).optional(),
  actor: z.string().min(1).max(200).optional(),
  /**
   * Comma-separated, so "everything that failed" is one call:
   * `outcome=failed,rolled_back,rollback_failed`. Validated against the closed
   * vocabulary rather than passed through — a typo that silently matches zero
   * rows would read as "we did nothing", which is the worst possible wrong
   * answer from an audit log.
   */
  outcome: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      const parts = Array.from(new Set(v.split(",").map((x) => x.trim()).filter(Boolean)));
      const bad = parts.filter((p) => !DEVICE_ACTION_OUTCOMES.includes(p as DeviceActionOutcome));
      if (bad.length > 0) {
        ctx.addIssue({
          code: "custom",
          message:
            `unknown outcome(s) ${bad.join(", ")}. Valid: ${DEVICE_ACTION_OUTCOMES.join(", ")}.`,
        });
        return z.NEVER;
      }
      return parts as DeviceActionOutcome[];
    }),
  action: z.string().min(1).max(64).optional(),
  /** Half-open window [since, until) on when the action STARTED. */
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
});

/** Dates out as ISO strings; `null` stays `null` and never becomes an epoch. */
const serialise = (row: DeviceActionRow) => ({
  ...row,
  startedAt: row.startedAt.toISOString(),
  finishedAt: row.finishedAt.toISOString(),
});

// ── counts: the numbers the outcome pills were shipped without ──────────────

/**
 * `GET /api/audit/counts` exists because the audit UI shipped with deliberately
 * NUMBERLESS outcome pills.
 *
 * The list endpoint serves one page of 50 rows, and a tally over that page is a
 * PAGE count wearing a log count's clothes: "3 failed" would mean "3 of the 50
 * most recent matching rows failed", which an operator reads as "3 writes have
 * ever failed". So the pills were left bare rather than wrong. This endpoint is
 * the fix — it groups over every row the SAME filters match, so the numbers
 * describe the whole matched log.
 *
 * Two properties are load-bearing:
 *
 *   1. **It takes exactly /api/audit's filters** (`CountQuery` is that schema
 *      with the page controls removed, not a re-declaration of it), so the two
 *      endpoints cannot disagree about what they are describing. `page`/`limit`
 *      are refused rather than ignored: a caller who sends them is asking for a
 *      page count, and silently answering a different question is the bug this
 *      endpoint was built to remove.
 *
 *   2. **A zero always means "we counted and the log holds none."** An outcome
 *      the caller's own `outcome=` filter excluded is ABSENT from the breakdown,
 *      never shown as 0 — a zero that means "you filtered it out" sitting beside
 *      a zero that means "it never happened" is exactly the fabricated-zero this
 *      project treats as its worst bug class. And the two flavours of empty —
 *      "nothing has ever been logged" and "nothing matches your filter" — read
 *      differently, because they are different facts and only one of them is
 *      about the filter.
 */
const AUDIT_COUNTS_BASIS =
  "Counted over every row matching these filters, not over a page of them: /api/audit serves " +
  "50 rows at a time and a tally over those is a page count, not a log count. The filters are " +
  "the same ones /api/audit accepts and are echoed back, so the two answers can be checked " +
  "against each other. Every number here is a count we performed — a zero means we looked and " +
  "the matched log holds none of that outcome, and an outcome your own filter excluded is " +
  "absent rather than reported as zero. Nothing is inferred or backfilled: this log is written " +
  "only when VFI actually writes to a device.";

/** The list query minus the page controls: counts describe a match, not a page. */
const CountQuery = ListQuery.omit({ page: true, limit: true });

type CountFilters = Omit<DeviceActionFilters, "page" | "limit">;

/**
 * The WHERE clause, built from the filters. Pure, and a deliberate mirror of
 * the one inside `Repository.listDeviceActions`.
 *
 * Mirroring is a debt, not a design: both belong in that repository method's
 * own file so there is one definition of "matches", and neither `repository.ts`
 * nor a shared home for it is this change's to edit. Until they are merged the
 * pair MUST stay identical — a filter that means something subtly different
 * here produces counts that disagree with the list they are printed beside,
 * which is the failure this endpoint exists to prevent. `audit.test.ts` asserts
 * the two clauses character-for-character against the same filter set.
 */
export function auditFilterSql(filters: CountFilters): { clause: string; values: unknown[] } {
  const where: string[] = [];
  const values: unknown[] = [];
  const bind = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  if (filters.deviceId) where.push(`l.device_id = ${bind(filters.deviceId)}`);
  if (filters.actor) where.push(`l.actor = ${bind(filters.actor)}`);
  if (filters.outcome) where.push(`l.outcome = ANY(${bind(filters.outcome)}::text[])`);
  if (filters.action) where.push(`l.action = ${bind(filters.action)}`);
  // Half-open [since, until): an audit window that includes both endpoints
  // double-counts a row when two adjacent windows are read back to back.
  if (filters.since) where.push(`l.started_at >= ${bind(filters.since)}`);
  if (filters.until) where.push(`l.started_at < ${bind(filters.until)}`);

  return { clause: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "", values };
}

/** One (outcome, action) group as the database returns it. */
export interface AuditCountGroup {
  outcome: string;
  action: string;
  count: number;
  oldest: Date | null;
  newest: Date | null;
}

export interface AuditCounts {
  /** Rows matching the filters. Summed from the groups, so it cannot disagree. */
  matched: number;
  /** Rows in the whole log, ignoring every filter — the denominator. */
  logSize: number;
  /**
   * Counts per outcome, over the matched set. Keys are the outcomes IN SCOPE:
   * the closed vocabulary, or just the ones an `outcome=` filter admits.
   */
  byOutcome: Record<string, number>;
  /**
   * Counts per action, highest first. An action with no matching row is absent
   * rather than zero — `action` is an open text column and nothing enumerates
   * the actions that have never been logged, so a zero for one would be
   * invented.
   */
  byAction: Array<{ action: string; count: number }>;
  /** Span of the MATCHED set. Null when nothing matched — never an epoch. */
  oldestActionAt: string | null;
  newestActionAt: string | null;
  /** Null when something matched. Otherwise WHICH empty this is. */
  emptyReason: string | null;
}

/**
 * Fold the grouped rows into the payload. Pure, so the arithmetic that must
 * reconcile — matched == sum(byOutcome) == sum(byAction) — is testable without
 * a database, which matters here because `device_action_log` holds 0 rows on
 * this deployment and every real count is currently a zero.
 */
export function foldAuditCounts(
  groups: readonly AuditCountGroup[],
  context: { logSize: number; outcomeScope: readonly DeviceActionOutcome[]; filtered: boolean },
): AuditCounts {
  const byOutcome: Record<string, number> = {};
  // Seed only the in-scope outcomes. A caller asking for `outcome=failed` gets
  // one key: the other six were excluded by their own filter and printing them
  // as 0 would claim we counted them.
  for (const outcome of context.outcomeScope) byOutcome[outcome] = 0;

  const perAction = new Map<string, number>();
  let matched = 0;
  let oldest: Date | null = null;
  let newest: Date | null = null;

  for (const group of groups) {
    matched += group.count;
    byOutcome[group.outcome] = (byOutcome[group.outcome] ?? 0) + group.count;
    perAction.set(group.action, (perAction.get(group.action) ?? 0) + group.count);
    if (group.oldest && (oldest === null || group.oldest < oldest)) oldest = group.oldest;
    if (group.newest && (newest === null || group.newest > newest)) newest = group.newest;
  }

  const emptyReason =
    matched > 0
      ? null
      : context.logSize === 0
        ? "No device action has been logged yet, under any filter. This log starts empty and " +
          "is only written when VFI actually writes to a device; nothing here is inferred or " +
          "backfilled, so every count being zero means no write has happened under this " +
          "build — not that the counting failed."
        : context.filtered
          ? `No logged action matches these filters. The log itself holds ` +
            `${context.logSize} action(s), so this is your filter matching none of them ` +
            `rather than an empty log.`
          : `The log holds ${context.logSize} action(s) but none were counted, which cannot ` +
            `happen from an unfiltered read and means this count is wrong. Treat it as a bug ` +
            `in /api/audit/counts, not as a fact about the fleet.`;

  return {
    matched,
    logSize: context.logSize,
    byOutcome,
    byAction: [...perAction.entries()]
      .map(([action, count]) => ({ action, count }))
      // Count first, then name, so the order is stable across identical counts.
      .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action)),
    oldestActionAt: oldest?.toISOString() ?? null,
    newestActionAt: newest?.toISOString() ?? null,
    emptyReason,
  };
}

/**
 * Group the matched rows by outcome AND action in one pass.
 *
 * One query rather than two so both breakdowns describe provably the same rows;
 * the per-outcome and per-action totals are then folded from the same groups and
 * cannot disagree with each other or with `matched`. Same SQL home as
 * `auditFilterSql`, for the same reason.
 */
async function auditCountGroups(
  pool: Pool,
  filters: CountFilters,
): Promise<AuditCountGroup[]> {
  const { clause, values } = auditFilterSql(filters);
  const { rows } = await pool.query<{
    outcome: string;
    action: string;
    n: string;
    oldest: Date | null;
    newest: Date | null;
  }>(
    `SELECT l.outcome, l.action, count(*)::text AS n,
            MIN(l.started_at) AS oldest, MAX(l.started_at) AS newest
       FROM device_action_log l
       ${clause}
      GROUP BY l.outcome, l.action`,
    values,
  );
  return rows.map((row) => ({
    outcome: row.outcome,
    action: row.action,
    count: Number(row.n),
    oldest: row.oldest,
    newest: row.newest,
  }));
}

export async function registerAuditRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  /**
   * Counts over the whole matched log — the numbers behind the outcome pills.
   *
   * Registered before the list route only for reading order; Fastify matches
   * both paths exactly, so there is no shadowing either way.
   */
  app.get("/api/audit/counts", async (request, reply) => {
    const raw = (request.query ?? {}) as Record<string, unknown>;
    // Refused, not ignored. A caller sending page controls is asking for a tally
    // over a page, and answering with a tally over the whole match — under the
    // parameters they sent — would be answering a question they did not ask.
    if (raw.page !== undefined || raw.limit !== undefined) {
      return reply.code(400).send({
        error: "bad_request",
        message:
          "`page` and `limit` are not accepted here: these counts describe every row matching " +
          "the filters, and a count over one page is a page count dressed as a log count — " +
          "which is why the outcome pills shipped without numbers at all. Use the same filters " +
          "you pass to /api/audit and leave the page controls off.",
      });
    }

    const parsed = CountQuery.safeParse(raw);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "bad_request",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }
    const f = parsed.data;
    if (f.since && f.until && f.since >= f.until) {
      return reply.code(400).send({
        error: "bad_request",
        message: "`since` must be earlier than `until`; the window is half-open [since, until).",
      });
    }

    const filters: CountFilters = {
      deviceId: f.deviceId,
      actor: f.actor,
      outcome: f.outcome,
      action: f.action,
      since: f.since,
      until: f.until,
    };
    const filtered = Object.values(filters).some((value) => value !== undefined);

    const [groups, logSize, freshness] = await Promise.all([
      auditCountGroups(ctx.pool, filters),
      // Always read, not just when the match is empty as the list endpoint does:
      // here it is the denominator. "12 of 1,043 actions match" and "12 of 12"
      // are different readings of the same 12.
      ctx.repo.deviceActionLogSize(),
      ctx.freshness(),
    ]);

    const counts = foldAuditCounts(groups, {
      logSize,
      // The outcomes in scope: the closed vocabulary, or only the ones the
      // caller's own filter admits.
      outcomeScope: f.outcome ?? DEVICE_ACTION_OUTCOMES,
      filtered,
    });

    return envelope(
      {
        ...counts,
        basis: AUDIT_COUNTS_BASIS,
        /** Echoed so a reader can check these counts against a list call. */
        filters: {
          deviceId: f.deviceId ?? null,
          actor: f.actor ?? null,
          outcome: f.outcome ?? null,
          action: f.action ?? null,
          since: f.since?.toISOString() ?? null,
          until: f.until?.toISOString() ?? null,
        },
        /** Which outcomes these counts cover, so an absent key is not read as 0. */
        outcomeScope: {
          counted: f.outcome ?? [...DEVICE_ACTION_OUTCOMES],
          excludedByFilter: f.outcome
            ? DEVICE_ACTION_OUTCOMES.filter((o) => !f.outcome!.includes(o))
            : [],
          note: f.outcome
            ? "Your `outcome=` filter narrowed this breakdown. The excluded outcomes are " +
              "absent from `byOutcome` rather than reported as 0, because we did not count " +
              "them — drop the filter to count them all."
            : "No outcome filter was applied, so all " +
              `${DEVICE_ACTION_OUTCOMES.length} outcomes in the vocabulary were counted and a ` +
              "0 here means the matched log genuinely holds none.",
        },
        /**
         * Actions are an open text column, so this breakdown can only list
         * actions that HAVE a matching row. Stated, because "brightness_write is
         * missing" must not be read as "we counted zero of them".
         */
        actionScope: {
          note:
            "`action` is an open vocabulary written by the call sites, not a closed enum, so " +
            "`byAction` lists only actions with at least one matching row. An action absent " +
            "from the list has no matching row; we cannot report a 0 for an action nothing " +
            "enumerates.",
        },
        /** These counts are as of this instant, from the log itself. */
        countedAt: new Date().toISOString(),
        retention: {
          retainDays: AUDIT_RETAIN_DAYS,
          enforced: false,
          note:
            `Counts are bounded by the same ${AUDIT_RETAIN_DAYS}-day retention ceiling as the ` +
            `list, and no pruning is wired up, so nothing has aged out of these numbers: a ` +
            `count of 0 means the action was never logged, not that it expired.`,
        },
      },
      freshness,
    );
  });

  app.get("/api/audit", async (request, reply) => {
    const parsed = ListQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "bad_request",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }
    const f = parsed.data;
    if (f.since && f.until && f.since >= f.until) {
      return reply.code(400).send({
        error: "bad_request",
        message: "`since` must be earlier than `until`; the window is half-open [since, until).",
      });
    }

    const [result, freshness] = await Promise.all([
      ctx.repo.listDeviceActions({
        deviceId: f.deviceId,
        actor: f.actor,
        outcome: f.outcome,
        action: f.action,
        since: f.since,
        until: f.until,
        page: f.page,
        limit: f.limit,
      }),
      ctx.freshness(),
    ]);

    /**
     * An empty log must say WHICH empty it is. "We have never logged an action"
     * and "your filter matched nothing" are different facts, and reporting the
     * first as the second (or either as a bare `[]`) is how someone concludes a
     * write went unrecorded when it did not. The extra count runs only when the
     * page came back empty.
     */
    let emptyReason: string | null = null;
    if (result.items.length === 0) {
      const total = await ctx.repo.deviceActionLogSize();
      emptyReason =
        total === 0
          ? "No device action has been logged yet. This log starts empty and is only " +
            "written when VFI actually writes to a device; nothing here is inferred " +
            "or backfilled, so an empty log means no write has happened under this build."
          : result.totalItems === 0
            ? "No logged action matches these filters."
            : `Page ${f.page} is past the end of ${result.totalItems} matching action(s).`;
    }

    return envelope(
      {
        actions: result.items.map(serialise),
        /**
         * Span of the MATCHED set, not of the page — a caller on page 1 of 40
         * still needs to know how far back the match reaches.
         */
        oldestActionAt: result.oldestAt?.toISOString() ?? null,
        newestActionAt: result.newestAt?.toISOString() ?? null,
        emptyReason,
        /**
         * Stated in the response because a reader of an audit log has to know
         * whether absence of a row means "it did not happen" or "it aged out".
         */
        retention: {
          retainDays: AUDIT_RETAIN_DAYS,
          /**
           * False today: nothing calls `pruneDeviceActionLog`. The bound is a
           * declared ceiling, not an active deletion — the same honest status as
           * the `fleet_snapshots` bound, which has never yet deleted a live row.
           */
          enforced: false,
          note:
            `The audit log is bounded at ${AUDIT_RETAIN_DAYS} days as a ceiling, ` +
            `deliberately far longer than the 14-90 day windows used for ` +
            `measurement history, and it is kept out of the nightly retention ` +
            `sweep. No pruning is wired up, so nothing has aged out: absence of a ` +
            `row means the action was not logged, not that it expired.`,
        },
      },
      freshness,
      {
        page: f.page,
        limit: f.limit,
        totalItems: result.totalItems,
        totalPages: Math.max(1, Math.ceil(result.totalItems / f.limit)),
      },
    );
  });
}
