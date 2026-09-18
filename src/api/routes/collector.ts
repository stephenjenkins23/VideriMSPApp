/**
 * Collector availability — the denominator behind every other number we serve.
 *
 *   GET /api/collector/availability?windowHours=&bucketSeconds=
 *
 * WHY THIS EXISTS (docs/18 §6.5)
 * Fleet-wide, across the measured week, only 1,561 of 2,016 possible five-minute
 * buckets carried a reading from any screen — the collector was up 77% of the
 * week, ≈38 h with no reading from ANY device. So no availability figure over
 * that window is defensible for any device at any grade, and the cause is OURS:
 * we were not looking. Publishing an uptime number over a window we did not
 * cover would be a fabricated figure attributed to Videri's platform.
 *
 * That makes collector availability a GATE, not a footnote, and it has to be
 * readable in the product rather than in SQL. This endpoint is that surface.
 *
 * WHAT IT DOES NOT DO: MEASURE ANYTHING ITSELF
 * Every number below is read from the engines that already own it. That is a
 * hard rule here, not tidiness: a second definition of "observed" is how one
 * endpoint clears a gate the next one fails, and a commit two hours before this
 * file removed exactly that class of bug (`Figure<T>` existed three ways).
 *
 *   per-lane coverage      `alerting/pipeline-health.ts` — `measureConfiguredCoverage`,
 *                          via `loadPipelineHealth`, whose span is each lane's OWN
 *                          first→last observation and whose thresholds are all
 *                          multiples of the lane's CONFIGURED interval.
 *   the lane roster        `pipeline/lanes/registry.ts` — the same declaration
 *                          `run-poller.ts` builds its task list from, so a lane
 *                          the scheduler runs cannot be missing from this page.
 *   outage correlation     `correlateOutages`, again via `loadPipelineHealth`.
 *   the fleet figure       `ReadQueries.availabilityBuckets().fleetObservedBuckets`
 *                          — distinct buckets in which any active device reported
 *                          presence. Already documented there as "the collector's
 *                          own uptime for the window", already the denominator the
 *                          SLA report divides by, and it reproduces docs/18's
 *                          1,561/2,016 to within one boundary bucket (measured:
 *                          1,562 for the 7 days to 2026-09-04 11:00 -04).
 *   the bars               `SLA_GRADE_BARS` in `sla/measurability.ts`.
 *
 * This file's own work is the four things none of those do: reshape per lane,
 * aggregate fleet-wide, aggregate the correlation into one sentence, and issue a
 * VERDICT against the bars that refuses rather than reporting a low number.
 *
 * THE FOUR WAYS A SURFACE LIKE THIS GOES WRONG, AND WHERE EACH IS HANDLED
 *   1. A daily lane's normal cadence reads as an outage. `data-usage`'s gaps are
 *      24.000 / 24.013 / 24.300 h — a daily lane working perfectly — and only its
 *      48.910 h gap is a miss. Gap sizes are therefore reported in MULTIPLES of
 *      the lane's configured interval (`longestGapIntervals`), and both
 *      `longestGapWithinCadence` and `longestGapMissedFires` are READ FROM
 *      `measureConfiguredCoverage`, whose one missed-fire rule (floor of
 *      gap/interval, minus one) is the only thing here entitled to say a fire
 *      went missing. An operator trained to ignore a daily false alarm ignores
 *      the real one — and an operator shown two answers to one question ignores
 *      the page. This surface asked that question for itself until BUG-11: it
 *      compared the gap to `coverageGapMultiplier` and called `data-usage`
 *      (x2.04) out of cadence while the rule scored it as the single skipped
 *      fire it is. `longestGapBasis` now states, per lane, which question the
 *      pair answers and that it is not the coverage verdict.
 *   2. An opt-in lane that is OFF is not broken. `state: "off-by-choice"`, and it
 *      is excluded from the gating set — it is not counted as a shortfall and
 *      never as 0%.
 *   3. A lane that leaves no trace is UNKNOWN. Three of sixteen record nothing
 *      anywhere; they report `state: "unobservable"` with a null coverage value
 *      and the registry's own reason. Never 0%, never healthy.
 *   4. A window the database cannot answer is REFUSED. Collection here stopped
 *      2026-09-04, so a default one-week lookback holds nothing at all — and
 *      "0% availability" over an empty window is the most misleading number this
 *      endpoint could print. `verdict.refusal` says the window is empty and when
 *      we last heard anything, and no share is stated.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { envelope } from "../freshness.js";
import {
  loadPipelineHealth,
  expectedLanesFor,
  type ExpectedLane,
  type LaneCoverage,
  type LaneHealth,
  type LaneStatus,
  type PipelineHealthReport,
  type PipelineOutage,
} from "../../alerting/pipeline-health.js";
import {
  LANE_REGISTRY,
  laneOptInState,
  type LaneObservability,
} from "../../pipeline/lanes/registry.js";
import { SLA_GRADE_BARS, humanDuration } from "../../sla/measurability.js";
import { makeFigureOf, type Figure as SharedFigure } from "../../intelligence/figure.js";
import type { ApiContext } from "../server.js";

// ── figures: no number leaves here without its basis ─────────────────────────

/**
 * This surface's unit vocabulary. The wrapper is shared
 * (`src/intelligence/figure.ts`); only the labels are local, because the
 * denominators genuinely differ: the fleet figure counts TIME BUCKETS, a lane's
 * coverage counts scheduled FIRES, and the verdict counts LANES.
 */
export type CollectorFigureUnit = "time-buckets" | "fires" | "lanes";

const UNIT_LABEL: Record<CollectorFigureUnit, string> = {
  "time-buckets": "time bucket(s) of the window",
  fires: "scheduled fire(s) of this lane",
  lanes: "scheduled lane(s)",
};

export type CollectorFigure<T> = SharedFigure<T, CollectorFigureUnit>;

export const collectorFigureOf = makeFigureOf(UNIT_LABEL);

const pct = (share: number | null): string =>
  share === null ? "unknown" : `${(share * 100).toFixed(1)}%`;

// ── the window: half-open, always stated ─────────────────────────────────────

export interface CollectorWindow {
  /** Inclusive lower bound, ISO. */
  from: string;
  /** EXCLUSIVE upper bound, ISO. */
  to: string;
  seconds: number;
  hours: number;
  bucketSeconds: number;
  /** Buckets the window contains — the denominator for the fleet figure. */
  expectedBuckets: number;
  /** True, always. Present so a consumer never has to assume it. */
  halfOpen: true;
  statement: string;
}

/**
 * The window is a LOOKBACK ending now, because that is all the two reads behind
 * it accept (`lookbackHours`). Said explicitly rather than implied by a pair of
 * timestamps, so nobody reads this as an arbitrary historical range.
 */
export function collectorWindow(
  now: Date,
  windowHours: number,
  bucketSeconds: number,
): CollectorWindow {
  const seconds = windowHours * 3600;
  const from = new Date(now.getTime() - seconds * 1000);
  return {
    from: from.toISOString(),
    to: now.toISOString(),
    seconds,
    hours: windowHours,
    bucketSeconds,
    expectedBuckets: Math.floor(seconds / bucketSeconds),
    halfOpen: true,
    statement:
      `The ${humanDuration(seconds)} ending ${now.toISOString()}, in ` +
      `${humanDuration(bucketSeconds)} buckets — ${Math.floor(seconds / bucketSeconds)} of ` +
      `them. Half-open: ${from.toISOString()} inclusive to ${now.toISOString()} exclusive.`,
  };
}

// ── per lane ─────────────────────────────────────────────────────────────────

/**
 * What this surface can say about one lane, in its own vocabulary.
 *
 * Deliberately NOT `LaneStatus`, which answers a different question (has this
 * lane stalled or collapsed). These five values answer "can this lane carry an
 * availability claim, and if not, which of the four traps are we in":
 *
 *   measured          — observed in this window, so there is a rate to report.
 *   silent            — scheduled and observable, but nothing in this window.
 *                       NOT a rate of zero; there is no rate at all.
 *   off-by-choice     — its opt-in flag is off. Off is off, never a fault.
 *   flag-not-visible  — opt-in, the flag is unset in THIS process, and nothing
 *                       was observed. Genuinely unknowable from here: the poller
 *                       may have it set. Reported, never blamed.
 *   unobservable      — leaves no trace anywhere, so we did not look. UNKNOWN.
 */
export type LaneCollectorState =
  | "measured"
  | "silent"
  | "off-by-choice"
  | "flag-not-visible"
  | "unobservable";

export type OptInReading = "not-gated" | "on" | "off" | "not-visible";

export interface LaneAvailability {
  lane: string;
  /** What goes stale when this lane stops. One clause, from the registry. */
  feeds: string;
  state: LaneCollectorState;
  /** Cross-reference to the self-check's own verdict, so the two never diverge. */
  health: LaneStatus;
  /** The SCHEDULER's interval. Every threshold here is a multiple of it. */
  configuredIntervalSeconds: number | null;
  observability: {
    kind: LaneObservability["kind"];
    /** `poller_runs`, `fleet_snapshots.computed_at`, … Null when none exists. */
    source: string | null;
    /** Why the lane cannot be observed, verbatim from the registry. */
    why: string | null;
  };
  optIn: { env: string | null; reading: OptInReading };
  /** Fires the configured interval implies over the lane's own span. */
  expectedFires: number | null;
  observedFires: number | null;
  /** observed / expected. NULL where unmeasurable — never 0. */
  coverage: CollectorFigure<number | null>;
  /** The same, with correlated daemon-outage time removed. The fairer number. */
  coverageExcludingOutages: number | null;
  /** First to last observation. NOT the caller's window — see the header. */
  spanSeconds: number | null;
  /** That span as a share of the window. A high rate over 30% of the window
   *  evidences 30% of the window, and nothing more. */
  windowShare: number | null;
  longestGapSeconds: number | null;
  /** The longest gap in MULTIPLES of the configured interval. The daily-lane trap. */
  longestGapIntervals: number | null;
  /**
   * True when even the worst gap skipped no scheduled fire. Read verbatim from
   * `measureConfiguredCoverage`, which derives it from the missed-fire rule —
   * this surface does not compare a gap to a threshold of its own.
   */
  longestGapWithinCadence: boolean | null;
  /** How many fires the worst gap alone skipped. The boolean above is `=== 0`. */
  longestGapMissedFires: number | null;
  /** Which question the three fields above answer, and which they do not. */
  longestGapBasis: string;
  missedFires: number | null;
  missedFiresOutsideOutages: number | null;
  /** True when more gaps qualified than were read back, so misses are a floor. */
  incomplete: boolean;
  /** Can this lane carry an availability claim over this window, and if not, why. */
  claim: { claimable: boolean; shortfalls: string[] };
}

/** Is this lane's opt-in flag on, off, or invisible from this process? */
function optInReading(
  expectation: ExpectedLane | undefined,
  optInEnabled: Readonly<Record<string, boolean>>,
): OptInReading {
  if (!expectation?.optInEnv) return "not-gated";
  const state = optInEnabled[expectation.lane];
  return state === undefined ? "not-visible" : state ? "on" : "off";
}

function laneState(
  observability: LaneObservability,
  coverage: LaneCoverage,
  reading: OptInReading,
): LaneCollectorState {
  if (observability.kind === "none") return "unobservable";
  if (coverage.ratio !== null) return "measured";
  // Nothing measurable in this window. WHICH of the three silences it is depends
  // on the flag, and the difference is the whole point: "off" is a choice, "the
  // flag is not set in the API process" is unknowable, and only the third is a
  // fact about the lane.
  if (reading === "off") return "off-by-choice";
  if (reading === "not-visible") return "flag-not-visible";
  return "silent";
}

/**
 * Reshape one lane, and judge it against the bars.
 *
 * Pure. Every number comes from `coverage`, which came from
 * `measureConfiguredCoverage`; nothing is recomputed here.
 */
export function laneAvailability(
  lane: LaneHealth,
  expectation: ExpectedLane | undefined,
  window: CollectorWindow,
  optInEnabled: Readonly<Record<string, boolean>>,
  bars: typeof SLA_GRADE_BARS,
): LaneAvailability {
  const observability: LaneObservability =
    expectation?.observability ?? { kind: "poller-runs" };
  const coverage = lane.coverage;
  const reading = optInReading(expectation, optInEnabled);
  const state = laneState(observability, coverage, reading);

  const interval = coverage.configuredIntervalSeconds;
  const windowShare =
    coverage.spanSeconds === null ? null : Math.min(1, coverage.spanSeconds / window.seconds);
  const shortfalls: string[] = [];
  if (state === "unobservable") {
    shortfalls.push(
      `${lane.lane} cannot be observed at all, so its availability is UNKNOWN rather ` +
        `than low: ${observability.kind === "none" ? observability.why : ""}. Nothing ` +
        `measured here can be claimed for it, in either direction.`,
    );
  } else if (state === "off-by-choice") {
    // Not a shortfall in the fault sense, and it is excluded from the gating set
    // below. It is still stated, because a lane that is off feeds nothing, and a
    // claim that needs what it feeds cannot be made either way.
    shortfalls.push(
      `${lane.lane} is off by choice (${expectation?.optInEnv} is not set), so it ` +
        `collected nothing in this window. That is a configuration decision, not a ` +
        `fault — but ${expectation?.feeds ?? "what it feeds"} is absent all the same.`,
    );
  } else if (state === "flag-not-visible") {
    shortfalls.push(
      `${lane.lane} is opt-in behind ${expectation?.optInEnv}, which is not set in this ` +
        `process, and nothing was observed in this window. Whether it should have run is ` +
        `unknowable from here, so this is neither a measurement nor a fault.`,
    );
  } else if (state === "silent") {
    shortfalls.push(
      `${lane.lane} produced nothing in this window — ${coverage.basis} There is no RATE ` +
        `to report, so this is not 0% coverage; it is no coverage at all.`,
    );
  } else {
    if ((coverage.ratio ?? 0) < bars.minCoverage) {
      shortfalls.push(
        `${lane.lane} ran at ${pct(coverage.ratio)} of its configured ` +
          `${humanDuration(interval ?? 0)} cadence (${pct(coverage.ratioExcludingOutages)} ` +
          `once correlated daemon-outage time is excluded), against the ` +
          `${pct(bars.minCoverage)} bar.`,
      );
    }
    // A high rate over a third of the window evidences a third of the window.
    // Without this the two slow lanes that were switched on late — measured 95.1%
    // and 98.4% over their OWN spans — would read as clearing the bar for a
    // window in which they are absent for 166 h and 144 h respectively.
    if (windowShare !== null && windowShare < bars.minCoverage) {
      shortfalls.push(
        `${lane.lane}'s observations span ${humanDuration(coverage.spanSeconds ?? 0)} of the ` +
          `window (${humanDuration(window.seconds)}, ${pct(windowShare)} of it) — its rate is ` +
          `measured over that span only, and the rest of the window has no data from it. ` +
          `Coverage span is deliberately the lane's own first→last observation; the time ` +
          `outside it is a stall, reported separately.`,
      );
    }
    if (interval !== null && interval > bars.maxCadenceSeconds) {
      shortfalls.push(
        `${lane.lane}'s configured ${humanDuration(interval)} cadence is coarser than the ` +
          `${humanDuration(bars.maxCadenceSeconds)} bar, so it cannot evidence a claim at ` +
          `that resolution — by arithmetic, not by fault.`,
      );
    }
  }

  return {
    lane: lane.lane,
    feeds: expectation?.feeds ?? "whatever this lane collects",
    state,
    health: lane.status,
    configuredIntervalSeconds: interval,
    observability: {
      kind: observability.kind,
      source: coverage.source,
      why: observability.kind === "none" ? observability.why : null,
    },
    optIn: { env: expectation?.optInEnv ?? null, reading },
    expectedFires: coverage.expected,
    observedFires: coverage.observed,
    coverage: collectorFigureOf(
      coverage.ratio,
      coverage.basis,
      coverage.observed ?? 0,
      coverage.expected ?? 0,
      "fires",
      coverage.basis,
    ),
    coverageExcludingOutages: coverage.ratioExcludingOutages,
    spanSeconds: coverage.spanSeconds,
    windowShare,
    longestGapSeconds: coverage.longestGapSeconds,
    longestGapIntervals: coverage.longestGapIntervals,
    // BUG-11: this used to be recomputed here as `longestGapIntervals <
    // coverageGapMultiplier`, which is a SECOND definition of "late" — exactly
    // what this file's header forbids, and it answered the opposite of the
    // missed-fire rule for every lane that skipped exactly one fire (a gap of
    // two intervals plus scheduler jitter is always a hair over 2x). It is now
    // read, not computed.
    longestGapWithinCadence: coverage.longestGapWithinCadence,
    longestGapMissedFires: coverage.longestGapMissedFires,
    longestGapBasis: coverage.longestGapBasis,
    missedFires: coverage.missedFires,
    missedFiresOutsideOutages: coverage.missedFiresOutsideOutages,
    incomplete: coverage.incomplete,
    claim: { claimable: state === "measured" && shortfalls.length === 0, shortfalls },
  };
}

// ── outage correlation, in one sentence ──────────────────────────────────────

/**
 * The most useful thing this surface can tell an operator.
 *
 * Eleven lanes with holes of the same shape over the same window is ONE process
 * dying, and the evidence is the stop spread: across the local history it is
 * p50 0.049 SECONDS. Lanes stopping within fifty milliseconds of each other are
 * one daemon; independent faults stop minutes apart at their own next-fire
 * times. `correlateOutages` makes that claim; this only aggregates it.
 */
export interface CollectorOutageSummary {
  count: number;
  totalSeconds: number;
  lanesAffected: string[];
  /** The one to read first — the longest. */
  largest: PipelineOutage | null;
  /** Spread of the member lanes' last observations, across every outage. */
  stopSpreadSeconds: { p50: number; p90: number; max: number } | null;
  /** Of the window's blind time, how much correlated outages explain. */
  shareOfBlindTime: number | null;
  /** The sentence itself, or null when nothing correlated. */
  verdict: string | null;
}

/** Nearest-rank percentile. Small samples, so no interpolation to argue about. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

export function summariseOutages(
  outages: readonly PipelineOutage[],
  blindSeconds: number | null,
): CollectorOutageSummary {
  if (outages.length === 0) {
    return {
      count: 0,
      totalSeconds: 0,
      lanesAffected: [],
      largest: null,
      stopSpreadSeconds: null,
      shareOfBlindTime: null,
      verdict: null,
    };
  }
  const totalSeconds = outages.reduce((sum, o) => sum + o.seconds, 0);
  const largest = [...outages].sort((a, b) => b.seconds - a.seconds)[0]!;
  const spreads = outages.map((o) => o.stopSpreadSeconds).sort((a, b) => a - b);
  const lanesAffected = [...new Set(outages.flatMap((o) => o.lanes))].sort();
  return {
    count: outages.length,
    totalSeconds,
    lanesAffected,
    largest,
    stopSpreadSeconds: {
      p50: percentile(spreads, 0.5),
      p90: percentile(spreads, 0.9),
      max: spreads[spreads.length - 1]!,
    },
    shareOfBlindTime:
      blindSeconds === null || blindSeconds <= 0
        ? null
        : Math.min(1, totalSeconds / blindSeconds),
    verdict:
      `${outages.length === 1 ? "This" : `These ${outages.length} windows`} ` +
      `total ${humanDuration(totalSeconds)} across ${lanesAffected.length} lane(s), and ` +
      `${outages.length === 1 ? "it is" : "they are"} OUR PROCESS STOPPING, not ` +
      `${lanesAffected.length} lane failures. The longest covered ${largest.lanes.length} ` +
      `lanes (${largest.lanes.join(", ")}) for ${humanDuration(largest.seconds)}, and their ` +
      `last observations are spread over just ` +
      `${largest.stopSpreadSeconds.toFixed(3)} s — far tighter than any lane interval, so ` +
      `they cannot have failed independently. Fix the deployment and every lane listed ` +
      `recovers together; remediating them one by one is wasted effort.`,
  };
}

// ── the fleet figure, and the verdict ────────────────────────────────────────

export interface FleetCollectorAvailability {
  /**
   * THE number that gates every SLA claim: buckets in which any active screen
   * reported presence, over buckets the window contains.
   *
   * Null only when the window contains no buckets to divide by. An empty window
   * is 0 of N and is reported as such — with `windowHasNoObservations` set and a
   * refusal above it, because 0% here means "we were not running", not "the
   * estate was down".
   */
  collectorUp: CollectorFigure<number | null>;
  observedBuckets: number;
  blindBuckets: number;
  /** Bucket-derived, so it is a multiple of `bucketSeconds`. */
  blindSeconds: number;
  /** True when we hold nothing at all for this window. */
  windowHasNoObservations: boolean;
  /**
   * When we last heard anything, independent of the window — the only way to
   * tell an empty window from a dead fleet.
   */
  lastCollectionAt: string | null;
  blindSinceSeconds: number | null;
  /** The weakest MEASURABLE lane: the per-lane read of the acceptance criterion. */
  weakestLane: { lane: string; coverage: number } | null;
  lanes: {
    declared: number;
    measured: number;
    silent: number;
    offByChoice: number;
    flagNotVisible: number;
    unobservable: number;
    claimable: number;
  };
}

export type CollectorBlockerKind =
  | "window-has-no-observations"
  | "fleet-coverage-below-bar"
  | "lane-coverage-below-bar"
  | "lane-span-shorter-than-window"
  /** Nothing observed, and no opt-in flag to explain it. A real absence. */
  | "lane-silent"
  /** Its flag is off. Listed because what it feeds is absent; never a fault. */
  | "lane-off-by-choice"
  /** Opt-in, flag unset in this process, nothing observed. Unknowable, not broken. */
  | "lane-flag-not-visible"
  | "lane-unobservable"
  | "lane-cadence-coarser-than-bar";

export interface CollectorVerdict {
  /** Can ANY availability figure over this window be defended externally? */
  claimable: boolean;
  headline: string;
  /**
   * Whose number this is. Always stated, because a low coverage figure with no
   * attribution reads as an estate fault, and it is not one.
   */
  cause: "ours" | "the estate" | "unknown";
  bars: { minCoverage: number; maxCadenceSeconds: number };
  /** Exactly what is missing. Empty only when everything clears both bars. */
  missing: Array<{ kind: CollectorBlockerKind; subject: string; detail: string }>;
  /** Lanes that DO clear both bars over this window. Usually empty today. */
  claimableLanes: string[];
  /** Why no availability figure is stated. Null only when one can be. */
  refusal: string | null;
}

export interface CollectorAvailability {
  /** Fixed. This report is about US, and no consumer may mix it with device data. */
  scope: "vfi-collector";
  generatedAt: string;
  window: CollectorWindow;
  fleet: FleetCollectorAvailability;
  lanes: LaneAvailability[];
  outages: CollectorOutageSummary;
  verdict: CollectorVerdict;
  /** The self-check's own summary sentence, so both surfaces say one thing. */
  pipelineSummary: string;
  summary: string;
}

export interface CollectorAvailabilityInput {
  now: Date;
  window: CollectorWindow;
  /** From `loadPipelineHealth` — the ONE definition of per-lane coverage. */
  health: PipelineHealthReport;
  /** The roster, resolved against the environment whose intervals apply. */
  expectedLanes: readonly ExpectedLane[];
  optInEnabled: Readonly<Record<string, boolean>>;
  /**
   * `availabilityBuckets().fleetObservedBuckets` — distinct buckets in which any
   * active device reported presence. Reused rather than re-queried so this page
   * and the SLA report can never disagree about what "observed" means.
   */
  fleetObservedBuckets: number;
  /** `freshness.newestSampleAt`: the last thing we heard, whatever the window. */
  lastCollectionAt: string | null;
  bars?: typeof SLA_GRADE_BARS;
}

/**
 * Assemble the surface. Pure: takes the engines' output, returns the payload.
 *
 * The verdict is the point of the function. Today it refuses, and it says the
 * refusal is about us.
 */
export function buildCollectorAvailability({
  now,
  window,
  health,
  expectedLanes,
  optInEnabled,
  fleetObservedBuckets,
  lastCollectionAt,
  bars = SLA_GRADE_BARS,
}: CollectorAvailabilityInput): CollectorAvailability {
  const expectedByName = new Map(expectedLanes.map((l) => [l.lane, l]));
  const lanes = health.lanes.map((lane) =>
    laneAvailability(
      lane,
      expectedByName.get(lane.lane),
      window,
      optInEnabled,
      bars,
    ),
  );

  const observedBuckets = Math.min(fleetObservedBuckets, window.expectedBuckets);
  const blindBuckets = Math.max(0, window.expectedBuckets - observedBuckets);
  const blindSeconds = blindBuckets * window.bucketSeconds;
  const windowHasNoObservations = observedBuckets === 0;
  // NULL, not 0, when the window holds nothing. The counts are still reported —
  // 0 of 2,016 buckets is a fact — but the SHARE is deliberately not stated,
  // because a "0%" sitting in an availability slot reads as an estate outage and
  // this figure is about us. `coverage.measured/inScope` carries the counts and
  // `note` carries the reason, which is exactly what `Figure<T>` is for.
  const share =
    window.expectedBuckets === 0 || windowHasNoObservations
      ? null
      : observedBuckets / window.expectedBuckets;
  const blindSinceSeconds =
    lastCollectionAt === null
      ? null
      : Math.max(0, (now.getTime() - new Date(lastCollectionAt).getTime()) / 1000);

  const measured = lanes.filter((l) => l.state === "measured");
  const weakest = measured
    .filter((l) => l.coverage.value !== null)
    .sort((a, b) => (a.coverage.value ?? 1) - (b.coverage.value ?? 1))[0];

  const fleet: FleetCollectorAvailability = {
    collectorUp: collectorFigureOf(
      share,
      `Distinct ${humanDuration(window.bucketSeconds)} buckets in which any active screen ` +
        `reported presence (health_samples, source='status'), over the ` +
        `${window.expectedBuckets} buckets the window contains. The same count the SLA ` +
        `report divides by, so the two cannot disagree about what "observed" means. ` +
        `This is OUR uptime, not the fleet's: a blind bucket is one in which we learned ` +
        `nothing about any device, whatever the devices were doing.`,
      observedBuckets,
      window.expectedBuckets,
      "time-buckets",
      windowHasNoObservations
        ? `NO bucket in this window carried a reading from any screen. That is not 0% ` +
          `availability of the estate — it is ${humanDuration(window.seconds)} in which we ` +
          `were not looking at all` +
          (lastCollectionAt
            ? `, the last reading of any kind being ${lastCollectionAt}` +
              `${blindSinceSeconds === null ? "" : ` (${humanDuration(blindSinceSeconds)} ago)`}.`
            : ` and no reading of any kind on record.`)
        : `${observedBuckets} of ${window.expectedBuckets} buckets carried a reading from ` +
          `some screen; the other ${blindBuckets} (${humanDuration(blindSeconds)}) carried ` +
          `none from any screen and are counted as blind, never as offline.`,
    ),
    observedBuckets,
    blindBuckets,
    blindSeconds,
    windowHasNoObservations,
    lastCollectionAt,
    blindSinceSeconds,
    weakestLane:
      weakest && weakest.coverage.value !== null
        ? { lane: weakest.lane, coverage: weakest.coverage.value }
        : null,
    lanes: {
      declared: lanes.length,
      measured: measured.length,
      silent: lanes.filter((l) => l.state === "silent").length,
      offByChoice: lanes.filter((l) => l.state === "off-by-choice").length,
      flagNotVisible: lanes.filter((l) => l.state === "flag-not-visible").length,
      unobservable: lanes.filter((l) => l.state === "unobservable").length,
      claimable: lanes.filter((l) => l.claim.claimable).length,
    },
  };

  const outages = summariseOutages(health.outages, blindSeconds);
  const verdict = collectorVerdict({ window, fleet, lanes, outages, bars });

  return {
    scope: "vfi-collector",
    generatedAt: now.toISOString(),
    window,
    fleet,
    lanes,
    outages,
    verdict,
    pipelineSummary: health.summary,
    summary: verdict.headline,
  };
}

/**
 * The verdict against `SLA_GRADE_BARS`.
 *
 * Two rules it must not break, both learned from the numbers in docs/18 §6.5:
 *
 *   A REFUSAL, NOT A LOW NUMBER. The honest answer today is "nothing is
 *   claimable, because of us". Printing 20.8% and letting the reader infer the
 *   rest invites exactly the wrong inference — that the estate was down — so
 *   `refusal` and `cause` are part of the verdict rather than commentary on it.
 *
 *   "OFF" AND "UNOBSERVABLE" ARE NOT SHORTFALLS. A lane behind an unset flag and
 *   a lane that records nothing anywhere are both listed under `missing`, but
 *   with their own kinds and their own words, never as a coverage figure. A
 *   self-check that reports a deliberate configuration as a fault gets ignored,
 *   and then it reports the real fault to nobody.
 */
function collectorVerdict({
  window,
  fleet,
  lanes,
  outages,
  bars,
}: {
  window: CollectorWindow;
  fleet: FleetCollectorAvailability;
  lanes: readonly LaneAvailability[];
  outages: CollectorOutageSummary;
  bars: typeof SLA_GRADE_BARS;
}): CollectorVerdict {
  const missing: CollectorVerdict["missing"] = [];
  const fleetShare = fleet.collectorUp.value;

  if (fleet.windowHasNoObservations) {
    missing.push({
      kind: "window-has-no-observations",
      subject: "(the whole window)",
      detail:
        `We hold no reading from any screen anywhere in this window ` +
        `(${humanDuration(window.seconds)})` +
        (fleet.lastCollectionAt
          ? `. Collection last produced something at ${fleet.lastCollectionAt}` +
            `${fleet.blindSinceSeconds === null ? "" : `, ${humanDuration(fleet.blindSinceSeconds)} before this window closed`}` +
            `, so the window is EMPTY rather than bad. Ask for a wider ` +
            `windowHours to measure the period we actually collected.`
          : `, and there is no reading of any kind on record.`),
    });
  } else if (fleetShare !== null && fleetShare < bars.minCoverage) {
    missing.push({
      kind: "fleet-coverage-below-bar",
      subject: "(the whole fleet)",
      detail:
        `The collector was up for ${fleet.observedBuckets} of ${window.expectedBuckets} ` +
        `${humanDuration(window.bucketSeconds)} buckets — ${pct(fleetShare)} against the ` +
        `${pct(bars.minCoverage)} bar, leaving ${humanDuration(fleet.blindSeconds)} in ` +
        `which we read nothing from any screen. Every availability figure over this ` +
        `window would be computed across that hole.`,
    });
  }

  for (const lane of lanes) {
    if (lane.claim.claimable) continue;
    // An empty window makes every lane silent by construction. Listing sixteen
    // lane blockers derived from one fact is the "one fault presented as N"
    // mistake this codebase keeps having to unlearn, so only the window-
    // independent finding — a lane that records nothing anywhere — is kept.
    if (fleet.windowHasNoObservations && lane.state !== "unobservable") continue;
    const detail = lane.claim.shortfalls.join(" ");
    const kind: CollectorBlockerKind =
      lane.state === "unobservable"
        ? "lane-unobservable"
        : lane.state === "off-by-choice"
          ? "lane-off-by-choice"
          : lane.state === "flag-not-visible"
            ? "lane-flag-not-visible"
            : lane.state === "silent"
              ? "lane-silent"
              : (lane.coverage.value ?? 0) < bars.minCoverage
                ? "lane-coverage-below-bar"
                : lane.windowShare !== null && lane.windowShare < bars.minCoverage
                  ? "lane-span-shorter-than-window"
                  : "lane-cadence-coarser-than-bar";
    missing.push({ kind, subject: lane.lane, detail });
  }

  const claimableLanes = lanes.filter((l) => l.claim.claimable).map((l) => l.lane);
  const claimable = missing.length === 0;

  // The cause. This is the sentence the epic exists for: the shortfall is ours,
  // and attributing it to the estate would be a fabricated claim about Videri's
  // platform. It is only "unknown" when literally nothing could be measured and
  // we cannot even date our own last reading.
  const cause: CollectorVerdict["cause"] =
    claimable
      ? "unknown"
      : fleet.windowHasNoObservations && fleet.lastCollectionAt === null
        ? "unknown"
        : "ours";

  const headline = claimable
    ? `Collector availability ${pct(fleetShare)} over ${humanDuration(window.seconds)}, ` +
      `clearing the ${pct(bars.minCoverage)} bar on ${claimableLanes.length} of ` +
      `${lanes.length} lanes — availability figures over this window are defensible.`
    : fleet.windowHasNoObservations
      ? `NO availability figure can be stated for this window: we hold no reading from ` +
        `any screen in it` +
        (fleet.lastCollectionAt
          ? ` (collection last produced something ${fleet.lastCollectionAt}).`
          : `.`) +
        ` This is our collector, not the estate.`
      : `NOTHING over this window is claimable, and the cause is OURS: the collector was ` +
        `up for ${pct(fleetShare)} of it against a ${pct(bars.minCoverage)} bar, and ` +
        `${lanes.length - claimableLanes.length} of ${lanes.length} lanes fall short. ` +
        `This is a measurement gap in our own collection, NOT an estate fault — the ` +
        `screens may well have been up throughout, and we cannot say either way.`;

  const refusal = claimable
    ? null
    : `Declining to state an availability figure for ` +
      `${window.from} → ${window.to}. ` +
      (fleet.windowHasNoObservations
        ? `The window carries no observations at all, so any percentage would be an ` +
          `artefact of the window's placement rather than a measurement. `
        : `Coverage is ${pct(fleetShare)} against the ${pct(bars.minCoverage)} bar, with ` +
          `${humanDuration(fleet.blindSeconds)} blind. `) +
      (outages.count > 0
        ? `${humanDuration(outages.totalSeconds)} of the blind time is ` +
          `${outages.count} CORRELATED outage(s) of our own process — one daemon ` +
          `stopping, not ${outages.lanesAffected.length} lanes failing. `
        : "") +
      `${fleet.lanes.unobservable} of ${lanes.length} lanes cannot be observed at all ` +
      `and are reported as unknown rather than as zero. A figure will become claimable ` +
      `when the collector runs continuously for a full window — which is a deployment ` +
      `fix (docs/18 §6.1), not a fleet fix.`;

  return {
    claimable,
    headline,
    cause,
    bars: { minCoverage: bars.minCoverage, maxCadenceSeconds: bars.maxCadenceSeconds },
    missing,
    claimableLanes,
    refusal,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// the route
// ─────────────────────────────────────────────────────────────────────────────

const Query = z.object({
  /**
   * The lookback. Default one WEEK because that is the unit of the acceptance
   * criterion in docs/18 §6.5 ("one clean week"), and the ceiling matches
   * /api/sla/coverage so the two pages can be asked the same question.
   */
  windowHours: z.coerce.number().int().min(1).max(2160).default(168),
  /** Bucket granularity. 5 min is the snapshot cadence and docs/18's unit. */
  bucketSeconds: z.coerce.number().int().min(60).max(3600).default(300),
});

export async function registerCollectorRoutes(
  app: FastifyInstance,
  ctx: ApiContext,
): Promise<void> {
  /**
   * Collector availability for a caller-supplied window.
   *
   * Three reads, all of them existing ones:
   *   `loadPipelineHealth`   per-lane configured coverage and outage correlation
   *   `availabilityBuckets`  the fleet figure, shared with the SLA report
   *   `freshness`            the envelope, plus the last reading of any kind —
   *                          which is how an EMPTY window is told apart from a
   *                          dead fleet. Without it a 7-day lookback on a
   *                          12-day-stale database would read as 0% availability.
   */
  app.get("/api/collector/availability", async (request, reply) => {
    const parsed = Query.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "bad_request",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }
    const { windowHours, bucketSeconds } = parsed.data;
    const now = new Date();
    const window = collectorWindow(now, windowHours, bucketSeconds);

    const [health, buckets, freshness] = await Promise.all([
      loadPipelineHealth(ctx.repo, { now, lookbackHours: windowHours }),
      ctx.queries.availabilityBuckets(window.from, window.to, bucketSeconds),
      ctx.freshness(),
    ]);

    // The opt-in gates, read the same way `loadPipelineHealth` reads them: from
    // the environment of whichever process is asking. A flag that is unset HERE
    // may be set for the poller, which is why `laneOptInState` returns undefined
    // rather than false, and why this surface has a `flag-not-visible` state.
    const optInEnabled: Record<string, boolean> = {};
    for (const decl of LANE_REGISTRY) {
      const state = laneOptInState(decl);
      if (state !== undefined) optInEnabled[decl.lane] = state;
    }

    const report = buildCollectorAvailability({
      now,
      window,
      health,
      expectedLanes: expectedLanesFor(),
      optInEnabled,
      fleetObservedBuckets: buckets.fleetObservedBuckets,
      lastCollectionAt: freshness.newestSampleAt,
    });
    return reply.send(envelope(report, freshness));
  });
}
