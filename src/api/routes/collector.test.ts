/**
 * Collector availability — the pure assembly and the verdict.
 *   `node --test dist/api/routes/collector.test.js`
 *
 * `alerting/pipeline-health.coverage.test.ts` already pins the MEASUREMENT hard
 * (spans, gap multiples, outage correlation), and this surface deliberately does
 * not re-measure anything. So what is left to go wrong is the presentation, and
 * every way it can go wrong is a way of telling a reader something false about
 * OUR collection:
 *
 *   1. a lane that records nothing anywhere rendered as 0% or as healthy;
 *   2. a daily lane's normal 24 h rhythm rendered as an outage;
 *   3. an opt-in lane that is OFF rendered as a fault;
 *   4. one daemon outage rendered as N independent lane failures;
 *   5. an empty or thin window rendered as a low availability figure, which
 *      reads as an estate outage when it is in fact us not looking.
 *
 * Every number in the fixtures was measured by hand against the local `vfi`
 * database on 2026-09-17 (`psql -d vfi`) and re-checked through the endpoint:
 *
 *   status   3,857 runs / 6,391 implied over its own 213.00 h span = 60.4%
 *   snapshot 1,686 fleet_snapshots rows / 2,842 over 236.82 h      = 59.3%
 *   fleet    1,793 of 8,640 five-minute buckets over 720 h         = 20.8%
 *   outages  130 correlated windows, 61.87 h, largest 22.28 h over 6 lanes,
 *            stop spread p50 0.048 s
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCollectorAvailability,
  collectorWindow,
  summariseOutages,
  type CollectorAvailabilityInput,
} from "./collector.js";
import {
  assessPipelineHealth,
  expectedLanesFor,
  type ExpectedLane,
  type LaneObservations,
  type PipelineOutage,
} from "../../alerting/pipeline-health.js";
import { SLA_GRADE_BARS } from "../../sla/measurability.js";

const NOW = new Date("2026-09-17T15:00:00Z");
const HOUR = 3600;
const at = (secondsAgo: number) => new Date(NOW.getTime() - secondsAgo * 1000);

/** The roster with no env set, which is how the API process actually sees it. */
const LANES = expectedLanesFor({});

/** A uniform observation series: what a lane running on time looks like. */
function series(
  lane: string,
  {
    source = "poller_runs",
    count,
    everySeconds,
    endedSecondsAgo = 0,
    gaps = [],
  }: {
    source?: string;
    count: number;
    everySeconds: number;
    endedSecondsAgo?: number;
    gaps?: ReadonlyArray<{ startedSecondsAgo: number; seconds: number }>;
  },
): LaneObservations {
  const lastAt = at(endedSecondsAgo);
  const firstAt = new Date(lastAt.getTime() - (count - 1) * everySeconds * 1000);
  return {
    lane,
    source,
    count,
    firstAt,
    lastAt,
    medianGapSeconds: everySeconds,
    // The floor-free aggregate: the largest interval the series really contains.
    // A lane on cadence has one too, which is the whole point of the field.
    maxGapSeconds: count < 2 ? null : Math.max(everySeconds, ...gaps.map((g) => g.seconds)),
    gaps: gaps.map((g) => ({
      startedAt: at(g.startedSecondsAgo),
      endedAt: at(g.startedSecondsAgo - g.seconds),
      seconds: g.seconds,
    })),
    // The floor `loadPipelineHealth` really asks for: 2x the configured
    // interval, the smallest gap the missed-fire rule can count.
    gapFloorSeconds: 2 * (LANES.find((l) => l.lane === lane)?.intervalSeconds ?? everySeconds),
    gapsTruncated: false,
  };
}

/** A lane with no rows at all — the shape `loadPipelineHealth` synthesises. */
const empty = (lane: string, source = "poller_runs"): LaneObservations => ({
  lane, source, count: 0, firstAt: null, lastAt: null, medianGapSeconds: null,
  // No read happened, so no floor and no gap: `loadPipelineHealth` synthesises
  // exactly this, and coverage must report unknown rather than a measured zero.
  maxGapSeconds: null, gaps: [], gapFloorSeconds: null, gapsTruncated: false,
});

function build({
  windowHours = 720,
  observations = [],
  optInEnabled = {},
  fleetObservedBuckets = 0,
  lastCollectionAt = at(0).toISOString(),
  expectedLanes = LANES,
}: {
  windowHours?: number;
  observations?: readonly LaneObservations[];
  optInEnabled?: Readonly<Record<string, boolean>>;
  fleetObservedBuckets?: number;
  lastCollectionAt?: string | null;
  expectedLanes?: readonly ExpectedLane[];
} = {}) {
  const window = collectorWindow(NOW, windowHours, 300);
  const input: CollectorAvailabilityInput = {
    now: NOW,
    window,
    health: assessPipelineHealth([], { now: NOW, expectedLanes, optInEnabled, observations }),
    expectedLanes,
    optInEnabled,
    fleetObservedBuckets,
    lastCollectionAt,
  };
  return buildCollectorAvailability(input);
}

const lane = (report: ReturnType<typeof build>, name: string) => {
  const found = report.lanes.find((l) => l.lane === name);
  assert.ok(found, `${name} must appear on the surface — a declared lane is never absent`);
  return found;
};

// ── 1. an unobservable lane is UNKNOWN, never 0% ─────────────────────────────

test("a lane that records nothing anywhere reports unknown, not 0%, and never claimable", () => {
  // Pinned on a SYNTHETIC lane on purpose. This test used to use
  // alert-cross-check / retention / prune-raw, and f32d600 gave all three a
  // record() call, so no lane in the real registry is unobservable any more.
  // The property still has to hold for the next lane that ships without
  // instrumentation, so the roster is injected rather than the assertion dropped.
  const ghost = {
    lane: "ghost", feeds: "nothing",
    observability: { kind: "none", why: "it records nothing" },
  } as const;
  const report = build({ fleetObservedBuckets: 8000, expectedLanes: [ghost] });
  const l = lane(report, "ghost");

  assert.equal(l.state, "unobservable", "no trace anywhere means it cannot be measured");
  assert.equal(l.coverage.value, null, "coverage must be NULL, not 0 — 0 claims a rate");
  assert.equal(l.observedFires, null);
  assert.equal(l.expectedFires, null);
  assert.equal(l.claim.claimable, false, "it can never carry a claim; we did not look");
  assert.notEqual(l.health, "healthy", "it must never read as healthy");
  assert.ok(l.observability.why, "the registry's reason must travel with the unknown");
  assert.match(l.coverage.basis, /UNKNOWN, not zero/);
  assert.equal(report.fleet.lanes.unobservable, 1);

  // And it is a blocker of its own kind, not a coverage number.
  const blockers = report.verdict.missing.filter((m) => m.kind === "lane-unobservable");
  assert.deepEqual(blockers.map((b) => b.subject), ["ghost"]);
  for (const b of blockers) assert.doesNotMatch(b.detail, /0\.0%/);
});

test("the three lanes that gained a record() call are SILENT now, not unobservable", () => {
  // The distinction is the whole point of f32d600. `unobservable` means we
  // cannot tell; `silent` means we can tell, and the answer is that nothing has
  // been recorded. Same zero rows, two completely different claims — and the
  // earlier one of them was asserted as "never ran" before it was true.
  const report = build({ fleetObservedBuckets: 8000 });

  for (const name of ["alert-cross-check", "retention", "prune-raw"]) {
    const l = lane(report, name);
    assert.equal(l.state, "silent", `${name} records now, so its silence is measurable`);
    assert.notEqual(l.state, "unobservable");
    // Still never a fabricated rate: no runs means no coverage, not 0%.
    assert.equal(l.coverage.value, null, `${name} coverage must be NULL, not 0`);
    assert.equal(l.claim.claimable, false, `${name} has no runs, so it carries no claim`);
    assert.notEqual(l.health, "healthy", `${name} must not read as healthy while silent`);
  }
  assert.equal(report.fleet.lanes.unobservable, 0, "no registry lane is unobservable any more");
});

// ── 2. a daily lane's normal cadence is not an outage ────────────────────────

test("data-usage's 24 h rhythm is a daily lane working, not a hole", () => {
  // The real measured gaps: 24.000 h, 24.013 h, 24.300 h. Every one of them is
  // barely over 1x the configured day, so none skips a fire.
  const report = build({
    fleetObservedBuckets: 8000,
    observations: [
      series("data-usage", {
        count: 30,
        everySeconds: 24 * HOUR,
        gaps: [
          { startedSecondsAgo: 300 * HOUR, seconds: 24.0 * HOUR },
          { startedSecondsAgo: 200 * HOUR, seconds: 24.013 * HOUR },
          { startedSecondsAgo: 100 * HOUR, seconds: 24.3 * HOUR },
        ],
      }),
    ],
  });
  const l = lane(report, "data-usage");

  assert.equal(l.configuredIntervalSeconds, 24 * HOUR);
  assert.ok(l.longestGapIntervals !== null && l.longestGapIntervals < 1.02,
    `the worst gap is ${l.longestGapIntervals}x a configured day — normal, not a miss`);
  assert.equal(l.longestGapWithinCadence, true,
    "a 24.3 h gap on a daily lane must read as within cadence");
  assert.equal(l.missedFires, 0, "floor(gap/interval)-1 is zero for a 1.01x gap");
  assert.equal(l.missedFiresOutsideOutages, 0);
  assert.equal(l.coverage.value, 1, "30 rows against 30 implied daily fires — perfect");

  // It is still not claimable, and the REASON is the one thing that matters
  // here: its configured day is coarser than the SLA bar's hour, by arithmetic.
  // What must never appear is a coverage shortfall or a gap complaint.
  assert.equal(l.claim.claimable, false);
  assert.deepEqual(
    report.verdict.missing.filter((m) => m.subject === "data-usage").map((m) => m.kind),
    ["lane-cadence-coarser-than-bar"],
    "a daily lane working must never be reported as short of its cadence",
  );
  assert.match(l.claim.shortfalls.join(" "), /by arithmetic, not by fault/);
  assert.doesNotMatch(l.claim.shortfalls.join(" "), /of its configured/);
});

test("data-usage's real 48.91 h gap IS a miss, measured in multiples of its own day", () => {
  const report = build({
    fleetObservedBuckets: 8000,
    observations: [
      series("data-usage", {
        count: 6,
        everySeconds: 24 * HOUR,
        gaps: [{ startedSecondsAgo: 100 * HOUR, seconds: 48.91 * HOUR }],
      }),
    ],
  });
  const l = lane(report, "data-usage");
  assert.ok(l.longestGapIntervals !== null && l.longestGapIntervals > 2,
    "48.91 h is 2.04 configured days");
  assert.equal(l.longestGapWithinCadence, false);
  assert.equal(l.missedFires, 1, "a 2.04x gap skipped exactly one daily fire");
});

// ── 3. off by choice is off, not broken ─────────────────────────────────────

test("an opt-in lane whose flag is off reads as off-by-choice, never as a fault", () => {
  const report = build({
    fleetObservedBuckets: 8000,
    // Explicitly off, which is what ENABLE_AI_JOBS=false looks like to the roster.
    optInEnabled: { "ai-brief": false, "ai-action-plan": false },
    observations: [empty("ai-brief"), empty("ai-action-plan")],
  });

  for (const name of ["ai-brief", "ai-action-plan"]) {
    const l = lane(report, name);
    assert.equal(l.state, "off-by-choice", `${name} is off by configuration`);
    assert.equal(l.optIn.reading, "off");
    assert.equal(l.coverage.value, null, "off is not a rate of zero");
    assert.equal(l.health, "disabled", "the self-check agrees: disabled, not never-ran");
    const blocker = report.verdict.missing.find((m) => m.subject === name);
    assert.ok(blocker);
    assert.equal(blocker.kind, "lane-off-by-choice",
      "an off lane must not share a kind with a silent one");
    assert.match(blocker.detail, /configuration decision, not a fault/);
  }
  assert.equal(report.fleet.lanes.offByChoice, 2);
  // "Off" and "silent" are different words for different facts, and the two
  // opt-in lanes must not be counted among the silent ones.
  assert.equal(
    report.lanes.filter((l) => l.state === "silent").some((l) => l.lane.startsWith("ai-")),
    false,
    "off is not silent",
  );
});

test("an opt-in lane whose flag is invisible here is unknowable, not a fault", () => {
  // No optInEnabled entry at all: an off-by-default flag unset in THIS process
  // may still be set for the poller. Blaming it would make the surface wrong on
  // a healthy system.
  const report = build({ fleetObservedBuckets: 8000, observations: [empty("telemetry-slowlane")] });
  const l = lane(report, "telemetry-slowlane");
  assert.equal(l.state, "flag-not-visible");
  assert.equal(l.optIn.reading, "not-visible");
  assert.equal(l.optIn.env, "ENABLE_TELEMETRY_SLOWLANE");
  assert.equal(l.coverage.value, null);
  const blocker = report.verdict.missing.find((m) => m.subject === "telemetry-slowlane");
  assert.equal(blocker?.kind, "lane-flag-not-visible");
  assert.match(blocker!.detail, /unknowable from here/);
});

test("a lane with no flag and no observations is silent — an absence, still not 0%", () => {
  const report = build({ fleetObservedBuckets: 8000, observations: [empty("devices")] });
  const l = lane(report, "devices");
  assert.equal(l.state, "silent", "devices is not opt-in, so silence is a real absence");
  assert.equal(l.coverage.value, null, "no rate exists; there is no coverage at all");
  assert.equal(report.verdict.missing.find((m) => m.subject === "devices")?.kind, "lane-silent");
});

// ── 4. one daemon outage, not N lane failures ───────────────────────────────

test("a correlated multi-lane hole is reported as ONE process outage", () => {
  // The real one: six lanes stop within seconds of each other and resume 22.28 h
  // later. Measured stop spread across the whole history is p50 0.049 s.
  const lanes = ["alerting", "compliance", "devices", "metrics", "snapshot", "status"];
  const stop = at(400 * HOUR);
  const outage: PipelineOutage = {
    startedAt: stop.toISOString(),
    endedAt: new Date(stop.getTime() + 22.28 * HOUR * 1000).toISOString(),
    seconds: 22.28 * HOUR,
    lanes,
    stopSpreadSeconds: 0.049,
    resumeSpreadSeconds: 35.23,
  };
  const summary = summariseOutages([outage], 100 * HOUR);

  assert.equal(summary.count, 1, "one outage, one finding — not six");
  assert.deepEqual(summary.lanesAffected, lanes);
  assert.equal(summary.largest?.lanes.length, 6);
  assert.equal(summary.stopSpreadSeconds?.p50, 0.049);
  assert.match(summary.verdict!, /OUR PROCESS STOPPING, not 6 lane failures/);
  assert.match(summary.verdict!, /recovers together/);
  // The share of blind time it explains, so a reader can tell a bounded outage
  // from a collector that simply is not running.
  assert.equal(summary.shareOfBlindTime, 0.2228);
});

test("130 correlated outages aggregate to one sentence with their stop spread", () => {
  // Shaped like the live history: 130 windows totalling 61.87 h.
  const outages: PipelineOutage[] = Array.from({ length: 130 }, (_, i) => ({
    startedAt: at((500 - i) * HOUR).toISOString(),
    endedAt: at((500 - i) * HOUR - 1713).toISOString(),
    seconds: 1713,
    lanes: ["metrics", "status"],
    stopSpreadSeconds: i === 129 ? 104.65 : 0.048,
    resumeSpreadSeconds: 1,
  }));
  const summary = summariseOutages(outages, 600 * HOUR);
  assert.equal(summary.count, 130);
  assert.ok(Math.abs(summary.totalSeconds / HOUR - 61.86) < 0.05);
  assert.equal(summary.stopSpreadSeconds?.p50, 0.048);
  assert.equal(summary.stopSpreadSeconds?.max, 104.65);
  assert.match(summary.verdict!, /not 2 lane failures/);
});

test("with nothing correlated the surface claims no outage at all", () => {
  const summary = summariseOutages([], 100 * HOUR);
  assert.equal(summary.count, 0);
  assert.equal(summary.verdict, null, "silence about outages beats an invented one");
  assert.equal(summary.shareOfBlindTime, null);
});

// ── 5. the verdict refuses; it never reports a low number as an estate fault ──

test("an empty window refuses instead of reporting 0% availability", () => {
  // The local database stopped collecting 2026-09-04, so a one-week lookback on
  // 2026-09-17 holds NOTHING. 0% here would read as an estate outage.
  const report = build({
    windowHours: 168,
    fleetObservedBuckets: 0,
    lastCollectionAt: at(13 * 24 * HOUR).toISOString(),
  });

  assert.equal(report.fleet.windowHasNoObservations, true);
  assert.equal(report.fleet.collectorUp.value, null, "NO share is stated for an empty window");
  // The counts are still facts and are still reported.
  assert.equal(report.fleet.collectorUp.coverage.measured, 0);
  assert.equal(report.fleet.collectorUp.coverage.inScope, 2016);
  assert.match(report.fleet.collectorUp.coverage.note, /not 0% availability of the estate/);

  assert.equal(report.verdict.claimable, false);
  assert.equal(report.verdict.cause, "ours");
  assert.ok(report.verdict.refusal, "a refusal, not a fallback");
  assert.match(report.verdict.refusal, /Declining to state an availability figure/);
  assert.match(report.verdict.headline, /NO availability figure can be stated/);
  assert.match(report.verdict.headline, /our collector, not the estate/);

  // One blocker for one fact. Sixteen lane blockers derived from an empty window
  // is the "one fault presented as N" mistake.
  assert.equal(report.verdict.missing[0]?.kind, "window-has-no-observations");
  assert.equal(
    report.verdict.missing.filter((m) => m.kind === "lane-silent").length,
    0,
    "an empty window must not be restated as sixteen silent lanes",
  );
  assert.match(report.verdict.missing[0]!.detail, /wider windowHours/);
});

test("the live shape: 20.8% fleet coverage refuses, and names us as the cause", () => {
  // 1,793 of 8,640 five-minute buckets over 720 h, measured by hand.
  const report = build({
    windowHours: 720,
    fleetObservedBuckets: 1793,
    observations: [
      series("status", { count: 3857, everySeconds: 120, endedSecondsAgo: 312.6 * HOUR }),
      series("snapshot", {
        source: "fleet_snapshots.computed_at",
        count: 1686,
        everySeconds: 505.66,
        endedSecondsAgo: 312.6 * HOUR,
      }),
    ],
  });

  const up = report.fleet.collectorUp;
  assert.ok(up.value !== null && Math.abs(up.value - 0.2075) < 0.0005, "1,793 / 8,640 = 20.8%");
  assert.ok(up.basis.length > 0, "every figure carries its basis");
  assert.equal(up.coverage.unit, "time-buckets");
  assert.equal(report.fleet.blindBuckets, 8640 - 1793);

  assert.equal(report.verdict.claimable, false);
  assert.equal(report.verdict.cause, "ours", "this is our measurement gap, not the estate's");
  assert.match(report.verdict.headline, /NOTHING over this window is claimable/);
  assert.match(report.verdict.headline, /NOT an estate fault/);
  assert.deepEqual(report.verdict.claimableLanes, [], "no lane clears the bar today");
  assert.ok(
    report.verdict.missing.some((m) => m.kind === "fleet-coverage-below-bar"),
    "the fleet figure is the gate, and it is stated as one",
  );
  assert.equal(report.verdict.bars.minCoverage, SLA_GRADE_BARS.minCoverage);
  assert.equal(report.verdict.bars.maxCadenceSeconds, SLA_GRADE_BARS.maxCadenceSeconds);
});

test("a high rate over a sliver of the window does not clear the bar", () => {
  // The trap in the doc's own per-lane table: screen-verify-slowlane ran at
  // 95.1% of its cadence — but only across 70.7 h of a 720 h window, and the
  // other 649 h has no data from it whatsoever.
  const report = build({
    windowHours: 720,
    fleetObservedBuckets: 1793,
    observations: [
      series("screen-verify-slowlane", {
        count: 269,
        everySeconds: 945.7,
        endedSecondsAgo: 312.6 * HOUR,
      }),
    ],
  });
  const l = lane(report, "screen-verify-slowlane");
  assert.ok(l.coverage.value !== null && l.coverage.value > 0.94, "its own-span rate is high");
  assert.ok(l.windowShare !== null && l.windowShare < 0.11, "it covers a tenth of the window");
  assert.equal(l.claim.claimable, false);
  assert.equal(
    report.verdict.missing.find((m) => m.subject === "screen-verify-slowlane")?.kind,
    "lane-span-shorter-than-window",
  );
  assert.match(l.claim.shortfalls.join(" "), /rest of the window has no data from it/);
});

test("a fully covered window with every lane on cadence IS claimable", () => {
  // The acceptance criterion from docs/18 §6.5 — one clean week. Nothing in the
  // local database looks like this yet, and the verdict must be able to say yes
  // when it does, or it is a rubber stamp in the other direction.
  const windowHours = 168;
  const clean = LANES.flatMap((l) => {
    if (l.observability?.kind === "none") return [];
    const interval = l.intervalSeconds ?? 900;
    // A lane whose cadence is coarser than the SLA bar cannot clear it by
    // arithmetic, so the clean week is asserted over the lanes that can.
    if (interval > SLA_GRADE_BARS.maxCadenceSeconds) return [];
    const count = Math.floor((windowHours * HOUR) / interval) + 1;
    return [
      series(l.lane, {
        source: l.observability?.kind === "table"
          ? `${l.observability.table}.${l.observability.timeColumn}`
          : "poller_runs",
        count,
        everySeconds: interval,
      }),
    ];
  });
  const report = build({
    windowHours,
    fleetObservedBuckets: 2016,
    observations: clean,
    expectedLanes: LANES.filter(
      (l) => l.observability?.kind !== "none" && (l.intervalSeconds ?? 0) <= SLA_GRADE_BARS.maxCadenceSeconds,
    ),
  });

  assert.equal(report.fleet.collectorUp.value, 1);
  assert.equal(report.verdict.claimable, true, "a clean week must be claimable");
  assert.equal(report.verdict.refusal, null);
  assert.deepEqual(report.verdict.missing, []);
  assert.equal(report.verdict.claimableLanes.length, report.lanes.length);
  assert.match(report.verdict.headline, /are defensible/);
});

// ── the invariants that hold whatever the window ─────────────────────────────

test("every declared lane appears, and every figure carries a basis", () => {
  const report = build({ fleetObservedBuckets: 1793 });
  assert.equal(report.lanes.length, LANES.length, "16 declared lanes, 16 rows");
  assert.equal(report.scope, "vfi-collector", "no consumer may mix this with device data");
  assert.ok(report.fleet.collectorUp.basis.length > 0);
  assert.ok(report.fleet.collectorUp.coverage.note.length > 0);
  for (const l of report.lanes) {
    assert.ok(l.coverage.basis.length > 0, `${l.lane} coverage must state its basis`);
    assert.ok(l.coverage.coverage.note.length > 0, `${l.lane} coverage needs a coverage note`);
    assert.ok(l.feeds.length > 0, `${l.lane} must say what goes stale when it stops`);
    if (l.coverage.value === null) {
      assert.ok(
        l.claim.shortfalls.length > 0,
        `${l.lane} reports no rate, so it must say why in words`,
      );
    }
  }
});

test("the window is half-open, stated, and never wider than the caller asked", () => {
  const w = collectorWindow(NOW, 720, 300);
  assert.equal(w.halfOpen, true);
  assert.equal(w.to, NOW.toISOString());
  assert.equal(w.from, new Date(NOW.getTime() - 720 * HOUR * 1000).toISOString());
  assert.equal(w.expectedBuckets, 8640);
  assert.match(w.statement, /Half-open/);
});

test("more observed buckets than the window holds cannot produce over-100% coverage", () => {
  // Defensive: a bucket count from a slightly different boundary must not print
  // 101%. It is capped and the cap is visible in the counts.
  const report = build({ windowHours: 168, fleetObservedBuckets: 2020 });
  assert.equal(report.fleet.observedBuckets, 2016);
  assert.equal(report.fleet.collectorUp.value, 1);
});

// ── BUG-11: the surface reads the gap verdict, it does not re-decide it ──────

test("the worst-gap verdict is the engine's, not a second threshold of this file's", () => {
  // This file measured `longestGapIntervals < coverageGapMultiplier` for itself,
  // which is a second definition of "late" — the thing the header forbids. On
  // `data-usage` it answered the OPPOSITE of the missed-fire rule: 2.038x > 2 so
  // "out of cadence", while the rule scored the same gap as the one skipped fire
  // it is. Pinned as the invariant, over every shape of lane on the surface.
  const DAY = 24 * HOUR;
  const report = build({
    fleetObservedBuckets: 8000,
    observations: [
      // one missed fire plus jitter — the case that was always "late"
      series("data-usage", { count: 5, everySeconds: DAY,
        gaps: [{ startedSecondsAgo: 100 * HOUR, seconds: 2.038 * DAY }] }),
      // many missed fires — must stay late. The real shape: 1,686 rows spread
      // over 236.82 h of a configured 5-minute cadence = 59.3%, with a 23.56 h
      // hole inside it.
      series("snapshot", { source: "fleet_snapshots.computed_at", count: 1686,
        everySeconds: (236.82 * HOUR) / 1685,
        gaps: [{ startedSecondsAgo: 100 * HOUR, seconds: 23.56 * HOUR }] }),
      // nothing at or past the read-back floor — the on-cadence lane, which used
      // to arrive here with NO gap figure at all
      series("status", { count: 2497, everySeconds: 122 }),
      // nothing at all: unknown, in both directions
      empty("device-settings"),
    ],
  });

  for (const l of report.lanes) {
    assert.equal(
      l.longestGapWithinCadence,
      l.missedFires === null ? null : l.missedFires === 0,
      `${l.lane}: the boolean must BE the missed-fire count, not a comparison`,
    );
    assert.equal(
      l.longestGapWithinCadence,
      l.longestGapMissedFires === null ? null : l.longestGapMissedFires === 0,
      `${l.lane}: the worst gap's own count and the boolean are one answer`,
    );
    assert.ok(l.longestGapBasis.length > 0, `${l.lane} must say which question it answered`);
  }

  const daily = lane(report, "data-usage");
  assert.equal(daily.longestGapMissedFires, 1, "2.038x a day skipped exactly one fire");
  assert.equal(daily.longestGapWithinCadence, false, "and the surface says the same, not more");
  assert.match(daily.longestGapBasis, /does NOT judge the lane/);
  // The other half of the pinned case: one missed fire in six is not ALSO a
  // shortfall. Two mechanisms, one question, one answer, one place to read it.
  assert.doesNotMatch(daily.claim.shortfalls.join(" "), /of its configured 1 day cadence/);

  const many = lane(report, "snapshot");
  assert.equal(many.longestGapMissedFires, 281, "a 23.56 h hole in a 5 min lane is 281 fires");
  assert.equal(many.longestGapWithinCadence, false);
  assert.equal((many.coverage.value! * 100).toFixed(1), "59.3");
  assert.match(many.claim.shortfalls.join(" "), /ran at 59\.3% of its configured 5 min cadence/);

  // The on-cadence lane: 2,497 observations, no gap at or past 2x its 2-minute
  // cadence. It reports TRUE *with a figure* — 122 s, 1.02x — where it used to
  // report TRUE and a null this surface then had to explain away. Nothing was
  // skipped AND we can say what the worst gap was.
  const clean = lane(report, "status");
  assert.equal(clean.longestGapWithinCadence, true);
  assert.equal(clean.longestGapMissedFires, 0);
  assert.equal(clean.longestGapSeconds, 122, "the true longest gap, floor or no floor");
  assert.equal(clean.longestGapIntervals!.toFixed(4), "1.0167");
  assert.equal(clean.missedFires, 0);
  assert.equal(clean.missedFiresExact, true, "exact, so the UI must not say 'at least'");
  assert.match(clean.longestGapBasis, /under 2x, which is where the rule starts counting/);

  // And the unknowable case keeps its honest null rather than inheriting one.
  assert.equal(lane(report, "device-settings").missedFiresExact, null);

  const silent = lane(report, "device-settings");
  assert.equal(silent.longestGapWithinCadence, null, "never looked is not within cadence");
  assert.match(silent.longestGapBasis, /UNKNOWN/);
});
