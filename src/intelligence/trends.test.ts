/**
 * Trend engine tests — `node --test dist/intelligence/trends.test.js`
 *
 * The gates are the product here, so they are what gets tested hardest. Four
 * classes of test carry the file:
 *
 *   1. **Each gate in BOTH directions.** A gate that only ever suppresses is
 *      indistinguishable from a broken detector, so every minimum is tested at
 *      one below (nothing emitted) and at exactly the threshold (emitted).
 *
 *   2. **Data gaps must never read as declines.** There is a dedicated test per
 *      trend type: a collector outage in the prior availability window, a
 *      multi-day hole inside a storage series, and a fleet-wide feed outage in
 *      the usage days. All three must produce a suppression or a refusal, never
 *      a regression. This is the single most likely way the feature could lie.
 *
 *   3. **Flat and recovering series.** A steady fleet must produce no trends, and
 *      an improving one must produce a `recovery` — if the detector can only find
 *      declines, the asymmetry is the bug.
 *
 *   4. **Clock garbage.** A platform date a year in the future must not become the
 *      reference "today" and brand the entire fleet silent, and an out-of-range
 *      storage percent must not become a fill rate.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AVAILABILITY_GATES,
  SILENCE_GATES,
  STORAGE_GATES,
  analyzeAvailability,
  analyzeStorage,
  analyzeTransmissionSilence,
  buildTrendReport,
  compareAvailability,
  leastSquaresSlope,
  observationBalance,
  sanitizeStoragePoints,
  sanitizeUsageDates,
  summarizeSuppressions,
  windowsComparable,
  type DeviceBucketCounts,
  type StorageSeries,
  type TrendDevice,
  type UsageDay,
  type WindowRef,
} from "./trends.js";

const NOW = new Date("2026-09-01T12:00:00Z");

const win = (label: string, fleetObservedBuckets: number, days = 7): WindowRef => ({
  label,
  from: "2026-08-25T12:00:00Z",
  to: "2026-09-01T12:00:00Z",
  days,
  bucketSeconds: 300,
  fleetObservedBuckets,
  collectorCoverage: fleetObservedBuckets / 2016,
});

const WINDOWS = { recent: win("the last 7 days", 800), prior: win("the previous 7 days", 800) };

const dev = (id: string, over: Partial<TrendDevice> = {}): TrendDevice => ({
  id,
  name: `Panel ${id}`,
  site: null,
  ...over,
});

const site = (uuid: string, name: string) => ({ uuid, name });

const buckets = (deviceId: string, observed: number, online: number): DeviceBucketCounts => ({
  deviceId,
  observedBuckets: observed,
  onlineBuckets: online,
});

// ─── helpers ──────────────────────────────────────────────────────────────────

test("observationBalance is the smaller over the larger, and 0 when nothing was observed", () => {
  assert.equal(observationBalance(100, 100), 1);
  assert.equal(observationBalance(25, 100), 0.25);
  assert.equal(observationBalance(100, 25), 0.25);
  assert.equal(observationBalance(0, 0), 0);
  assert.equal(observationBalance(0, 50), 0);
});

test("leastSquaresSlope fits an exact line and refuses a series with no x spread", () => {
  assert.equal(leastSquaresSlope([0, 1, 2, 3], [10, 12, 14, 16]), 2);
  assert.equal(leastSquaresSlope([0, 1, 2], [5, 5, 5]), 0);
  // All readings at the same instant: no slope exists, and 0 would be a claim.
  assert.equal(leastSquaresSlope([2, 2, 2], [1, 5, 9]), null);
  assert.equal(leastSquaresSlope([1], [1]), null);
});

test("summarizeSuppressions counts every item but caps the examples", () => {
  const items = Array.from({ length: 20 }, (_, i) => ({
    scope: "device" as const,
    key: `d${i}`,
    label: `d${i}`,
    reason: "insufficient-points" as const,
    detail: "x",
  }));
  const summary = summarizeSuppressions(items);
  assert.equal(summary.total, 20);
  assert.equal(summary.byReason["insufficient-points"], 20);
  assert.ok(summary.examples.length < 20, "examples must be bounded");
});

// ─── 1. availability: window comparability (the data-gap guard) ───────────────

test("windowsComparable accepts two well-collected windows", () => {
  assert.equal(windowsComparable(win("a", 800), win("b", 800)).comparable, true);
});

test("GATE: a recent window below minFleetBuckets refuses the whole comparison", () => {
  const below = windowsComparable(
    win("recent", AVAILABILITY_GATES.minFleetBuckets - 1),
    win("prior", 800),
  );
  assert.equal(below.comparable, false);
  assert.match(below.reason!, /not enough history/i);

  // ...and exactly at the threshold it is allowed through. Balance still applies,
  // so the prior window is sized to keep them comparable.
  const at = windowsComparable(
    win("recent", AVAILABILITY_GATES.minFleetBuckets),
    win("prior", AVAILABILITY_GATES.minFleetBuckets),
  );
  assert.equal(at.comparable, true);
});

test("GATE: a prior window we barely watched is refused as a baseline", () => {
  const result = windowsComparable(win("recent", 800), win("prior", 6));
  assert.equal(result.comparable, false);
  assert.match(result.reason!, /prior window/i);
});

test("DATA GAP: wildly unequal collection between windows is refused, not reported", () => {
  // The real shape on this deployment: the collector produced 2 buckets one day
  // and 228 another. 800 vs 100 is a balance of 0.125, under the 0.25 floor.
  const result = windowsComparable(win("recent", 800), win("prior", 100));
  assert.equal(result.comparable, false);
  assert.match(result.reason!, /how much we were looking/i);
});

test("DATA GAP: a collector outage in the prior window yields no trends at all", () => {
  const report = analyzeAvailability({
    recent: {
      window: win("the last 7 days", 800),
      // Looks catastrophic: 20% availability now vs 100% before.
      devices: [buckets("a", 400, 80), buckets("b", 400, 80)],
    },
    prior: {
      // The collector only managed 10 buckets — we were not looking.
      window: win("the previous 7 days", 10),
      devices: [buckets("a", 5, 5), buckets("b", 5, 5)],
    },
    devices: [dev("a"), dev("b")],
  });
  assert.equal(report.available, false);
  assert.deepEqual(report.trends, []);
  assert.ok(report.reason);
});

// ─── 1. availability: per-entity gates ───────────────────────────────────────

test("GATE: a device one bucket below minDeviceBuckets is suppressed, at it is judged", () => {
  const gate = AVAILABILITY_GATES.minDeviceBuckets;
  const below = compareAvailability(
    "device",
    "a",
    "Panel a",
    { observed: gate - 1, online: 0, devices: 1 },
    { observed: gate, online: gate, devices: 1 },
    WINDOWS,
  );
  assert.ok("suppressed" in below);
  assert.equal(below.suppressed.reason, "insufficient-recent-samples");

  const at = compareAvailability(
    "device",
    "a",
    "Panel a",
    { observed: gate, online: 0, devices: 1 },
    { observed: gate, online: gate, devices: 1 },
    WINDOWS,
  );
  assert.ok("trend" in at, "at the threshold the trend must be emitted");
  assert.equal(at.trend.direction, "regression");
  assert.equal(at.trend.deltaPoints, -100);
});

test("GATE: a thin PRIOR window for one device suppresses with the prior reason", () => {
  const gate = AVAILABILITY_GATES.minDeviceBuckets;
  const result = compareAvailability(
    "device",
    "a",
    "Panel a",
    { observed: 400, online: 100, devices: 1 },
    { observed: gate - 1, online: gate - 1, devices: 1 },
    WINDOWS,
  );
  assert.ok("suppressed" in result);
  assert.equal(result.suppressed.reason, "insufficient-prior-samples");
  assert.match(result.suppressed.detail, /No usable baseline/);
});

test('DATA GAP: "we stopped looking" is observation-imbalance, never a regression', () => {
  // Both windows clear the absolute floor, but we observed the device 400 times
  // then 30 times. Availability across those two samples is not comparable.
  const result = compareAvailability(
    "device",
    "a",
    "Panel a",
    { observed: 30, online: 6, devices: 1 },
    { observed: 400, online: 400, devices: 1 },
    WINDOWS,
  );
  assert.ok("suppressed" in result);
  assert.equal(result.suppressed.reason, "observation-imbalance");
  assert.match(result.suppressed.detail, /change here would be ours/);
});

test("GATE: minObservationBalance at exactly the floor is allowed through", () => {
  const result = compareAvailability(
    "device",
    "a",
    "Panel a",
    { observed: 100, online: 20, devices: 1 },
    { observed: 400, online: 400, devices: 1 },
    WINDOWS,
  );
  assert.ok("trend" in result, "balance 0.25 is exactly the floor and must pass");
  assert.equal(result.trend.direction, "regression");
});

test("GATE: a site below minSiteDevices is not judged as a site", () => {
  const result = compareAvailability(
    "site",
    "s1",
    "Montreal Office",
    { observed: 400, online: 100, devices: AVAILABILITY_GATES.minSiteDevices - 1 },
    { observed: 400, online: 400, devices: AVAILABILITY_GATES.minSiteDevices - 1 },
    WINDOWS,
  );
  assert.ok("suppressed" in result);
  assert.equal(result.suppressed.reason, "insufficient-devices");
});

test("a site's bucket floor scales with its membership", () => {
  const gate = AVAILABILITY_GATES.minDeviceBuckets;
  const devices = 5;
  // 5 devices need 5x the per-device floor; one short must suppress.
  const below = compareAvailability(
    "site",
    "s1",
    "NYC Office",
    { observed: gate * devices - 1, online: 0, devices },
    { observed: gate * devices, online: gate * devices, devices },
    WINDOWS,
  );
  assert.ok("suppressed" in below);
  const at = compareAvailability(
    "site",
    "s1",
    "NYC Office",
    { observed: gate * devices, online: 0, devices },
    { observed: gate * devices, online: gate * devices, devices },
    WINDOWS,
  );
  assert.ok("trend" in at);
});

// ─── 1. availability: direction, magnitude, wording ──────────────────────────

test("FLAT: a fleet that did not move produces no trends, only steady counts", () => {
  const report = analyzeAvailability({
    recent: {
      window: win("the last 7 days", 800),
      devices: [buckets("a", 400, 380), buckets("b", 400, 360)],
    },
    prior: {
      window: win("the previous 7 days", 800),
      devices: [buckets("a", 400, 382), buckets("b", 400, 356)],
    },
    devices: [dev("a"), dev("b")],
  });
  assert.equal(report.available, true);
  assert.deepEqual(report.trends, []);
  assert.equal(report.steady.devices, 2);
  assert.equal(report.suppressed.total, 0);
});

test("BOUNDARY: a change just under minDeltaPoints is steady, just over is a trend", () => {
  const mk = (recentOnline: number) =>
    compareAvailability(
      "device",
      "a",
      "Panel a",
      { observed: 100, online: recentOnline, devices: 1 },
      { observed: 100, online: 90, devices: 1 },
      WINDOWS,
    );
  // 90% -> 81% is 9 points: steady, under the 10-point floor.
  assert.ok("steady" in mk(81));
  // 90% -> 80% is exactly 10 points: reported.
  assert.ok("trend" in mk(80));
});

test("RECOVERY: an improving entity is reported as a recovery, not ignored", () => {
  const result = compareAvailability(
    "site",
    "s1",
    "Techops",
    { observed: 500, online: 460, devices: 8 },
    { observed: 500, online: 300, devices: 8 },
    WINDOWS,
  );
  assert.ok("trend" in result);
  assert.equal(result.trend.direction, "recovery");
  assert.ok(result.trend.deltaPoints > 0);
  assert.match(result.trend.statement, /rose from 60% to 92%/);
});

test("the headline site case reads with direction, magnitude AND both windows", () => {
  const result = compareAvailability(
    "site",
    "s1",
    "Videri Sales",
    { observed: 1000, online: 610, devices: 12 },
    { observed: 1000, online: 820, devices: 12 },
    WINDOWS,
  );
  assert.ok("trend" in result);
  const { statement } = result.trend;
  assert.match(statement, /fell from 82% to 61%/);
  assert.match(statement, /the last 7 days against the previous 7 days/);
  assert.match(statement, /21 points/);
  // Sample counts must be quotable from the statement itself, not just the JSON.
  assert.match(statement, /1000 observed bucket\(s\) recently and 1000 before/);
  assert.match(statement, /observed time only/);
  assert.equal(result.trend.recent.observedBuckets, 1000);
  assert.equal(result.trend.prior.onlineBuckets, 820);
});

test("availability is computed over OBSERVED buckets, never over the whole window", () => {
  // 50 of 100 observed buckets online, in a window that had 2016 possible
  // buckets. The answer is 50%, not 2.5% — unobserved time is excluded.
  const result = compareAvailability(
    "device",
    "a",
    "Panel a",
    { observed: 100, online: 50, devices: 1 },
    { observed: 100, online: 100, devices: 1 },
    WINDOWS,
  );
  assert.ok("trend" in result);
  assert.equal(result.trend.recent.availability, 0.5);
});

test("sites roll devices up by their resolved site and rank fleet, then site, then device", () => {
  const s = site("s-mtl", "Montreal Office");
  const report = analyzeAvailability({
    recent: {
      window: win("the last 7 days", 800),
      devices: [buckets("a", 300, 90), buckets("b", 300, 90), buckets("c", 300, 90)],
    },
    prior: {
      window: win("the previous 7 days", 800),
      devices: [buckets("a", 300, 270), buckets("b", 300, 270), buckets("c", 300, 270)],
    },
    devices: [
      dev("a", { site: s }),
      dev("b", { site: s }),
      dev("c", { site: s }),
      // No site: contributes to fleet and device scope, to no site bucket.
      dev("d"),
    ],
  });
  assert.equal(report.available, true);
  assert.deepEqual(
    report.trends.map((t) => t.scope),
    ["fleet", "site", "device", "device", "device"],
  );
  const siteTrend = report.trends.find((t) => t.scope === "site")!;
  assert.equal(siteTrend.label, "Montreal Office");
  assert.equal(siteTrend.recent.devices, 3);
  assert.match(siteTrend.statement, /across 3 device\(s\)/);
  // Device d has no rows in either window, so it is suppressed, not called down.
  assert.ok(report.suppressed.examples.some((s2) => s2.key === "d"));
});

test("a device with no rows in either window is suppressed, never reported as 0%", () => {
  const report = analyzeAvailability({
    recent: { window: win("the last 7 days", 800), devices: [buckets("a", 400, 400)] },
    prior: { window: win("the previous 7 days", 800), devices: [buckets("a", 400, 400)] },
    devices: [dev("a"), dev("ghost")],
  });
  const ghost = report.suppressed.examples.find((s) => s.key === "ghost");
  assert.ok(ghost, "the never-observed device must appear as a suppression");
  assert.equal(ghost.reason, "insufficient-recent-samples");
  assert.ok(!report.trends.some((t) => t.key === "ghost"));
});

// ─── 2. storage ──────────────────────────────────────────────────────────────

/** A rising series: `days` daily readings starting at `from`, +`step` per day. */
const rising = (from: number, step: number, days: number, startIso = "2026-08-20T00:00:00Z") =>
  Array.from({ length: days }, (_, i) => ({
    observedAt: new Date(Date.parse(startIso) + i * 86_400_000).toISOString(),
    percent: from + i * step,
  }));

const series = (deviceId: string, points: StorageSeries["points"]): StorageSeries => ({
  deviceId,
  points,
});

test("sanitizeStoragePoints drops unreadable, out-of-range and unparseable readings", () => {
  const result = sanitizeStoragePoints(
    [
      { observedAt: "2026-08-30T00:00:00Z", percent: 40 },
      // Honest null: absent, not suspect — not counted as discarded.
      { observedAt: "2026-08-30T02:00:00Z", percent: null },
      { observedAt: "2026-08-30T04:00:00Z", percent: 140 },
      { observedAt: "2026-08-30T06:00:00Z", percent: -3 },
      { observedAt: "not-a-date", percent: 50 },
    ],
    NOW,
  );
  assert.equal(result.points.length, 1);
  assert.equal(result.discarded, 3);
});

test("CLOCK GARBAGE: a reading stamped in the future is dropped, never clamped to now", () => {
  const result = sanitizeStoragePoints(
    [
      { observedAt: "2026-08-30T00:00:00Z", percent: 40 },
      { observedAt: "2027-06-01T00:00:00Z", percent: 41 },
      { observedAt: "1999-01-01T00:00:00Z", percent: 42 },
    ],
    NOW,
  );
  assert.equal(result.discarded, 2);
  assert.deepEqual(
    result.points.map((p) => p.percent),
    [40],
  );
});

test("sanitizeStoragePoints sorts by time, so an out-of-order feed cannot invert a slope", () => {
  const result = sanitizeStoragePoints(
    [
      { observedAt: "2026-08-30T00:00:00Z", percent: 60 },
      { observedAt: "2026-08-28T00:00:00Z", percent: 50 },
      { observedAt: "2026-08-29T00:00:00Z", percent: 55 },
    ],
    NOW,
  );
  assert.deepEqual(
    result.points.map((p) => p.percent),
    [50, 55, 60],
  );
});

test("GATE: one point below minPoints emits nothing; at minPoints a trend appears", () => {
  const devices = [dev("a")];
  const below = analyzeStorage(
    [series("a", rising(60, 2, STORAGE_GATES.minPoints - 1))],
    devices,
    14,
    NOW,
  );
  assert.deepEqual(below.trends, []);
  assert.equal(below.suppressed.byReason["insufficient-points"], 1);
  assert.match(below.suppressed.examples[0]!.detail, /slow lane has not reached/);

  const at = analyzeStorage([series("a", rising(60, 2, STORAGE_GATES.minPoints))], devices, 14, NOW);
  assert.equal(at.trends.length, 1);
  assert.equal(at.trends[0]!.points, STORAGE_GATES.minPoints);
});

test("GATE: enough points crammed into too short a span is not a trend", () => {
  // 8 readings two hours apart: clears minPoints, fails minSpanHours.
  const points = Array.from({ length: 8 }, (_, i) => ({
    observedAt: new Date(Date.parse("2026-08-30T00:00:00Z") + i * 2 * 3_600_000).toISOString(),
    percent: 60 + i,
  }));
  const report = analyzeStorage([series("a", points)], [dev("a")], 14, NOW);
  assert.deepEqual(report.trends, []);
  assert.equal(report.suppressed.byReason["insufficient-span"], 1);
  assert.match(report.suppressed.examples[0]!.detail, /noise, not a trend/);
});

test("DATA GAP: a multi-day hole inside the series voids the fit rather than fitting across it", () => {
  const before = rising(60, 1, 4, "2026-08-16T00:00:00Z");
  const after = rising(90, 1, 4, "2026-08-27T00:00:00Z");
  const report = analyzeStorage([series("a", [...before, ...after])], [dev("a")], 14, NOW);
  assert.deepEqual(report.trends, [], "a step across a blind period is not a fill rate");
  assert.equal(report.suppressed.byReason["observation-gap"], 1);
  assert.match(report.suppressed.examples[0]!.detail, /We stopped looking/);
});

test("GATE: maxGapHours boundary — 36h passes, 37h voids the fit", () => {
  const at = [
    { observedAt: "2026-08-25T00:00:00Z", percent: 60 },
    { observedAt: "2026-08-26T12:00:00Z", percent: 62 }, // 36h
    { observedAt: "2026-08-27T00:00:00Z", percent: 63 },
    { observedAt: "2026-08-28T00:00:00Z", percent: 65 },
    { observedAt: "2026-08-29T00:00:00Z", percent: 67 },
    { observedAt: "2026-08-30T00:00:00Z", percent: 69 },
  ];
  assert.equal(analyzeStorage([series("a", at)], [dev("a")], 14, NOW).trends.length, 1);

  const over = at.map((p, i) =>
    i === 1 ? { observedAt: "2026-08-26T13:00:00Z", percent: 62 } : p,
  );
  assert.equal(analyzeStorage([series("a", over)], [dev("a")], 14, NOW).trends.length, 0);
});

test("FLAT: a device whose storage does not move is counted flat, not trended", () => {
  const points = rising(36, 0, 8, "2026-08-24T00:00:00Z");
  const report = analyzeStorage([series("a", points)], [dev("a")], 14, NOW);
  assert.deepEqual(report.trends, []);
  assert.equal(report.flat, 1);
  assert.equal(report.suppressed.total, 0);
});

test("GATE: a slope under minSlopePctPerDay is flat, at the threshold it is a trend", () => {
  // 0.4/day over 10 days: under the 0.5 floor.
  const under = analyzeStorage(
    [series("a", rising(60, 0.4, 10, "2026-08-22T00:00:00Z"))],
    [dev("a")],
    14,
    NOW,
  );
  assert.equal(under.flat, 1);
  assert.deepEqual(under.trends, []);

  const at = analyzeStorage(
    [series("a", rising(60, 0.5, 10, "2026-08-22T00:00:00Z"))],
    [dev("a")],
    14,
    NOW,
  );
  assert.equal(at.trends.length, 1);
  assert.equal(at.trends[0]!.slopePctPerDay, 0.5);
});

test("a filling device near capacity gets a days-to-full projection and a full statement", () => {
  const report = analyzeStorage(
    [series("a", rising(80, 2, 8, "2026-08-24T00:00:00Z"))],
    [dev("a")],
    14,
    NOW,
  );
  const trend = report.trends[0]!;
  assert.equal(trend.direction, "filling");
  assert.equal(trend.slopePctPerDay, 2);
  assert.equal(trend.firstPercent, 80);
  assert.equal(trend.latestPercent, 94);
  assert.equal(trend.daysToFull, 3);
  assert.equal(trend.projectionNote, null);
  assert.equal(trend.points, 8);
  assert.equal(trend.distinctDays, 8);
  assert.match(trend.statement, /rose from 80% to 94%/);
  assert.match(trend.statement, /\+2\.00 points\/day/);
  assert.match(trend.statement, /100% in about 3 days/);
  assert.match(trend.statement, /whole percent/);
});

test("a device far from full gets the RATE but no projected date", () => {
  const report = analyzeStorage(
    [series("a", rising(10, 1, 8, "2026-08-24T00:00:00Z"))],
    [dev("a")],
    14,
    NOW,
  );
  const trend = report.trends[0]!;
  assert.equal(trend.daysToFull, null);
  assert.match(trend.projectionNote!, /too far from full/);
});

test("a very slow fill beyond the horizon reports the rate, not a date", () => {
  // 0.5 pt/day from 50% used: clears the slope gate and the projection floor, but
  // lands 93 days out — past the 90-day horizon, so no date is asserted.
  const points = rising(50, 0.5, 8, "2026-08-24T00:00:00Z");
  const trend = analyzeStorage([series("a", points)], [dev("a")], 14, NOW).trends[0]!;
  assert.equal(trend.daysToFull, null);
  assert.match(trend.projectionNote!, /beyond the 90-day horizon/);
});

test("RECOVERY: a draining device is reported with no projection", () => {
  const points = rising(90, -2, 8, "2026-08-24T00:00:00Z");
  const trend = analyzeStorage([series("a", points)], [dev("a")], 14, NOW).trends[0]!;
  assert.equal(trend.direction, "draining");
  assert.equal(trend.daysToFull, null);
  assert.match(trend.projectionNote!, /being freed/);
  assert.match(trend.statement, /fell from 90% to 76%/);
});

test("no storage history at all is an honest unavailable, not an empty all-clear", () => {
  const report = analyzeStorage([], [dev("a")], 14, NOW);
  assert.equal(report.available, false);
  assert.match(report.reason!, /No storage telemetry/);
});

test("filling devices sort by urgency — soonest projected full first", () => {
  const report = analyzeStorage(
    [
      series("slow", rising(80, 1, 8, "2026-08-24T00:00:00Z")),
      series("fast", rising(90, 2, 8, "2026-08-24T00:00:00Z")),
    ],
    [dev("slow"), dev("fast")],
    14,
    NOW,
  );
  assert.deepEqual(
    report.trends.map((t) => t.deviceId),
    ["fast", "slow"],
  );
});

// ─── 3. transmission silence ──────────────────────────────────────────────────

/** `deviceCount` devices reporting `bytes` on each of the given dates. */
const usage = (dates: string[], deviceIds: string[], bytes = 5_000_000): UsageDay[] =>
  dates.flatMap((date) => deviceIds.map((deviceId) => ({ deviceId, date, bytes })));

const days = (throughDate: string, n: number): string[] => {
  const end = Date.parse(`${throughDate}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) =>
    new Date(end - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
};

/** A 20-device fleet so the median-based quorum has something to work with. */
const HERD = Array.from({ length: 20 }, (_, i) => `d${i}`);
const HERD_DEVICES = HERD.map((id) => dev(id));

test("sanitizeUsageDates rejects malformed dates and normalises negative byte counts", () => {
  const result = sanitizeUsageDates(
    [
      { deviceId: "a", date: "2026-08-29", bytes: 100 },
      { deviceId: "a", date: "29/08/2026", bytes: 100 },
      { deviceId: "a", date: "2026-8-9", bytes: 100 },
      { deviceId: "a", date: "2026-08-28", bytes: -5 },
    ],
    NOW,
  );
  assert.equal(result.discarded, 2);
  // The row survives (it proves the feed reported this device that day) but the
  // bytes read as zero rather than as a negative volume.
  assert.equal(result.rows.find((r) => r.date === "2026-08-28")!.bytes, 0);
});

test("CLOCK GARBAGE: a row dated next year is discarded and cannot become the reference day", () => {
  const rows = [
    ...usage(days("2026-08-29", 17), HERD),
    // Without the guard this single row moves the feed's "today" to 2027 and
    // brands all 20 devices silent for ~9 months.
    { deviceId: "d0", date: "2027-06-01", bytes: 1 },
  ];
  const report = analyzeTransmissionSilence(rows, HERD_DEVICES, NOW);
  assert.equal(report.discardedRows, 1);
  assert.equal(report.feedThroughDate, "2026-08-29");
  assert.deepEqual(report.trends, [], "no device may be branded silent by a bad date");
  assert.equal(report.transmitting, 20);
});

test("the reference day is the FEED's newest day, and its lag is stated", () => {
  // Feed runs three days behind wall clock — the real situation on this fleet.
  const report = analyzeTransmissionSilence(usage(days("2026-08-29", 17), HERD), HERD_DEVICES, NOW);
  assert.equal(report.available, true);
  assert.equal(report.feedThroughDate, "2026-08-29");
  assert.equal(report.feedLagDays, 3);
  assert.deepEqual(report.trends, [], "the feed's own lag must never read as silence");
});

test("a habitual transmitter that stops on every recent feed day is reported", () => {
  const dates = days("2026-08-29", 17);
  const recent = dates.slice(-SILENCE_GATES.recentDays);
  const rows = usage(dates, HERD).filter(
    (row) => !(row.deviceId === "d7" && recent.includes(row.date)),
  );
  const report = analyzeTransmissionSilence(rows, HERD_DEVICES, NOW);
  assert.equal(report.trends.length, 1);
  const trend = report.trends[0]!;
  assert.equal(trend.deviceId, "d7");
  assert.equal(trend.silentDays, SILENCE_GATES.recentDays);
  assert.equal(trend.baselineActiveDays, trend.baselineDaysExamined);
  assert.equal(trend.lastTransmissionDate, dates[dates.length - 1 - SILENCE_GATES.recentDays]);
  assert.match(trend.statement, /independent of the presence/);
  assert.match(trend.statement, /3 day\(s\) behind/);
  assert.equal(report.transmitting, 19);
});

test("GATE: still transmitting on one recent day is not silence", () => {
  const dates = days("2026-08-29", 17);
  const recent = dates.slice(-SILENCE_GATES.recentDays);
  const rows = usage(dates, HERD).map((row) =>
    row.deviceId === "d7" && recent.includes(row.date) && row.date !== recent[0]
      ? { ...row, bytes: 0 }
      : row,
  );
  const report = analyzeTransmissionSilence(rows, HERD_DEVICES, NOW);
  assert.deepEqual(report.trends, []);
  assert.equal(report.transmitting, 20);
});

test("GATE: a device with no baseline habit is suppressed, not reported as newly silent", () => {
  const dates = days("2026-08-29", 17);
  const baseline = dates.slice(0, dates.length - SILENCE_GATES.recentDays);
  const recent = dates.slice(-SILENCE_GATES.recentDays);
  // d7 transmits on under 60% of baseline days, then stops. Intermittent going
  // quiet is not a change.
  const rows = usage(dates, HERD).map((row) => {
    if (row.deviceId !== "d7") return row;
    if (recent.includes(row.date)) return { ...row, bytes: 0 };
    return baseline.indexOf(row.date) % 3 === 0 ? row : { ...row, bytes: 0 };
  });
  const report = analyzeTransmissionSilence(rows, HERD_DEVICES, NOW);
  assert.deepEqual(report.trends, []);
  assert.equal(report.suppressed.byReason["no-baseline-habit"], 1);
  assert.match(report.suppressed.examples[0]!.detail, /a habit needs/);
});

test("DATA GAP: a fleet-wide feed outage is excluded, never read as fleet-wide silence", () => {
  const dates = days("2026-08-29", 17);
  const blackout = dates.slice(-2); // last two feed days: only one device reported
  const rows = [
    ...usage(
      dates.filter((d) => !blackout.includes(d)),
      HERD,
    ),
    ...usage(blackout, ["d0"]),
  ];
  const report = analyzeTransmissionSilence(rows, HERD_DEVICES, NOW);
  // The blackout days fail quorum and are excluded from both windows.
  assert.deepEqual(report.feedGapDates, blackout);
  assert.ok(!report.recentDaysExamined.some((d) => blackout.includes(d)));
  assert.deepEqual(report.trends, [], "19 devices did not fail at once; the feed did");
});

test("GATE: too few healthy recent feed days refuses the whole trend type", () => {
  // The poller has produced exactly one day of history. One day is not two, so
  // the trend type refuses rather than calling every device silent-or-fine on the
  // strength of a single reading.
  const report = analyzeTransmissionSilence(usage(days("2026-08-29", 1), HERD), HERD_DEVICES, NOW);
  assert.equal(report.available, false);
  assert.match(report.reason!, /the feed not reporting, not devices going quiet/);
  assert.deepEqual(report.trends, []);
  assert.equal(report.recentDaysExamined.length, 1);
  // The 16 dates with no rows at all are named as OUR blind days, not silence.
  assert.equal(report.feedGapDates.length, 16);
});

test("GATE: too few healthy baseline days suppresses every device with a feed-gap reason", () => {
  // Only 5 days of feed history: enough for the recent window, not for a habit.
  const dates = days("2026-08-29", 5);
  const report = analyzeTransmissionSilence(usage(dates, HERD), HERD_DEVICES, NOW);
  assert.equal(report.available, true);
  assert.deepEqual(report.trends, []);
  assert.equal(report.suppressed.byReason["feed-gap"], 20);
  assert.match(report.suppressed.examples[0]!.detail, /establish a transmission habit/);
});

test("a device the feed has never mentioned is not silent — it is uncovered", () => {
  const report = analyzeTransmissionSilence(
    usage(days("2026-08-29", 17), HERD),
    [...HERD_DEVICES, dev("never-in-feed")],
    NOW,
  );
  assert.ok(!report.trends.some((t) => t.deviceId === "never-in-feed"));
  assert.ok(!report.suppressed.examples.some((s) => s.key === "never-in-feed"));
});

test("no usable usage rows is an honest unavailable", () => {
  const report = analyzeTransmissionSilence([], [dev("a")], NOW);
  assert.equal(report.available, false);
  assert.match(report.reason!, /has not produced trustworthy history/);
});

// ─── report assembly ─────────────────────────────────────────────────────────

test("buildTrendReport headlines regressions and silence, and notes every refusal", () => {
  const availability = analyzeAvailability({
    recent: {
      window: win("the last 7 days", 800),
      devices: [buckets("a", 400, 100), buckets("b", 400, 396)],
    },
    prior: {
      window: win("the previous 7 days", 800),
      devices: [buckets("a", 400, 380), buckets("b", 400, 392)],
    },
    devices: [dev("a"), dev("b")],
  });
  const storage = analyzeStorage([], [dev("a")], 14, NOW);
  const silence = analyzeTransmissionSilence([], [dev("a")], NOW);
  const report = buildTrendReport(NOW, availability, storage, silence);

  assert.equal(report.observedAt, NOW.toISOString());
  assert.match(report.basis, /computed over time we actually observed/);
  assert.ok(report.headlines.length >= 1);
  assert.match(report.headlines[0]!, /Availability fell/);
  assert.ok(report.notes.some((n) => /Storage fill: No storage telemetry/.test(n)));
  assert.ok(report.notes.some((n) => /Transmission silence:/.test(n)));
});

test("buildTrendReport says so out loud when nothing moved", () => {
  const availability = analyzeAvailability({
    recent: { window: win("the last 7 days", 800), devices: [buckets("a", 400, 400)] },
    prior: { window: win("the previous 7 days", 800), devices: [buckets("a", 400, 400)] },
    devices: [dev("a")],
  });
  const storage = analyzeStorage(
    [series("a", rising(36, 0, 8, "2026-08-24T00:00:00Z"))],
    [dev("a")],
    14,
    NOW,
  );
  const silence = analyzeTransmissionSilence(usage(days("2026-08-29", 17), HERD), HERD_DEVICES, NOW);
  const report = buildTrendReport(NOW, availability, storage, silence);
  assert.deepEqual(report.headlines, []);
  assert.ok(report.notes.length > 0, "an empty result must always carry a reason");
});

test("a recovery never appears in the regression headlines but is still in the payload", () => {
  const availability = analyzeAvailability({
    recent: { window: win("the last 7 days", 800), devices: [buckets("a", 400, 396)] },
    prior: { window: win("the previous 7 days", 800), devices: [buckets("a", 400, 200)] },
    devices: [dev("a")],
  });
  const report = buildTrendReport(
    NOW,
    availability,
    analyzeStorage([], [dev("a")], 14, NOW),
    analyzeTransmissionSilence([], [dev("a")], NOW),
  );
  assert.ok(availability.trends.some((t) => t.direction === "recovery"));
  assert.ok(!report.headlines.some((h) => /rose from/.test(h)));
});
