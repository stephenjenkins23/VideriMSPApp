/**
 * Data freshness.
 *
 * We poll; Videri has XMPP straight to the device. There is a latency floor we
 * cannot go below, so the honest response is to always tell the client how old
 * the data is rather than pretend it is live (see docs/03-BUILD-STRATEGY.md §3).
 *
 * Every API response carries this envelope, and the dashboard is expected to
 * surface it. A dashboard that silently shows 40-minute-old telemetry as current
 * is worse than one that says "last updated 40 minutes ago" — the operator makes
 * a different decision in each case.
 */

import type { Pool } from "pg";

export type FreshnessState = "fresh" | "lagging" | "stale" | "unknown";

export interface Freshness {
  /** Most recent sample we hold, whatever its source. */
  newestSampleAt: string | null;
  /** Age of that sample in seconds. */
  ageSeconds: number | null;
  state: FreshnessState;
  /** Per-poller last successful completion. */
  pollers: Array<{
    poller: string;
    lastRunAt: string | null;
    lastDurationMs: number | null;
    batchesFailed: number | null;
    /** Share of devices where an undocumented metric resolved, if applicable. */
    telemetryYield: number | null;
  }>;
  /** Populated when something is wrong enough that the UI should say so. */
  warnings: string[];
}

/**
 * Thresholds are generous relative to the 120-second status interval (sized
 * from the measured device push cadence — see docs/11) — a single missed tick
 * is normal operation, not a fault worth flagging to an operator.
 */
const LAGGING_AFTER_SECONDS = 5 * 60;
const STALE_AFTER_SECONDS = 20 * 60;

/**
 * Failed-batch warnings are only relevant for pollers that ran recently. The
 * `data-usage` poller is disabled by default, and its one manual run (250
 * known-403 failures) kept resurfacing as "on its last run" for DAYS — a stale
 * fact about a dormant poller presented as a current fault. A warning must
 * carry its age or not appear at all.
 */
const WARN_ABOUT_RUNS_WITHIN_SECONDS = 24 * 3600;

export async function getFreshness(pool: Pool): Promise<Freshness> {
  const [sampleResult, pollerResult] = await Promise.all([
    pool.query<{ newest: Date | null }>(
      `SELECT MAX(observed_at) AS newest FROM health_samples`,
    ),
    pool.query<{
      poller: string;
      started_at: Date;
      duration_ms: number;
      batches_failed: number;
      telemetry_yield: number | null;
    }>(
      `SELECT DISTINCT ON (poller)
              poller, started_at, duration_ms, batches_failed, telemetry_yield
         FROM poller_runs
        ORDER BY poller, started_at DESC`,
    ),
  ]);

  const newest = sampleResult.rows[0]?.newest ?? null;
  const ageSeconds = newest ? Math.max(0, (Date.now() - newest.getTime()) / 1000) : null;

  const state: FreshnessState =
    ageSeconds === null
      ? "unknown"
      : ageSeconds > STALE_AFTER_SECONDS
        ? "stale"
        : ageSeconds > LAGGING_AFTER_SECONDS
          ? "lagging"
          : "fresh";

  const warnings: string[] = [];
  if (state === "unknown") {
    warnings.push(
      "No telemetry has been collected yet. The poller has either never run or has never succeeded.",
    );
  } else if (state === "stale") {
    warnings.push(
      `Newest reading is ${Math.round(ageSeconds! / 60)} minutes old. Treat everything on this page as historical.`,
    );
  } else if (state === "lagging") {
    warnings.push(`Newest reading is ${Math.round(ageSeconds! / 60)} minutes old.`);
  }

  const pollers = pollerResult.rows.map((row) => ({
    poller: row.poller,
    lastRunAt: row.started_at.toISOString(),
    lastDurationMs: row.duration_ms,
    batchesFailed: row.batches_failed,
    telemetryYield: row.telemetry_yield,
  }));

  const metrics = pollers.find((p) => p.poller === "metrics");
  if (metrics?.telemetryYield === 0) {
    warnings.push(
      "The batch metrics feed carries no hardware telemetry — CPU, memory and " +
        "signal are absent from the platform's bulk payload, so fleet-wide metric " +
        "tiles are empty. This is the shape of the bulk feed, not a fault: those " +
        "values ARE readable per-device on demand — open any device to see live " +
        "CPU, memory, storage and signal read straight from it.",
    );
  }

  const now = Date.now();
  for (const poller of pollers) {
    if ((poller.batchesFailed ?? 0) === 0) continue;
    const runAgeSeconds = poller.lastRunAt
      ? (now - new Date(poller.lastRunAt).getTime()) / 1000
      : Number.POSITIVE_INFINITY;
    if (runAgeSeconds > WARN_ABOUT_RUNS_WITHIN_SECONDS) continue;
    const ageLabel =
      runAgeSeconds < 120 ? "just now" : `${Math.round(runAgeSeconds / 60)} min ago`;
    warnings.push(
      `The ${poller.poller} poller had ${poller.batchesFailed} failed batch(es) ` +
        `on its last run (${ageLabel}).`,
    );
  }

  return { newestSampleAt: newest?.toISOString() ?? null, ageSeconds, state, pollers, warnings };
}

/** Standard response envelope. Every endpoint returns this shape. */
export interface Envelope<T> {
  data: T;
  meta: {
    freshness: Freshness;
    /** Present on paginated collections. */
    page?: { page: number; limit: number; totalItems: number; totalPages: number };
  };
}

export const envelope = <T>(
  data: T,
  freshness: Freshness,
  page?: Envelope<T>["meta"]["page"],
): Envelope<T> => ({ data, meta: { freshness, ...(page ? { page } : {}) } });
