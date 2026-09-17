/**
 * The two prune lanes — `retention` and `prune-raw` — extracted so that what
 * they RECORD is testable.
 *
 * WHY THIS EXISTS
 * Both lanes ran nightly and left no trace anywhere. They DELETE rows, so a
 * successful prune and a prune that never happened were identical in the
 * database, and the lane registry had to declare them `observability: "none"`.
 * `pipeline-health.ts` then reported them UNKNOWN with that reason — honest, and
 * useless: nobody could answer "did the prune run last night?" at all.
 *
 * Note what that is NOT evidence of. Zero `poller_runs` rows for a lane that
 * never calls `record()` is evidence WE CANNOT TELL, not evidence the lane never
 * ran. Reading it the other way is how a previous claim that a lane "has never
 * run once" got made from the same zero. So this module does not add a
 * judgement; it adds the record that makes a judgement possible.
 *
 * WHY IT LIVES IN ITS OWN MODULE
 * Same reason as `pipeline/lanes/data-usage.ts`: `run-poller.ts` exports nothing
 * and, at import time, opens a real pool and starts a scheduler — an inline
 * handler there is untestable by construction. The deps are plain functions, not
 * a Repository, so nothing here does IO or needs a database to test.
 *
 * WHAT IT DELIBERATELY DOES NOT CHANGE
 * Nothing about WHAT is deleted, from which table, or with which window. That
 * all stays in `Repository.pruneTimeSeries` / `pruneRawPayloads` and is pinned
 * by `retention.test.ts`. This module only observes.
 *
 * HOW THE poller_runs FIELDS ARE FILLED, AND WHY
 * These lanes are not device pollers and their run row must not pretend to be
 * one:
 *
 *   devicesTargeted — 0 BY NATURE, not by failure. A prune targets TABLES; it
 *     touches no device, and it must never delete a device row (standing rule:
 *     device rows are retired, soft and reversible, never hard-deleted). The
 *     column is a NOT NULL integer, so the honest-null this project prefers is
 *     not available; the zero's meaning is carried in the run's `errors` note
 *     and in this comment instead.
 *   rowsWritten — rows DELETED. There is no rows_deleted column, and for a lane
 *     whose entire output is deletion, the rows it removed are the volume every
 *     consumer means by "what did this run do". One meaning, both lanes:
 *     retention sums its six table counts, prune-raw reports its single one.
 *   batchesOk — table prunes that COMPLETED (6 for retention, 1 for prune-raw).
 *     This is the field that separates the two kinds of zero, which is the whole
 *     point: `batchesOk > 0` with `rowsWritten === 0` means "checked, nothing was
 *     old enough"; `batchesOk === 0` means "we could not look".
 *   batchesFailed — 1 when the prune threw. `pruneTimeSeries` is sequential and
 *     throws on the first failing statement, so a failure leaves no partial
 *     counts worth reporting. Kept at 0 on success because a recent non-zero
 *     raises an operator-facing warning in `api/freshness.ts`.
 *   telemetryYield — null. No meaning for a lane that reads no telemetry, and a
 *     0.0 there would read as "collected nothing", which is a different claim.
 */

import type { PollerResult } from "../pipeline/pollers/types.js";

/**
 * The lane names, as constants.
 *
 * Both the recorded `poller` value and the scheduler's task name come from
 * these, so a lane cannot record under its sibling's name. A previous retention
 * change in this project handed `run("poller_runs", …)` the `fleet_snapshots`
 * DELETE: the SQL worked, nothing errored, and the counts lied. The same swap
 * one level up — retention reporting prune-raw's count — would be just as quiet,
 * so the name is never written twice.
 */
export const RETENTION_POLLER = "retention";
export const PRUNE_RAW_POLLER = "prune-raw";

/** Per-table prune counts, as `Repository.pruneTimeSeries` returns them. */
export type PruneCounts = Record<string, number>;

export interface RetentionLaneDeps {
  /** `() => repo.pruneTimeSeries({})`. */
  prune: () => Promise<PruneCounts>;
  record: (result: PollerResult) => Promise<void>;
  log?: (message: string) => void;
  now?: () => number;
}

export interface PruneRawLaneDeps {
  /** `() => repo.pruneRawPayloads(PRUNE_RAW_RETAIN_DAYS)`. */
  prune: () => Promise<number>;
  record: (result: PollerResult) => Promise<void>;
  log?: (message: string) => void;
  now?: () => number;
}

/** Unchanged from the inline handler this replaced. */
export const PRUNE_RAW_RETAIN_DAYS = 14;

/**
 * What one prune attempt produced, before it becomes a run row.
 *
 * `counts === null` is the honest representation of "the prune did not complete,
 * so there are no counts" — distinct from a completed prune whose counts are all
 * zero. Every field of the run row follows from that distinction.
 */
export interface PruneOutcome<T> {
  startedAt: Date;
  durationMs: number;
  counts: T | null;
  error: string | null;
}

/** Pure: a completed-or-failed retention prune → the row we record. */
export function toRetentionRun(outcome: PruneOutcome<PruneCounts>): PollerResult {
  const counts = outcome.counts;
  const labels = counts ? Object.keys(counts) : [];
  const deleted = counts ? Object.values(counts).reduce((sum, n) => sum + n, 0) : 0;
  const breakdown = counts
    ? Object.entries(counts).filter(([, n]) => n > 0).map(([label, n]) => `${label}=${n}`)
    : [];

  return {
    poller: RETENTION_POLLER,
    startedAt: outcome.startedAt,
    durationMs: outcome.durationMs,
    // Zero by nature — see the field notes at the top of this file.
    devicesTargeted: 0,
    rowsWritten: deleted,
    batchesOk: labels.length,
    batchesFailed: outcome.error === null ? 0 : 1,
    telemetryYield: null,
    errors: outcome.error !== null
      ? [outcome.error]
      : [
          // `errors` is this project's note channel on a run row (see
          // `alerting/engine.ts` `toPollerRun`), and poller_runs is the only
          // per-cycle record we keep. Which tables a prune emptied — or that it
          // checked every window and found nothing — exists nowhere else once
          // the rows are gone and stdout has rotated.
          breakdown.length > 0
            ? `pruned ${deleted} row(s) from ${breakdown.length} table(s): ${breakdown.join(" ")}`
            : `nothing to prune: all ${labels.length} retention window(s) checked and ` +
              `already clear — a measured zero, not a run we cannot account for`,
          "no device was targeted and no device row was deleted: this lane prunes " +
            "time-series tables only",
        ],
  };
}

/** Pure: a completed-or-failed raw-payload prune → the row we record. */
export function toPruneRawRun(outcome: PruneOutcome<number>): PollerResult {
  const deleted = outcome.counts ?? 0;
  return {
    poller: PRUNE_RAW_POLLER,
    startedAt: outcome.startedAt,
    durationMs: outcome.durationMs,
    devicesTargeted: 0,
    rowsWritten: deleted,
    // One statement, so one batch — and 0 is exactly "the DELETE did not run".
    batchesOk: outcome.counts === null ? 0 : 1,
    batchesFailed: outcome.error === null ? 0 : 1,
    telemetryYield: null,
    errors: outcome.error !== null
      ? [outcome.error]
      : [
          deleted > 0
            ? `pruned ${deleted} raw payload(s) older than ${PRUNE_RAW_RETAIN_DAYS} days`
            : `nothing to prune: raw_payloads checked and already clear of rows older ` +
              `than ${PRUNE_RAW_RETAIN_DAYS} days — a measured zero, not a run we ` +
              `cannot account for`,
        ],
  };
}

/**
 * Run one prune and capture its outcome without letting a failure escape.
 *
 * A thrown prune becomes `counts: null` plus an error string, because a lane
 * that failed must still record THAT it ran — the whole fault this closes is a
 * lane whose absence and whose failure look identical.
 */
async function attempt<T>(
  prune: () => Promise<T>,
  now: () => number,
): Promise<PruneOutcome<T>> {
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs);
  try {
    const counts = await prune();
    return { startedAt, durationMs: now() - startedAtMs, counts, error: null };
  } catch (error) {
    return {
      startedAt,
      durationMs: now() - startedAtMs,
      counts: null,
      error: `prune failed: ${(error as Error).message}`,
    };
  }
}

/**
 * Record the run, and never let bookkeeping break the work.
 *
 * `run-poller.ts`'s own `record()` already swallows its failures for this
 * reason; this second guard is here so the lane holds that property no matter
 * which `record` it is handed — including in tests, where a rejecting `record`
 * is exactly what we assert against.
 */
async function recordQuietly(
  record: (result: PollerResult) => Promise<void>,
  result: PollerResult,
): Promise<void> {
  try {
    await record(result);
  } catch (error) {
    console.error(
      `[${result.poller}] could not record run: ${(error as Error).message}`,
    );
  }
}

export async function runRetentionLane(deps: RetentionLaneDeps): Promise<PollerResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const outcome = await attempt(deps.prune, deps.now ?? Date.now);
  const result = toRetentionRun(outcome);

  // The existing log line, unchanged in shape: labels with a non-zero count, or
  // the explicit "nothing to prune".
  const parts = Object.entries(outcome.counts ?? {}).filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`);
  log(
    outcome.error !== null
      ? `[${RETENTION_POLLER}] ${outcome.error}`
      : `[${RETENTION_POLLER}] ${parts.length ? parts.join(" ") : "nothing to prune"}`,
  );

  await recordQuietly(deps.record, result);
  return result;
}

export async function runPruneRawLane(deps: PruneRawLaneDeps): Promise<PollerResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const outcome = await attempt(deps.prune, deps.now ?? Date.now);
  const result = toPruneRawRun(outcome);

  if (outcome.error !== null) log(`[${PRUNE_RAW_POLLER}] ${outcome.error}`);
  // Unchanged: a quiet night stays quiet in the log. The run row carries the
  // measured zero, which is where it belongs.
  else if (result.rowsWritten > 0) {
    log(
      `[${PRUNE_RAW_POLLER}] removed ${result.rowsWritten} payload(s) older than ` +
        `${PRUNE_RAW_RETAIN_DAYS} days`,
    );
  }

  await recordQuietly(deps.record, result);
  return result;
}
