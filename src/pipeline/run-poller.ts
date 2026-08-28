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
import type { PollerResult } from "./pollers/types.js";

const args = process.argv.slice(2);
const once = args.includes("--once");
const dryRun = args.includes("--dry-run");

const log = (message: string) => console.log(message);

const repo = new Repository(pool);
const http = new VideriHttp(new VideriAuth());
const canvas = new CanvasService(http);

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
            runOnStart: false,
            handler: async () => record(await pollDataUsage(http, repo, await targets(), { log })),
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
