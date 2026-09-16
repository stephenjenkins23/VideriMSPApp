/**
 * THE lane registry — one declaration per scheduled lane, consumed by both the
 * scheduler that runs them and the health check that watches them.
 *
 * WHY THIS EXISTS
 * `pipeline-health.ts` used to carry its own hand-written roster whose comment
 * said it "mirrors the task list in run-poller.ts". It had drifted, and the
 * drift was not cosmetic: four lanes the scheduler runs every day — `snapshot`,
 * `alert-cross-check`, `retention`, `prune-raw` — were absent from the roster
 * and therefore INVISIBLE to the only check that watches our own collection.
 * `snapshot` wrote 1,686 rows to `fleet_snapshots` at 59.3% of its configured
 * 5-minute cadence and nothing could report it. `alert-cross-check` has never
 * recorded a single run and nothing could report that either.
 *
 * A hand-maintained mirror drifts again. So the registry is the source, and:
 *
 *   - `run-poller.ts` builds every task through `laneTask(name, …)`, whose
 *     `name` parameter is typed `LaneName`. Adding a lane to the scheduler
 *     WITHOUT declaring it here is a COMPILE ERROR, not a silent blind spot.
 *   - `assertSchedulerMatchesRegistry` re-checks the assembled task list at
 *     boot, which catches the lanes built by factories in other modules
 *     (`dataUsageTask`, `aiJobTasks`) where the type check cannot reach.
 *   - `pipeline-health.ts` derives its roster from here, so a declared lane is
 *     always watched.
 *
 * WHY IT LIVES HERE AND NOT IN run-poller.ts
 * `run-poller.ts` exports nothing and builds a real Pool, auth client and
 * scheduler at import time — importing it starts a daemon. `lanes/data-usage.ts`
 * already exists for exactly that reason; this is its sibling.
 *
 * WHY IT DOES NOT IMPORT src/config.ts
 * `config.ts` runs `Schema.parse(process.env)` at import and THROWS without a
 * populated `.env` (VIDERI_TENANT and DATABASE_URL are required). The health
 * path is imported by tests that must run with no credentials at all, so the two
 * env-driven intervals are resolved here with the same coercion and the same
 * defaults as `config.ts`, and `assertSchedulerMatchesRegistry` is what proves
 * the two agree — at boot, loudly, rather than in a report nobody checks.
 */

/** Just the slice of `process.env` interval resolution needs. */
export type LaneEnv = Record<string, string | undefined>;

/**
 * Every lane the scheduler runs, in scheduler order.
 *
 * A `const` tuple on purpose: `LaneName` is derived from it, so this list is
 * what makes an undeclared lane a type error at the call site in run-poller.ts.
 */
export const LANE_NAMES = [
  "devices",
  "status",
  "metrics",
  "data-usage",
  "alerting",
  "alert-cross-check",
  "device-settings",
  "telemetry-slowlane",
  "schedule-slowlane",
  "screen-verify-slowlane",
  "ai-brief",
  "ai-action-plan",
  "compliance",
  "snapshot",
  "retention",
  "prune-raw",
] as const;

export type LaneName = (typeof LANE_NAMES)[number];

/**
 * Where evidence that this lane RAN can be found.
 *
 * The honest-null rule applied to our own pipeline. Most lanes call `record()`
 * and land a `poller_runs` row. Some do not, and the difference has to be
 * declared rather than assumed, because "no run row" and "no lane" look
 * identical from the health check and mean completely different things:
 *
 *   `poller-runs` — the lane records every cycle. Full assessment available.
 *   `table`       — the lane records nothing, but the DATA IT WRITES is itself
 *                   the evidence. `snapshot` is the case that proves it: no run
 *                   row, but one `fleet_snapshots` row per successful cycle, so
 *                   its cadence and coverage are measurable from
 *                   `computed_at` — ten days of history a newly-added
 *                   `record()` call could never recover.
 *   `none`        — the lane leaves no trace anywhere. It must report UNKNOWN.
 *                   Not 0%, which claims a measured rate we do not have; and
 *                   never healthy, which claims we looked when we did not.
 */
export type LaneObservability =
  | { kind: "poller-runs" }
  | {
      kind: "table";
      table: string;
      /** The timestamp column one row per cycle is stamped with. */
      timeColumn: string;
      why: string;
    }
  | { kind: "none"; why: string };

/** How the absence of an opt-in flag should be read. */
export type OptInDefault = "on" | "off";

export interface LaneDecl {
  lane: LaneName;
  /**
   * The cadence the SCHEDULER is configured to run. A number where it is fixed
   * in code; a resolver where it comes from the environment.
   *
   * This is the number every coverage threshold is a multiple of, and it has to
   * come from here rather than from observation. A daily lane's normal rhythm is
   * indistinguishable from an outage against an absolute threshold: `data-usage`
   * ran at 24.00 h, 24.01 h and 24.30 h — perfect — and once at 48.91 h, which
   * is the only real miss. A naive longest-gap alarm flags it every single day,
   * and an operator who learns to ignore that alarm has been trained to ignore
   * the real one.
   */
  intervalMs: number | ((env: LaneEnv) => number);
  /** Env flag this lane is gated behind, if any. */
  optInEnv?: string;
  /**
   * What absence of the flag means. Defaults to "off".
   *
   * `ENABLE_DATA_USAGE_POLL` is the one DEFAULT-ON flag — the scheduler runs the
   * lane when it is unset — and getting that polarity wrong once made the
   * self-check go quiet about the exact starvation it exists to catch. It is
   * declared here so no consumer has to string-match the flag name.
   */
  optInDefault?: OptInDefault;
  /** What goes stale when this lane stops. One clause, plain words. */
  feeds: string;
  /**
   * Set when a run writing zero rows is normal rather than a collapse.
   * `alerting` on a clean fleet legitimately opens, refreshes and resolves
   * nothing.
   */
  zeroRowsIsNormal?: true;
  observability: LaneObservability;
}

/**
 * Mirrors `config.ts`'s coercion for the two env-driven intervals.
 *
 * Deliberately permissive: an unparseable value falls back to the documented
 * default rather than throwing, because a bad interval must not be able to take
 * the health report down. `assertSchedulerMatchesRegistry` is what catches a
 * genuine divergence from `config`.
 */
const fromEnv =
  (name: string, defaultMs: number) =>
  (env: LaneEnv): number => {
    const parsed = Number(env[name]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMs;
  };

const statusInterval = fromEnv("POLL_STATUS_INTERVAL_MS", 120_000);
const metricsInterval = fromEnv("POLL_METRICS_INTERVAL_MS", 420_000);

const POLLER_RUNS: LaneObservability = { kind: "poller-runs" };

export const LANE_REGISTRY: readonly LaneDecl[] = [
  {
    lane: "devices",
    intervalMs: 15 * 60_000,
    feeds: "the device registry, names, locations and firmware versions",
    observability: POLLER_RUNS,
  },
  {
    lane: "status",
    intervalMs: statusInterval,
    feeds: "presence — which canvases are online, and every offline alert",
    observability: POLLER_RUNS,
  },
  {
    lane: "metrics",
    intervalMs: metricsInterval,
    feeds: "screen state — black screen, logo, what is playing",
    observability: POLLER_RUNS,
  },
  {
    lane: "data-usage",
    // Daily: the platform aggregation is per-day, so a second run inside the
    // same day cannot produce a new row (see lanes/data-usage.ts).
    intervalMs: 24 * 60 * 60_000,
    optInEnv: "ENABLE_DATA_USAGE_POLL",
    optInDefault: "on",
    feeds: "daily per-device data usage",
    observability: POLLER_RUNS,
  },
  {
    lane: "alerting",
    // Offset from the metrics interval so evaluation usually sees a freshly
    // written sample rather than racing the poller that produces it.
    intervalMs: (env) => metricsInterval(env) + 30_000,
    feeds: "every alert; without it nothing opens, refreshes or resolves",
    zeroRowsIsNormal: true,
    observability: POLLER_RUNS,
  },
  {
    lane: "alert-cross-check",
    intervalMs: 60 * 60_000,
    feeds: "the second opinion on our detection — where we and the platform disagree",
    // It prints `renderCrossCheck(result)` to the log and persists NOTHING: no
    // poller_runs row, no table of its own. So we cannot tell whether it has run
    // hourly for a month or has never run once, and the report must say exactly
    // that instead of picking the flattering reading.
    observability: {
      kind: "none",
      why:
        "it logs its result to stdout and persists nothing — no poller_runs row and no " +
        "table of its own, so whether it ran is unknowable from the database. Making it " +
        "measurable means calling record() in run-poller.ts, or persisting the verdict",
    },
  },
  {
    lane: "device-settings",
    intervalMs: 60 * 60_000,
    optInEnv: "ENABLE_SETTINGS_POLL",
    feeds: "cached device settings, and so compliance drift",
    observability: POLLER_RUNS,
  },
  {
    lane: "telemetry-slowlane",
    intervalMs: 15 * 60_000,
    optInEnv: "ENABLE_TELEMETRY_SLOWLANE",
    feeds: "per-device CPU, memory, storage and signal",
    observability: POLLER_RUNS,
  },
  {
    lane: "schedule-slowlane",
    intervalMs: 30 * 60_000,
    optInEnv: "ENABLE_SCHEDULE_SLOWLANE",
    feeds: "what each canvas is scheduled to play, and proof-of-play gaps",
    observability: POLLER_RUNS,
  },
  {
    lane: "screen-verify-slowlane",
    intervalMs: 15 * 60_000,
    optInEnv: "ENABLE_SCREEN_VERIFY",
    feeds: "device-confirmed black-screen verdicts",
    observability: POLLER_RUNS,
  },
  {
    // Intervals live in src/ai/scheduled.ts as BRIEF_INTERVAL_MS /
    // ACTION_PLAN_INTERVAL_MS. Repeated rather than imported: `ai/scheduled.ts`
    // pulls in the Anthropic SDK and the whole read-query layer, and the health
    // path must not. `assertSchedulerMatchesRegistry` compares these against the
    // tasks those factories actually produce at boot.
    lane: "ai-brief",
    intervalMs: 24 * 60 * 60_000,
    optInEnv: "ENABLE_AI_JOBS",
    feeds: "the generated fleet brief",
    observability: POLLER_RUNS,
  },
  {
    lane: "ai-action-plan",
    intervalMs: 8 * 60 * 60_000,
    optInEnv: "ENABLE_AI_JOBS",
    feeds: "the generated action plan",
    observability: POLLER_RUNS,
  },
  {
    lane: "compliance",
    intervalMs: 15 * 60_000,
    feeds: "compliance scores and settings drift",
    observability: POLLER_RUNS,
  },
  {
    lane: "snapshot",
    intervalMs: 5 * 60_000,
    feeds: "the computed fleet snapshot behind every trend and rollup",
    // The case that forced this whole mechanism. No `record()` call, so
    // poller_runs is blind to it — but one row per successful cycle lands in
    // fleet_snapshots, and that IS the evidence. Measured there: 1,686 rows
    // over a 236.8 h span = 59.3% of its configured 5-minute cadence.
    observability: {
      kind: "table",
      table: "fleet_snapshots",
      timeColumn: "computed_at",
      why: "it writes one row per successful cycle, so its own output dates every run",
    },
  },
  {
    lane: "retention",
    intervalMs: 24 * 60 * 60_000,
    feeds: "the retention prune that keeps the time-series tables bounded",
    observability: {
      kind: "none",
      why:
        "it DELETES rows and records nothing, so a successful prune and a prune that " +
        "never happened are identical in the database. Making it measurable means " +
        "calling record() in run-poller.ts",
    },
  },
  {
    lane: "prune-raw",
    intervalMs: 24 * 60 * 60_000,
    feeds: "the raw-payload prune that keeps raw_payloads bounded",
    observability: {
      kind: "none",
      why:
        "it DELETES rows and records nothing, so a successful prune and a prune that " +
        "never happened are identical in the database. Making it measurable means " +
        "calling record() in run-poller.ts",
    },
  },
];

const BY_NAME = new Map<string, LaneDecl>(LANE_REGISTRY.map((l) => [l.lane, l]));

export function laneDecl(lane: string): LaneDecl | undefined {
  return BY_NAME.get(lane);
}

/** The configured cadence in ms, with env-driven lanes resolved. */
export function laneIntervalMs(decl: LaneDecl, env: LaneEnv = process.env): number {
  return typeof decl.intervalMs === "function" ? decl.intervalMs(env) : decl.intervalMs;
}

/** The configured cadence in seconds — the unit every threshold is expressed in. */
export function laneIntervalSeconds(decl: LaneDecl, env: LaneEnv = process.env): number {
  return laneIntervalMs(decl, env) / 1000;
}

/**
 * Is this lane's opt-in flag on, off, or unknowable from this process?
 *
 * `undefined` means genuinely unknowable: an off-by-default flag may be unset
 * here and set for the poller, and reporting that as a fault would make the
 * self-check wrong on a healthy system.
 */
export function laneOptInState(decl: LaneDecl, env: LaneEnv = process.env): boolean | undefined {
  if (!decl.optInEnv) return undefined;
  const raw = env[decl.optInEnv];
  // POLARITY FIRST, then absence. The reverse order was a real bug: on a default
  // deployment a data-usage lane that had NEVER RUN reported "possibly off by
  // choice" instead of a fault, and was excluded from deviceDataAtRisk.
  if (decl.optInDefault === "on") return raw !== "false";
  if (raw === undefined) return undefined;
  return raw === "true";
}

/** A task the scheduler will run, as the drift check needs it. */
export interface ScheduledTaskShape {
  name: string;
  intervalMs: number;
}

export interface LaneDrift {
  lane: string;
  problem: string;
}

/**
 * Compare the task list the scheduler is about to run against this registry.
 *
 * Catches the two ways drift gets in that the type check cannot see: a task
 * built by a factory in another module under a name nobody declared, and a
 * declared lane whose real interval no longer matches the one health thresholds
 * are computed from. Both are silent today and both make the health report wrong
 * about us.
 */
export function laneRegistryDrift(
  tasks: readonly ScheduledTaskShape[],
  env: LaneEnv = process.env,
): LaneDrift[] {
  const drift: LaneDrift[] = [];
  for (const task of tasks) {
    const decl = laneDecl(task.name);
    if (!decl) {
      drift.push({
        lane: task.name,
        problem:
          `scheduled but not declared in the lane registry, so pipeline-health cannot ` +
          `see it at all. Add it to LANE_NAMES and LANE_REGISTRY in ` +
          `src/pipeline/lanes/registry.ts, including how a run of it can be observed.`,
      });
      continue;
    }
    const declared = laneIntervalMs(decl, env);
    if (declared !== task.intervalMs) {
      drift.push({
        lane: task.name,
        problem:
          `scheduled every ${task.intervalMs}ms but declared every ${declared}ms. Every ` +
          `coverage threshold is a multiple of the DECLARED interval, so this would ` +
          `misreport the lane by a factor of ${(task.intervalMs / declared).toFixed(2)}.`,
      });
    }
  }
  return drift;
}

/**
 * Refuse to start on drift.
 *
 * A throw at boot is deliberate. The alternative — a warning — is how the
 * original mirror drifted for weeks: nobody reads a warning in a daemon log,
 * and the cost of getting this wrong is a lane nobody can see. A deploy that
 * fails immediately and says which lane is a much cheaper failure.
 */
export function assertSchedulerMatchesRegistry(
  tasks: readonly ScheduledTaskShape[],
  env: LaneEnv = process.env,
): void {
  const drift = laneRegistryDrift(tasks, env);
  if (drift.length === 0) return;
  throw new Error(
    `Lane registry does not match the scheduler (${drift.length} problem(s)):\n` +
      drift.map((d) => `  - ${d.lane}: ${d.problem}`).join("\n"),
  );
}

/** Every declared table source, for the one query that reads them. */
export function laneTableSources(
  registry: readonly LaneDecl[] = LANE_REGISTRY,
): Array<{ lane: string; table: string; timeColumn: string }> {
  return registry.flatMap((decl) =>
    decl.observability.kind === "table"
      ? [{ lane: decl.lane, table: decl.observability.table, timeColumn: decl.observability.timeColumn }]
      : [],
  );
}
