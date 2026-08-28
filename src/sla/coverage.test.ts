/**
 * SLA coverage/confidence tests — `node --test dist/sla/coverage.test.js`
 *
 * Pure, deterministic. No pool, no network. These lock the two rules the module
 * exists to enforce:
 *   1. observedUptime and collectionCoverage are separate numbers; a high
 *      uptime measured over a sliver of the window is NEVER claimable.
 *   2. fleet-wide silence is OUR collector, not a fleet outage, and is never
 *      folded into an uptime figure.
 * Every test is named by the contract it protects.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  confidenceFor,
  assessDevice,
  buildFleetReport,
  UNMEASURABLE,
  type DeviceWindowAggregate,
  type DeviceSlaWindow,
  type BlindWindow,
} from "./coverage.js";

const BUCKET = 300; // 5-minute buckets

// A fully-covered, fully-online aggregate we can dent field-by-field.
const agg = (over: Partial<DeviceWindowAggregate> = {}): DeviceWindowAggregate => ({
  deviceId: "d1",
  name: "Lobby North",
  observedBuckets: 288,
  onlineBuckets: 288,
  expectedBuckets: 288,
  longestGapSeconds: 0,
  stalenessSeconds: 60,
  ...over,
});

// A ready-made DeviceSlaWindow for fleet-level tests, so coverage/claimable/
// staleness can be set independently of assessDevice's arithmetic.
const win = (over: Partial<DeviceSlaWindow> = {}): DeviceSlaWindow => ({
  deviceId: "d1",
  name: null,
  collectionCoverage: 1,
  observedUptime: 1,
  blindSeconds: 0,
  longestGapSeconds: 0,
  stalenessSeconds: 60,
  confidence: "high",
  claimable: true,
  statement: "",
  ...over,
});

// ─── confidence banding ───────────────────────────────────────────────────────

test("confidenceFor bands coverage at its documented thresholds, inclusive", () => {
  assert.equal(confidenceFor(1), "high");
  assert.equal(confidenceFor(0.98), "high"); // HIGH boundary is inclusive
  assert.equal(confidenceFor(0.9799), "medium");
  assert.equal(confidenceFor(0.9), "medium"); // MEDIUM boundary is inclusive
  assert.equal(confidenceFor(0.8999), "low");
  assert.equal(confidenceFor(0.5), "low"); // LOW boundary is inclusive
  assert.equal(confidenceFor(0.4999), "none");
  assert.equal(confidenceFor(0), "none");
});

// ─── the honest-null invariant ────────────────────────────────────────────────

test("a device with no readings yields a NULL uptime, never a zero", () => {
  const d = assessDevice(agg({ observedBuckets: 0, onlineBuckets: 0 }), BUCKET);
  assert.equal(d.observedUptime, null, "unobserved uptime must be null, not 0");
  assert.notEqual(d.observedUptime, 0);
  assert.equal(d.collectionCoverage, 0);
  assert.equal(d.confidence, "none");
  assert.equal(d.claimable, false);
  assert.match(d.statement, /cannot be asserted/);
});

test("uptime is measured over OBSERVED buckets only — our collection gaps are not charged to the device", () => {
  // Observed only half the window, but online in every bucket we did see.
  const d = assessDevice(
    agg({ observedBuckets: 144, onlineBuckets: 144, expectedBuckets: 288 }),
    BUCKET,
  );
  assert.equal(d.observedUptime, 1, "online in every observed bucket → 100% observed uptime");
  assert.equal(d.collectionCoverage, 0.5, "…but coverage reflects the half we missed");
  // Dividing online by expected would have read 50% — silently charging the
  // device for OUR blindness. The two numbers stay separate.
  assert.notEqual(d.observedUptime, 0.5);
});

// ─── the claimable floor ──────────────────────────────────────────────────────

test("a high uptime measured below the coverage floor is NOT claimable", () => {
  // Online 100% of the tiny slice we watched — the textbook over-claim trap.
  const d = assessDevice(
    agg({ observedBuckets: 20, onlineBuckets: 20, expectedBuckets: 288 }),
    BUCKET,
  );
  assert.equal(d.observedUptime, 1);
  assert.ok(d.collectionCoverage < 0.95);
  assert.equal(d.claimable, false, "coverage below floor must refuse the external claim");
  assert.match(d.statement, /NOT CLAIMABLE/);
});

test("coverage exactly at the claimable floor (0.95) supports a claim", () => {
  // 274/288 = 0.9513… ≥ 0.95.
  const d = assessDevice(
    agg({ observedBuckets: 274, onlineBuckets: 270, expectedBuckets: 288 }),
    BUCKET,
  );
  assert.ok(d.collectionCoverage >= 0.95);
  assert.equal(d.claimable, true);
  assert.match(d.statement, /Coverage/);
  assert.doesNotMatch(d.statement, /NOT CLAIMABLE/);
});

test("just below the floor refuses the claim even with the same uptime", () => {
  // 272/288 = 0.9444… < 0.95.
  const d = assessDevice(
    agg({ observedBuckets: 272, onlineBuckets: 268, expectedBuckets: 288 }),
    BUCKET,
  );
  assert.ok(d.collectionCoverage < 0.95);
  assert.equal(d.claimable, false);
});

// ─── coverage arithmetic edges ────────────────────────────────────────────────

test("coverage is clamped to 1 even when more buckets are observed than expected", () => {
  const d = assessDevice(
    agg({ observedBuckets: 300, onlineBuckets: 300, expectedBuckets: 288 }),
    BUCKET,
  );
  assert.equal(d.collectionCoverage, 1, "coverage must never exceed 100%");
  assert.equal(d.blindSeconds, 0, "and blind time cannot go negative");
});

test("blindSeconds counts the unobserved buckets, in seconds", () => {
  const d = assessDevice(
    agg({ observedBuckets: 200, onlineBuckets: 200, expectedBuckets: 288 }),
    BUCKET,
  );
  assert.equal(d.blindSeconds, (288 - 200) * BUCKET);
});

test("a partial-outage device reports uptime and coverage independently", () => {
  // Fully observed, down for a quarter of the window.
  const d = assessDevice(
    agg({ observedBuckets: 288, onlineBuckets: 216, expectedBuckets: 288, longestGapSeconds: 0 }),
    BUCKET,
  );
  assert.equal(d.collectionCoverage, 1);
  assert.equal(d.observedUptime, 0.75);
  assert.equal(d.claimable, true, "full coverage → a real 75% outage IS claimable against the device");
});

test("stalenessSeconds and name pass through untouched, including a null name", () => {
  const d = assessDevice(agg({ name: null, stalenessSeconds: 4242 }), BUCKET);
  assert.equal(d.name, null);
  assert.equal(d.stalenessSeconds, 4242);
});

// ─── fleet roll-up: claimable-only uptime ─────────────────────────────────────

test("fleet uptime is averaged over claimable devices ONLY", () => {
  const devices: DeviceSlaWindow[] = [
    win({ deviceId: "a", claimable: true, observedUptime: 1.0, collectionCoverage: 0.99 }),
    win({ deviceId: "b", claimable: true, observedUptime: 0.9, collectionCoverage: 0.98 }),
    // Barely-observed, perfect uptime — must NOT drag the fleet number up.
    win({ deviceId: "c", claimable: false, observedUptime: 1.0, collectionCoverage: 0.1, confidence: "none" }),
  ];
  const r = buildFleetReport(24, BUCKET, devices, []);
  assert.equal(r.fleetObservedUptimeClaimable, 0.95, "(1.0 + 0.9) / 2, ignoring the non-claimable device");
  assert.equal(r.devicesClaimable, 2);
});

test("with no claimable devices the fleet uptime is NULL, not zero or a lie", () => {
  const devices = [
    win({ claimable: false, observedUptime: 1.0, collectionCoverage: 0.2, confidence: "none" }),
  ];
  const r = buildFleetReport(24, BUCKET, devices, []);
  assert.equal(r.fleetObservedUptimeClaimable, null);
  assert.ok(
    r.warnings.some((w) => w.includes("do not have") && w.includes("coverage")),
    "must warn that no device supports a claim",
  );
});

test("an empty fleet reports zero coverage and a null claimable uptime, without dividing by zero", () => {
  const r = buildFleetReport(24, BUCKET, [], []);
  assert.equal(r.devicesAssessed, 0);
  assert.equal(r.fleetCollectionCoverage, 0);
  assert.equal(r.fleetObservedUptimeClaimable, null);
  assert.deepEqual(r.reportingLag, { p50: null, p95: null, max: null });
});

// ─── fleet roll-up: blind windows are OUR fault ───────────────────────────────

test("a fleet-wide blind window is flagged as OUR collector, never a fleet outage", () => {
  const blind: BlindWindow[] = [
    { from: "2026-08-28T00:00:00Z", to: "2026-08-28T00:30:00Z", durationSeconds: 1800, devicesReporting: 0 },
  ];
  const r = buildFleetReport(24, BUCKET, [win()], blind);
  assert.equal(r.blindWindows.length, 1);
  assert.equal(r.blindWindows[0]!.devicesReporting, 0);
  const w = r.warnings.find((x) => x.includes("blind window"));
  assert.ok(w, "a blind window must produce a warning");
  assert.match(w!, /not a fleet outage/);
  // The blind time is never blended into an uptime number.
  assert.equal(typeof r.fleetObservedUptimeClaimable, "number");
});

// ─── fleet roll-up: reporting lag percentiles ─────────────────────────────────

test("reporting-lag percentiles are computed from staleness and ignore null-staleness devices", () => {
  const devices = [
    win({ deviceId: "a", stalenessSeconds: 10 }),
    win({ deviceId: "b", stalenessSeconds: 20 }),
    win({ deviceId: "c", stalenessSeconds: 30 }),
    win({ deviceId: "d", stalenessSeconds: 40 }),
    win({ deviceId: "e", stalenessSeconds: null }), // never reported — excluded
  ];
  const r = buildFleetReport(24, BUCKET, devices, []);
  // sorted lags [10,20,30,40]; p50→idx floor(4*.5)=2→30; p95→floor(4*.95)=3→40; max→40
  assert.equal(r.reportingLag.p50, 30);
  assert.equal(r.reportingLag.p95, 40);
  assert.equal(r.reportingLag.max, 40);
});

// ─── fleet roll-up: counts, confidence breakdown, ordering ────────────────────

test("confidence breakdown tallies every band and unobserved devices are counted", () => {
  const devices = [
    win({ deviceId: "a", confidence: "high" }),
    win({ deviceId: "b", confidence: "high" }),
    win({ deviceId: "c", confidence: "medium" }),
    win({ deviceId: "d", confidence: "low", claimable: false }),
    win({ deviceId: "e", confidence: "none", claimable: false, observedUptime: null }),
  ];
  const r = buildFleetReport(24, BUCKET, devices, []);
  assert.deepEqual(r.confidenceBreakdown, { high: 2, medium: 1, low: 1, none: 1 });
  assert.equal(r.devicesUnobserved, 1, "the null-uptime device is the one unobserved");
  assert.ok(
    r.warnings.some((w) => w.includes("no readings at all")),
    "unobserved devices must be called out",
  );
});

test("leastObserved is sorted worst-coverage-first and capped at 15", () => {
  const devices = Array.from({ length: 20 }, (_, i) =>
    win({ deviceId: `d${i}`, collectionCoverage: i / 20, claimable: i / 20 >= 0.95 }),
  );
  const r = buildFleetReport(24, BUCKET, devices, []);
  assert.equal(r.leastObserved.length, 15, "capped at 15");
  assert.equal(r.leastObserved[0]!.collectionCoverage, 0, "worst coverage first");
  for (let i = 1; i < r.leastObserved.length; i++) {
    assert.ok(
      r.leastObserved[i]!.collectionCoverage >= r.leastObserved[i - 1]!.collectionCoverage,
      "ascending coverage order",
    );
  }
});

// ─── device-independent optionality: the unmeasurable dimensions ──────────────

test("the unmeasurable dimensions are always surfaced, every one carrying an SLA impact", () => {
  const r = buildFleetReport(24, BUCKET, [win()], []);
  assert.equal(r.unmeasurable.length, UNMEASURABLE.length);
  assert.ok(UNMEASURABLE.length >= 5);
  for (const dim of r.unmeasurable) {
    assert.ok(dim.dimension && dim.reason && dim.slaImpact, "each dimension states what it blocks");
  }
  assert.ok(
    r.warnings.some((w) => w.includes("cannot be measured at all")),
    "the unmeasurable count is always warned, even for a perfectly-covered fleet",
  );
});

test("fleetCollectionCoverage is the mean of per-device coverage, rounded to 4 dp", () => {
  const devices = [
    win({ deviceId: "a", collectionCoverage: 1 }),
    win({ deviceId: "b", collectionCoverage: 0.5 }),
    win({ deviceId: "c", collectionCoverage: 0.0 }),
  ];
  const r = buildFleetReport(24, BUCKET, devices, []);
  assert.equal(r.fleetCollectionCoverage, 0.5);
});
