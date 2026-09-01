/**
 * Telemetry slow-lane — run ONE batch by hand.
 *
 *   npm run build
 *   node --env-file=.env dist/pipeline/run-telemetry-slowlane.js [batchSize] [concurrency]
 *
 * Reads runtime telemetry (CPU / memory / signal / NTP / storage) from the next
 * batch of online devices whose reading is stalest or absent, persists each into
 * `device_telemetry`, and prints an honest per-run summary. Selection rotates,
 * so running it repeatedly sweeps the online estate.
 *
 * This is DELIBERATELY not wired into the poller daemon (see run-poller.ts). It
 * is a slow lane — one batch is a few dozen serial device commands — and enabling
 * it fleet-wide is a cadence/cost decision, not a default. Run it here first to
 * see the yield on real hardware before committing to a schedule.
 *
 * It issues only read-style demo_command verbs and writes nothing to any device;
 * the only writes are the telemetry rows it saves to our own database.
 */

import { pool, closePool } from "../db/pool.js";
import { Repository } from "../db/repository.js";
import { VideriAuth } from "../videri/auth.js";
import { VideriHttp } from "../videri/http.js";
import type { TelemetryRunner } from "../videri/telemetry.js";
import {
  pollTelemetrySlowLane,
  type TelemetrySlowLaneTarget,
} from "./pollers/telemetry-slowlane.js";

const batchSize = Number(process.argv[2] ?? 10);
const concurrency = Number(process.argv[3] ?? 4);

const repo = new Repository(pool);
const http = new VideriHttp(new VideriAuth());

/** Bind a TelemetryRunner to one device — the same shape the drawer route uses. */
const makeRunner = (t: TelemetrySlowLaneTarget): TelemetryRunner => async (arg) => {
  const r = await http.request<{
    response_code?: string;
    message?: string;
    responses?: Array<{ params?: { response_code?: string } }>;
        others?: unknown;
  }>("messaging", "/messaging/sync_command", {
    method: "POST",
    body: {
      device_id: t.deviceId,
      device_jid: t.deviceJid,
      player_id: t.playerId ?? t.deviceId,
      command_name: "demo_command",
      command_params: { arg },
      message_id: crypto.randomUUID(),
    },
  });
  const code = r.response_code ?? r.responses?.[0]?.params?.response_code ?? "UNKNOWN";
  return { code, message: r.message ?? "", others: r.others };
};

const log = (message: string) => console.log(message);

try {
  const targets = await repo.telemetrySlowLaneTargets(batchSize);
  console.log(
    `Telemetry slow lane — ${targets.length} online device(s) selected ` +
      `(batch ${batchSize}, concurrency ${concurrency}), stalest telemetry first.\n`,
  );

  if (targets.length === 0) {
    console.log(
      "Nothing to read. Either no device is online in the last 30 minutes, or none\n" +
        "has an XMPP JID recorded. Run the status poller first so presence is fresh.",
    );
  } else {
    const result = await pollTelemetrySlowLane(repo, targets, makeRunner, { concurrency, log });

    const yieldPct = result.telemetryYield === null ? "n/a" : `${(result.telemetryYield * 100).toFixed(0)}%`;
    console.log(
      `\n[telemetry-slowlane] ${result.durationMs}ms · ${result.devicesTargeted} device(s) · ` +
        `${result.rowsWritten} row(s) · ${result.batchesOk} read / ${result.batchesFailed} unreachable · ` +
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
