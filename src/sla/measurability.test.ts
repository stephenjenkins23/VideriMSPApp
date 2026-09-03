/**
 * The readable-vs-SLA-grade boundary.
 *
 * Every test here defends one of the two failure modes BUG-3 sat between:
 * under-claiming (telling a customer we cannot measure what we measure) and
 * over-claiming (promising a rotating 42%-coverage read as an SLA metric). The
 * boundary is exercised in BOTH directions, because a classifier that can only
 * be promoted is just a slower constant.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  DIMENSION_CATALOG,
  MEASURABILITY_WITHOUT_LIVE_SIGNAL,
  SLA_GRADE_BARS,
  buildMeasurability,
  classifyDimension,
  healthScoreBasis,
  sweepPeriodSeconds,
  type DimensionDefinition,
  type MeasurabilityInputs,
} from "./measurability.js";
import { UNMEASURABLE, buildFleetReport, type DeviceSlaWindow } from "./coverage.js";
import type { PollerRunRow } from "../alerting/pipeline-health.js";

const FLEET = 248;

const sourced: DimensionDefinition = {
  id: "test-sourced",
  dimension: "Test sourced dimension",
  slaImpact: "irrelevant to the grading",
  source: { feed: "test feed", fields: ["test_field"], lane: "test-lane", persisted: true },
};

const signal = (over: {
  readableDevices?: number | null;
  cadenceSeconds?: number | null;
  persisted?: boolean;
}) => {
  const readableDevices = over.readableDevices === undefined ? FLEET : over.readableDevices;
  return {
    coverage: {
      readableDevices,
      fleetSize: FLEET,
      share: readableDevices === null ? null : readableDevices / FLEET,
    },
    cadenceSeconds: over.cadenceSeconds === undefined ? 300 : over.cadenceSeconds,
    persisted: over.persisted ?? true,
    basis: "synthetic",
  };
};

// ─── the boundary, upward ─────────────────────────────────────────────────────

test("full coverage on a stored, continuous feed is SLA-grade", () => {
  const c = classifyDimension(sourced, signal({}));
  assert.equal(c.grade, "sla-grade");
  assert.deepEqual(c.shortfalls, []);
  assert.match(c.reason, /Measured continuously and fleet-wide/);
});

test("coverage exactly at the floor clears it; a hair under does not", () => {
  const atFloor = Math.ceil(SLA_GRADE_BARS.minCoverage * FLEET);
  assert.equal(classifyDimension(sourced, signal({ readableDevices: atFloor })).grade, "sla-grade");
  assert.equal(
    classifyDimension(sourced, signal({ readableDevices: atFloor - 1 })).grade,
    "readable",
  );
});

// ─── the boundary, downward ──────────────────────────────────────────────────

test("partial fleet coverage is readable, NOT SLA-grade, and states the figure", () => {
  // The live storage/signal case: ~105 of 248.
  const c = classifyDimension(sourced, signal({ readableDevices: 105, cadenceSeconds: 22_800 }));
  assert.equal(c.grade, "readable");
  assert.match(c.reason, /105 of 248 devices \(42\.3%\)/);
  assert.match(c.reason, /not something to promise a customer/);
  assert.equal(c.shortfalls.length, 2, "coverage AND cadence both fall short");
});

test("full coverage on too slow a rotation is still not SLA-grade", () => {
  const c = classifyDimension(
    sourced,
    signal({ cadenceSeconds: SLA_GRADE_BARS.maxCadenceSeconds + 1 }),
  );
  assert.equal(c.grade, "readable");
  assert.match(c.shortfalls.join(" "), /returns to a given device/);
});

test("an unstored reading can never be SLA-grade, however complete", () => {
  // The screenshot case: every device is addressable, but we keep no frames, so
  // nothing about a PAST window could be reproduced from evidence.
  const c = classifyDimension(sourced, signal({ cadenceSeconds: 60, persisted: false }));
  assert.equal(c.grade, "readable");
  assert.match(c.shortfalls.join(" "), /not stored/);
});

test("an unprobed dimension fails closed to readable, never to SLA-grade", () => {
  const c = classifyDimension(sourced, signal({ readableDevices: null }));
  assert.equal(c.grade, "readable");
  assert.match(c.reason, /coverage unknown/);
});

// ─── genuinely sourceless dimensions ─────────────────────────────────────────

test("a sourceless dimension stays unmeasurable even if a live field appears for it", () => {
  const sourceless: DimensionDefinition = {
    id: "test-sourceless",
    dimension: "Test sourceless dimension",
    slaImpact: "cannot be evidenced",
    sourceless: { reason: "no verb returns it on any model" },
  };
  const c = classifyDimension(sourceless, signal({ readableDevices: FLEET }));
  assert.equal(c.grade, "unmeasurable");
  assert.equal(c.permanent, true, "an asserted absence of source is permanent");
  assert.equal(c.coverage.share, 0);
});

test("temperature and per-slot playback remain unmeasurable against live capability", () => {
  // Both are asserted, not probed: temperature has no verb on ANY model, and
  // confirmed playback has no readable render log (docs/22 Ask 5, external).
  const a = buildMeasurability({
    fleetSize: FLEET,
    // Deliberately claiming a reading for every field, including the two that
    // cannot have one. A live probe must not be able to promote them.
    fieldReadable: {
      cpu_percent: FLEET, ram_percent: FLEET, storage_percent: FLEET,
      wifi_signal_dbm: FLEET, temperature_c: FLEET, playback_quality: FLEET,
    },
    laneRuns: [],
    screenshot: { addressable: FLEET, capturedWithin24h: FLEET },
  });
  const ids = a.unmeasurable.map((d) => d.id);
  assert.ok(ids.includes("thermal"), "thermal stays unmeasurable");
  assert.ok(ids.includes("playback-slot"), "per-slot playback stays unmeasurable");
  for (const d of a.unmeasurable) assert.equal(d.permanent, true);
});

// ─── degradation: the direction a constant could never travel ────────────────

test("a dimension whose live coverage collapses to zero degrades out of SLA-grade", () => {
  const runs = laneRuns("telemetry-slowlane", { count: 8, gapSeconds: 300, targeted: FLEET });
  const healthy = buildMeasurability(inputs({ readable: FLEET, laneRuns: runs }));
  assert.equal(
    healthy.dimensions.find((d) => d.id === "storage")!.grade,
    "sla-grade",
    "precondition: a fully-covered fast lane IS SLA-grade",
  );

  const collapsed = buildMeasurability(inputs({ readable: 0, laneRuns: runs }));
  const storage = collapsed.dimensions.find((d) => d.id === "storage")!;
  assert.equal(storage.grade, "unmeasurable");
  assert.equal(storage.permanent, false, "a quiet feed is not the same as no source");
  assert.match(storage.reason, /no device returned a value/);
  assert.ok(
    !collapsed.slaGrade.some((d) => d.id === "storage"),
    "it must leave the SLA-grade list on its own, without anyone editing a constant",
  );
});

test("a lane that stops running loses its cadence, and with it SLA grade", () => {
  const withLane = buildMeasurability(
    inputs({ readable: FLEET, laneRuns: laneRuns("telemetry-slowlane", { count: 8, gapSeconds: 300, targeted: FLEET }) }),
  );
  assert.equal(withLane.dimensions.find((d) => d.id === "storage")!.grade, "sla-grade");

  const noLane = buildMeasurability(inputs({ readable: FLEET, laneRuns: [] }));
  const storage = noLane.dimensions.find((d) => d.id === "storage")!;
  assert.equal(storage.grade, "readable");
  assert.match(storage.shortfalls.join(" "), /no standing sweep/);
});

// ─── the sweep period: a rotation is not a fleet feed ────────────────────────

test("sweep period is the lane interval multiplied by the passes a rotation needs", () => {
  const s = sweepPeriodSeconds(
    { seconds: 900, confidence: "measured", basis: "median of 20 gaps" },
    10,
    FLEET,
  );
  // 15 min x 24.8 passes = ~6.2 h. Reporting the 15 min would be the bug.
  assert.equal(Math.round(s.seconds!), 22_320);
  assert.match(s.basis, /24\.8 passes/);
});

test("a lane covering the whole fleet each run has the lane interval as its cadence", () => {
  const s = sweepPeriodSeconds(
    { seconds: 120, confidence: "measured", basis: "median of 40 gaps" },
    FLEET,
    FLEET,
  );
  assert.equal(s.seconds, 120);
  assert.match(s.basis, /whole fleet/);
});

// ─── the health-score knock-on ───────────────────────────────────────────────

test("the health-score basis follows a reclassification instead of being hardcoded", () => {
  const runs = laneRuns("telemetry-slowlane", { count: 8, gapSeconds: 300, targeted: FLEET });

  // As the fleet stands: storage/signal readable on a slow rotation, so the
  // score must still EXCLUDE them — but for the live reason, not "no source".
  const today = healthScoreBasis(
    buildMeasurability(
      inputs({ readable: 105, laneRuns: laneRuns("telemetry-slowlane", { count: 8, gapSeconds: 900, targeted: 10 }) }),
    ),
  );
  assert.deepEqual(today.scorable, [], "nothing on the slow lane may weight a headline number");
  const storageWhy = today.excluded.find((e) => /Storage/.test(e.dimension))!.why;
  assert.match(storageWhy, /readable on 105 of 248 devices/);
  assert.match(storageWhy, /rotation/);
  assert.doesNotMatch(storageWhy, /no source/);

  // If the lane ever became continuous and fleet-wide, the exclusion list must
  // shrink by itself — the case the old constant made impossible.
  const promoted = healthScoreBasis(buildMeasurability(inputs({ readable: FLEET, laneRuns: runs })));
  assert.ok(promoted.scorable.includes("Storage capacity"));
  assert.ok(!promoted.excluded.some((e) => /Storage/.test(e.dimension)));
  assert.ok(
    promoted.excluded.some((e) => /Thermal/.test(e.dimension)),
    "sourceless dimensions stay excluded whatever the lane does",
  );
});

// ─── the report contract ─────────────────────────────────────────────────────

test("the fleet report separates the sourceless from the merely partial", () => {
  const win: DeviceSlaWindow = {
    deviceId: "d1", name: null, collectionCoverage: 1, observedUptime: 1, blindSeconds: 0,
    longestGapSeconds: 0, stalenessSeconds: 60, confidence: "high", claimable: true,
    statement: "fine",
  };
  const a = buildMeasurability(
    inputs({ readable: 105, laneRuns: laneRuns("telemetry-slowlane", { count: 8, gapSeconds: 900, targeted: 10 }) }),
  );
  const r = buildFleetReport(24, 300, [win], [], a);

  assert.equal(r.unmeasurable.length, a.unmeasurable.length);
  assert.ok(
    r.unmeasurable.every((d) => !/Storage|Wi-Fi|screenshot/i.test(d.dimension)),
    "readable dimensions must not appear in the unmeasurable list — that WAS the bug",
  );
  assert.ok(r.warnings.some((w) => /READABLE per device but not to SLA grade/.test(w)));
  assert.ok(r.warnings.some((w) => /cannot be measured at all/.test(w)));
});

test("with no capability probe the report promotes nothing and says so", () => {
  const r = buildFleetReport(24, 300, [], []);
  assert.equal(r.measurability.slaGrade.length, 0);
  assert.equal(r.measurability.fromLiveCapability, false);
  assert.ok(r.warnings.some((w) => /NO live capability sample/.test(w)));
});

test("the legacy UNMEASURABLE export is the whole not-SLA-grade set, fail-closed", () => {
  // Kept under its old name for callers with no probe. It must never be shorter
  // than the two tiers it unions, or a caller would silently lose a caveat.
  assert.equal(
    UNMEASURABLE.length,
    MEASURABILITY_WITHOUT_LIVE_SIGNAL.unmeasurable.length +
      MEASURABILITY_WITHOUT_LIVE_SIGNAL.readable.length,
  );
  assert.equal(UNMEASURABLE.length, DIMENSION_CATALOG.length);
  for (const d of UNMEASURABLE) assert.ok(d.dimension && d.reason && d.slaImpact);
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function laneRuns(
  lane: string,
  { count, gapSeconds, targeted }: { count: number; gapSeconds: number; targeted: number },
): PollerRunRow[] {
  const now = Date.UTC(2026, 8, 3, 12, 0, 0);
  return Array.from({ length: count }, (_, i) => ({
    poller: lane,
    startedAt: new Date(now - i * gapSeconds * 1000),
    durationMs: 1000,
    devicesTargeted: targeted,
    rowsWritten: targeted,
    batchesOk: 1,
    batchesFailed: 0,
    telemetryYield: null,
  }));
}

/** Every telemetry field readable on the same number of devices, for brevity. */
function inputs({
  readable,
  laneRuns: runs,
}: { readable: number; laneRuns: PollerRunRow[] }): MeasurabilityInputs {
  return {
    fleetSize: FLEET,
    fieldReadable: {
      cpu_percent: readable, ram_percent: readable, storage_percent: readable,
      wifi_signal_dbm: readable, temperature_c: 0, playback_quality: 0,
    },
    laneRuns: runs,
    screenshot: { addressable: FLEET, capturedWithin24h: 2 },
  };
}
