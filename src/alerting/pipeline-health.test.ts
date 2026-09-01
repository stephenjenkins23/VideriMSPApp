/**
 * Pipeline self-observability tests — `node --test dist/alerting/pipeline-health.test.js`
 *
 * The failure this guards against is not a crash. It is a lane that stops and
 * says nothing, which is why every branch below asserts on the DETECTION rather
 * than on a happy path: never ran, ran once long ago, stalled, overdue, failing
 * every batch, and running perfectly while bringing back nothing.
 *
 * The two false-positive branches matter just as much. A lane that has never
 * yielded anything is not collapsing (`metrics` yields 0 forever, by design), and
 * a lane whose opt-in flag is off has not broken. A self-check that cries wolf is
 * a self-check nobody reads, and then we are back to finding a three-day-old
 * daemon by accident.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessPipelineHealth,
  measureCadence,
  EXPECTED_LANES,
  PIPELINE_HEALTH_DEFAULTS,
  type PollerRunRow,
  type ExpectedLane,
} from "./pipeline-health.js";

const NOW = new Date("2026-09-01T12:00:00Z");
const secondsAgo = (s: number) => new Date(NOW.getTime() - s * 1000);
const MIN = 60;
const HOUR = 3600;

const run = (over: Partial<PollerRunRow> & { poller: string; agoSeconds: number }): PollerRunRow => ({
  poller: over.poller,
  startedAt: secondsAgo(over.agoSeconds),
  durationMs: over.durationMs ?? 1_000,
  devicesTargeted: over.devicesTargeted ?? 100,
  rowsWritten: over.rowsWritten ?? 100,
  batchesOk: over.batchesOk ?? 1,
  batchesFailed: over.batchesFailed ?? 0,
  telemetryYield: over.telemetryYield ?? null,
});

/** A lane running cleanly every `everySeconds`, `count` runs deep. */
const series = (
  poller: string,
  everySeconds: number,
  count: number,
  { startAgo = 0, ...over }: Partial<PollerRunRow> & { startAgo?: number } = {},
): PollerRunRow[] =>
  Array.from({ length: count }, (_, i) =>
    run({ poller, agoSeconds: startAgo + i * everySeconds, ...over }),
  );

const lanes = (roster: ExpectedLane[] = []) => roster;
const assess = (runs: PollerRunRow[], opts: Parameters<typeof assessPipelineHealth>[1] = {}) =>
  assessPipelineHealth(runs, { now: NOW, expectedLanes: [], ...opts });

const laneOf = (report: ReturnType<typeof assess>, name: string) =>
  report.lanes.find((l) => l.lane === name)!;

// ─────────────────────────────────────────────────────────────────────────────
// Cadence is measured, not declared
// ─────────────────────────────────────────────────────────────────────────────

test("cadence is the median gap, so one daemon restart cannot redefine it", () => {
  const runs = [
    run({ poller: "status", agoSeconds: 0 }),
    run({ poller: "status", agoSeconds: 2 * MIN }),
    run({ poller: "status", agoSeconds: 4 * MIN }),
    // A 5-hour hole where the daemon was restarted.
    run({ poller: "status", agoSeconds: 5 * HOUR }),
    run({ poller: "status", agoSeconds: 5 * HOUR + 2 * MIN }),
    run({ poller: "status", agoSeconds: 5 * HOUR + 4 * MIN }),
  ];
  const cadence = measureCadence(runs);
  assert.equal(cadence.confidence, "measured");
  assert.equal(cadence.seconds, 2 * MIN, "the outlier must not move the median");
  assert.match(cadence.basis, /median of 5 gaps/);
});

test("one or two gaps give a provisional cadence — the slowest we have seen", () => {
  const cadence = measureCadence([
    run({ poller: "data-usage", agoSeconds: 0 }),
    run({ poller: "data-usage", agoSeconds: 20 * HOUR }),
    run({ poller: "data-usage", agoSeconds: 44 * HOUR }),
  ]);
  assert.equal(cadence.confidence, "provisional");
  assert.equal(cadence.seconds, 24 * HOUR);
  assert.match(cadence.basis, /too few to be sure/);
});

test("a single run has no cadence at all, and says so rather than guessing", () => {
  const cadence = measureCadence([run({ poller: "x", agoSeconds: 0 })]);
  assert.equal(cadence.seconds, null);
  assert.equal(cadence.confidence, "unknown");
  assert.match(cadence.basis, /no gap to measure/);
});

// ─────────────────────────────────────────────────────────────────────────────
// (a) a lane that has stopped running
// ─────────────────────────────────────────────────────────────────────────────

test("a lane running at its measured cadence is healthy", () => {
  const report = assess(series("status", 2 * MIN, 20));
  assert.equal(laneOf(report, "status").status, "healthy");
  assert.deepEqual(report.findings, []);
  assert.equal(report.deviceDataAtRisk, false);
  assert.match(report.summary, /running at their measured cadence/);
});

test("a lane past 3x its own cadence is STALLED, and says the data is stale", () => {
  // Every run is old: the newest is 90 minutes back on a 15-minute lane.
  const report = assess(series("telemetry-slowlane", 15 * MIN, 20, { startAgo: 90 * MIN }));
  const lane = laneOf(report, "telemetry-slowlane");
  assert.equal(lane.status, "stalled");
  const finding = lane.findings.find((f) => f.kind === "lane-stalled")!;
  assert.equal(finding.severity, "high");
  assert.equal(finding.scope, "vfi-pipeline", "never confusable with a device alert");
  assert.match(finding.detail, /6\.0× its own cadence/);
  assert.match(finding.dataImpact, /DEVICE DATA IS STALE/);
  assert.match(finding.dataImpact, /Silence from this lane is not health/);
  assert.equal(report.deviceDataAtRisk, true);
  assert.match(report.summary, /device data they feed is stale/);
});

test("a lane behind but not stalled is OVERDUE — said, not paged", () => {
  const report = assess(series("compliance", 15 * MIN, 20, { startAgo: 30 * MIN }));
  const lane = laneOf(report, "compliance");
  assert.equal(lane.status, "overdue");
  assert.equal(lane.findings[0]?.kind, "lane-overdue");
  assert.equal(lane.findings[0]?.severity, "info");
  assert.equal(report.deviceDataAtRisk, false, "overdue is not yet a data-loss claim");
});

test("a fast lane is not called stalled over one hiccup — the floor holds", () => {
  // 2-minute cadence × 3 = 6 min, but the floor is 10 min, so 8 min is fine.
  const report = assess(series("status", 2 * MIN, 20, { startAgo: 8 * MIN }));
  assert.notEqual(laneOf(report, "status").status, "stalled");
  assert.ok(
    PIPELINE_HEALTH_DEFAULTS.minStallSeconds >= 600,
    "the floor is what makes a 2-minute lane liveable",
  );
});

test("a provisional cadence gets a wider stall threshold", () => {
  // Two gaps of ~24h; 2 days of silence is 2x, under the 4x provisional bar.
  const daily = [
    run({ poller: "data-usage", agoSeconds: 48 * HOUR }),
    run({ poller: "data-usage", agoSeconds: 72 * HOUR }),
    run({ poller: "data-usage", agoSeconds: 96 * HOUR }),
  ];
  const lane = laneOf(assess(daily), "data-usage");
  assert.equal(lane.status, "overdue", "behind, but a weak cadence estimate cannot condemn it");
  assert.equal(lane.cadence.confidence, "provisional");

  // Five days of silence is past even the wide bar.
  const stalled = daily.map((r) => ({ ...r, startedAt: new Date(r.startedAt.getTime() - 5 * 24 * HOUR * 1000) }));
  const worse = laneOf(assess(stalled), "data-usage");
  assert.equal(worse.status, "stalled");
  assert.equal(worse.findings[0]?.severity, "medium", "a provisional cadence cannot claim `high`");
});

test("ran once, long ago: judged against the ceiling, not against a guessed interval", () => {
  const report = assess([run({ poller: "screen-verify-slowlane", agoSeconds: 30 * HOUR })]);
  const lane = laneOf(report, "screen-verify-slowlane");
  assert.equal(lane.status, "stalled");
  assert.equal(lane.cadence.seconds, null);
  const finding = lane.findings[0]!;
  assert.match(finding.headline, /one run in the assessed history/);
  assert.match(finding.detail, /no cadence to compare against/);
  assert.match(finding.dataImpact, /DEVICE DATA IS STALE/);
});

test("ran once, recently: unknown rather than healthy — and no false alarm", () => {
  const report = assess([run({ poller: "screen-verify-slowlane", agoSeconds: 5 * MIN })]);
  const lane = laneOf(report, "screen-verify-slowlane");
  assert.equal(lane.status, "unknown", "one run is not evidence of a cadence");
  assert.deepEqual(lane.findings, []);
});

test("never ran, and it is not opt-in: a high finding naming what is missing", () => {
  const report = assess([], { expectedLanes: lanes([{ lane: "status", feeds: "presence" }]) });
  const lane = laneOf(report, "status");
  assert.equal(lane.status, "never-ran");
  assert.equal(lane.ageSeconds, null, "no run means no age — not zero");
  const finding = lane.findings[0]!;
  assert.equal(finding.kind, "lane-never-ran");
  assert.equal(finding.severity, "high");
  assert.match(finding.dataImpact, /absent — not zero, not fine/);
  assert.equal(report.deviceDataAtRisk, true);
});

test("never ran with its opt-in flag OFF is disabled, not broken", () => {
  const roster = lanes([{ lane: "ai-brief", optInEnv: "ENABLE_AI_JOBS", feeds: "the brief" }]);
  const report = assess([], { expectedLanes: roster, optInEnabled: { "ai-brief": false } });
  assert.equal(laneOf(report, "ai-brief").status, "disabled");
  assert.deepEqual(report.findings, [], "off by choice is not a fault");
  assert.match(report.summary, /running at their measured cadence/);
});

test("never ran with its opt-in flag ON is a fault", () => {
  const roster = lanes([{ lane: "ai-brief", optInEnv: "ENABLE_AI_JOBS", feeds: "the brief" }]);
  const report = assess([], { expectedLanes: roster, optInEnabled: { "ai-brief": true } });
  assert.equal(laneOf(report, "ai-brief").status, "never-ran");
  assert.equal(report.findings[0]?.severity, "high");
  assert.match(report.findings[0]!.detail, /ENABLE_AI_JOBS is set, so it should have run/);
});

test("never ran with an unreadable flag is UNKNOWN, not a fault", () => {
  // Two paid AI lanes that were never switched on must not make the live report
  // claim device data is at risk. Unknown is the honest word for it.
  const roster = lanes([{ lane: "ai-brief", optInEnv: "ENABLE_AI_JOBS", feeds: "the brief" }]);
  const report = assess([], { expectedLanes: roster });
  assert.equal(laneOf(report, "ai-brief").status, "unknown");
  assert.equal(report.findings[0]?.severity, "info");
  assert.match(report.findings[0]!.detail, /if that flag is set this is a fault/);
  assert.equal(report.deviceDataAtRisk, false);
  assert.equal(report.worstStatus, "unknown");
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) a lane failing every batch
// ─────────────────────────────────────────────────────────────────────────────

test("failing every batch on the last run is a high finding", () => {
  const runs = [
    run({ poller: "devices", agoSeconds: 0, batchesOk: 0, batchesFailed: 3, rowsWritten: 0 }),
    ...series("devices", 15 * MIN, 10, { startAgo: 15 * MIN }),
  ];
  const lane = laneOf(assess(runs), "devices");
  assert.equal(lane.status, "failing");
  assert.equal(lane.consecutiveAllFailed, 1);
  const finding = lane.findings.find((f) => f.kind === "lane-all-batches-failing")!;
  assert.equal(finding.severity, "high");
  assert.match(finding.detail, /alive and doing nothing/);
  assert.match(finding.dataImpact, /Treat it as stale, not as unchanged/);
});

test("failing every batch for three runs escalates to critical", () => {
  const runs = [
    ...series("devices", 15 * MIN, 3, { batchesOk: 0, batchesFailed: 3, rowsWritten: 0 }),
    ...series("devices", 15 * MIN, 10, { startAgo: 45 * MIN }),
  ];
  const lane = laneOf(assess(runs), "devices");
  assert.equal(lane.consecutiveAllFailed, 3);
  assert.equal(lane.findings.find((f) => f.kind === "lane-all-batches-failing")?.severity, "critical");
});

test("SOME failed batches is not the same as all of them", () => {
  const runs = series("device-settings", 60 * MIN, 10, { batchesOk: 104, batchesFailed: 4 });
  const lane = laneOf(assess(runs), "device-settings");
  assert.equal(lane.consecutiveAllFailed, 0);
  assert.equal(lane.status, "healthy", "4 unreachable devices out of 108 is normal operation");
});

test("a lane with nothing to do reports zero of both and is not failing", () => {
  const runs = series("screen-verify-slowlane", 15 * MIN, 10, {
    devicesTargeted: 0, rowsWritten: 0, batchesOk: 0, batchesFailed: 0, telemetryYield: null,
  });
  const lane = laneOf(assess(runs), "screen-verify-slowlane");
  assert.equal(lane.status, "healthy");
  assert.deepEqual(lane.findings, [], "no targets, no rows, no fault");
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) a lane running and bringing back nothing
// ─────────────────────────────────────────────────────────────────────────────

test("yield falling to zero after a positive run is a collapse", () => {
  const runs = [
    ...series("telemetry-slowlane", 15 * MIN, 3, { telemetryYield: 0 }),
    ...series("telemetry-slowlane", 15 * MIN, 8, { startAgo: 45 * MIN, telemetryYield: 1 }),
  ];
  const lane = laneOf(assess(runs), "telemetry-slowlane");
  assert.equal(lane.status, "collapsed");
  const finding = lane.findings.find((f) => f.kind === "lane-yield-collapsed")!;
  assert.equal(finding.severity, "high");
  assert.match(finding.headline, /telemetry yield has fallen to zero/);
  assert.match(finding.detail, /succeeds at collecting nothing/);
  assert.match(finding.dataImpact, /payload shape change/);
  assert.ok(finding.since, "the collapse must be dated");
});

test("one or two zero runs is not a collapse — slow lanes have quiet ticks", () => {
  const runs = [
    ...series("telemetry-slowlane", 15 * MIN, 2, { telemetryYield: 0 }),
    ...series("telemetry-slowlane", 15 * MIN, 8, { startAgo: 30 * MIN, telemetryYield: 1 }),
  ];
  const lane = laneOf(assess(runs), "telemetry-slowlane");
  assert.equal(lane.status, "healthy");
  assert.deepEqual(lane.findings, []);
});

test("a lane that has NEVER yielded is not collapsing — it is doing what it always did", () => {
  // `metrics` reports yield 0 on every run: the platform's bulk payload carries
  // no hardware telemetry at all. Flagging that daily would be crying wolf.
  const runs = series("metrics", 7 * MIN, 20, { telemetryYield: 0 });
  const lane = laneOf(assess(runs), "metrics");
  assert.equal(lane.status, "healthy");
  assert.deepEqual(lane.findings, []);
});

test("a null yield is not a zero yield", () => {
  const runs = series("status", 2 * MIN, 20, { telemetryYield: null });
  assert.deepEqual(laneOf(assess(runs), "status").findings, []);
});

test("rows falling to zero after productive runs is a collapse too", () => {
  const runs = [
    ...series("schedule-slowlane", 30 * MIN, 4, { rowsWritten: 0 }),
    ...series("schedule-slowlane", 30 * MIN, 8, { startAgo: 120 * MIN, rowsWritten: 20 }),
  ];
  const lane = laneOf(assess(runs), "schedule-slowlane");
  const finding = lane.findings.find((f) => f.kind === "lane-yield-collapsed")!;
  assert.match(finding.headline, /rows written has fallen to zero/);
});

test("lanes where writing nothing is normal are exempt from the rows check", () => {
  // An alerting cycle on a clean fleet opens, refreshes and resolves nothing.
  const runs = [
    ...series("alerting", 7 * MIN, 5, { rowsWritten: 0 }),
    ...series("alerting", 7 * MIN, 8, { startAgo: 40 * MIN, rowsWritten: 300 }),
  ];
  const report = assess(runs, { expectedLanes: EXPECTED_LANES });
  assert.deepEqual(laneOf(report, "alerting").findings, []);
  assert.equal(
    EXPECTED_LANES.find((l) => l.lane === "alerting")?.zeroRowsIsNormal,
    true,
    "the exemption is declared in the roster, not inferred",
  );
});

test("runs that targeted no devices are excluded from the rows check", () => {
  const runs = [
    ...series("screen-verify-slowlane", 15 * MIN, 4, { devicesTargeted: 0, rowsWritten: 0 }),
    ...series("screen-verify-slowlane", 15 * MIN, 8, { startAgo: 60 * MIN, rowsWritten: 2 }),
  ];
  assert.deepEqual(laneOf(assess(runs), "screen-verify-slowlane").findings, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// Report shape
// ─────────────────────────────────────────────────────────────────────────────

test("every finding is scoped to our pipeline and explains the data impact", () => {
  const report = assess(
    [
      ...series("telemetry-slowlane", 15 * MIN, 20, { startAgo: 4 * HOUR }),
      run({ poller: "devices", agoSeconds: 0, batchesOk: 0, batchesFailed: 2 }),
      ...series("devices", 15 * MIN, 8, { startAgo: 15 * MIN }),
    ],
    { expectedLanes: lanes([{ lane: "ai-brief", optInEnv: "ENABLE_AI_JOBS", feeds: "the brief" }]) },
  );
  assert.ok(report.findings.length >= 3);
  for (const finding of report.findings) {
    assert.equal(finding.scope, "vfi-pipeline");
    assert.ok(finding.dataImpact.length > 40, `${finding.kind} must state the data impact`);
    assert.ok(finding.lane.length > 0);
  }
  // Worst first, so the summary line cannot lead with an `info`.
  assert.equal(report.findings[0]?.severity, "high");
  assert.equal(report.scope, "vfi-pipeline");
});

test("a lane that runs but is missing from the roster is still watched", () => {
  const report = assess(series("brand-new-lane", 10 * MIN, 20, { startAgo: 3 * HOUR }), {
    expectedLanes: EXPECTED_LANES,
  });
  assert.equal(laneOf(report, "brand-new-lane").status, "stalled");
});

test("the roster carries no cadences — those are measured", () => {
  for (const lane of EXPECTED_LANES) {
    assert.deepEqual(
      Object.keys(lane).filter((k) => /interval|cadence|seconds|ms/i.test(k)),
      [],
      `${lane.lane} must not declare a cadence`,
    );
  }
});

test("worstStatus reports the worst lane, not the average", () => {
  const report = assess([
    ...series("status", 2 * MIN, 20),
    ...series("compliance", 15 * MIN, 20, { startAgo: 30 * MIN }),
    run({ poller: "devices", agoSeconds: 0, batchesOk: 0, batchesFailed: 1 }),
    ...series("devices", 15 * MIN, 8, { startAgo: 15 * MIN }),
  ]);
  assert.equal(report.worstStatus, "failing");
  assert.match(report.summary, /OUR pipeline \(not the fleet\)/);
});
