/**
 * Configured-cadence coverage, and the four lanes that used to be invisible.
 *   `node --test dist/alerting/pipeline-health.coverage.test.js`
 *
 * WHAT WENT WRONG, AND WHAT EACH TEST HERE PINS
 *
 * `EXPECTED_LANES` was hand-written with a comment saying it mirrored the
 * scheduler. It had drifted by four lanes, and the drift hid two real failures:
 *
 *   `snapshot`           — writes 1,686 rows to `fleet_snapshots` and ZERO
 *                          `poller_runs` rows. At its configured 5-minute
 *                          cadence that is 59.3% coverage, and nothing could
 *                          report it because the lane was not on the roster.
 *   `alert-cross-check`  — records nothing at all, anywhere. 0 rows against 214
 *                          hourly fires implied by the same span. Also
 *                          unreportable.
 *
 * Every figure quoted here was measured by hand against the local `vfi`
 * database on 2026-09-16 and the fixtures reproduce those shapes.
 *
 * The two false alarms this must NOT produce are as important as the detections:
 *   - a daily lane's normal 24 h rhythm read as an outage (`data-usage`'s real
 *     gaps are 24.00 h, 24.01 h, 24.30 h and one genuine 48.91 h miss);
 *   - a lane whose coverage hole is a shared daemon outage read as a lane fault.
 *     Measured: six lanes stop within 4.62 SECONDS of each other and resume
 *     within 35.23 s, 22.28 h later. That is one process, not six collectors.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessPipelineHealth,
  correlateOutages,
  measureConfiguredCoverage,
  measureCadence,
  expectedLanesFor,
  toExpectedLane,
  type ExpectedLane,
  type LaneObservations,
  type PollerRunRow,
} from "./pipeline-health.js";
import { LANE_REGISTRY, laneDecl, laneRegistryDrift } from "../pipeline/lanes/registry.js";

const NOW = new Date("2026-09-04T15:10:00Z");
const MIN = 60;
const HOUR = 3600;
const at = (secondsAgo: number) => new Date(NOW.getTime() - secondsAgo * 1000);

const decl = (lane: string): ExpectedLane => toExpectedLane(laneDecl(lane)!, {});

/**
 * An observation series with a uniform gap, which is what a healthy lane looks
 * like. `gapEvery`/`gapSeconds` inject holes at a chosen stride.
 */
function observations(
  lane: string,
  source: string,
  {
    count,
    everySeconds,
    gaps = [],
    medianGapSeconds,
    gapsTruncated = false,
  }: {
    count: number;
    everySeconds: number;
    gaps?: Array<{ agoSeconds: number; seconds: number }>;
    medianGapSeconds?: number;
    gapsTruncated?: boolean;
  },
): LaneObservations {
  const span = (count - 1) * everySeconds + gaps.reduce((sum, g) => sum + g.seconds, 0);
  return {
    lane,
    source,
    count,
    firstAt: at(span),
    lastAt: at(0),
    medianGapSeconds: medianGapSeconds ?? everySeconds,
    gaps: gaps.map((g) => ({
      startedAt: at(g.agoSeconds + g.seconds),
      endedAt: at(g.agoSeconds),
      seconds: g.seconds,
    })),
    gapsTruncated,
  };
}

const laneOf = (report: ReturnType<typeof assessPipelineHealth>, name: string) =>
  report.lanes.find((l) => l.lane === name)!;

// ─────────────────────────────────────────────────────────────────────────────
// The registry is the source, not a mirror
// ─────────────────────────────────────────────────────────────────────────────

test("a lane scheduled but not declared is caught, naming the lane", () => {
  const drift = laneRegistryDrift([{ name: "brand-new-lane", intervalMs: 60_000 }], {});
  assert.equal(drift.length, 1);
  assert.equal(drift[0]?.lane, "brand-new-lane");
  assert.match(drift[0]!.problem, /pipeline-health cannot see it/);
});

test("a lane whose real interval no longer matches its declaration is caught", () => {
  // The silent failure this prevents: every coverage threshold is a multiple of
  // the DECLARED interval, so a scheduler tuned to 30m against a 15m declaration
  // would report a healthy lane at 50%.
  const drift = laneRegistryDrift([{ name: "devices", intervalMs: 30 * 60_000 }], {});
  assert.equal(drift.length, 1);
  assert.match(drift[0]!.problem, /scheduled every 1800000ms but declared every 900000ms/);
});

test("the two env-driven intervals follow the environment, not a copied constant", () => {
  const tuned = expectedLanesFor({ POLL_STATUS_INTERVAL_MS: "60000" });
  assert.equal(tuned.find((l) => l.lane === "status")?.intervalSeconds, 60);
  // And the default matches config.ts's, which the poller asserts at boot.
  assert.equal(expectedLanesFor({}).find((l) => l.lane === "status")?.intervalSeconds, 120);
  // `alerting` is derived from the metrics interval, so it must move with it.
  const offset = expectedLanesFor({ POLL_METRICS_INTERVAL_MS: "600000" });
  assert.equal(offset.find((l) => l.lane === "alerting")?.intervalSeconds, 630);
});

// ─────────────────────────────────────────────────────────────────────────────
// snapshot: visible at last, and measured from the data it writes
// ─────────────────────────────────────────────────────────────────────────────

test("snapshot is visible to the health check at all", () => {
  // It was not. This is the whole bug in one assertion.
  assert.ok(LANE_REGISTRY.some((l) => l.lane === "snapshot"));
  const report = assessPipelineHealth([], { now: NOW, expectedLanes: expectedLanesFor({}) });
  assert.ok(laneOf(report, "snapshot"), "snapshot must appear in the report");
});

test("snapshot's coverage comes from fleet_snapshots, because it writes no run row", () => {
  // Reproduces the measured shape: 1,686 rows over a 236.82 h span against a
  // configured 5-minute cadence = 2,842 expected = 59.3%.
  const span = 236.82 * HOUR;
  const obs: LaneObservations = {
    lane: "snapshot",
    source: "fleet_snapshots.computed_at",
    count: 1686,
    firstAt: at(span),
    lastAt: at(0),
    medianGapSeconds: 5.33 * MIN,
    gaps: [{ startedAt: at(span - 100), endedAt: at(span - 100 - 23.56 * HOUR), seconds: 23.56 * HOUR }],
    gapsTruncated: false,
  };
  const coverage = measureConfiguredCoverage(decl("snapshot"), obs);

  assert.equal(coverage.source, "fleet_snapshots.computed_at");
  assert.equal(coverage.configuredIntervalSeconds, 5 * MIN);
  assert.equal(coverage.observed, 1686);
  assert.equal(coverage.expected, 2842);
  assert.ok(coverage.ratio !== null);
  assert.equal((coverage.ratio! * 100).toFixed(1), "59.3");
  // 23.56 h is 282.7 five-minute intervals, so 281 fires were DEMONSTRABLY
  // skipped — floor, not round, because a missed fire has to be certain before
  // it is counted. Saying it in INTERVALS rather than hours is what makes it
  // comparable across a 2-minute lane and a daily one.
  assert.equal(coverage.missedFires, 281);
  assert.equal(Math.round(coverage.longestGapIntervals!), 283);

  // And the whole point: the lane is assessed, not merely listed.
  const report = assessPipelineHealth([], {
    now: NOW,
    expectedLanes: expectedLanesFor({}),
    observations: [obs],
  });
  const lane = laneOf(report, "snapshot");
  assert.notEqual(lane.status, "never-ran");
  assert.equal(lane.runsConsidered, 1686);
  assert.equal(lane.lastRunAt, at(0).toISOString());
  // Honest nulls: no run row means no batch outcome and no yield to report.
  assert.equal(lane.lastRowsWritten, null);
  assert.equal(lane.lastYield, null);
  assert.ok(
    lane.findings.some((f) => f.kind === "lane-coverage-shortfall"),
    "59.3% of its configured cadence must be a finding, not a silent number",
  );
});

test("snapshot with no fleet_snapshots rows reads never-ran, not 0% and not healthy", () => {
  const obs = observations("snapshot", "fleet_snapshots.computed_at", {
    count: 0,
    everySeconds: 5 * MIN,
  });
  const report = assessPipelineHealth([], {
    now: NOW,
    expectedLanes: expectedLanesFor({}),
    observations: [{ ...obs, firstAt: null, lastAt: null, medianGapSeconds: null }],
  });
  const lane = laneOf(report, "snapshot");
  assert.equal(lane.status, "never-ran");
  // Nothing ran, so there is no RATE. A 0 here would claim we measured one.
  assert.equal(lane.coverage.ratio, null);
  assert.match(lane.coverage.basis, /no rows in fleet_snapshots/);
  assert.match(lane.coverage.basis, /not that it ran 0% of the time/);
});

// ─────────────────────────────────────────────────────────────────────────────
// alert-cross-check: no source at all → unknown, never 0% and never healthy
// ─────────────────────────────────────────────────────────────────────────────

test("alert-cross-check now RECORDS, so silence is a claim we are allowed to make", () => {
  // History, because this test used to assert the opposite and the reversal is
  // the point. This lane called no record() and wrote no table, so 0 rows meant
  // "we cannot tell" and the honest report was `unknown`. Claiming "never ran"
  // off 0 rows was a false statement about our OWN pipeline, and it was made.
  // The lane records now, so absence of a row is finally evidence of absence.
  const report = assessPipelineHealth([], { now: NOW, expectedLanes: expectedLanesFor({}) });
  const lane = laneOf(report, "alert-cross-check");

  assert.equal(lane.status, "never-ran");
  assert.ok(!report.unobservableLanes.includes("alert-cross-check"), "it has a source now");
  // Still never a fabricated measurement: no runs means no coverage RATIO, and
  // the absence is carried by the finding rather than by a 0.
  assert.equal(lane.coverage.ratio, null, "never 0% — that would be a fabricated measurement");
  const finding = lane.findings.find((f) => f.kind === "lane-never-ran");
  assert.ok(finding, "silence must produce a finding, not silence");
  // The wording says RECORDED, not ran, which is the precise claim: a run before
  // the instrumentation existed left no trace and cannot be ruled out.
  assert.match(finding!.detail, /has ever been recorded/);

  // And it self-clears on the first recorded run rather than needing a human to
  // dismiss it — which is what makes it safe to raise at this severity.
  const afterOneRun = assessPipelineHealth(
    [{
      poller: "alert-cross-check", startedAt: new Date(NOW.getTime() - 10 * 60_000),
      durationMs: 500, devicesTargeted: 0, rowsWritten: 0,
      batchesOk: 1, batchesFailed: 0, telemetryYield: null,
    }],
    { now: NOW, expectedLanes: expectedLanesFor({}) },
  );
  const cleared = laneOf(afterOneRun, "alert-cross-check");
  assert.notEqual(cleared.status, "never-ran");
  assert.equal(
    cleared.findings.find((f) => f.kind === "lane-never-ran"), undefined,
    "one recorded run must retire the finding entirely",
  );
});

test("retention and prune-raw are measurable too, and 0 rows written is not a stall", () => {
  // Both lanes DELETE and persist nothing of their own, so rows_written is 0 by
  // design. zeroRowsIsNormal is what stops that reading as a stalled lane — the
  // distinction between "nothing needed deleting" and "we could not look" is
  // carried by batches_ok, not by the row count.
  const runs = ["retention", "prune-raw"].map((poller, i) => ({
    poller, startedAt: new Date(NOW.getTime() - (i + 1) * 60 * 60_000),
    durationMs: 900, devicesTargeted: 0, rowsWritten: 0,
    batchesOk: 6, batchesFailed: 0, telemetryYield: null,
  }));
  const report = assessPipelineHealth(runs, { now: NOW, expectedLanes: expectedLanesFor({}) });
  for (const name of ["retention", "prune-raw"]) {
    const lane = laneOf(report, name);
    assert.ok(!report.unobservableLanes.includes(name), `${name} has a source now`);
    // There is deliberately no "wrote nothing" finding kind to assert against —
    // the real risk is these lanes being called stalled or overdue for writing
    // zero rows, so assert the absence of a FAULT rather than of an invented one.
    assert.ok(
      !["stalled", "overdue", "never-ran"].includes(lane.status),
      `${name} ran an hour ago on a 24 h cadence and wrote 0 rows by design; ` +
        `status was ${lane.status}`,
    );
    for (const kind of ["lane-stalled", "lane-overdue", "lane-never-ran"] as const) {
      assert.equal(
        lane.findings.find((f) => f.kind === kind), undefined,
        `${name} must not raise ${kind} for a by-design zero`,
      );
    }
  }
});

test("a lane with no measurable source is unknown even when a run history exists", () => {
  // Belt and braces: the `none` declaration wins over any rows that happen to
  // share the lane's name, because the declaration is about what we can TRUST.
  const lane = laneOf(
    assessPipelineHealth([], {
      now: NOW,
      expectedLanes: [{ lane: "ghost", feeds: "nothing", observability: { kind: "none", why: "it records nothing" } }],
    }),
    "ghost",
  );
  assert.equal(lane.status, "unknown");
  assert.equal(lane.coverage.ratio, null);
  assert.match(lane.coverage.basis, /UNKNOWN, not zero/);
});

// ─────────────────────────────────────────────────────────────────────────────
// The trap: a daily lane's normal cadence is not an outage
// ─────────────────────────────────────────────────────────────────────────────

test("data-usage's real 24h gaps do NOT read as an outage — only the 48.91h one is a miss", () => {
  // The exact measured series: 24.30 h, 48.91 h, 24.00 h, 24.013 h.
  const gaps = [24.3, 48.91, 24.0, 24.013];
  let ago = 0;
  const gapRows = gaps.map((h) => {
    const row = { agoSeconds: ago, seconds: h * HOUR };
    ago += h * HOUR;
    return row;
  });
  const obs: LaneObservations = {
    lane: "data-usage",
    source: "poller_runs",
    count: 5,
    firstAt: at(ago),
    lastAt: at(0),
    medianGapSeconds: 24.155 * HOUR,
    // Only gaps past the 2x-interval floor are ever returned, which for a daily
    // lane is exactly the 48.91 h one. The 24 h gaps are its NORMAL day.
    gaps: gapRows.filter((g) => g.seconds > 2 * 24 * HOUR).map((g) => ({
      startedAt: at(g.agoSeconds + g.seconds),
      endedAt: at(g.agoSeconds),
      seconds: g.seconds,
    })),
    gapsTruncated: false,
  };

  const coverage = measureConfiguredCoverage(decl("data-usage"), obs);
  // floor(48.91/24) - 1 = 1. Exactly one fire skipped, across the whole history.
  assert.equal(coverage.missedFires, 1, "one real miss, not one per day");
  assert.equal(coverage.observed, 5);
  assert.equal(coverage.expected, 6);

  // And even measuring every gap, a normal day skips nothing.
  for (const h of [24.0, 24.013, 24.3]) {
    const normal = measureConfiguredCoverage(decl("data-usage"), {
      ...obs,
      count: 2,
      firstAt: at(h * HOUR),
      lastAt: at(0),
      gaps: [{ startedAt: at(h * HOUR), endedAt: at(0), seconds: h * HOUR }],
    });
    assert.equal(normal.missedFires, 0, `${h}h is one configured day, not a miss`);
    assert.equal(normal.expected, 2);
    assert.equal(normal.ratio, 1, `${h}h must read as full coverage`);
  }
});

test("an hour of downtime cannot excuse a missed DAILY fire", () => {
  // Found on the real data. `data-usage`'s 48.91 h gap skipped exactly one daily
  // fire, and about an hour of scattered correlated outage inside that two-day
  // window was enough — under proportional subtraction — to drag 48.91 h under
  // 2x its interval and excuse the miss entirely. An outage excuses only as many
  // fires as it had ROOM for, quantised to whole intervals.
  const gapSeconds = 48.91 * HOUR;
  const obs: LaneObservations = {
    lane: "data-usage",
    source: "poller_runs",
    count: 2,
    firstAt: at(gapSeconds),
    lastAt: at(0),
    medianGapSeconds: gapSeconds,
    gaps: [{ startedAt: at(gapSeconds), endedAt: at(0), seconds: gapSeconds }],
    gapsTruncated: false,
  };
  const hourLongOutage = {
    startedAt: at(gapSeconds - HOUR).toISOString(),
    endedAt: at(gapSeconds - 2 * HOUR).toISOString(),
    seconds: HOUR,
    lanes: ["status", "metrics"],
    stopSpreadSeconds: 0.05,
    resumeSpreadSeconds: 0.1,
  };
  const coverage = measureConfiguredCoverage(decl("data-usage"), obs, [hourLongOutage]);
  assert.equal(coverage.missedFires, 1);
  assert.equal(
    coverage.missedFiresOutsideOutages,
    1,
    "one hour of downtime cannot swallow a fire that happens once a day",
  );

  // And the converse must still hold: an outage LONGER than the interval does
  // excuse it, which is what keeps the 22.28 h hole off a 2-minute lane.
  const twoDayOutage = { ...hourLongOutage, seconds: 2 * 24 * HOUR,
    startedAt: at(gapSeconds).toISOString(), endedAt: at(0).toISOString() };
  assert.equal(
    measureConfiguredCoverage(decl("data-usage"), obs, [twoDayOutage])
      .missedFiresOutsideOutages,
    0,
  );
});

test("a daily lane at its configured cadence produces no coverage finding", () => {
  const dayRuns: PollerRunRow[] = [0, 1, 2, 3].map((i) => ({
    poller: "data-usage",
    startedAt: at(i * 24 * HOUR),
    durationMs: 1000,
    devicesTargeted: 26,
    rowsWritten: 780,
    batchesOk: 26,
    batchesFailed: 0,
    telemetryYield: null,
  }));
  const report = assessPipelineHealth(dayRuns, {
    now: NOW,
    expectedLanes: [decl("data-usage")],
    optInEnabled: { "data-usage": true },
    observations: [
      observations("data-usage", "poller_runs", { count: 4, everySeconds: 24 * HOUR }),
    ],
  });
  const lane = laneOf(report, "data-usage");
  assert.equal(lane.coverage.ratio, 1);
  assert.equal(
    lane.findings.filter((f) => f.kind === "lane-coverage-shortfall").length,
    0,
    "a daily lane working perfectly must be silent, or the alarm gets ignored",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// One process outage, not N lane failures
// ─────────────────────────────────────────────────────────────────────────────

test("lanes that stop and resume together are ONE outage, not one finding each", () => {
  // The measured event: six lanes stop within 4.62 s and resume within 35.23 s,
  // 22.28 h later.
  const stop = new Date("2026-08-26T18:19:12.000Z");
  const resume = new Date("2026-08-27T16:36:09.000Z");
  const lanes = ["alerting", "compliance", "devices", "metrics", "snapshot", "status"];
  const outages = correlateOutages(
    lanes.map((lane, i) => ({
      lane,
      startedAt: new Date(stop.getTime() + i * 900),
      endedAt: new Date(resume.getTime() + i * 7000),
      seconds: (resume.getTime() + i * 7000 - (stop.getTime() + i * 900)) / 1000,
    })),
  );
  assert.equal(outages.length, 1, "one process, one finding");
  assert.deepEqual(outages[0]!.lanes, lanes);
  assert.ok(outages[0]!.stopSpreadSeconds < 10);
  assert.ok(outages[0]!.resumeSpreadSeconds < 60);
  // The window claimed is only what every member shares: from the LAST stop to
  // the FIRST resume. Claiming the union would overstate the outage.
  assert.equal(outages[0]!.startedAt, new Date(stop.getTime() + 5 * 900).toISOString());
  assert.equal(outages[0]!.endedAt, resume.toISOString());
});

test("ONE lane alone is never an outage — that is a lane question", () => {
  // The floor: correlation needs something to correlate. A single lane going
  // quiet is exactly what the stall and coverage checks are for.
  const outages = correlateOutages([
    {
      lane: "status",
      startedAt: new Date("2026-08-26T18:19:12.000Z"),
      endedAt: new Date("2026-08-26T20:19:12.000Z"),
      seconds: 7200,
    },
  ]);
  assert.equal(outages.length, 0);
});

test("two lanes stopping within milliseconds IS the daemon, and excuses both", () => {
  // Measured: the stop spread inside a correlated window is p50 0.049 s. Two
  // collectors failing independently would stop at their own next-fire times,
  // minutes apart — not 49 ms apart. Requiring three members left seven lanes
  // individually blamed for holes they demonstrably shared.
  const stop = new Date("2026-08-26T18:19:12.000Z");
  const resume = new Date("2026-08-26T20:19:12.000Z");
  const outages = correlateOutages(
    ["status", "metrics"].map((lane, i) => ({
      lane,
      startedAt: new Date(stop.getTime() + i * 50),
      endedAt: resume,
      seconds: 7200,
    })),
  );
  assert.equal(outages.length, 1);
  assert.deepEqual(outages[0]!.lanes, ["metrics", "status"]);
  assert.ok(outages[0]!.stopSpreadSeconds < 1);
});

test("two lanes silent over the same window but MINUTES apart is not correlated", () => {
  // The discriminator is the tightness of the stop, not the overlap. Past the
  // cluster tolerance these are two faults that happen to coincide.
  const stop = new Date("2026-08-26T18:19:12.000Z");
  const resume = new Date("2026-08-26T20:19:12.000Z");
  const outages = correlateOutages(
    ["status", "metrics"].map((lane, i) => ({
      lane,
      startedAt: new Date(stop.getTime() + i * 10 * 60_000),
      endedAt: resume,
      seconds: 7200,
    })),
  );
  assert.equal(outages.length, 0);
});

test("lanes silent at unrelated times are never merged into one outage", () => {
  const outages = correlateOutages([
    { lane: "status", startedAt: new Date("2026-08-26T01:00:00Z"), endedAt: new Date("2026-08-26T03:00:00Z"), seconds: 7200 },
    { lane: "metrics", startedAt: new Date("2026-08-27T01:00:00Z"), endedAt: new Date("2026-08-27T03:00:00Z"), seconds: 7200 },
    { lane: "devices", startedAt: new Date("2026-08-28T01:00:00Z"), endedAt: new Date("2026-08-28T03:00:00Z"), seconds: 7200 },
  ]);
  assert.equal(outages.length, 0, "a day apart is three faults, not one outage");
});

test("a hole the whole daemon shared is not charged to the lane", () => {
  // `status` over the real span: a 22.28 h shared outage inside an otherwise
  // healthy 2-minute rhythm. Raw coverage looks broken; adjusted does not, and
  // the adjusted figure is the one judged.
  const outageSeconds = 22.28 * HOUR;
  // Internally consistent with the real lane: 3,857 runs at a measured 122 s
  // median is 130.7 h of rhythm, plus the 22.28 h hole the daemon shared.
  const span = 3856 * 122 + outageSeconds;
  const obs: LaneObservations = {
    lane: "status",
    source: "poller_runs",
    count: 3857,
    firstAt: at(span),
    lastAt: at(0),
    medianGapSeconds: 122,
    gaps: [{ startedAt: at(span - HOUR), endedAt: at(span - HOUR - outageSeconds), seconds: outageSeconds }],
    gapsTruncated: false,
  };
  const outage = {
    startedAt: at(span - HOUR).toISOString(),
    endedAt: at(span - HOUR - outageSeconds).toISOString(),
    seconds: outageSeconds,
    lanes: ["alerting", "metrics", "status"],
    stopSpreadSeconds: 4.62,
    resumeSpreadSeconds: 35.23,
  };
  const coverage = measureConfiguredCoverage(decl("status"), obs, [outage]);

  assert.ok(
    coverage.ratio! < 0.9,
    "raw coverage includes the daemon's downtime and would trip the floor",
  );
  assert.ok(
    coverage.ratioExcludingOutages! > 0.9,
    "excluding it, the lane itself ran at its configured rate",
  );
  assert.equal(coverage.missedFiresOutsideOutages, 0, "the lane skipped nothing of its own");
  assert.match(coverage.basis, /fell inside a correlated \n?daemon outage/);
});

test("the report says 'one process outage', so an operator does not count lanes", () => {
  const stop = 40 * HOUR;
  const outageSeconds = 22.28 * HOUR;
  const affected = ["alerting", "devices", "metrics", "status"];
  const report = assessPipelineHealth(
    affected.flatMap((poller) =>
      [0, 1, 2, 3, 4].map((i) => ({
        poller,
        startedAt: at(i * 2 * MIN),
        durationMs: 1000,
        devicesTargeted: 100,
        rowsWritten: 100,
        batchesOk: 1,
        batchesFailed: 0,
        telemetryYield: null,
      })),
    ),
    {
      now: NOW,
      expectedLanes: affected.map(decl),
      observations: affected.map((lane, i) => ({
        lane,
        source: "poller_runs",
        count: 500,
        firstAt: at(100 * HOUR),
        lastAt: at(0),
        medianGapSeconds: 122,
        gaps: [
          {
            startedAt: at(stop + i),
            endedAt: at(stop - outageSeconds + i * 5),
            seconds: outageSeconds - i * 4,
          },
        ],
        gapsTruncated: false,
      })),
    },
  );
  assert.equal(report.outages.length, 1);
  const finding = report.findings.find((f) => f.kind === "pipeline-outage");
  assert.ok(finding);
  assert.equal(finding!.lane, "(whole pipeline)", "no single lane owns a daemon outage");
  assert.match(finding!.detail, /this is the DAEMON stopping, not 4 independent/);
  assert.match(report.summary, /is ONE process outage, not 4 lane failures/);
  // And no lane is individually condemned for it.
  assert.equal(report.findings.filter((f) => f.kind === "lane-coverage-shortfall").length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Opt-in lanes, and the two cadences staying separate
// ─────────────────────────────────────────────────────────────────────────────

test("an opt-in lane that is OFF reads as off, not broken, and carries no coverage claim", () => {
  const report = assessPipelineHealth([], {
    now: NOW,
    // Scoped to the two lanes under test: with the full roster the untouched
    // non-opt-in lanes are legitimately never-ran here and would mask the point.
    expectedLanes: [decl("screen-verify-slowlane"), decl("telemetry-slowlane")],
    optInEnabled: { "screen-verify-slowlane": false, "telemetry-slowlane": false },
  });
  for (const lane of ["screen-verify-slowlane", "telemetry-slowlane"]) {
    const health = laneOf(report, lane);
    assert.equal(health.status, "disabled", `${lane} is off by choice, not broken`);
    assert.deepEqual(health.findings, [], "off by choice must not generate a finding");
    // Off means we collected nothing, which is not a rate of zero.
    assert.equal(health.coverage.ratio, null);
  }
  assert.equal(report.deviceDataAtRisk, false);
});

test("the observed cadence and the configured one are both reported, and can disagree", () => {
  // `snapshot` is the case that proves they must both exist: a flawless 5.33 min
  // observed rhythm and 59.3% of its configured 5-minute rate. Either number
  // alone tells a different, incomplete story.
  const obs: LaneObservations = {
    lane: "snapshot",
    source: "fleet_snapshots.computed_at",
    count: 1686,
    firstAt: at(236.82 * HOUR),
    lastAt: at(0),
    medianGapSeconds: 5.33 * MIN,
    gaps: [{ startedAt: at(100 * HOUR), endedAt: at(100 * HOUR - 23.56 * HOUR), seconds: 23.56 * HOUR }],
    gapsTruncated: false,
  };
  const lane = laneOf(
    assessPipelineHealth([], {
      now: NOW,
      expectedLanes: expectedLanesFor({}),
      observations: [obs],
    }),
    "snapshot",
  );
  assert.equal(lane.cadence.seconds, 5.33 * MIN, "observed: its own recent rhythm");
  assert.equal(lane.coverage.configuredIntervalSeconds, 300, "configured: what we set it to");
  assert.match(lane.cadence.basis, /fleet_snapshots\.computed_at/);
  assert.ok(lane.coverage.ratio! < 0.6, "and the two disagree, which is the finding");
});

test("measureCadence is untouched: it still ignores the configured interval entirely", () => {
  // Requirement: add the configured question, do not replace the observed one.
  const runs: PollerRunRow[] = [0, 1, 2, 3, 4].map((i) => ({
    poller: "status",
    startedAt: at(i * 9 * MIN),
    durationMs: 1000,
    devicesTargeted: 100,
    rowsWritten: 100,
    batchesOk: 1,
    batchesFailed: 0,
    telemetryYield: null,
  }));
  // Configured cadence for `status` is 2 minutes; the observed one is 9, and
  // `measureCadence` reports the observation without consulting the declaration.
  assert.equal(measureCadence(runs).seconds, 9 * MIN);
  assert.equal(decl("status").intervalSeconds, 2 * MIN);
});

test("coverage is unmeasured, not zero, when no observation history is supplied", () => {
  // The route reads coverage separately from run history, so one read failing
  // must leave honest nulls rather than a wall of 0%.
  const report = assessPipelineHealth([], { now: NOW, expectedLanes: expectedLanesFor({}) });
  for (const lane of report.lanes) {
    assert.equal(lane.coverage.ratio, null, `${lane.lane} must not claim a measured rate`);
    assert.ok(lane.coverage.basis.length > 0, `${lane.lane} must say why coverage is null`);
  }
});

test("a truncated gap list is reported as a floor, not as a fact", () => {
  const obs = observations("status", "poller_runs", {
    count: 3857,
    everySeconds: 122,
    gaps: [{ agoSeconds: HOUR, seconds: 40 * MIN }],
    gapsTruncated: true,
  });
  const coverage = measureConfiguredCoverage(decl("status"), obs);
  assert.equal(coverage.incomplete, true);
  assert.match(coverage.basis, /missed fires is a floor/);
});
