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
 * TWO CADENCES, BOTH REPORTED, NEITHER REPLACING THE OTHER
 * They answer different questions and conflating them loses one of them:
 *
 *   OBSERVED   — the median gap between this lane's own recent runs. Answers
 *                "has it stalled relative to its own rhythm", which is what the
 *                stall and overdue checks are about, and it needs no declaration
 *                to be true. `measureCadence` is unchanged.
 *   CONFIGURED — the interval the scheduler is actually set to, read from the
 *                same registry the scheduler builds its task list from. Answers
 *                "did it run as often as it was configured to", which is what
 *                SLA coverage needs, and which observation alone cannot answer:
 *                a lane that ran twice five minutes apart has a perfect observed
 *                cadence and 0.1% coverage.
 *
 * A configured interval is also the only safe basis for a GAP threshold. A daily
 * lane's normal rhythm is indistinguishable from an outage against an absolute
 * one: `data-usage` ran at 24.00 h, 24.01 h and 24.30 h — working perfectly —
 * and once at 48.91 h, which is the only real miss. A naive longest-gap alarm
 * flags it every single day, and an operator who learns to ignore that alarm has
 * been trained to ignore the real one. So every threshold here is a MULTIPLE of
 * the lane's own configured interval.
 *
 * THE ROSTER IS DERIVED, NOT MIRRORED
 * `EXPECTED_LANES` used to be hand-written, with a comment saying it "mirrors
 * the task list in run-poller.ts". It had drifted, and four lanes the scheduler
 * runs every day were invisible to this check as a result — including `snapshot`,
 * which was writing 1,686 rows at 59.3% of its configured cadence with nothing
 * able to report it. The roster now comes from `pipeline/lanes/registry.ts`,
 * which is the same declaration the scheduler runs.
 *
 * AND THE HONEST-NULL RULE, APPLIED TO OURSELVES
 * Some lanes write no `poller_runs` row. Where their OUTPUT dates their runs
 * (`snapshot` → `fleet_snapshots.computed_at`) coverage is measured from that.
 * Where nothing records them at all (`alert-cross-check`, `retention`,
 * `prune-raw`) the lane reports UNKNOWN and says why — never 0%, which claims a
 * measured rate we do not have, and never healthy, which claims we looked when
 * we did not. Absence of a run row must never be indistinguishable from absence
 * of a lane.
 */

import type { Severity } from "../domain/types.js";
import type { Repository } from "../db/repository.js";
import { formatDuration } from "./evaluate.js";
import {
  LANE_REGISTRY,
  laneIntervalSeconds,
  laneOptInState,
  laneTableSources,
  type LaneDecl,
  type LaneEnv,
  type LaneObservability,
} from "../pipeline/lanes/registry.js";

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
 * The lane roster, as the health path needs it.
 *
 * DERIVED from `pipeline/lanes/registry.ts` — the same declaration
 * `run-poller.ts` builds its task list from — so a lane added to the scheduler
 * cannot be invisible here. The previous hand-written mirror had drifted by four
 * lanes.
 *
 * `optInEnv` matters for honesty. Most slow lanes are opt-in behind a flag, so
 * "never ran" means two completely different things depending on the flag: a
 * fault, or a deliberate choice. Reporting both as a fault would train the
 * operator to ignore the report.
 *
 * A lane found in `poller_runs` but absent here is still assessed — the roster
 * only adds expectations, it never restricts them.
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
  /**
   * The CONFIGURED cadence, from the scheduler's own registry. Every coverage
   * threshold is a multiple of this. Null or absent means no interval is
   * declared, and coverage then reports unknown rather than guessing one.
   *
   * This does NOT replace the observed cadence — `measureCadence` still derives
   * the stall threshold from the lane's own recent rhythm. Both are reported.
   */
  intervalSeconds?: number | null;
  /**
   * How a run of this lane can be observed at all. Absent means `poller_runs`,
   * which is true of every lane that calls `record()` and of any undeclared lane
   * we only know about because it appears there.
   */
  observability?: LaneObservability;
}

/** One lane's observation history, aggregated. Matches `LaneObservationRow`. */
export interface LaneObservations {
  lane: string;
  /** Where the evidence came from, in words an operator can check. */
  source: string;
  count: number;
  firstAt: Date | null;
  lastAt: Date | null;
  medianGapSeconds: number | null;
  /** The TRUE longest gap, with no read-back floor applied. Null under two
   *  observations. This is what `longestGapSeconds` is measured from. */
  maxGapSeconds: number | null;
  gaps: ReadonlyArray<{ startedAt: Date; endedAt: Date; seconds: number }>;
  /** The floor `gaps` was read back above, so a sum over `gaps` can say whether
   *  it is exact. Provenance only — never compared to decide health. */
  gapFloorSeconds: number | null;
  gapsTruncated: boolean;
}

/** One lane declaration, as this module reads it. */
export function toExpectedLane(decl: LaneDecl, env: LaneEnv = process.env): ExpectedLane {
  return {
    lane: decl.lane,
    ...(decl.optInEnv ? { optInEnv: decl.optInEnv } : {}),
    feeds: decl.feeds,
    ...(decl.zeroRowsIsNormal ? { zeroRowsIsNormal: decl.zeroRowsIsNormal } : {}),
    intervalSeconds: laneIntervalSeconds(decl, env),
    observability: decl.observability,
  };
}

/** The roster resolved against a specific environment (two intervals are env-driven). */
export function expectedLanesFor(env: LaneEnv = process.env): readonly ExpectedLane[] {
  return LANE_REGISTRY.map((decl) => toExpectedLane(decl, env));
}

/**
 * The roster against this process's environment.
 *
 * A const for the many callers that just want the list; `expectedLanesFor` is
 * the form to use when the environment matters (tests, and `loadPipelineHealth`,
 * which is handed the env explicitly).
 */
export const EXPECTED_LANES: readonly ExpectedLane[] = expectedLanesFor();

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

  // ── configured-cadence coverage ────────────────────────────────────────────
  //
  // Every one of these is a MULTIPLE of the lane's own configured interval, for
  // the reason in the header: an absolute gap threshold flags a daily lane every
  // single day, and the operator learns to ignore it.
  /**
   * Gap size, in configured intervals, at which a gap is worth READING BACK at
   * all — the SQL floor in `loadPipelineHealth`, and nothing else.
   *
   * It is 2 because that is where `missedFiresInGap` starts counting: at 2x a
   * gap has demonstrably skipped at least one fire (floor(gap/interval) - 1 >=
   * 1), and below it `data-usage`'s perfectly normal 24.30 h gap — 1.01x its
   * configured day — is correctly worth nothing. So the floor is DERIVED from
   * the missed-fire rule rather than being a second opinion about it, and
   * because it is EQUAL to the rule's first countable gap (and the SQL compares
   * `>=`, so a gap of exactly 2.000x is read back) the per-gap sum it feeds is
   * the exact missed-fire count, not a floor. Raise it and `missedFiresExact`
   * turns false and says so; it does not quietly undercount.
   *
   * It says nothing about a lane whose longest gap is below it: that gap is
   * still measured and reported (`laneObservations.maxGapSeconds`, aggregated
   * with no floor at all), because "its worst gap was 1.99x its interval" is an
   * answer and a null is not.
   *
   * IT IS NOT A HEALTH THRESHOLD, and nothing may compare a gap to it to decide
   * whether a lane is late (BUG-11: the collector surface did exactly that, and
   * because a lane that misses exactly ONE fire produces a gap of two intervals
   * plus scheduler jitter, every such lane sat a hair over 2x and read as out of
   * cadence while the missed-fire rule scored it as the single skipped fire it
   * is. The two answers were about the same gap.) Ask `missedFiresInGap` —
   * whose answer `longestGapWithinCadence` now is.
   */
  coverageGapMultiplier: 2,
  /**
   * Gap size, in configured intervals, at which a lane counts as SILENT for
   * outage correlation. Wider than the coverage gate on purpose: correlation is
   * a claim about the whole daemon, so it should rest on unambiguous silence.
   */
  outageSilenceMultiplier: 3,
  /**
   * How many lanes must be silent together, and how tightly their last
   * observations must cluster, before this is called one process outage rather
   * than N lane faults.
   *
   * BOTH NUMBERS ARE MEASURED, not chosen. Across the local history the stop
   * spread within a cluster is p50 0.049 SECONDS, p90 14.2 s, p99 69.7 s, max
   * 104.7 s. Lanes stopping within fifty milliseconds of each other are one
   * process dying; two collectors failing for their own reasons would stop at
   * their own next-fire times, minutes apart. 120 s is therefore the smallest
   * tolerance that still captures the whole observed population, and it remains
   * below the shortest lane interval.
   *
   * TWO lanes, not three. Three was the cautious first guess and it was too
   * cautious: 101 of the 130 correlated windows have exactly two members, and
   * excluding them left SEVEN lanes individually blamed for holes they shared —
   * one fault presented as seven, which is how a self-check stops being read.
   * The direction of error also matters: being generous about what counts as a
   * shared outage under-blames a lane, and an unreported lane shortfall is
   * recoverable from the coverage numbers, which are always shown. A false
   * accusation against a healthy lane is not.
   */
  outageMinLanes: 2,
  outageClusterSeconds: 120,
  /**
   * Coverage below which a shortfall is worth reporting, AFTER correlated
   * outage time is excluded. 0.9 because the scheduler measures its interval
   * from task COMPLETION and adds startup jitter, so a healthy lane lands a few
   * percent under its nominal rate by construction — `status` at 120 s runs at a
   * measured 122 s median, and calling that broken would be a false alarm about
   * ourselves.
   */
  minConfiguredCoverage: 0.9,
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

/**
 * Did this lane run as often as it was CONFIGURED to?
 *
 * A different question from `LaneCadence`, which asks whether it has stalled
 * against its own recent rhythm. Both are reported; neither replaces the other.
 *
 * Every number here is nullable and `basis` always explains a null. That is
 * deliberate and it is the whole point of this type: a lane we cannot measure
 * must not be reported as 0% (which claims we measured a rate of zero) and must
 * not be reported as healthy (which claims we looked).
 */
export interface LaneCoverage {
  /** The scheduler's interval, from the registry. Null = none declared. */
  configuredIntervalSeconds: number | null;
  /** Where the evidence came from: `poller_runs`, `fleet_snapshots.computed_at`. */
  source: string | null;
  /** Observations found in the assessed window. */
  observed: number | null;
  /** Observations the configured interval implies over the same span. */
  expected: number | null;
  /** observed / expected, capped at 1. NULL where unmeasurable — never 0. */
  ratio: number | null;
  /**
   * The same, with time inside a CORRELATED DAEMON OUTAGE removed.
   *
   * This is the number worth judging a lane on. Raw coverage over the local
   * history is 60-80% for nearly every lane, and that is one intermittently
   * dead daemon (31.6 h across 29 correlated outages in a 213 h span), not
   * eleven broken collectors. Judging lanes on the raw figure would produce
   * eleven findings for one fault.
   */
  ratioExcludingOutages: number | null;
  /** First to last observation, in seconds. Not the whole lookback window. */
  spanSeconds: number | null;
  /** Of that span, how much fell inside a correlated outage. */
  outageSeconds: number | null;
  /** floor(gap / interval) - 1, summed over the gaps we have. */
  missedFires: number | null;
  /** The same, counting only the part of each gap outside a correlated outage. */
  missedFiresOutsideOutages: number | null;
  /**
   * Is `missedFires` the EXACT count, or a floor?
   *
   * Exact when both hold: every gap the missed-fire rule can count was read back
   * (the source's read-back floor is at or below 2x the interval, the smallest
   * gap for which floor(gap/interval) - 1 reaches 1), and no gap was truncated
   * off the cap. Null when the source did not report its floor, which is "we
   * cannot tell", not "it is exact" — the surface must say "at least" then.
   *
   * It is stated rather than implied because the two were indistinguishable
   * before: a coarser floor and a truncated cap both silently undercounted.
   *
   * It governs `missedFiresOutsideOutages` as well — both are summed over the
   * same gap list — and anything false or null must be rendered "at least".
   */
  missedFiresExact: boolean | null;
  /**
   * The longest gap between consecutive observations. THE longest — not the
   * longest above a read-back floor, which is what this used to mean, so a lane
   * running perfectly on cadence reported null and the surface had to explain
   * the null away. A lane with two observations has a longest gap.
   */
  longestGapSeconds: number | null;
  /** The longest gap as a multiple of the configured interval. */
  longestGapIntervals: number | null;
  /**
   * What the WORST gap alone skipped: `missedFiresInGap(longestGap, interval)`.
   *
   * The same rule and the same arithmetic as `missedFires`, applied to one gap
   * instead of summed over all of them — so the two cannot disagree. Because
   * the longest gap is by definition the largest, this is 0 exactly when
   * `missedFires` is 0.
   */
  longestGapMissedFires: number | null;
  /**
   * Did even the worst gap skip nothing? DERIVED, never thresholded.
   *
   * `longestGapMissedFires === 0`, which is the missed-fire rule's own answer to
   * the missed-fire rule's own question. It is deliberately NOT a comparison
   * against `coverageGapMultiplier`: that was BUG-11, where a lane that skipped
   * exactly one daily fire read as out of cadence here and as nothing at all
   * there, from one 48.91 h gap.
   */
  longestGapWithinCadence: boolean | null;
  /**
   * What the pair above answers, what it tolerates, and what it does NOT judge.
   *
   * Carried as prose because the field is a boolean that a surface will colour:
   * "a fire was skipped" is not "this lane is failing", and the coverage RATE
   * against its own bar is the only thing that says the latter.
   */
  longestGapBasis: string;
  /**
   * True when more gaps qualified than were read back, so `missedFires` is a
   * floor. Said rather than silently rounded off.
   */
  incomplete: boolean;
  /** How the numbers were arrived at, or why they are null. Never empty. */
  basis: string;
}

/**
 * Several lanes silent over the same window — one process outage.
 *
 * Reported as ONE finding because that is what it is. The alternative, which is
 * what a per-lane check alone produces, is N findings for one fault, and the
 * operator has to reconstruct the correlation by eye from timestamps.
 */
export interface PipelineOutage {
  /** The last lane to go silent — the outage cannot have started before this. */
  startedAt: string;
  /** The first lane to come back — it cannot have ended after this. */
  endedAt: string;
  seconds: number;
  lanes: string[];
  /** Spread of the lanes' final observations. Small = one process died. */
  stopSpreadSeconds: number;
  /** Spread of their first observations after. Small = one process restarted. */
  resumeSpreadSeconds: number;
}

export type PipelineFindingKind =
  | "lane-never-ran"
  | "lane-stalled"
  | "lane-overdue"
  | "lane-all-batches-failing"
  | "lane-yield-collapsed"
  /** The lane is scheduled but leaves no trace, so we cannot tell if it ran. */
  | "lane-unobservable"
  /** It ran, but measurably less often than it was configured to. */
  | "lane-coverage-shortfall"
  /** Several lanes stopped and resumed together: one process, not N lanes. */
  | "pipeline-outage";

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
  /** Did it run as often as CONFIGURED. Always present; always honest about nulls. */
  coverage: LaneCoverage;
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
  /** Windows where lanes went silent TOGETHER. One process, not N lanes. */
  outages: PipelineOutage[];
  /**
   * Lanes the scheduler runs that leave no trace we can read. Not a fault about
   * the fleet and not necessarily a fault at all — but never reportable as
   * healthy, because we did not look.
   */
  unobservableLanes: string[];
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
  /**
   * Aggregated observation history per lane, for configured-cadence coverage.
   *
   * Separate from `runs` because the two need different windows. `runs` is
   * capped per lane so a median is cheap to compute; 40 `status` rows span 80
   * minutes, which cannot answer a coverage question over 14 days. Omitted means
   * coverage is simply not measured, and every lane says so rather than
   * reporting a zero.
   */
  observations?: readonly LaneObservations[];
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
 * The observed cadence for a lane we can only see through the data it writes.
 *
 * `measureCadence` needs the runs themselves; a table-sourced lane has no run
 * rows, so its rhythm comes from the aggregate instead. Same question, same
 * vocabulary, different evidence — and the evidence is named in `basis` so an
 * operator can tell which one they are reading.
 */
export function cadenceFromObservations(obs: LaneObservations | undefined): LaneCadence {
  if (!obs || obs.count === 0) {
    return { seconds: null, confidence: "unknown", basis: "no runs recorded" };
  }
  if (obs.count === 1 || obs.medianGapSeconds === null) {
    return {
      seconds: null,
      confidence: "unknown",
      basis: `only ${obs.count} observation in ${obs.source}, so there is no gap to measure`,
    };
  }
  return {
    seconds: obs.medianGapSeconds,
    confidence: obs.count - 1 >= PIPELINE_HEALTH_DEFAULTS.minGapsForMeasuredCadence
      ? "measured"
      : "provisional",
    basis: `median of ${obs.count - 1} gaps between ${obs.count} rows in ${obs.source}`,
  };
}

/** Seconds of `[startedAt, endedAt)` that fall inside any of `windows`. */
function overlapSeconds(
  gap: { startedAt: Date; endedAt: Date },
  windows: ReadonlyArray<{ start: number; end: number }>,
): number {
  const from = gap.startedAt.getTime();
  const to = gap.endedAt.getTime();
  let total = 0;
  for (const w of windows) {
    const lo = Math.max(from, w.start);
    const hi = Math.min(to, w.end);
    if (hi > lo) total += (hi - lo) / 1000;
  }
  return total;
}

/**
 * Find windows where several lanes were silent TOGETHER.
 *
 * "Together" is the whole claim, so it is made on two pieces of evidence rather
 * than one: at least `outageMinLanes` distinct lanes, AND their last
 * observations clustered inside `outageClusterSeconds`. Independent lane faults
 * do not stop within two minutes of each other; a dying process does.
 *
 * Pure. Gaps may arrive in any order and from any mix of lanes.
 */
export function correlateOutages(
  gapsByLane: ReadonlyArray<{ lane: string; startedAt: Date; endedAt: Date; seconds: number }>,
  thresholds: typeof PIPELINE_HEALTH_DEFAULTS = PIPELINE_HEALTH_DEFAULTS,
): PipelineOutage[] {
  const sorted = [...gapsByLane].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const outages: PipelineOutage[] = [];

  let cluster: typeof sorted = [];
  const flush = (): void => {
    const lanes = [...new Set(cluster.map((g) => g.lane))].sort();
    if (lanes.length < thresholds.outageMinLanes) return;
    // The outage can only be claimed for the window every member was silent:
    // it started no earlier than the LAST lane to stop, and ended no later than
    // the FIRST to come back. Claiming the union would overstate it.
    const stops = cluster.map((g) => g.startedAt.getTime());
    const resumes = cluster.map((g) => g.endedAt.getTime());
    const startedAt = Math.max(...stops);
    const endedAt = Math.min(...resumes);
    if (endedAt <= startedAt) return;
    outages.push({
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      seconds: (endedAt - startedAt) / 1000,
      lanes,
      stopSpreadSeconds: (Math.max(...stops) - Math.min(...stops)) / 1000,
      resumeSpreadSeconds: (Math.max(...resumes) - Math.min(...resumes)) / 1000,
    });
  };

  for (const gap of sorted) {
    const last = cluster[cluster.length - 1];
    if (
      last &&
      (gap.startedAt.getTime() - last.startedAt.getTime()) / 1000 > thresholds.outageClusterSeconds
    ) {
      flush();
      cluster = [];
    }
    cluster.push(gap);
  }
  flush();
  return outages.sort((a, b) => b.seconds - a.seconds);
}

/**
 * THE missed-fire rule, in one function: a gap of N configured intervals means
 * N-1 scheduled fires went missing.
 *
 * Floor, not round, because a missed fire has to be CERTAIN before it is
 * counted — which is what keeps `data-usage`'s normal 24.30 h day (1.01x its
 * configured day) at zero and makes its 48.91 h gap (2.04x) exactly one.
 *
 * Exported and used everywhere the question "did a scheduled fire go missing?"
 * is asked: the per-gap sum (`missedFires`), the worst gap's own count
 * (`longestGapMissedFires`) and therefore `longestGapWithinCadence`. One
 * question, one authority. BUG-11 was what happens without that — a second
 * mechanism comparing the same gap to a multiplier of its own and answering the
 * opposite.
 */
export function missedFiresInGap(gapSeconds: number, intervalSeconds: number): number {
  if (!(intervalSeconds > 0)) return 0;
  return Math.max(0, Math.floor(gapSeconds / intervalSeconds) - 1);
}

/**
 * Did this lane run as often as it was configured to?
 *
 * Pure. Returns nulls with a stated reason wherever it cannot answer, which is
 * the point: three of our sixteen lanes record nothing at all, and a 0% for
 * those would be a fabricated measurement.
 *
 * The span is the lane's OWN first-to-last observation, not the whole lookback.
 * Time after a lane stopped is not a coverage question — it is a stall, which
 * the cadence check already owns and reports with its own age and threshold.
 * Counting it here as well would double-report one fault and reduce coverage to
 * "was the daemon up", which is the outage finding's job.
 *
 * It takes NO thresholds, and that is the signature saying so. It used to take
 * `PIPELINE_HEALTH_DEFAULTS` and use it for one word of prose about the SQL
 * read-back floor; the rest of this function has exactly one authority — the
 * missed-fire rule — and an unused threshold parameter is how a second opinion
 * grows back (BUG-11 was a second opinion). Read-back provenance arrives with
 * the observations, in `gapFloorSeconds`, where the read that applied it can be
 * held to it.
 */
export function measureConfiguredCoverage(
  expectation: Pick<ExpectedLane, "intervalSeconds" | "observability"> | undefined,
  obs: LaneObservations | undefined,
  outages: readonly PipelineOutage[] = [],
): LaneCoverage {
  const interval = expectation?.intervalSeconds ?? null;
  const blank = (basis: string): LaneCoverage => ({
    configuredIntervalSeconds: interval,
    source: obs?.source ?? null,
    observed: obs?.count ?? null,
    expected: null,
    ratio: null,
    ratioExcludingOutages: null,
    spanSeconds: null,
    outageSeconds: null,
    missedFires: null,
    missedFiresOutsideOutages: null,
    // Not `true`: there is no count, so calling it exact would claim a figure.
    missedFiresExact: null,
    longestGapSeconds: null,
    longestGapIntervals: null,
    longestGapMissedFires: null,
    longestGapWithinCadence: null,
    // Unknown, not "within cadence": with no measurable span there is no gap to
    // have skipped anything, and `false` would accuse while `true` would clear.
    longestGapBasis: `no gap was measured, so whether a scheduled fire went missing is UNKNOWN: ${basis}`,
    incomplete: obs?.gapsTruncated ?? false,
    basis,
  });

  const observability = expectation?.observability ?? { kind: "poller-runs" };
  if (observability.kind === "none") {
    return blank(
      `UNKNOWN, not zero: this lane cannot be observed at all — ${observability.why}. ` +
        `Its coverage is not 0%; it is unmeasured.`,
    );
  }
  if (interval === null) {
    return blank(
      "no configured interval is declared for this lane, so there is nothing to " +
        "measure coverage against. Declare it in src/pipeline/lanes/registry.ts.",
    );
  }
  if (!obs) {
    return blank(
      "no observation history was supplied for this lane, so coverage was not measured.",
    );
  }
  if (obs.count === 0) {
    return blank(
      `no rows in ${obs.source} for the assessed window. Nothing ran, so there is no ` +
        `RATE to report — the finding is that it never ran, not that it ran 0% of the time.`,
    );
  }
  if (obs.count === 1 || !obs.firstAt || !obs.lastAt) {
    return blank(
      `one row in ${obs.source}, so there is no span to measure a rate over.`,
    );
  }

  const spanSeconds = (obs.lastAt.getTime() - obs.firstAt.getTime()) / 1000;
  const windows = outages.map((o) => ({
    start: new Date(o.startedAt).getTime(),
    end: new Date(o.endedAt).getTime(),
  }));

  let outageSeconds = 0;
  let missedFiresOverGaps = 0;
  let missedFiresOutsideOutages = 0;
  let longestReadBackGapSeconds = 0;
  for (const gap of obs.gaps) {
    const shared = overlapSeconds(gap, windows);
    outageSeconds += shared;
    longestReadBackGapSeconds = Math.max(longestReadBackGapSeconds, gap.seconds);
    // The one missed-fire rule, for every gap. See `missedFiresInGap`.
    const skipped = missedFiresInGap(gap.seconds, interval);
    missedFiresOverGaps += skipped;
    // An outage can only excuse as many fires as it had ROOM for, quantised to
    // whole intervals — not a proportional share of the gap.
    //
    // Subtracting the raw overlap was wrong for coarse lanes and it hid a real
    // fault: `data-usage` is daily, its 48.91 h gap skipped exactly one fire,
    // and roughly an hour of scattered outage inside that two-day window was
    // enough to make 48.91 - 1 fall under 2x and excuse it entirely. An hour of
    // downtime cannot swallow a daily fire. Quantising asks the right question —
    // how many whole fires could this outage have eaten — and leaves the 22.28 h
    // hole in a 2-minute lane fully excused, which is correct.
    missedFiresOutsideOutages += Math.max(0, skipped - Math.floor(shared / interval));
  }

  // THE longest gap, for every lane with two observations — `maxGapSeconds` is
  // aggregated with no read-back floor, so an on-cadence lane now has a figure
  // instead of a null the surface had to explain. The fallback to the read-back
  // gaps is for a source that does not report the aggregate (a stub, an older
  // caller); it degrades to the old meaning rather than to a fabricated zero.
  const longestGapSeconds =
    obs.maxGapSeconds ?? (obs.gaps.length > 0 ? longestReadBackGapSeconds : null);

  // The smallest gap the missed-fire rule can count, in seconds: at 2x,
  // floor(gap / interval) - 1 first reaches 1. Derived from the rule itself, NOT
  // a threshold and not a knob — `coverageGapMultiplier` is the SQL read-back
  // floor and is deliberately not consulted here. Anything below this cannot
  // have skipped a fire, which is why a lane whose longest gap is 1.99x is
  // within cadence as a matter of arithmetic rather than tolerance.
  const countableGapSeconds = 2 * interval;

  // The worst gap's verdict, from the SAME rule that produced the per-gap sum
  // rather than from a threshold of its own. Three consequences worth stating
  // because they are what BUG-11 lacked:
  //
  //   - `longestGapMissedFires === 0` exactly when `missedFires === 0`. The
  //     longest gap is the largest, so if any gap skipped a fire this one did;
  //     and `missedFires` is floored at this count below, so the two mechanisms
  //     cannot diverge even if the source read back a coarser set of gaps than
  //     the rule can count.
  //   - it is now answered for EVERY measurable lane, including one with no gap
  //     over the read-back floor: its longest gap is a real number below
  //     `countableGapSeconds`, so the rule returns 0 and "within cadence" is the
  //     rule's own answer about a measured gap rather than an inference from an
  //     empty array. On the local corpus that is ten lanes at a 420 h window,
  //     `data-usage` among them (longest gap 86,447.65 s = 1.0006x its day).
  //   - nothing flips: a gap below 2x scored 0 before and scores 0 now. What
  //     changed is that the figure the 0 rests on is visible.
  const longestGapMissedFires =
    longestGapSeconds === null ? 0 : missedFiresInGap(longestGapSeconds, interval);
  const longestGapWithinCadence = longestGapMissedFires === 0;
  // Never less than what the worst gap alone proves. A no-op whenever the source
  // read back every countable gap (which `laneObservations` does: its floor is
  // `>= 2x`), and the guard that keeps the identity above true when it did not.
  const missedFires = Math.max(missedFiresOverGaps, longestGapMissedFires);
  // Exactness is a FACT about the read, not an assumption: the floor has to have
  // been at or below the first countable gap, and nothing may have been dropped
  // by the cap. An unreported floor is unknown, never "exact".
  const missedFiresExact =
    obs.gapFloorSeconds == null
      ? null
      : obs.gapFloorSeconds <= countableGapSeconds && !obs.gapsTruncated;
  const gapQuestion =
    `This answers "did a scheduled fire go missing", by floor(gap / interval) - 1 — the ` +
    `same rule as missedFires, not a separate threshold. It does NOT judge the lane: a ` +
    `skipped fire and a coverage rate below its bar are different claims, and only the ` +
    `rate is a verdict.`;

  const expected = Math.floor(spanSeconds / interval) + 1;
  const spanExcludingOutages = Math.max(0, spanSeconds - outageSeconds);
  const expectedExcludingOutages = Math.floor(spanExcludingOutages / interval) + 1;
  const ratio = Math.min(1, obs.count / Math.max(1, expected));
  const ratioExcludingOutages = Math.min(1, obs.count / Math.max(1, expectedExcludingOutages));

  return {
    configuredIntervalSeconds: interval,
    source: obs.source,
    observed: obs.count,
    expected,
    ratio,
    ratioExcludingOutages,
    spanSeconds,
    outageSeconds,
    missedFires,
    missedFiresOutsideOutages,
    missedFiresExact,
    longestGapSeconds,
    longestGapIntervals: longestGapSeconds === null ? null : longestGapSeconds / interval,
    longestGapMissedFires,
    longestGapWithinCadence,
    longestGapBasis:
      (longestGapSeconds === null
        ? `no interval between observations could be measured in ${obs.source}, so nothing ` +
          `is shown to have gone missing. `
        : `the longest gap in ${obs.source} is ${formatDuration(longestGapSeconds)}, ` +
          `${(longestGapSeconds / interval).toFixed(2)}x the configured ` +
          `${formatDuration(interval)} cadence, and it skipped ` +
          `${longestGapMissedFires} scheduled fire(s)` +
          (longestGapMissedFires === 0
            ? ` — under 2x, which is where the rule starts counting, so across ` +
              `${obs.count} observation(s) none can have gone missing. `
            : `. `)) + gapQuestion,
    incomplete: obs.gapsTruncated,
    basis:
      `${obs.count} row(s) in ${obs.source} over ${formatDuration(spanSeconds)}, against ` +
      `${expected} implied by a configured ${formatDuration(interval)} cadence` +
      (outageSeconds > 0
        ? ` (${formatDuration(outageSeconds)} of that span fell inside a correlated ` +
          `daemon outage and is excluded from the adjusted figure)`
        : "") +
      // Exact or floor, always stated — the two used to look identical.
      (missedFiresExact === true
        ? `. ${missedFires} missed fire(s), an exact count: every gap of 2x the interval ` +
          `or more was read back`
        : missedFiresExact === null
          ? `. At least ${missedFires} missed fire(s) — the source did not report which ` +
            `gaps it read back, so this is a floor`
          : obs.gapsTruncated
            ? `. At least ${missedFires} missed fire(s): more gaps qualified than were read, ` +
              `so this is a floor`
            : `. At least ${missedFires} missed fire(s): gaps were read back only above ` +
              `${formatDuration(obs.gapFloorSeconds ?? 0)}, which is coarser than the 2x ` +
              `(${formatDuration(countableGapSeconds)}) at which a fire can be shown ` +
              `missing, so this is a floor`),
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
    observations = [],
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
  const observedByName = new Map(observations.map((o) => [o.lane, o]));
  // Union: everything we expect, plus anything that has actually run or written.
  // A lane added in code but not in the roster must still be watched, and a lane
  // we only know about through the data it writes must still appear.
  const laneNames = [
    ...new Set([...expectedByName.keys(), ...byLane.keys(), ...observedByName.keys()]),
  ].sort();

  // Correlate BEFORE assessing lanes, because whether a lane's coverage hole is
  // its own fault depends on whether the whole daemon was down at the time. Only
  // unambiguous silence — 3x a lane's configured interval — is admitted as
  // evidence of an outage.
  const outages = correlateOutages(
    laneNames.flatMap((lane) => {
      const interval = expectedByName.get(lane)?.intervalSeconds ?? null;
      const obs = observedByName.get(lane);
      if (interval === null || !obs) return [];
      return obs.gaps
        .filter((g) => g.seconds > interval * thresholds.outageSilenceMultiplier)
        .map((g) => ({ lane, startedAt: g.startedAt, endedAt: g.endedAt, seconds: g.seconds }));
    }),
    thresholds,
  );

  const lanes = laneNames.map((lane) =>
    assessLane(lane, byLane.get(lane) ?? [], expectedByName.get(lane), {
      now,
      optInEnabled,
      thresholds,
      observations: observedByName.get(lane),
      outages,
    }),
  );

  const findings = [...lanes.flatMap((l) => l.findings), ...outageFindings(outages, thresholds)]
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
    outages,
    unobservableLanes: lanes
      .filter((l) => l.findings.some((f) => f.kind === "lane-unobservable"))
      .map((l) => l.lane),
    summary: summarise(lanes, findings, stalled, outages),
  };
}

/**
 * One finding per correlated outage, not one per lane per outage.
 *
 * The improvement this buys an operator is a sentence they would otherwise have
 * to derive from timestamps by eye: "this is one process outage, not eleven lane
 * failures". It is only claimed where the evidence supports it — see
 * `correlateOutages` for the two conditions.
 */
function outageFindings(
  outages: readonly PipelineOutage[],
  thresholds: typeof PIPELINE_HEALTH_DEFAULTS,
): PipelineFinding[] {
  if (outages.length === 0) return [];
  const worst = outages[0]!;
  const totalSeconds = outages.reduce((sum, o) => sum + o.seconds, 0);
  const affected = [...new Set(outages.flatMap((o) => o.lanes))].sort();
  return [
    {
      kind: "pipeline-outage",
      scope: "vfi-pipeline",
      // Not "lane"-scoped: the point is that no single lane owns this.
      lane: "(whole pipeline)",
      severity: worst.seconds > 4 * 3600 ? "high" : "medium",
      headline:
        outages.length === 1
          ? `${worst.lanes.length} lanes stopped and resumed together for ` +
            `${formatDuration(worst.seconds)} — one process outage`
          : `${outages.length} correlated outages totalling ` +
            `${formatDuration(totalSeconds)} across ${affected.length} lanes`,
      detail:
        `The longest ran ${worst.startedAt} to ${worst.endedAt} ` +
        `(${formatDuration(worst.seconds)}) and covered ${worst.lanes.join(", ")}. Those ` +
        `lanes' last observations are spread over ` +
        `${formatDuration(worst.stopSpreadSeconds)} and their first observations after it ` +
        `over ${formatDuration(worst.resumeSpreadSeconds)} — far tighter than any lane ` +
        `interval, so this is the DAEMON stopping, not ${worst.lanes.length} independent ` +
        `collectors failing. Each lane's coverage is reported both raw and excluding this ` +
        `time, because judging a lane on a hole the whole process shared would produce ` +
        `${affected.length} findings for one fault.`,
      dataImpact:
        `Every lane listed has a hole of the same shape over the same window, so device ` +
        `data from all of them is missing for that period rather than wrong. Anything ` +
        `computed across it — SLA coverage, trends, uptime — is measuring our absence, ` +
        `not the fleet's.`,
      since: worst.startedAt,
    },
  ];
}

interface LaneContext {
  now: Date;
  optInEnabled?: Readonly<Record<string, boolean>> | undefined;
  thresholds: typeof PIPELINE_HEALTH_DEFAULTS;
  observations?: LaneObservations | undefined;
  outages: readonly PipelineOutage[];
}

function assessLane(
  lane: string,
  runs: readonly PollerRunRow[],
  expectation: ExpectedLane | undefined,
  { now, optInEnabled, thresholds, observations, outages }: LaneContext,
): LaneHealth {
  const feeds = expectation?.feeds ?? "whatever this lane collects";
  const observability = expectation?.observability ?? { kind: "poller-runs" };
  const coverage = measureConfiguredCoverage(expectation, observations, outages);
  const findings: PipelineFinding[] = [];

  // ── the lane leaves no trace at all ────────────────────────────────────────
  //
  // `alert-cross-check`, `retention` and `prune-raw` run on the scheduler and
  // record nothing anywhere. The old roster left them out entirely, which meant
  // the health report could not distinguish "this lane is fine" from "this lane
  // does not exist" — and two of them had, in fact, never run.
  //
  // UNKNOWN, not never-ran, and not 0%. We genuinely cannot tell whether they
  // ran; claiming a fault would be the same false-alarm mistake as flagging a
  // daily lane every day, and claiming 0% would invent a measurement. The
  // finding names the fix, which is in our own code.
  if (observability.kind === "none") {
    findings.push({
      kind: "lane-unobservable",
      scope: "vfi-pipeline",
      lane,
      // Info: this is a gap in OUR instrumentation, not evidence of a fault.
      // Raising it higher would put a permanent amber on a healthy pipeline.
      severity: "info",
      headline: `${lane} runs on the scheduler but cannot be observed`,
      detail:
        `${lane} is scheduled every ` +
        `${expectation?.intervalSeconds ? formatDuration(expectation.intervalSeconds) : "(no declared interval)"}, ` +
        `but ${observability.why}. So we cannot tell whether it has run hourly for a ` +
        `month or has never run once, and this report will not guess. It is reported as ` +
        `UNKNOWN rather than 0% (which would claim a measurement) or healthy (which ` +
        `would claim we looked).`,
      dataImpact:
        `${feeds} may be up to date or may never have been produced — we cannot tell ` +
        `from here. Treat anything downstream of this lane as unverified rather than ` +
        `stale or fresh.`,
      since: null,
    });
    return {
      lane, status: "unknown", lastRunAt: null, ageSeconds: null,
      cadence: { seconds: null, confidence: "unknown", basis: observability.why },
      runsConsidered: 0, consecutiveAllFailed: 0, consecutiveEmpty: 0,
      lastYield: null, lastRowsWritten: null, coverage, findings,
    };
  }

  // A table-sourced lane records no runs, so everything below that needs a run
  // row is unavailable for it — and reported as null rather than as zero. Its
  // freshness and rhythm come from the data it wrote instead.
  const fromTable = observability.kind === "table";
  const cadence = fromTable ? cadenceFromObservations(observations) : measureCadence(runs, thresholds);
  const observedCount = fromTable ? (observations?.count ?? 0) : runs.length;
  const lastObservedAt = fromTable ? (observations?.lastAt ?? null) : (runs[0]?.startedAt ?? null);

  // ── never ran ──────────────────────────────────────────────────────────────
  if (observedCount === 0 || lastObservedAt === null) {
    const flag = expectation?.optInEnv;
    const flagState = flag && optInEnabled ? optInEnabled[lane] : undefined;

    if (flag && flagState === false) {
      // Off by choice. Not a fault — but not silence either: the report still
      // says the data is absent, because "no rows" and "off" look identical on
      // a dashboard and mean very different things.
      return {
        lane, status: "disabled", lastRunAt: null, ageSeconds: null, cadence,
        runsConsidered: 0, consecutiveAllFailed: 0, consecutiveEmpty: 0,
        lastYield: null, lastRowsWritten: null, coverage, findings: [],
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
        `No run of ${lane} has ever been recorded` +
        (fromTable ? ` in ${observability.table}.${observability.timeColumn}` : "") +
        `.` +
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
      lastYield: null, lastRowsWritten: null, coverage, findings,
    };
  }

  const latest = runs[0];
  const ageSeconds = Math.max(0, (now.getTime() - lastObservedAt.getTime()) / 1000);

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
          `${lastObservedAt.toISOString()}. With a single run there is no cadence to ` +
          `compare against, so this is judged against a ` +
          `${formatDuration(thresholds.singleRunStaleSeconds)} ceiling rather than a multiple ` +
          `of its own interval.`,
        dataImpact: stallImpact(lane, feeds, lastObservedAt, ageSeconds),
        since: iso(lastObservedAt),
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
          `${lastObservedAt.toISOString()}.`,
        dataImpact: stallImpact(lane, feeds, lastObservedAt, ageSeconds),
        since: iso(lastObservedAt),
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
        since: iso(lastObservedAt),
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
  if (consecutiveAllFailed > 0 && latest) {
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

  // ── (d) it ran, but less often than it was configured to ───────────────────
  //
  // Judged on coverage EXCLUDING correlated outage time. The raw figure over the
  // local history is 60-80% for nearly every lane, and that is one intermittently
  // dead daemon rather than eleven broken collectors — reporting the raw number
  // per lane would put eleven findings on the board for one fault, which is how
  // a self-check stops being read.
  //
  // Two conditions, not one: the rate must be short AND at least one fire must
  // demonstrably have been skipped outside an outage. The second is what keeps a
  // daily lane quiet — `data-usage`'s 24.00/24.01/24.30 h gaps skip nothing.
  const coverageFinding =
    coverage.ratioExcludingOutages !== null &&
    coverage.ratioExcludingOutages < thresholds.minConfiguredCoverage &&
    (coverage.missedFiresOutsideOutages ?? 0) > 0
      ? coverageShortfallFinding(lane, feeds, coverage, thresholds)
      : null;
  if (coverageFinding) findings.push(coverageFinding);

  const status: LaneStatus =
    consecutiveAllFailed > 0
      ? "failing"
      : cadenceStatus !== "healthy" && cadenceStatus !== "unknown"
        ? cadenceStatus
        : yieldFinding
          ? "collapsed"
          : coverageFinding
            // Reusing `overdue` rather than inventing a status: a lane running
            // below its configured rate IS behind its cadence, and a new enum
            // value would silently render as unknown in every consumer.
            ? "overdue"
            : cadenceStatus;

  return {
    lane,
    status,
    lastRunAt: iso(lastObservedAt),
    ageSeconds,
    cadence,
    runsConsidered: observedCount,
    consecutiveAllFailed,
    consecutiveEmpty,
    // Honest nulls: a table-sourced lane records no batches and no yield, so
    // these are unknown rather than zero.
    lastYield: latest?.telemetryYield ?? null,
    lastRowsWritten: latest?.rowsWritten ?? null,
    coverage,
    findings,
  };
}

/** "It ran, but not as often as configured" — stated in intervals, not minutes. */
function coverageShortfallFinding(
  lane: string,
  feeds: string,
  coverage: LaneCoverage,
  thresholds: typeof PIPELINE_HEALTH_DEFAULTS,
): PipelineFinding {
  const pct = (r: number | null): string => (r === null ? "unknown" : `${(r * 100).toFixed(1)}%`);
  const interval = coverage.configuredIntervalSeconds ?? 0;
  const missed = coverage.missedFiresOutsideOutages ?? 0;
  return {
    kind: "lane-coverage-shortfall",
    scope: "vfi-pipeline",
    lane,
    severity: (coverage.ratioExcludingOutages ?? 1) < 0.5 ? "high" : "medium",
    headline:
      `${lane} ran at ${pct(coverage.ratioExcludingOutages)} of its configured ` +
      `${formatDuration(interval)} cadence`,
    detail:
      `${coverage.basis}. Raw coverage ${pct(coverage.ratio)}; ` +
      `${pct(coverage.ratioExcludingOutages)} once time inside a correlated daemon outage ` +
      `is excluded, which is the figure judged against the ` +
      `${(thresholds.minConfiguredCoverage * 100).toFixed(0)}% floor. ` +
      `At least ${missed} scheduled fire(s) were skipped outside any outage` +
      // The worst gap's skipped count is quoted from `longestGapMissedFires`,
      // which is the same rule as the total above: a reader who sees that gap
      // flagged on a lane card must find the identical number here.
      (coverage.longestGapIntervals !== null
        ? `, the worst gap being ${coverage.longestGapIntervals.toFixed(1)}× its configured ` +
          `interval and skipping ${coverage.longestGapMissedFires} of them`
        : "") +
      `. The lane is alive and its last run is recent, so nothing else here flags it.`,
    dataImpact:
      `${feeds} exists but is sampled more coarsely than intended, so anything computed ` +
      `per interval over it — coverage, uptime, trends — is built on ` +
      `${pct(coverage.ratioExcludingOutages)} of the samples it assumes. That is a ` +
      `resolution problem, not a staleness one, and it does not show up as either.`,
    since: null,
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
  outages: readonly PipelineOutage[],
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
  // Said explicitly, because it is the difference between one thing to fix and
  // a page of them: correlated silence is the daemon, not the lanes.
  const outageClause = ((): string => {
    if (outages.length === 0) return "";
    const lanes = [...new Set(outages.flatMap((o) => o.lanes))].length;
    const hours = formatDuration(outages.reduce((sum, o) => sum + o.seconds, 0));
    return outages.length === 1
      ? ` The ${formatDuration(outages[0]!.seconds)} hole in ${outages[0]!.lanes.length} lanes ` +
        `is ONE process outage, not ${outages[0]!.lanes.length} lane failures.`
      : ` ${hours} of the silence below is ${outages.length} CORRELATED outages across ` +
        `${lanes} lanes — the daemon stopping and restarting, not ${lanes} broken collectors.`;
  })();
  return stalled.length === 0
    ? head + outageClause
    : `${head} ${stalled.length} lane(s) have stopped, so the device data they feed is ` +
      `stale — treat the console as a snapshot for those areas.` + outageClause;
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
 * Read the run history and assess it.
 *
 * TWO reads, deliberately, because the two questions need different windows:
 *
 *   `pollerRunHistory`  — the last N runs per lane, row by row, for the OBSERVED
 *                         cadence, the batch outcomes and the yield.
 *   `laneObservations`  — aggregates over the whole window for CONFIGURED
 *                         coverage. 40 `status` rows span 80 minutes, which
 *                         cannot answer "did it run as often as configured" over
 *                         14 days, and pulling every row would be ~9,000
 *                         timestamps for a four-number answer.
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
  const expectedLanes = expectedLanesFor(env);
  const runs = await repo.pollerRunHistory({ lookbackHours, runsPerLane });

  // Gap floors are PER LANE and relative to each lane's configured interval —
  // the one thing an absolute floor cannot do. A flat 15 minutes would treat
  // `data-usage`'s normal day as a hole and miss every one of `status`'s.
  const minGapSeconds: Record<string, number> = {};
  for (const lane of expectedLanes) {
    if (lane.intervalSeconds) {
      minGapSeconds[lane.lane] =
        lane.intervalSeconds * PIPELINE_HEALTH_DEFAULTS.coverageGapMultiplier;
    }
  }

  // Coverage is additive: if this read fails, every lane reports coverage
  // `unknown` with a reason and the rest of the report still stands. A
  // self-check that goes blank because one of its two inputs is unavailable is
  // worse than one that says which half it is missing.
  let observations: LaneObservations[] = [];
  let coverageError: string | null = null;
  try {
    observations =
      typeof repo.laneObservations === "function"
        ? await repo.laneObservations({
            lookbackHours,
            minGapSeconds,
            tableSources: laneTableSources(),
          })
        : [];
    // A lane with no rows at all returns no row at all, which reads as "we did
    // not look" rather than "we looked and it is empty". Those are different
    // claims and the difference is the whole point of this module, so an empty
    // observation is made explicit — naming the source that was checked.
    if (observations.length > 0) {
      const seen = new Set(observations.map((o) => o.lane));
      for (const decl of LANE_REGISTRY) {
        if (seen.has(decl.lane) || decl.observability.kind === "none") continue;
        observations.push({
          lane: decl.lane,
          source:
            decl.observability.kind === "table"
              ? `${decl.observability.table}.${decl.observability.timeColumn}`
              : "poller_runs",
          count: 0,
          firstAt: null,
          lastAt: null,
          medianGapSeconds: null,
          maxGapSeconds: null,
          gaps: [],
          // No read happened for this lane, so there is no floor to report.
          // Coverage is blank for a zero-count lane anyway, and a floor quoted
          // for a read that did not occur would be provenance for nothing.
          gapFloorSeconds: null,
          gapsTruncated: false,
        });
      }
    }
  } catch (error) {
    coverageError = error instanceof Error ? error.message : "unknown error";
  }

  const optInEnabled: Record<string, boolean> = {};
  for (const decl of LANE_REGISTRY) {
    const state = laneOptInState(decl, env);
    if (state !== undefined) optInEnabled[decl.lane] = state;
  }

  const report = assessPipelineHealth(runs, { now, expectedLanes, optInEnabled, observations });
  return coverageError === null
    ? report
    : {
        ...report,
        summary:
          `${report.summary} Configured-cadence coverage could not be read ` +
          `(${coverageError}), so every lane's coverage below is unknown rather than zero.`,
      };
}
