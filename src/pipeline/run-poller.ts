/**
 * Poller entry point.
 *
 *   npm run poll                # long-running daemon
 *   npm run poll -- --once      # single pass of every poller, then exit
 *   npm run poll -- --dry-run   # discover devices only; no telemetry writes
 *
 * `--once` is the mode to use from cron or a container that should exit; the
 * daemon mode is for a long-lived process.
 *
 * Ordering matters: device discovery must complete before the telemetry pollers
 * run, because they poll whatever is in the devices table. In daemon mode the
 * intervals differ enough that this settles itself after the first pass.
 */

import { config } from "../config.js";
import { pool, closePool } from "../db/pool.js";
import { Repository } from "../db/repository.js";
import { VideriAuth } from "../videri/auth.js";
import { VideriHttp } from "../videri/http.js";
import { CanvasService } from "../videri/services/canvas.js";
import { Scheduler, type Task } from "./scheduler.js";
import { pollDevices } from "./pollers/devices.js";
import { pollStatus } from "./pollers/status.js";
import { pollMetrics } from "./pollers/metrics.js";
import { pollDataUsage } from "./pollers/data-usage.js";
import { computeFleetSnapshot } from "./snapshot.js";
import { runAlerting, seedRules, toPollerRun } from "../alerting/engine.js";
import { crossCheckVideriAlerts, renderCrossCheck } from "../alerting/videri-cross-check.js";
import { pollDeviceSettings } from "../compliance/settings-poller.js";
import { runCompliance, seedTemplates, toPollerRun as complianceRun } from "../compliance/engine.js";
import { pollTelemetrySlowLane, type TelemetrySlowLaneTarget } from "./pollers/telemetry-slowlane.js";
import {
  pollScheduleSlowLane,
  type ScheduleReader,
} from "./pollers/schedule-slowlane.js";
import {
  pollScreenVerifySlowLane,
  type ScreenVerifyTarget,
} from "./pollers/screen-verify-slowlane.js";
import { normalizeEvents } from "../intelligence/proof-of-play.js";
import { aiJobTasks } from "../ai/scheduled.js";
import type { TelemetryRunner } from "../videri/telemetry.js";
import type { PollerResult } from "./pollers/types.js";

const args = process.argv.slice(2);
const once = args.includes("--once");
const dryRun = args.includes("--dry-run");

const log = (message: string) => console.log(message);

const repo = new Repository(pool);
const http = new VideriHttp(new VideriAuth());
const canvas = new CanvasService(http);

/** Bind a TelemetryRunner to one device — identical to the drawer route and the
 *  standalone run-telemetry-slowlane entrypoint, so all three issue the same
 *  read-only demo_command sync_command. */
const makeTelemetryRunner = (t: TelemetrySlowLaneTarget): TelemetryRunner => async (arg) => {
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

/** Bind a TelemetryRunner to one screen-verify target — same read-only
 *  demo_command sync_command as the telemetry lane and the screen-check route.
 *  Separate factory only because the target shape differs. */
const makeScreenRunner = (t: ScreenVerifyTarget): TelemetryRunner => async (arg) => {
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

/** Read + normalise one canvas's publisher events — the same shape the
 *  proof-of-play route and the standalone run-schedule-slowlane entrypoint read.
 *  GET only; `normalizeEvents` is the one place that knows the envelope. */
const readSchedule: ScheduleReader = async (t, date) => {
  const raw = await http.request<unknown>(
    "publisher",
    `/api/v1/canvases/${encodeURIComponent(t.id)}/events/${date}`,
  );
  return normalizeEvents(raw);
};

/** Records every run and surfaces failures without letting them escape. */
async function record(result: PollerResult): Promise<void> {
  try {
    await repo.recordPollerRun(result);
  } catch (error) {
    console.error(`[poller] could not record run for ${result.poller}: ${(error as Error).message}`);
  }

  const summary =
    `[${result.poller}] ${result.durationMs}ms · ${result.devicesTargeted} device(s) · ` +
    `${result.rowsWritten} row(s) · batches ${result.batchesOk} ok / ${result.batchesFailed} failed` +
    (result.telemetryYield !== null ? ` · yield ${(result.telemetryYield * 100).toFixed(0)}%` : "");
  console.log(summary);
  for (const error of result.errors) console.warn(`  ! ${error}`);
}

const targets = () => repo.listPollTargets();

const tasks: Task[] = [
  {
    name: "devices",
    intervalMs: 15 * 60_000,
    handler: async () => record(await pollDevices(canvas, repo, log)),
  },
];

if (!dryRun) {
  tasks.push(
    {
      name: "status",
      intervalMs: config.POLL_STATUS_INTERVAL_MS,
      handler: async () =>
        record(
          await pollStatus(canvas, repo, await targets(), {
            batchSize: config.POLL_DEVICE_BATCH_SIZE,
            log,
          }),
        ),
    },
    {
      name: "metrics",
      intervalMs: config.POLL_METRICS_INTERVAL_MS,
      handler: async () =>
        record(
          await pollMetrics(canvas, repo, await targets(), {
            batchSize: config.POLL_DEVICE_BATCH_SIZE,
            log,
          }),
        ),
    },
    // data-usage is now ENABLED by default.
    //
    // It was disabled on a finding that turned out to be our own bug: we sent
    // `x-tenant_id` to canvas-status, which that endpoint ignores, and the
    // resulting "no tenant context" 403 was read as a permissions denial. With
    // `x-tenant` it returns 200 for every device tested — 26 of 26, online and
    // offline alike — with 30 days of daily tx/rx.
    //
    // Daily cadence: the aggregation is per-day, so polling more often than
    // once a day cannot produce a new row.
    ...(process.env["ENABLE_DATA_USAGE_POLL"] !== "false"
      ? [
          {
            name: "data-usage",
            intervalMs: 24 * 60 * 60_000,
            // runOnStart is TRUE, with a last-run gate inside the handler.
            //
            // It was false, which combined with a 24h interval meant the lane
            // never fired at all if the daemon restarted inside 24h — and we
            // restart it often. The pipeline-health check caught this: 48.8h
            // since the last run against a 24.3h cadence, with only 2 runs in
            // the whole 14-day retention window.
            //
            // Simply flipping runOnStart would re-poll 249 devices on every
            // restart, so the handler asks poller_runs when it last succeeded
            // and skips if that was recent. Cheap, and it uses the history the
            // self-observability work already exposes.
            runOnStart: true,
            handler: async () => {
              const MIN_GAP_MS = 20 * 60 * 60_000;
              const history = await repo.pollerRunHistory({ lookbackHours: 48, runsPerLane: 1 });
              const last = history.find((r) => r.poller === "data-usage");
              if (last) {
                const ageMs = Date.now() - new Date(last.startedAt).getTime();
                if (ageMs < MIN_GAP_MS) {
                  console.log(
                    `[data-usage] skipped — last run ${Math.round(ageMs / 3_600_000)}h ago; ` +
                      `the aggregation is per-day, so a second run cannot produce a new row`,
                  );
                  return;
                }
              }
              record(await pollDataUsage(http, repo, await targets(), { log }));
            },
          } satisfies Task,
        ]
      : []),
    {
      name: "alerting",
      // Slightly offset from the metrics interval so evaluation usually sees a
      // freshly written sample rather than racing the poller that produces it.
      intervalMs: config.POLL_METRICS_INTERVAL_MS + 30_000,
      runOnStart: false,
      handler: async () => {
        const result = await runAlerting(repo, { log });
        await record(toPollerRun(result));
      },
    },
    {
      name: "alert-cross-check",
      intervalMs: 60 * 60_000,
      runOnStart: false,
      handler: async () => {
        const result = await crossCheckVideriAlerts(http, pool);
        console.log(renderCrossCheck(result));
      },
    },
    {
      // SLOW LANE. ops_get_settings is one synchronous command per device with a
      // ~10s timeout and no batch read, so this is hourly and online-only —
      // polling an offline device burns the full timeout to learn nothing.
      // Requires ENABLE_SETTINGS_POLL: it issues device commands, which is a
      // heavier action than the read-only pollers and should be opt-in.
      name: "device-settings",
      intervalMs: 60 * 60_000,
      runOnStart: false,
      handler: async () => {
        if (process.env["ENABLE_SETTINGS_POLL"] !== "true") {
          console.log("[device-settings] skipped — set ENABLE_SETTINGS_POLL=true to enable");
          return;
        }
        const targets = await repo.listSettingsTargets(true);
        record(await pollDeviceSettings(http, repo, targets, { log }));
      },
    },
    {
      // SLOW LANE. Runtime telemetry (CPU/RAM/storage/signal/NTP) exists only as
      // per-device demo_command reads — ~6 synchronous commands per device, no
      // batch feed — so this rotates a small batch of the stalest online devices
      // each tick (batch 10 → a ~70-online estate sweeps roughly every 2h) and
      // persists what it reads into device_telemetry. Like device-settings it
      // issues device commands, so it is opt-in behind ENABLE_TELEMETRY_SLOWLANE.
      // Reads only — it writes nothing to any device.
      name: "telemetry-slowlane",
      intervalMs: 15 * 60_000,
      runOnStart: false,
      handler: async () => {
        if (process.env["ENABLE_TELEMETRY_SLOWLANE"] !== "true") {
          console.log("[telemetry-slowlane] skipped — set ENABLE_TELEMETRY_SLOWLANE=true to enable");
          return;
        }
        const targets = await repo.telemetrySlowLaneTargets(10);
        record(await pollTelemetrySlowLane(repo, targets, makeTelemetryRunner, { concurrency: 4, log }));
      },
    },
    {
      // SLOW LANE. The platform SCHEDULE is per-canvas — one publisher v1 events
      // GET per device — so this rotates a batch of the stalest-persisted devices
      // each tick, computes "scheduled now", and persists it into device_schedule
      // so proof-of-play gap detection can run FLEET-WIDE from stored rows instead
      // of live-sampling a bounded batch on every request (US-4.5). Unlike the
      // telemetry lane it is NOT online-only — a canvas has a schedule whether or
      // not it is reachable, and the events endpoint is a control-plane read, not
      // a device command. Opt-in behind ENABLE_SCHEDULE_SLOWLANE; ~30m so a
      // several-hundred-device fleet sweeps in a handful of hours. GET reads only.
      name: "schedule-slowlane",
      intervalMs: 30 * 60_000,
      runOnStart: false,
      handler: async () => {
        if (process.env["ENABLE_SCHEDULE_SLOWLANE"] !== "true") {
          console.log("[schedule-slowlane] skipped — set ENABLE_SCHEDULE_SLOWLANE=true to enable");
          return;
        }
        const targets = await repo.scheduleSlowLaneTargets(20);
        record(await pollScheduleSlowLane(repo, targets, readSchedule, { concurrency: 8, log }));
      },
    },
    {
      // SLOW LANE. Asks the panels the alerting engine is about to raise a
      // CRITICAL over whether they are actually black, and persists the verdict
      // for the engine to READ — the engine never commands a device itself.
      //
      // Deliberately the smallest lane here. `screenVerifyTargets` selects only
      // devices online RIGHT NOW whose newest readable flag claims black, which
      // on 2026-09-01 was 1 of the 9 flagged devices; an unanswered verb costs
      // ~11s of timeout, so a wider net buys silence. Batch 5 / concurrency 2
      // means a worst case of roughly one minute.
      //
      // Opt-in behind ENABLE_SCREEN_VERIFY and left OFF: it issues device
      // commands, and cadence against a live fleet is a human's call. Reads only
      // — is_blackscreen and is_showing_logo change nothing on the device.
      name: "screen-verify-slowlane",
      intervalMs: 15 * 60_000,
      runOnStart: false,
      handler: async () => {
        if (process.env["ENABLE_SCREEN_VERIFY"] !== "true") {
          console.log("[screen-verify-slowlane] skipped — set ENABLE_SCREEN_VERIFY=true to enable");
          return;
        }
        const targets = await repo.screenVerifyTargets(5);
        record(
          await pollScreenVerifySlowLane(repo, targets, makeScreenRunner, {
            concurrency: 2,
            log,
          }),
        );
      },
    },
    // The two AI artifacts (brief + action plan). Scheduled here because run-by-
    // hand is how they drifted: a plan is only true about the fleet it was
    // generated from, and one that outlives a fix contradicts the engine that
    // made it. Both are gated behind ENABLE_AI_JOBS and left OFF — every tick is
    // a paid Claude call — and both call the SAME core the npm scripts do
    // (src/ai/jobs.ts), so there is no second prompt or persistence path.
    ...aiJobTasks(pool, { record, log }),
    {
      // Evaluation is pure and cheap, so it runs regardless of whether the
      // settings poll is enabled — it simply reports how many devices lack
      // cached settings rather than scoring them as failures.
      name: "compliance",
      intervalMs: 15 * 60_000,
      runOnStart: false,
      handler: async () => record(complianceRun(await runCompliance(repo, { log }))),
    },
    {
      name: "snapshot",
      intervalMs: 5 * 60_000,
      runOnStart: false,
      handler: async () => {
        const snapshot = await computeFleetSnapshot(pool, repo);
        console.log(
          `[snapshot] ${snapshot.totalDevices} device(s) · coverage ` +
            `${(snapshot.telemetryCoverage * 100).toFixed(1)}% · ` +
            `${snapshot.firmwareDistribution.length} firmware version(s)`,
        );
      },
    },
    {
      name: "retention",
      intervalMs: 24 * 60 * 60_000,
      runOnStart: false,
      handler: async () => {
        const deleted = await repo.pruneTimeSeries({});
        const parts = Object.entries(deleted).filter(([, n]) => n > 0)
          .map(([k, n]) => `${k}=${n}`);
        console.log(`[retention] ${parts.length ? parts.join(" ") : "nothing to prune"}`);
      },
    },
    {
      name: "prune-raw",
      intervalMs: 24 * 60 * 60_000,
      runOnStart: false,
      handler: async () => {
        const deleted = await repo.pruneRawPayloads(14);
        if (deleted > 0) console.log(`[prune-raw] removed ${deleted} payload(s) older than 14 days`);
      },
    },
  );
}

const scheduler = new Scheduler(tasks, {
  info: (m) => console.log(`[scheduler] ${m}`),
  warn: (m) => console.warn(`[scheduler] ${m}`),
  error: (m) => console.error(`[scheduler] ${m}`),
});

console.log(
  `VFI poller starting — mode=${once ? "once" : "daemon"}${dryRun ? " (dry run: discovery only)" : ""}\n` +
    `  api=${config.VIDERI_API_BASE} tenant=${config.VIDERI_TENANT}\n` +
    `  status every ${config.POLL_STATUS_INTERVAL_MS / 1000}s · ` +
    `metrics every ${config.POLL_METRICS_INTERVAL_MS / 1000}s · ` +
    `batch size ${config.POLL_DEVICE_BATCH_SIZE}\n`,
);

try {
  // Seeds DEFAULT_RULES on first run only; operator tuning in the table wins
  // afterwards, so a deploy never reverts someone's thresholds.
  if (!dryRun) {
    const seeded = await seedRules(repo);
    if (seeded > 0) console.log(`[alerting] seeded ${seeded} default rule(s)`);
    const templates = await seedTemplates(repo);
    if (templates > 0) console.log(`[compliance] seeded ${templates} template(s)`);
    console.log("");
  }

  if (once) {
    await scheduler.runOnce();
  } else {
    scheduler.start();
    await scheduler.handleSignals();
  }
} finally {
  await scheduler.stop();
  await closePool();
}
