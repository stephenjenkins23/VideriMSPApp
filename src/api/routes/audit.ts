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
 * Three later additions all exist to make it USABLE rather than merely correct:
 *
 *   `previousValue` — the from-half of from→to, normalised (migration 011). It
 *     is served as a value-or-reason, never as a bare nullable column, because a
 *     null rendered as 0 claims we set a panel from display-off and a null
 *     rendered as a dash reads as "no change".
 *   `q` — free text over WHO acted and WHICH SCREEN, because "what happened to
 *     the canvas in the Denver lobby" was unanswerable when `actor` was
 *     exact-match and nothing matched a device by name.
 *   `actionGroup` — a brightness change is written under two different `action`
 *     values, and needing two calls plus a client-side merge is how one of them
 *     goes quietly missing from a dispute.
 *
 * Each of the last two is added to `auditFilterSql` AND to
 * `Repository.listDeviceActions`; `audit.counts.test.ts` compares the two
 * clauses character-for-character, which is what stops the counts from
 * describing a different set than the list they are printed beside.
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
  PREVIOUS_VALUE_BASES,
  auditSearchPattern,
  type DeviceActionFilters,
  type DeviceActionOutcome,
  type DeviceActionRow,
  type PreviousValueBasis,
} from "../../db/repository.js";
import { percentFromRaw, type BrightnessState } from "../../videri/brightness.js";

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

/**
 * ── from → to: reading a previous value that is allowed not to exist ────────
 *
 * `previous_value` (migration 011) is nullable, and a nullable column in an
 * audit view is where fabricated data gets in: rendered as `0` it claims we set
 * a panel from display-off, and rendered as `—` it reads as "no change". Both
 * are statements we cannot support. So the column is never served raw — this
 * turns it into a value plus, when there is no value, the REASON there is none.
 *
 * `known === false` and `reason === null` is impossible by construction, and
 * that pairing is what the UI can rely on: if `known` is false there is always a
 * sentence to print.
 */
export type PreviousValueSource = "recorded" | "derived_from_raw";

export interface PreviousValueView {
  /** Normalised to `requestedValue`'s unit. Null whenever `known` is false. */
  value: string | null;
  known: boolean;
  /** How the writer said it knew. Null on rows written before the column. */
  basis: PreviousValueBasis | null;
  source: PreviousValueSource | null;
  /** Non-null exactly when `known` is false: WHY we do not know. */
  reason: string | null;
  /** Non-null when the value is real but carries a caveat worth printing. */
  note: string | null;
}

const isBasis = (value: unknown): value is PreviousValueBasis =>
  typeof value === "string" && (PREVIOUS_VALUE_BASES as readonly string[]).includes(value);

/**
 * Why unknown, per basis. Prose, because this is printed to a human who is
 * trying to work out whether a screen was changed.
 */
const UNKNOWN_BECAUSE: Record<PreviousValueBasis, string> = {
  preflight_read:
    "This row says the panel WAS read before the write but stored no value, which cannot both " +
    "be true. Treat it as a bug in the writer, not as a fact about the device.",
  preflight_unreadable:
    "VFI read the panel before writing and the device would not report its brightness, so what " +
    "it was at beforehand is unknown. That unreadable preflight is why the write was refused — " +
    "and it is not 0, which on this scale is a display-off screen.",
  not_read:
    "This action does not read the device's prior state before acting — it sends the command and " +
    "reports what the device answered — so no before-value was ever available to record.",
  not_attempted:
    "VFI refused before touching the device, so nothing was read and there is no before-value. " +
    "The screen was not changed.",
};

const NEVER_RECORDED =
  "This row was written before VFI recorded a normalised before-value, and nothing in it says " +
  "what the device was at, so the value before this action is unknown. It was never recorded and " +
  "has deliberately not been backfilled — a guessed before-value in an audit table would be " +
  "invented history.";

/**
 * Read the from-half of from→to off one row. Pure.
 *
 * Three sources, in descending order of what they prove:
 *
 *   1. the column, written by the call site in the requested value's own unit;
 *   2. `detail.originalRaw` — brightness rows written BEFORE the column existed
 *      carry the preflight reading on the device's raw 0-255 scale. Converting
 *      it to a percent here is the same conversion the writer already applies to
 *      `observedRaw`, so it is a unit change on a recorded fact, not an
 *      inference — and it is labelled `derived_from_raw` so nobody has to guess
 *      which it was. This is a READ-time conversion; the stored row is untouched;
 *   3. nothing, which is an answer with a reason and never a 0 or a dash.
 */
export function describePreviousValue(
  row: Pick<DeviceActionRow, "previousValue" | "detail">,
): PreviousValueView {
  const basis = isBasis(row.detail["previousValueBasis"])
    ? (row.detail["previousValueBasis"] as PreviousValueBasis)
    : null;

  if (row.previousValue !== null) {
    return { value: row.previousValue, known: true, basis, source: "recorded", reason: null, note: null };
  }

  // A pre-011 brightness row: the fact is in the row, on the wrong scale.
  const originalRaw = row.detail["originalRaw"];
  if (basis === null && typeof originalRaw === "number" && Number.isFinite(originalRaw)) {
    return {
      value: `${percentFromRaw(originalRaw)}%`,
      known: true,
      basis: null,
      source: "derived_from_raw",
      reason: null,
      note:
        `Converted at read time from the raw ${originalRaw} this row recorded on the device's ` +
        `0-255 scale, because it was written before the normalised column existed. The stored ` +
        `row is unchanged; rounding to a whole percent is the only loss.`,
    };
  }

  return {
    value: null,
    known: false,
    basis,
    source: null,
    reason: basis === null ? NEVER_RECORDED : UNKNOWN_BECAUSE[basis],
    note: null,
  };
}

/**
 * ── action groups: one concept, more than one `action` string ───────────────
 *
 * A device's brightness history spans TWO action values — `brightness_write`
 * from the single-device slider and `bulk_brightness_write` from a batch push —
 * so "every brightness change on this device" needed two calls and a merge in
 * the client, which is how one of them ends up quietly missing from a dispute.
 *
 * A CLOSED map rather than letting `action` take a comma list: `action` is an
 * open text column with nothing to validate a typo against, and an audit filter
 * that silently matches zero rows reads as "we never touched it". A group name
 * can be checked, so `actionGroup=brigthness` is a 400 that names the
 * vocabulary. It also means the fact that one concept spans two writers stays an
 * implementation detail here instead of in every caller.
 */
export const AUDIT_ACTION_GROUPS: Record<string, readonly string[]> = {
  brightness: ["brightness_write", "bulk_brightness_write"],
};
export const AUDIT_ACTION_GROUP_NAMES = Object.keys(AUDIT_ACTION_GROUPS);

/**
 * ── free text: what the search box actually searches ───────────────────────
 *
 * "What happened to the canvas in the Denver lobby" was unanswerable: `actor`
 * was exact-match and nothing matched a device by name. So `q` matches WHO acted
 * and WHICH SCREEN it was, over the five columns that identify those:
 *
 *   l.device_id    — so a pasted id works in the same box
 *   d.name         — the obvious one; all 251 devices have one
 *   d.group_name   — where an operator actually puts the placement
 *                    ("Front Sitting Area", "Regus New Side"): 234 of 251
 *   d.location     — city/address, populated on only 18 of 251, but when it is
 *                    set it is the only geographic fact we hold
 *   l.actor        — 'api:stephen'; substring, unlike the exact `actor` filter
 *
 * Deliberately NOT searched, because a search whose scope cannot be stated in
 * one sentence produces result sets nobody can explain:
 *
 *   action / verb — they have exact filters and `actionGroup`; folding them in
 *                   makes `q=brightness` a vague duplicate of a precise filter.
 *   error / message prose — our own generated sentences. `q=rollback` would
 *                   match rows whose error merely MENTIONS rollback while
 *                   missing rows whose outcome IS `rolled_back`; `outcome=` is
 *                   the honest way to ask that.
 *   params / detail JSON — raw device payloads, where `q=100` would hit
 *                   `originalRaw: 100` and read as a device match.
 *
 * The scope is echoed in the response so the UI can tell the operator exactly
 * what the box covers, rather than letting an empty result imply nothing
 * happened.
 */
export const AUDIT_SEARCH_FIELDS = [
  "deviceId", "deviceName", "groupName", "location", "actor",
] as const;

const AUDIT_SEARCH_NOTE =
  "`q` is a case-insensitive substring match over WHO acted and WHICH SCREEN it was — device " +
  "id, device name, group name, location and actor. It does NOT search the action, the verb, " +
  "the error prose or the raw device payloads: those have exact filters, and matching our own " +
  "sentences would return rows that merely mention a word while missing the rows that are the " +
  "thing. Your `%` and `_` are matched literally, not as wildcards. A device removed upstream " +
  "keeps its audit rows but has no name to match, so it is findable by id only.";

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
  /**
   * A named set of actions that mean one thing to an operator — today only
   * `brightness`, which is the two writers of it. Validated against the closed
   * map above rather than passed through, for the same reason `outcome` is.
   */
  actionGroup: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      const name = v.trim();
      if (!Object.hasOwn(AUDIT_ACTION_GROUPS, name)) {
        ctx.addIssue({
          code: "custom",
          message:
            `unknown actionGroup ${v}. Valid: ${AUDIT_ACTION_GROUP_NAMES.join(", ")}.`,
        });
        return z.NEVER;
      }
      return name;
    }),
  /**
   * Free text. Trimmed, and a blank one is REFUSED rather than dropped: a filter
   * the server silently ignores returns the whole log under a heading that says
   * it was searched.
   */
  q: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      const trimmed = v.trim();
      if (trimmed.length === 0) {
        ctx.addIssue({
          code: "custom",
          message:
            "`q` is blank. A blank search is not a filter, and silently ignoring it would " +
            "return the whole log as though it had been searched — say what you are looking " +
            "for, or leave `q` off.",
        });
        return z.NEVER;
      }
      return trimmed;
    }),
  /** Half-open window [since, until) on when the action STARTED. */
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
});

/**
 * Dates out as ISO strings; `null` stays `null` and never becomes an epoch.
 *
 * `previousValue` goes out as the DESCRIBED view rather than the bare column:
 * from→to is the sentence this log exists to produce, and the half of it that
 * can be missing must carry why. The row's own `detail.previousValueBasis` stays
 * in `detail` as well — this is a rendering of the row, not a replacement for it.
 */
const serialise = (row: DeviceActionRow) => ({
  ...row,
  previousValue: describePreviousValue(row),
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
 * `action` and `actionGroup` are two ways to say the same thing, and combining
 * them can only NARROW to whichever single action is in both — a caller who
 * sends both almost certainly expects the union. Refused rather than intersected.
 */
const ACTION_CONFLICT =
  "`action` and `actionGroup` cannot be combined. They are two ways to name the same column, " +
  "and ANDing them narrows to the overlap rather than the union you probably want. Use " +
  "`actionGroup=brightness` for every brightness change, or `action=` for exactly one writer.";

/**
 * Turn the validated query into repository filters. One function, used by BOTH
 * endpoints, so `actionGroup` and `q` cannot expand differently on the two sides
 * — the expansion is the sort of thing that drifts silently and shows up as
 * counts that disagree with the list printed beside them.
 */
function toFilters(f: z.infer<typeof ListQuery> | z.infer<typeof CountQuery>): CountFilters {
  return {
    deviceId: f.deviceId,
    actor: f.actor,
    outcome: f.outcome,
    action: f.action,
    actions: f.actionGroup ? [...AUDIT_ACTION_GROUPS[f.actionGroup]!] : undefined,
    search: f.q === undefined ? undefined : auditSearchPattern(f.q),
    since: f.since,
    until: f.until,
  };
}

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
  if (filters.actions) where.push(`l.action = ANY(${bind(filters.actions)}::text[])`);
  if (filters.search) {
    const pattern = bind(filters.search);
    where.push(
      `(l.device_id ILIKE ${pattern} OR d.name ILIKE ${pattern} ` +
        `OR d.group_name ILIKE ${pattern} OR d.location ILIKE ${pattern} ` +
        `OR l.actor ILIKE ${pattern})`,
    );
  }
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
    // The LEFT JOIN is unconditional and matches the list query's: `q` reaches
    // into `devices`, and joining that table on its primary key can neither add
    // nor drop a row, so these counts describe the same rows with or without a
    // search. Conditionally joining would be two shapes of query to keep in
    // agreement with the list instead of one.
    `SELECT l.outcome, l.action, count(*)::text AS n,
            MIN(l.started_at) AS oldest, MAX(l.started_at) AS newest
       FROM device_action_log l
       LEFT JOIN devices d ON d.id = l.device_id
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
    if (f.action && f.actionGroup) {
      return reply.code(400).send({ error: "bad_request", message: ACTION_CONFLICT });
    }

    const filters = toFilters(f);
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
          actionGroup: f.actionGroup ?? null,
          /** The expansion, not just the group name: the caller sees what was counted. */
          actions: f.actionGroup ? [...AUDIT_ACTION_GROUPS[f.actionGroup]!] : null,
          q: f.q ?? null,
          since: f.since?.toISOString() ?? null,
          until: f.until?.toISOString() ?? null,
        },
        /** What `q` covered, so an empty result is not read as "nothing happened". */
        searchScope: {
          query: f.q ?? null,
          fields: [...AUDIT_SEARCH_FIELDS],
          note: AUDIT_SEARCH_NOTE,
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
          /**
           * The breakdown stays per ACTION even under a group filter, so a
           * `brightness` total is visibly the sum of its two writers rather than
           * a number whose composition you have to take on trust.
           */
          groups: AUDIT_ACTION_GROUPS,
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
    if (f.action && f.actionGroup) {
      return reply.code(400).send({ error: "bad_request", message: ACTION_CONFLICT });
    }

    const [result, freshness] = await Promise.all([
      // Same `toFilters` the counts endpoint uses: one expansion of `actionGroup`
      // and one of `q`, so the two answers cannot describe different sets.
      ctx.repo.listDeviceActions({ ...toFilters(f), page: f.page, limit: f.limit }),
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
         * What a `q` covered and what an `actionGroup` expanded to, echoed for
         * the same reason the counts echo their filters: an empty result under a
         * search must be readable as "nothing matched THESE fields", never as
         * "nothing happened to that screen".
         */
        searchScope: {
          query: f.q ?? null,
          fields: [...AUDIT_SEARCH_FIELDS],
          note: AUDIT_SEARCH_NOTE,
        },
        actionScope: {
          action: f.action ?? null,
          group: f.actionGroup ?? null,
          actions: f.actionGroup ? [...AUDIT_ACTION_GROUPS[f.actionGroup]!] : null,
          groups: AUDIT_ACTION_GROUPS,
          note:
            "A brightness change is written under one of two actions — `brightness_write` from " +
            "the single-device slider, `bulk_brightness_write` from a batch push — so " +
            "`actionGroup=brightness` matches both in one call. Filtering `action=` to one of " +
            "them shows exactly that writer and silently omits the other.",
        },
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
