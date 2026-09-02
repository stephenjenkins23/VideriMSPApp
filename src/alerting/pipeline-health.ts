/**
 * Pipeline self-observability — does VFI's own collection still work?
 *
 * WHY THIS EXISTS
 * The poller daemon once ran three-day-old code in memory for days, and we found
 * out by accident. Every lane writes a row to `poller_runs` on every cycle, and
 * until now nothing read those rows to ask the only question that matters about
 * them: is each lane still running, still succeeding, and still bringing back
 * anything? A collector that stops is invisible by construction — it produces no
 * error, no alert and no row. It produces SILENCE, and a dashboard reads silence
 * as calm.
 *
 * THE THREE FAILURES THIS DETECTS
 *   (a) STALLED   — the lane has not run within a sane multiple of its own
 *                   measured cadence (or has never run at all).
 *   (b) FAILING   — the lane runs, but every batch inside it fails.
 *   (c) COLLAPSED — the lane runs and succeeds, but brings back nothing, having
 *                   previously brought back something. This is the one that hides
 *                   best: green ticks all the way down and no data behind them.
 *
 * THIS IS OUR HEALTH, NOT THE FLEET'S
 * Deliberately a separate report with its own vocabulary (`lane`, not `device`;
 * `stalled`, not `offline`) and nothing here is ever written to the `alerts`
 * table. An operator must never have to work out whether "critical" means a
 * screen is broken or our own cron is wedged — they are different jobs, done by
 * different people, at different times of day.
 *
 * And the corollary that gets forgotten: a stalled lane means DEVICE DATA IS
 * STALE. Every finding therefore carries `dataImpact`, in words, because silence
 * from us is not health — it is us not looking.
 *
 * CADENCE IS MEASURED, NOT DECLARED
 * The expected interval for each lane is derived from the gaps between its own
 * recent runs (median, so a daemon restart or one slow tick cannot move it).
 * Copying the interval table out of run-poller.ts would have created a second
 * source of truth that drifts the first time someone tunes an interval — and
 * "the config says 15 minutes" is worth nothing next to "it has in fact been
 * running every 15 minutes". The ONE hardcoded thing is a roster of lane NAMES
 * (`EXPECTED_LANES`), with no cadences in it, because a lane that has never
 * recorded a single run leaves no data to measure and is only visible against a
 * declaration.
 */

import type { Severity } from "../domain/types.js";
import type { Repository } from "../db/repository.js";
import { formatDuration } from "./evaluate.js";

/** One row of `poller_runs`, as this module needs it. */
export interface PollerRunRow {
  poller: string;
  startedAt: Date;
  durationMs: number;
  devicesTargeted: number;
  rowsWritten: number;
  batchesOk: number;
  batchesFailed: number;
  /** Share of targeted devices where an inferred metric resolved. Null = N/A. */
  telemetryYield: number | null;
}

/**
 * The lane roster.
 *
 * Mirrors the task list in `src/pipeline/run-poller.ts` (plus `src/ai/scheduled.ts`),
 * and is the only hardcoded lane knowledge in the health path. It carries NO
 * intervals on purpose — those are measured. It exists for the one thing data
 * cannot tell us: a lane that has never once recorded a run.
 *
 * `optInEnv` matters for honesty. Most slow lanes are opt-in behind a flag, so
 * "never ran" means two completely different things depending on the flag: a
 * fault, or a deliberate choice. Reporting both as a fault would train the
 * operator to ignore the report.
 *
 * A lane found in `poller_runs` but absent here is still assessed — the roster
 * only adds expectations, it never restricts them — so adding a lane in
 * run-poller.ts and forgetting this list costs the "never ran" check and nothing
 * else.
 */
export interface ExpectedLane {
  lane: string;
  optInEnv?: string;
  /** What goes stale when this lane stops. One clause, plain words. */
  feeds: string;
  /**
   * Set when a run of this lane writing zero rows is normal rather than a
   * collapse. `alerting` on a clean fleet legitimately opens, refreshes and
   * resolves nothing; flagging that would train the operator to ignore the one
   * check that catches a silent collector. Stall and all-batches-failing still
   * cover these lanes.
   */
  zeroRowsIsNormal?: true;
}

/**
 * Only lanes that actually call `record()` belong here. `snapshot`, `retention`,
 * `prune-raw` and `alert-cross-check` run on the same scheduler but write no
 * `poller_runs` row, so this check is blind to them by construction — listing
 * them would report a permanent, false "never ran". Making them visible means
 * making them record, in run-poller.ts.
 */
export const EXPECTED_LANES: readonly ExpectedLane[] = [
  { lane: "devices", feeds: "the device registry, names, locations and firmware versions" },
  { lane: "status", feeds: "presence — which canvases are online, and every offline alert" },
  { lane: "metrics", feeds: "screen state — black screen, logo, what is playing" },
  { lane: "alerting", feeds: "every alert; without it nothing opens, refreshes or resolves", zeroRowsIsNormal: true },
  { lane: "compliance", feeds: "compliance scores and settings drift" },
  { lane: "data-usage", optInEnv: "ENABLE_DATA_USAGE_POLL", feeds: "daily per-device data usage" },
  { lane: "device-settings", optInEnv: "ENABLE_SETTINGS_POLL", feeds: "cached device settings, and so compliance drift" },
  { lane: "telemetry-slowlane", optInEnv: "ENABLE_TELEMETRY_SLOWLANE", feeds: "per-device CPU, memory, storage and signal" },
  { lane: "schedule-slowlane", optInEnv: "ENABLE_SCHEDULE_SLOWLANE", feeds: "what each canvas is scheduled to play, and proof-of-play gaps" },
  { lane: "screen-verify-slowlane", optInEnv: "ENABLE_SCREEN_VERIFY", feeds: "device-confirmed black-screen verdicts" },
  { lane: "ai-brief", optInEnv: "ENABLE_AI_JOBS", feeds: "the generated fleet brief" },
  { lane: "ai-action-plan", optInEnv: "ENABLE_AI_JOBS", feeds: "the generated action plan" },
];

/**
 * Every threshold in one place.
 *
 * All of them are MULTIPLES of a measured cadence rather than absolute times,
 * with two absolute floors that exist only to stop a fast lane from being called
 * stalled over one hiccup.
 */
export const PIPELINE_HEALTH_DEFAULTS = {
  /** Gaps needed before the median is trusted as the cadence. */
  minGapsForMeasuredCadence: 3,
  /** Missed cadences before a lane is stalled, when the cadence is measured. */
  stallMultiplier: 3,
  /** Wider, when the cadence rests on one or two observed gaps. */
  provisionalStallMultiplier: 4,
  /** Behind but not yet stalled — worth saying, not worth paging. */
  overdueMultiplier: 1.5,
  /**
   * A floor on the stall threshold. `status` runs every 2 min, so 3× cadence is
   * 6 min, and one slow API call must not read as a stalled collector.
   */
  minStallSeconds: 600,
  /**
   * With exactly one run ever there are no gaps, so there is no cadence to
   * compare against. Rather than declare it healthy (the silence trap) it is
   * judged against this ceiling and reported as unknown-cadence.
   */
  singleRunStaleSeconds: 6 * 3600,
  /** Consecutive all-batches-failed runs before this escalates to critical. */
  failingRunsForCritical: 3,
  /** Consecutive empty runs before "brought nothing back" is a finding. */
  emptyRunsForCollapse: 3,
} as const;

export type LaneStatus =
  | "healthy"
  | "overdue"
  | "stalled"
  | "failing"
  | "collapsed"
  | "unknown"
  | "never-ran"
  | "disabled";

export interface LaneCadence {
  seconds: number | null;
  confidence: "measured" | "provisional" | "unknown";
  /** How the number was arrived at — shown, not hidden behind a threshold. */
  basis: string;
}

export type PipelineFindingKind =
  | "lane-never-ran"
  | "lane-stalled"
  | "lane-overdue"
  | "lane-all-batches-failing"
  | "lane-yield-collapsed";

export interface PipelineFinding {
  kind: PipelineFindingKind;
  /** Always "vfi-pipeline". Present on every finding so a UI can never mix these
   *  in with device alerts by accident. */
  scope: "vfi-pipeline";
  lane: string;
  severity: Severity;
  headline: string;
  detail: string;
  /**
   * What this does to the device data an operator is looking at. Never empty on
   * a stall: a stopped collector shows the fleet as it was, not as it is.
   */
  dataImpact: string;
  /** When the condition started, where we can date it. */
  since: string | null;
}

export interface LaneHealth {
  lane: string;
  status: LaneStatus;
  lastRunAt: string | null;
  /** Age of the last run. Null when the lane has never run. */
  ageSeconds: number | null;
  cadence: LaneCadence;
  runsConsidered: number;
  consecutiveAllFailed: number;
  consecutiveEmpty: number;
  lastYield: number | null;
  lastRowsWritten: number | null;
  findings: PipelineFinding[];
}

export interface PipelineHealthReport {
  generatedAt: string;
  /** Fixed. This report is about US. */
  scope: "vfi-pipeline";
  lanes: LaneHealth[];
  /** Every finding, worst first. Empty means every lane looks healthy. */
  findings: PipelineFinding[];
  worstStatus: LaneStatus;
  summary: string;
  /** True when at least one lane is stalled — i.e. device data is going stale. */
  deviceDataAtRisk: boolean;
}

export interface AssessOptions {
  now?: Date;
  /** Overrides the roster; tests use this, and so could a future config. */
  expectedLanes?: readonly ExpectedLane[];
  /**
   * lane → whether its opt-in flag is currently on. A lane whose flag is off and
   * which has never run is `disabled`, not broken. Omitted means "we do not know
   * whether the flag is set", which is reported as such rather than guessed.
   */
  optInEnabled?: Readonly<Record<string, boolean>>;
  thresholds?: Partial<typeof PIPELINE_HEALTH_DEFAULTS>;
}

const STATUS_RANK: Record<LaneStatus, number> = {
  failing: 0,
  stalled: 1,
  collapsed: 2,
  "never-ran": 3,
  overdue: 4,
  unknown: 5,
  disabled: 6,
  healthy: 7,
};

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, info: 3 };

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

/** Median, so one daemon restart cannot redefine a lane's cadence. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Measure a lane's cadence from the gaps between its own runs.
 *
 * `runs` must be newest-first. With three or more gaps the median is trusted;
 * with one or two it is provisional (and judged against a wider multiplier);
 * with none there is no cadence at all, and saying so beats inventing one.
 */
export function measureCadence(
  runs: readonly PollerRunRow[],
  thresholds: typeof PIPELINE_HEALTH_DEFAULTS = PIPELINE_HEALTH_DEFAULTS,
): LaneCadence {
  const gaps: number[] = [];
  for (let i = 0; i + 1 < runs.length; i += 1) {
    const seconds = (runs[i]!.startedAt.getTime() - runs[i + 1]!.startedAt.getTime()) / 1000;
    if (seconds > 0) gaps.push(seconds);
  }

  if (gaps.length === 0) {
    return {
      seconds: null,
      confidence: "unknown",
      basis:
        runs.length === 0
          ? "no runs recorded"
          : `only ${runs.length} run recorded, so there is no gap to measure`,
    };
  }
  if (gaps.length < thresholds.minGapsForMeasuredCadence) {
    // The LARGEST observed gap, not the median: with one or two samples the
    // conservative reading is the slowest we have actually seen this lane go,
    // otherwise a single fast pair would make a daily lane look stalled.
    return {
      seconds: Math.max(...gaps),
      confidence: "provisional",
      basis: `largest of only ${gaps.length} observed gap(s) — too few to be sure`,
    };
  }
  return {
    seconds: median(gaps),
    confidence: "measured",
    basis: `median of ${gaps.length} gaps across the last ${runs.length} runs`,
  };
}

/**
 * Assess every lane. Pure: takes rows, returns a report.
 *
 * `runs` may be in any order and may contain any set of lanes; they are grouped
 * and sorted here so a caller cannot break the assessment with an ORDER BY.
 */
export function assessPipelineHealth(
  runs: readonly PollerRunRow[],
  {
    now = new Date(),
    expectedLanes = EXPECTED_LANES,
    optInEnabled,
    thresholds: overrides,
  }: AssessOptions = {},
): PipelineHealthReport {
  const thresholds = { ...PIPELINE_HEALTH_DEFAULTS, ...overrides };

  const byLane = new Map<string, PollerRunRow[]>();
  for (const run of runs) {
    const list = byLane.get(run.poller);
    if (list) list.push(run);
    else byLane.set(run.poller, [run]);
  }
  for (const list of byLane.values()) {
    list.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }

  const expectedByName = new Map(expectedLanes.map((l) => [l.lane, l]));
  // Union: everything we expect, plus anything that has actually run. A lane
  // added in code but not in the roster must still be watched.
  const laneNames = [...new Set([...expectedByName.keys(), ...byLane.keys()])].sort();

  const lanes = laneNames.map((lane) =>
    assessLane(lane, byLane.get(lane) ?? [], expectedByName.get(lane), {
      now,
      optInEnabled,
      thresholds,
    }),
  );

  const findings = lanes
    .flatMap((l) => l.findings)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  const worstStatus = lanes.reduce<LaneStatus>(
    (worst, lane) => (STATUS_RANK[lane.status] < STATUS_RANK[worst] ? lane.status : worst),
    "healthy",
  );
  // "At risk" means we have STOPPED COLLECTING something we were collecting, or
  // something we positively expected. A lane we merely cannot judge does not
  // qualify — it is reported as unknown and says so, which is a different claim.
  const stalled = lanes.filter((l) => l.status === "stalled" || l.status === "never-ran");

  return {
    generatedAt: now.toISOString(),
    scope: "vfi-pipeline",
    lanes,
    findings,
    worstStatus,
    deviceDataAtRisk: stalled.length > 0,
    summary: summarise(lanes, findings, stalled),
  };
}

interface LaneContext {
  now: Date;
  optInEnabled?: Readonly<Record<string, boolean>> | undefined;
  thresholds: typeof PIPELINE_HEALTH_DEFAULTS;
}

function assessLane(
  lane: string,
  runs: readonly PollerRunRow[],
  expectation: ExpectedLane | undefined,
  { now, optInEnabled, thresholds }: LaneContext,
): LaneHealth {
  const feeds = expectation?.feeds ?? "whatever this lane collects";
  const cadence = measureCadence(runs, thresholds);
  const findings: PipelineFinding[] = [];

  // ── never ran ──────────────────────────────────────────────────────────────
  if (runs.length === 0) {
    const flag = expectation?.optInEnv;
    const flagState = flag && optInEnabled ? optInEnabled[lane] : undefined;

    if (flag && flagState === false) {
      // Off by choice. Not a fault — but not silence either: the report still
      // says the data is absent, because "no rows" and "off" look identical on
      // a dashboard and mean very different things.
      return {
        lane, status: "disabled", lastRunAt: null, ageSeconds: null, cadence,
        runsConsidered: 0, consecutiveAllFailed: 0, consecutiveEmpty: 0,
        lastYield: null, lastRowsWritten: null, findings: [],
      };
    }

    // An opt-in lane whose flag we cannot see is genuinely UNKNOWN, not dead.
    // Calling it "never ran" made the live report claim device data was at risk
    // because two paid AI lanes had never been switched on — a self-check that
    // is wrong on a healthy system is a self-check that gets ignored.
    const unknowable = Boolean(flag) && flagState === undefined;

    findings.push({
      kind: "lane-never-ran",
      scope: "vfi-pipeline",
      lane,
      severity: unknowable ? "info" : "high",
      headline: `${lane} has never run`,
      detail:
        `No run of ${lane} has ever been recorded.` +
        (flag
          ? flagState === undefined
            ? ` It is opt-in behind ${flag}; if that flag is set this is a fault, and if it is not, this lane is off by choice.`
            : ` ${flag} is set, so it should have run.`
          : ` It is not opt-in, so it should have run.`),
      dataImpact:
        `We hold nothing from this lane, so ${feeds} is absent — not zero, not fine. ` +
        `Anything the console shows in its place comes from somewhere else or from nowhere.`,
      since: null,
    });

    return {
      lane, status: unknowable ? "unknown" : "never-ran",
      lastRunAt: null, ageSeconds: null, cadence,
      runsConsidered: 0, consecutiveAllFailed: 0, consecutiveEmpty: 0,
      lastYield: null, lastRowsWritten: null, findings,
    };
  }

  const latest = runs[0]!;
  const ageSeconds = Math.max(0, (now.getTime() - latest.startedAt.getTime()) / 1000);

  // ── (a) stalled / overdue ──────────────────────────────────────────────────
  let cadenceStatus: LaneStatus = "healthy";
  if (cadence.seconds === null) {
    // Exactly one run ever: no cadence exists, so judge against the ceiling and
    // label the answer unknown rather than dressing it as healthy.
    if (ageSeconds > thresholds.singleRunStaleSeconds) {
      cadenceStatus = "stalled";
      findings.push({
        kind: "lane-stalled",
        scope: "vfi-pipeline",
        lane,
        severity: "high",
        headline: `${lane} has one run in the assessed history, ${formatDuration(ageSeconds)} ago`,
        detail:
          `The only run of ${lane} in the history we assessed started ` +
          `${latest.startedAt.toISOString()}. With a single run there is no cadence to ` +
          `compare against, so this is judged against a ` +
          `${formatDuration(thresholds.singleRunStaleSeconds)} ceiling rather than a multiple ` +
          `of its own interval.`,
        dataImpact: stallImpact(lane, feeds, latest.startedAt, ageSeconds),
        since: iso(latest.startedAt),
      });
    } else {
      cadenceStatus = "unknown";
    }
  } else {
    const multiplier =
      cadence.confidence === "measured"
        ? thresholds.stallMultiplier
        : thresholds.provisionalStallMultiplier;
    const stallAfter = Math.max(cadence.seconds * multiplier, thresholds.minStallSeconds);
    const overdueAfter = Math.max(
      cadence.seconds * thresholds.overdueMultiplier,
      thresholds.minStallSeconds,
    );

    if (ageSeconds > stallAfter) {
      cadenceStatus = "stalled";
      findings.push({
        kind: "lane-stalled",
        scope: "vfi-pipeline",
        lane,
        severity: cadence.confidence === "measured" ? "high" : "medium",
        headline: `${lane} has not run for ${formatDuration(ageSeconds)}`,
        detail:
          `${lane} runs about every ${formatDuration(cadence.seconds)} (${cadence.basis}), ` +
          `so ${formatDuration(ageSeconds)} is ${(ageSeconds / cadence.seconds).toFixed(1)}× ` +
          `its own cadence — past the ${multiplier}× stall threshold. Last run ` +
          `${latest.startedAt.toISOString()}.`,
        dataImpact: stallImpact(lane, feeds, latest.startedAt, ageSeconds),
        since: iso(latest.startedAt),
      });
    } else if (ageSeconds > overdueAfter) {
      cadenceStatus = "overdue";
      findings.push({
        kind: "lane-overdue",
        scope: "vfi-pipeline",
        lane,
        severity: "info",
        headline: `${lane} is behind its usual cadence`,
        detail:
          `Last ran ${formatDuration(ageSeconds)} ago against a usual ` +
          `${formatDuration(cadence.seconds)} (${cadence.basis}). Not yet stalled ` +
          `(${thresholds.stallMultiplier}× cadence), but it has missed a turn.`,
        dataImpact:
          `${feeds} is ${formatDuration(ageSeconds)} old rather than the usual ` +
          `${formatDuration(cadence.seconds)}. Still usable; not live.`,
        since: iso(latest.startedAt),
      });
    }
  }

  // ── (b) every batch failing ────────────────────────────────────────────────
  //
  // A run is only evidence of a FAILING LANE if it attempted enough work to
  // distinguish "the lane is broken" from "the one device it happened to pick
  // did not answer". The screen-verify lane grades itself on whatever targets
  // exist, and it legitimately had a single target — the only reachable panel
  // with a black-screen claim. That one panel staying silent got the whole lane
  // graded `failing`/high, which is a false positive about OURSELVES, and the
  // one thing a self-check must not produce if anyone is to trust it.
  //
  // The gate is DEVICES ATTEMPTED, not batches. That distinction is the whole
  // point, and the live data shows why: the screen-verify run that triggered the
  // false positive was `devicesTargeted=1, batchesOk=0, batchesFailed=1` — one
  // panel, which stayed silent. A `devices` run with one failed batch may have
  // attempted a hundred devices, and that IS a lane fault. Keying on batch count
  // conflated the two; keying on device count separates them exactly.
  //
  // A one-device wipeout is still recorded and still visible in the lane's runs;
  // it simply does not condemn the lane by itself. A second consecutive one does.
  const MIN_DEVICES_TO_CONDEMN = 2;
  const wipeout = (r: PollerRunRow): boolean => r.batchesFailed > 0 && r.batchesOk === 0;
  let consecutiveAllFailed = 0;
  for (const [i, run] of runs.entries()) {
    if (!wipeout(run)) break;
    const tooSmallToJudge = run.devicesTargeted < MIN_DEVICES_TO_CONDEMN;
    const nextAlsoFailed = runs[i + 1] !== undefined && wipeout(runs[i + 1]!);
    if (tooSmallToJudge && consecutiveAllFailed === 0 && !nextAlsoFailed) break;
    consecutiveAllFailed += 1;
  }
  if (consecutiveAllFailed > 0) {
    const oldestFailing = runs[consecutiveAllFailed - 1]!;
    findings.push({
      kind: "lane-all-batches-failing",
      scope: "vfi-pipeline",
      lane,
      severity:
        consecutiveAllFailed >= thresholds.failingRunsForCritical ? "critical" : "high",
      headline:
        consecutiveAllFailed === 1
          ? `${lane} failed every batch on its last run`
          : `${lane} has failed every batch for ${consecutiveAllFailed} runs`,
      detail:
        `${consecutiveAllFailed} consecutive run(s) of ${lane} completed with ` +
        `${latest.batchesFailed} failed batch(es) and none succeeding, starting ` +
        `${oldestFailing.startedAt.toISOString()}. The lane is alive and doing nothing — ` +
        `which is why the run count and the freshness clock both still look normal.`,
      dataImpact:
        `${feeds} has not been updated since before ${oldestFailing.startedAt.toISOString()}, ` +
        `even though the lane keeps reporting runs. Treat it as stale, not as unchanged.`,
      since: iso(oldestFailing.startedAt),
    });
  }

  // ── (c) yield collapse ─────────────────────────────────────────────────────
  // Two measures, because a lane can bring back nothing in two ways: the
  // inferred-metric yield falls to zero, or it simply writes no rows. Both need
  // a PRIOR non-zero in the window: a lane that has never yielded anything is
  // not collapsing, it is doing what it always did (`metrics` yields 0 always —
  // the bulk payload carries no hardware telemetry — and must not be flagged).
  const yieldFinding =
    collapseFinding(lane, feeds, runs, thresholds, (r) => r.telemetryYield, "telemetry yield") ??
    (expectation?.zeroRowsIsNormal
      ? null
      : collapseFinding(
          lane,
          feeds,
          // Only runs that had something to do: a lane that targeted no devices
          // and wrote no rows did exactly the right thing. That keeps the
          // rotating slow lanes (screen-verify targets 0 devices on a quiet
          // cycle) out of this check without hardcoding them.
          runs.filter((r) => r.devicesTargeted > 0),
          thresholds,
          (r) => r.rowsWritten,
          "rows written",
        ));
  if (yieldFinding) findings.push(yieldFinding);

  const consecutiveEmpty = countLeading(runs, (r) => r.rowsWritten === 0);

  const status: LaneStatus =
    consecutiveAllFailed > 0
      ? "failing"
      : cadenceStatus !== "healthy" && cadenceStatus !== "unknown"
        ? cadenceStatus
        : yieldFinding
          ? "collapsed"
          : cadenceStatus;

  return {
    lane,
    status,
    lastRunAt: iso(latest.startedAt),
    ageSeconds,
    cadence,
    runsConsidered: runs.length,
    consecutiveAllFailed,
    consecutiveEmpty,
    lastYield: latest.telemetryYield,
    lastRowsWritten: latest.rowsWritten,
    findings,
  };
}

function countLeading(runs: readonly PollerRunRow[], predicate: (r: PollerRunRow) => boolean): number {
  let count = 0;
  for (const run of runs) {
    if (predicate(run)) count += 1;
    else break;
  }
  return count;
}

/**
 * "Running but bringing back nothing", for one measure.
 *
 * Requires BOTH a run of consecutive zeros (anti-flap: one empty tick is normal
 * on a rotating slow lane) and an earlier non-zero in the same window (proof
 * that this lane ever produced anything, so zero is a change rather than its
 * nature). `null` measures are skipped entirely — not readable is not zero.
 */
function collapseFinding(
  lane: string,
  feeds: string,
  runs: readonly PollerRunRow[],
  thresholds: typeof PIPELINE_HEALTH_DEFAULTS,
  read: (run: PollerRunRow) => number | null,
  measure: string,
): PipelineFinding | null {
  const readable = runs.filter((r) => read(r) !== null);
  if (readable.length === 0) return null;

  const leadingZeros = countLeading(readable, (r) => read(r) === 0);
  if (leadingZeros < thresholds.emptyRunsForCollapse) return null;

  const lastProductive = readable.slice(leadingZeros).find((r) => (read(r) ?? 0) > 0);
  if (!lastProductive) return null; // never produced anything — not a collapse

  const firstEmpty = readable[leadingZeros - 1]!;
  return {
    kind: "lane-yield-collapsed",
    scope: "vfi-pipeline",
    lane,
    severity: "high",
    headline: `${lane} is running but its ${measure} has fallen to zero`,
    detail:
      `The last ${leadingZeros} runs of ${lane} reported ${measure} of 0, with no failed ` +
      `batches to explain it. It last produced something at ` +
      `${lastProductive.startedAt.toISOString()} (${measure} ` +
      `${read(lastProductive)}), and the collapse begins with the run at ` +
      `${firstEmpty.startedAt.toISOString()}. A lane that succeeds at collecting nothing ` +
      `looks healthy on every dashboard we have.`,
    dataImpact:
      `${feeds} has been frozen since ${lastProductive.startedAt.toISOString()} while the ` +
      `lane kept reporting successful runs. The likeliest cause is a payload shape change ` +
      `at the platform, not an outage.`,
    since: iso(firstEmpty.startedAt),
  };
}

function stallImpact(lane: string, feeds: string, lastRunAt: Date, ageSeconds: number): string {
  return (
    `DEVICE DATA IS STALE: ${feeds} has not been refreshed since ` +
    `${lastRunAt.toISOString()} — ${formatDuration(ageSeconds)} ago. Anything the console ` +
    `shows from ${lane} is a snapshot of that moment, not the fleet now, and any judgement ` +
    `built on it (alerts, SLA, compliance) inherits the same age. Silence from this lane is ` +
    `not health; it is us not looking.`
  );
}

function summarise(
  lanes: readonly LaneHealth[],
  findings: readonly PipelineFinding[],
  stalled: readonly LaneHealth[],
): string {
  const counted = lanes.filter((l) => l.status !== "disabled");
  const healthy = counted.filter((l) => l.status === "healthy").length;
  if (findings.length === 0) {
    return (
      `All ${counted.length} recording lane(s) are running at their measured cadence, ` +
      `succeeding, and bringing back data.`
    );
  }
  const head =
    `${healthy} of ${counted.length} lane(s) healthy; ${findings.length} finding(s) about ` +
    `OUR pipeline (not the fleet): ` +
    findings.map((f) => `${f.lane} ${f.kind.replace("lane-", "")}`).join(", ") + ".";
  return stalled.length === 0
    ? head
    : `${head} ${stalled.length} lane(s) have stopped, so the device data they feed is ` +
      `stale — treat the console as a snapshot for those areas.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O
// ─────────────────────────────────────────────────────────────────────────────

export interface LoadPipelineHealthOptions {
  now?: Date;
  /**
   * How much run history to measure cadence from. Defaults to the full 14 days
   * `poller_runs` is retained for (repository.pruneTimeSeries), i.e. all the
   * history there is.
   *
   * A short window is actively dangerous here: at 72 hours a daily lane looked
   * like it had "run once, ever" and a lane that stalled four days ago looked
   * like it had NEVER run — the window's edge masquerading as a fact about the
   * lane. The per-lane cap is what bounds the read, so the window costs nothing.
   */
  lookbackHours?: number;
  /** Runs per lane. 40 is plenty for a median and bounds the read. */
  runsPerLane?: number;
  /** Injected so a test can drive the opt-in gates without touching the process. */
  env?: Record<string, string | undefined>;
}

/**
 * Read the run history and assess it. One query, no per-lane round trips.
 *
 * The opt-in flags are read from the environment of whichever process asks —
 * normally the API server, which loads the same `.env` the poller does. If a
 * flag is genuinely unset in this process the lane is reported as "opt-in, flag
 * not visible here" rather than as broken.
 */
export async function loadPipelineHealth(
  repo: Repository,
  { now = new Date(), lookbackHours = 14 * 24, runsPerLane = 40, env = process.env }: LoadPipelineHealthOptions = {},
): Promise<PipelineHealthReport> {
  const runs = await repo.pollerRunHistory({ lookbackHours, runsPerLane });
  const optInEnabled: Record<string, boolean> = {};
  for (const lane of EXPECTED_LANES) {
    if (!lane.optInEnv) continue;
    const raw = env[lane.optInEnv];
    // POLARITY FIRST, then absence — the reverse order was a real bug.
    //
    // ENABLE_DATA_USAGE_POLL is the one DEFAULT-ON flag (see run-poller.ts:175,
    // which schedules the lane when it is unset, and DEPLOY.md, which documents
    // it as "on unless set false"). For that flag `undefined` means ENABLED, not
    // unknown. Skipping on `undefined` before applying the polarity meant that
    // on a default deployment — the flag commented out in .env.example — a
    // data-usage lane that had NEVER RUN was reported as `unknown`/`info`
    // ("possibly off by choice") instead of `never-ran`/`high`, and was excluded
    // from `deviceDataAtRisk`. The self-check went quiet about precisely the
    // starvation it was built to catch, and which we had just fixed.
    if (lane.optInEnv === "ENABLE_DATA_USAGE_POLL") {
      optInEnabled[lane.lane] = raw !== "false";
      continue;
    }
    // Every other flag is off unless "true", so absence really is unknowable
    // from here: it may be unset in THIS process but set for the poller.
    if (raw === undefined) continue;
    optInEnabled[lane.lane] = raw === "true";
  }
  return assessPipelineHealth(runs, { now, optInEnabled });
}
