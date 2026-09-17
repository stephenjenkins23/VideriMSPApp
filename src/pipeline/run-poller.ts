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
import {
  crossCheckVideriAlerts,
  renderCrossCheck,
  toPollerRun as crossCheckRun,
} from "../alerting/videri-cross-check.js";
import {
  runRetentionLane,
  runPruneRawLane,
  PRUNE_RAW_RETAIN_DAYS,
} from "../db/retention.js";
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
import { dataUsageTask } from "./lanes/data-usage.js";
import {
  assertSchedulerMatchesRegistry,
  laneDecl,
  laneIntervalMs,
  type LaneName,
} from "./lanes/registry.js";
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

/**
 * Records every run and surfaces failures without letting them escape.
 *
 * CALLERS MUST AWAIT THIS. Four gated lanes called it as a bare statement, so the
 * handler resolved before the poller_runs insert landed. Harmless in daemon mode,
 * but `--once` is the mode DEPLOY.md recommends for cron, and there closePool()
 * runs immediately after the pass — so the insert raced teardown and record()
 * swallowed the error. A lost run row is not cosmetic: pipeline-health reads
 * poller_runs, so a dropped record makes a lane that DID run look never-run or
 * stalled. It would have manufactured the exact fault the self-check exists to
 * report, and for the data-usage lane it would also have re-opened the 20h gate.
 */
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

/**
 * Build a scheduler task from its DECLARATION in `lanes/registry.ts`.
 *
 * Two things this buys, both of which were missing:
 *
 *  1. `lane` is typed `LaneName`, so adding a lane here without declaring it in
 *     the registry is a COMPILE ERROR. The health check derives its roster from
 *     the same registry, which is what makes "scheduled but invisible to health"
 *     impossible rather than merely discouraged. It was not discouraged enough:
 *     `snapshot`, `alert-cross-check`, `retention` and `prune-raw` all drifted
 *     out of the hand-written roster and could not be reported on at all.
 *  2. The interval comes from the registry too, so the cadence health measures
 *     coverage against is by construction the cadence we run.
 */
const laneTask = (lane: LaneName, spec: Omit<Task, "name" | "intervalMs">): Task => ({
  name: lane,
  intervalMs: laneIntervalMs(laneDecl(lane)!, process.env),
  ...spec,
});

const tasks: Task[] = [
  laneTask("devices", {
    handler: async () => record(await pollDevices(canvas, repo, log)),
  }),
];

if (!dryRun) {
  tasks.push(
    laneTask("status", {
      handler: async () =>
        record(
          await pollStatus(canvas, repo, await targets(), {
            batchSize: config.POLL_DEVICE_BATCH_SIZE,
            log,
          }),
        ),
    }),
    laneTask("metrics", {
      handler: async () =>
        record(
          await pollMetrics(canvas, repo, await targets(), {
            batchSize: config.POLL_DEVICE_BATCH_SIZE,
            log,
          }),
        ),
    }),
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
          dataUsageTask({
            history: () => repo.pollerRunHistory({ lookbackHours: 48, runsPerLane: 5 }),
            poll: async () => pollDataUsage(http, repo, await targets(), { log }),
            record,
          }),
        ]
      : []),
    // Slightly offset from the metrics interval (in the registry) so evaluation
    // usually sees a freshly written sample rather than racing the poller that
    // produces it.
    laneTask("alerting", {
      runOnStart: false,
      handler: async () => {
        const result = await runAlerting(repo, { log });
        await record(toPollerRun(result));
      },
    }),
    // Records a poller_runs row per cycle, like every other lane here. It used
    // to log and return, which left poller_runs with zero rows for it — and zero
    // rows for a lane that never records means WE CANNOT TELL whether it ran,
    // not that it never ran. The verdict itself is still not persisted as data
    // (that would be a table of its own); what the run row carries is that the
    // lane ran, whether the comparison COMPLETED, and the verdict as notes —
    // see `toPollerRun` in videri-cross-check.ts for why its device and row
    // counts are 0 by nature.
    laneTask("alert-cross-check", {
      runOnStart: false,
      handler: async () => {
        const result = await crossCheckVideriAlerts(http, pool);
        console.log(renderCrossCheck(result));
        await record(crossCheckRun(result));
      },
    }),
    // SLOW LANE. ops_get_settings is one synchronous command per device with a
    // ~10s timeout and no batch read, so this is hourly and online-only —
    // polling an offline device burns the full timeout to learn nothing.
    // Requires ENABLE_SETTINGS_POLL: it issues device commands, which is a
    // heavier action than the read-only pollers and should be opt-in.
    laneTask("device-settings", {
      runOnStart: false,
      handler: async () => {
        if (process.env["ENABLE_SETTINGS_POLL"] !== "true") {
          console.log("[device-settings] skipped — set ENABLE_SETTINGS_POLL=true to enable");
          return;
        }
        const targets = await repo.listSettingsTargets(true);
        await record(await pollDeviceSettings(http, repo, targets, { log }));
      },
    }),
    // SLOW LANE. Runtime telemetry (CPU/RAM/storage/signal/NTP) exists only as
    // per-device demo_command reads — ~6 synchronous commands per device, no
    // batch feed — so this rotates a small batch of the stalest online devices
    // each tick (batch 10 → a ~70-online estate sweeps roughly every 2h) and
    // persists what it reads into device_telemetry. Like device-settings it
    // issues device commands, so it is opt-in behind ENABLE_TELEMETRY_SLOWLANE.
    // Reads only — it writes nothing to any device.
    laneTask("telemetry-slowlane", {
      runOnStart: false,
      handler: async () => {
        if (process.env["ENABLE_TELEMETRY_SLOWLANE"] !== "true") {
          console.log("[telemetry-slowlane] skipped — set ENABLE_TELEMETRY_SLOWLANE=true to enable");
          return;
        }
        const targets = await repo.telemetrySlowLaneTargets(10);
        await record(await pollTelemetrySlowLane(repo, targets, makeTelemetryRunner, { concurrency: 4, log }));
      },
    }),
    // SLOW LANE. The platform SCHEDULE is per-canvas — one publisher v1 events
    // GET per device — so this rotates a batch of the stalest-persisted devices
    // each tick, computes "scheduled now", and persists it into device_schedule
    // so proof-of-play gap detection can run FLEET-WIDE from stored rows instead
    // of live-sampling a bounded batch on every request (US-4.5). Unlike the
    // telemetry lane it is NOT online-only — a canvas has a schedule whether or
    // not it is reachable, and the events endpoint is a control-plane read, not
    // a device command. Opt-in behind ENABLE_SCHEDULE_SLOWLANE; ~30m so a
    // several-hundred-device fleet sweeps in a handful of hours. GET reads only.
    laneTask("schedule-slowlane", {
      runOnStart: false,
      handler: async () => {
        if (process.env["ENABLE_SCHEDULE_SLOWLANE"] !== "true") {
          console.log("[schedule-slowlane] skipped — set ENABLE_SCHEDULE_SLOWLANE=true to enable");
          return;
        }
        const targets = await repo.scheduleSlowLaneTargets(20);
        await record(await pollScheduleSlowLane(repo, targets, readSchedule, { concurrency: 8, log }));
      },
    }),
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
    laneTask("screen-verify-slowlane", {
      runOnStart: false,
      handler: async () => {
        if (process.env["ENABLE_SCREEN_VERIFY"] !== "true") {
          console.log("[screen-verify-slowlane] skipped — set ENABLE_SCREEN_VERIFY=true to enable");
          return;
        }
        const targets = await repo.screenVerifyTargets(5);
        await record(
          await pollScreenVerifySlowLane(repo, targets, makeScreenRunner, {
            concurrency: 2,
            log,
          }),
        );
      },
    }),
    // The two AI artifacts (brief + action plan). Scheduled here because run-by-
    // hand is how they drifted: a plan is only true about the fleet it was
    // generated from, and one that outlives a fix contradicts the engine that
    // made it. Both are gated behind ENABLE_AI_JOBS and left OFF — every tick is
    // a paid Claude call — and both call the SAME core the npm scripts do
    // (src/ai/jobs.ts), so there is no second prompt or persistence path.
    //
    // Built by a factory, so `laneTask`'s type check cannot reach them — the
    // boot-time registry assertion below is what covers these.
    ...aiJobTasks(pool, { record, log }),
    // Evaluation is pure and cheap, so it runs regardless of whether the
    // settings poll is enabled — it simply reports how many devices lack
    // cached settings rather than scoring them as failures.
    laneTask("compliance", {
      runOnStart: false,
      handler: async () => record(complianceRun(await runCompliance(repo, { log }))),
    }),
    // NOTE: records NO poller_runs row — it logs and returns. But it writes one
    // fleet_snapshots row per successful cycle, and the registry declares THAT
    // as its observability source, so pipeline-health measures its cadence and
    // coverage from `fleet_snapshots.computed_at`. Measured that way on
    // 2026-09-16: 1,686 rows over a 236.8 h span = 59.3% of this 5-minute
    // cadence, which nothing could report while the lane was off the roster.
    laneTask("snapshot", {
      runOnStart: false,
      handler: async () => {
        const snapshot = await computeFleetSnapshot(pool, repo);
        console.log(
          `[snapshot] ${snapshot.totalDevices} device(s) · coverage ` +
            `${(snapshot.telemetryCoverage * 100).toFixed(1)}% · ` +
            `${snapshot.firmwareDistribution.length} firmware version(s)`,
        );
      },
    }),
    // Both prune lanes now record a poller_runs row per cycle. They DELETE rows,
    // so a successful prune and a prune that never happened used to be identical
    // in the database — the run row is the only thing that can tell them apart,
    // and `batchesOk` is what separates "checked, nothing was old enough" from
    // "we could not look". WHAT they delete is unchanged; the orchestration and
    // the field choices live in src/db/retention.ts, out of this un-importable
    // entrypoint so they can be unit-tested.
    laneTask("retention", {
      runOnStart: false,
      handler: async () => {
        await runRetentionLane({ prune: () => repo.pruneTimeSeries({}), record, log });
      },
    }),
    laneTask("prune-raw", {
      runOnStart: false,
      handler: async () => {
        await runPruneRawLane({
          prune: () => repo.pruneRawPayloads(PRUNE_RAW_RETAIN_DAYS),
          record,
          log,
        });
      },
    }),
  );
}

/**
 * Refuse to start if the task list and the registry disagree.
 *
 * `laneTask` already makes an undeclared lane a compile error, but two lanes
 * come from factories in other modules (`dataUsageTask`, `aiJobTasks`) where
 * the type check cannot reach, and the two env-driven intervals are resolved in
 * two places (here via `config`, in the registry via the same env with the same
 * defaults). This is what proves they agree — at boot, naming the lane, rather
 * than in a health report that quietly measures the wrong cadence.
 *
 * A throw is deliberate: the previous failure mode was silence for weeks.
 */
assertSchedulerMatchesRegistry(
  [
    ...tasks,
    // The two env-driven intervals AS `config` VALIDATED THEM. The registry
    // resolves them from the same variables with the same defaults but cannot
    // import config.ts (it parses process.env at import and throws without a
    // populated .env, and the health path must run with no credentials). This is
    // the check that the two readings agree: if they ever diverge, coverage would
    // be measured against a cadence we do not run.
    { name: "status", intervalMs: config.POLL_STATUS_INTERVAL_MS },
    { name: "metrics", intervalMs: config.POLL_METRICS_INTERVAL_MS },
    { name: "alerting", intervalMs: config.POLL_METRICS_INTERVAL_MS + 30_000 },
  ],
  process.env,
);

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
