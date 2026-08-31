/**
 * Schedule slow-lane — run ONE batch by hand.
 *
 *   npm run build
 *   node --env-file=.env dist/pipeline/run-schedule-slowlane.js [batchSize] [concurrency]
 *
 * Reads the platform SCHEDULE (publisher v1 events, per canvas, for today) from
 * the next batch of devices whose persisted schedule is stalest or absent,
 * computes the "scheduled now" snapshot, persists each into `device_schedule`,
 * and prints an honest per-run summary. Selection rotates, so running it
 * repeatedly sweeps the WHOLE fleet — not just the online estate: a canvas has a
 * platform schedule whether or not it is reachable right now, and the publisher
 * events endpoint is a control-plane read, not a device command.
 *
 * This is DELIBERATELY not wired into the poller daemon (see run-poller.ts). It
 * is a slow lane — one publisher call per device — and enabling it fleet-wide is
 * a cadence/cost decision, not a default. Run it here first to see coverage on
 * real data before committing to a schedule.
 *
 * GET reads only — one `GET /publisher/api/v1/canvases/{id}/events/{date}` per
 * device; the only writes are the schedule rows saved to our own database.
 */

import { pool, closePool } from "../db/pool.js";
import { Repository } from "../db/repository.js";
import { VideriAuth } from "../videri/auth.js";
import { VideriHttp } from "../videri/http.js";
import { normalizeEvents } from "../intelligence/proof-of-play.js";
import {
  pollScheduleSlowLane,
  type ScheduleReader,
} from "./pollers/schedule-slowlane.js";

const batchSize = Number(process.argv[2] ?? 20);
const concurrency = Number(process.argv[3] ?? 8);

const repo = new Repository(pool);
const http = new VideriHttp(new VideriAuth());

/**
 * Read + normalise one canvas's events for `date`. Same publisher shape the
 * proof-of-play route reads live; `normalizeEvents` is the one place that knows
 * the envelope. Rejecting = "we could not read this canvas at all".
 */
const readSchedule: ScheduleReader = async (t, date) => {
  const raw = await http.request<unknown>(
    "publisher",
    `/api/v1/canvases/${encodeURIComponent(t.id)}/events/${date}`,
  );
  return normalizeEvents(raw);
};

const log = (message: string) => console.log(message);

try {
  const targets = await repo.scheduleSlowLaneTargets(batchSize);
  console.log(
    `Schedule slow lane — ${targets.length} device(s) selected ` +
      `(batch ${batchSize}, concurrency ${concurrency}), stalest schedule first.\n`,
  );

  if (targets.length === 0) {
    console.log("Nothing to read — no devices in the table. Run the discovery poller first.");
  } else {
    const result = await pollScheduleSlowLane(repo, targets, readSchedule, { concurrency, log });

    const yieldPct = result.telemetryYield === null ? "n/a" : `${(result.telemetryYield * 100).toFixed(0)}%`;
    console.log(
      `\n[schedule-slowlane] ${result.durationMs}ms · ${result.devicesTargeted} device(s) · ` +
        `${result.rowsWritten} row(s) · ${result.batchesOk} read / ${result.batchesFailed} unreadable · ` +
        `yield ${yieldPct}`,
    );
    for (const error of result.errors) console.warn(`  ! ${error}`);

    // Record it like any other poller run, so the run history reflects it when
    // it is run by hand. Non-fatal if the table/method is unavailable.
    await repo.recordPollerRun(result).catch((e) =>
      console.warn(`  ! could not record run: ${(e as Error).message}`),
    );
  }
} finally {
  await closePool();
}
