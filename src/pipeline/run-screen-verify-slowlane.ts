/**
 * Screen-verification slow lane — run ONE batch by hand.
 *
 *   npm run build
 *   node --env-file=.env dist/pipeline/run-screen-verify-slowlane.js [batchSize] [concurrency]
 *
 * Asks every reachable panel that the platform currently flags `is_black_screen`
 * whether it is actually black, and persists the verdict into
 * `device_screen_verdict`, where the alerting engine reads it without ever
 * issuing a command of its own.
 *
 * EXPECT A SMALL BATCH. Measured 2026-09-01, 8 of the 9 devices flagged black
 * were offline, so a full run may legitimately target one device or none. That is
 * the honest result: the only claims worth a device command are the ones on
 * panels that can answer.
 *
 * Not wired into the poller daemon by default (see run-poller.ts, gated behind
 * ENABLE_SCREEN_VERIFY). Cadence is a cost decision — run it here first and look
 * at the yield on real hardware.
 *
 * Reads only: `is_blackscreen` and `is_showing_logo` report state and change
 * nothing on the device. The only writes are the verdict rows in our own database.
 */

import { pool, closePool } from "../db/pool.js";
import { Repository } from "../db/repository.js";
import { VideriAuth } from "../videri/auth.js";
import { VideriHttp } from "../videri/http.js";
import type { TelemetryRunner } from "../videri/telemetry.js";
import {
  pollScreenVerifySlowLane,
  type ScreenVerifyTarget,
} from "./pollers/screen-verify-slowlane.js";

const batchSize = Number(process.argv[2] ?? 10);
const concurrency = Number(process.argv[3] ?? 3);

const repo = new Repository(pool);
const http = new VideriHttp(new VideriAuth());

/** Bind a TelemetryRunner to one device — the same shape the screen-check route uses. */
const makeRunner = (t: ScreenVerifyTarget): TelemetryRunner => async (arg) => {
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
  const targets = await repo.screenVerifyTargets(batchSize);
  console.log(
    `Screen-verify slow lane — ${targets.length} target(s) selected (batch ${batchSize}, ` +
      `concurrency ${concurrency}): online right now AND currently flagged black, ` +
      `stalest verdict first.\n`,
  );
  for (const t of targets) {
    console.log(
      `  ${t.id} ${t.name ?? "(unnamed)"} — platform claimed black at ` +
        `${t.claimObservedAt.toISOString()}`,
    );
  }
  if (targets.length > 0) console.log("");

  if (targets.length === 0) {
    console.log(
      "Nothing to verify. Either no device is currently flagged is_black_screen, or\n" +
        "every device that is has its latest presence offline — in which case the\n" +
        "actionable fault is the outage, not the screen. Run the status poller first\n" +
        "so presence and the flag are both fresh.",
    );
  } else {
    const result = await pollScreenVerifySlowLane(repo, targets, makeRunner, {
      concurrency,
      log,
    });

    const yieldPct =
      result.telemetryYield === null ? "n/a" : `${(result.telemetryYield * 100).toFixed(0)}%`;
    console.log(
      `\n[screen-verify-slowlane] ${result.durationMs}ms · ${result.devicesTargeted} device(s) · ` +
        `${result.rowsWritten} row(s) · ${result.batchesOk} asked / ${result.batchesFailed} unreachable · ` +
        `answer yield ${yieldPct}`,
    );
    console.log(
      `  refuted ${result.totals.contradicted} · confirmed ${result.totals.confirmed} · ` +
        `unanswered ${result.totals.unanswered}`,
    );
    for (const error of result.errors) console.warn(`  ! ${error}`);

    // Record it like any other poller run, so the run history reflects a manual
    // batch too. Non-fatal if the table/method is unavailable.
    await repo.recordPollerRun(result).catch((e) =>
      console.warn(`  ! could not record run: ${(e as Error).message}`),
    );
  }
} finally {
  await closePool();
}
