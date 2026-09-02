/**
 * The data-usage lane, extracted so its gate is testable.
 *
 * History: the lane was `intervalMs: 24h` with `runOnStart: false`, which means
 * it NEVER fires if the daemon restarts inside 24h — and we restart often. It
 * managed 2 runs in a 14-day retention window, and our own pipeline-health check
 * is what caught it. Firing on start alone would re-poll 249 devices on every
 * restart, so the lane fires on start and then asks whether it needs to.
 *
 * Kept in its own module (mirroring `aiJobTasks` in src/ai/scheduled.ts) because
 * `run-poller.ts` exports nothing and builds a real Pool, auth client and
 * scheduler at import time — importing it from a test starts a daemon, so an
 * inline gate there is untestable by construction.
 */

import type { Task } from "../scheduler.js";
import type { PollerResult } from "../pollers/types.js";
import type { PollerRunHistoryRow } from "../../db/repository.js";

/**
 * How recently a SUCCESSFUL run suppresses another. Under a day, because the
 * aggregation is per-day and a second run inside the same day cannot produce a
 * new row; short of 24h so a restart-heavy day still gets one collection.
 */
export const DATA_USAGE_MIN_GAP_MS = 20 * 60 * 60_000;

export type DataUsageDisposition = "ran" | "skipped";

export interface DataUsageDeps {
  history: () => Promise<PollerRunHistoryRow[]>;
  poll: () => Promise<PollerResult>;
  record: (result: PollerResult) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * Did this run actually collect anything?
 *
 * The gate deliberately looks for a SUCCESSFUL run, not merely a recent one.
 * `record()` writes a poller_runs row even when every batch failed (the historical
 * 250x403 case wrote exactly such a row), so keying on recency alone let a total
 * failure suppress retries for 20 hours while logging that "a second run cannot
 * produce a new row" — when zero rows had been produced.
 */
const succeeded = (r: PollerRunHistoryRow): boolean => r.batchesOk > 0 && r.rowsWritten > 0;

/** Pure decision, exported so every branch is assertable without a pool. */
export function shouldSkipDataUsage(
  history: PollerRunHistoryRow[],
  nowMs: number,
  minGapMs: number = DATA_USAGE_MIN_GAP_MS,
): { skip: boolean; reason: string } {
  const last = history
    .filter((r) => r.poller === "data-usage" && succeeded(r))
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];
  if (!last) {
    return { skip: false, reason: "no successful run on record" };
  }
  const ageMs = nowMs - new Date(last.startedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    // A future timestamp is not evidence of a recent success. The metrics path
    // has already had to clamp absurd platform dates; refuse rather than trust.
    return { skip: false, reason: "last run has an unusable timestamp" };
  }
  if (ageMs < minGapMs) {
    return {
      skip: true,
      reason:
        `last successful run ${Math.round(ageMs / 3_600_000)}h ago; the aggregation ` +
        `is per-day, so a second run cannot produce a new row`,
    };
  }
  return { skip: false, reason: `last success ${Math.round(ageMs / 3_600_000)}h ago` };
}

export function dataUsageTask(deps: DataUsageDeps): Task {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((m: string) => console.log(m));
  return {
    name: "data-usage",
    intervalMs: 24 * 60 * 60_000,
    runOnStart: true,
    handler: async (): Promise<void> => {
      const decision = shouldSkipDataUsage(await deps.history(), now());
      if (decision.skip) {
        log(`[data-usage] skipped — ${decision.reason}`);
        return;
      }
      await deps.record(await deps.poll());
    },
  };
}
