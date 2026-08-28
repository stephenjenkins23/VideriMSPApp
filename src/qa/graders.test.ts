/**
 * Tests for the graders themselves — `node --test dist/qa/graders.test.js`
 *
 * These matter more than they look. The graders are the safety net for a
 * non-deterministic system, so a grader that silently fails to catch a
 * hallucinated number is worse than having no grader at all: it produces a
 * green build and false confidence. So we test the detectors against known-bad
 * output.
 *
 * Runs with no API key and no database.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { FleetBundle } from "../ai/bundle.js";
import type { FleetBrief } from "../ai/brief.js";
import {
  numericGrounding,
  gapDisclosure,
  noFalseHealthClaims,
  severityGrounding,
  structuralSanity,
} from "./graders.js";

const bundle = (over: Partial<FleetBundle["overview"]> = {}): FleetBundle => ({
  overview: {
    computedAt: "2026-08-24T08:00:00.000Z",
    totalDevices: 100,
    byStatus: { online: 90, offline: 10 },
    byDeviceClass: { canvas: 100 },
    openAlerts: { critical: 0, high: 2, medium: 0, info: 0 },
    telemetryCoverage: 1,
    statusCoverage: 1,
    unavailableMetrics: [],
    ...over,
  },
  firmware: {
    latestVersion: "3.4.1",
    devicesBehind: 10,
    versions: [{ version: "3.4.1", count: 90, isLatest: true, sharePercent: 90 }],
  },
  attention: [],
  changes: {
    windowHours: 24, wentOffline: [], cameBackOnline: [],
    newAlerts: [], resolvedAlertCount: 0, firmwareChanges: [],
  },
});

const brief = (over: Partial<FleetBrief> = {}): FleetBrief => ({
  headline: "90 of 100 devices online.",
  fleetState: "The fleet is largely stable with 10 devices offline and 2 high-severity alerts open.",
  needsAttention: [],
  changes: [],
  dataGaps: [],
  ...over,
});

// ─── numericGrounding ───────────────────────────────────────────────────────

test("numericGrounding accepts numbers present in the bundle", () => {
  const r = numericGrounding(bundle(), brief());
  assert.equal(r.passed, true, JSON.stringify(r.findings));
});

test("numericGrounding accepts a derived percentage", () => {
  const r = numericGrounding(bundle(), brief({ headline: "10% of the fleet is offline." }));
  assert.equal(r.passed, true, JSON.stringify(r.findings));
});

test("numericGrounding CATCHES an invented number", () => {
  const r = numericGrounding(
    bundle(),
    brief({ headline: "437 devices went offline overnight across 12 regions." }),
  );
  assert.equal(r.passed, false, "437 is not in the bundle and must be caught");
  assert.ok(r.findings.some((f) => f.message.includes("437")));
  assert.ok(r.score < 1);
});

test("numericGrounding inspects nested needsAttention text too", () => {
  const r = numericGrounding(
    bundle(),
    brief({
      needsAttention: [
        {
          device: "Gate B22", problem: "Offline", severity: "high",
          evidence: "CPU has averaged 68% for 9 days.", // neither figure is in the bundle
          suggestedAction: "Investigate.",
        },
      ],
    }),
  );
  assert.equal(r.passed, false);
  assert.ok(r.findings.some((f) => f.message.includes("68")));
});

// ─── gapDisclosure ──────────────────────────────────────────────────────────

test("gapDisclosure CATCHES silence about zero coverage", () => {
  const r = gapDisclosure(
    bundle({
      telemetryCoverage: 0,
      statusCoverage: 1,
      unavailableMetrics: [{ metric: "cpuPercent", reason: "undocumented" }],
    }),
    brief({ dataGaps: [] }),
  );
  assert.equal(r.passed, false);
  assert.equal(r.score, 0);
});

test("gapDisclosure passes when gaps are declared", () => {
  const r = gapDisclosure(
    bundle({
      telemetryCoverage: 0,
      statusCoverage: 1,
      unavailableMetrics: [{ metric: "cpuPercent", reason: "undocumented" }],
    }),
    brief({ dataGaps: ["CPU utilisation could not be read for any device in this fleet."] }),
  );
  assert.equal(r.passed, true, JSON.stringify(r.findings));
});

test("gapDisclosure stays quiet on full coverage", () => {
  const r = gapDisclosure(
    bundle({ telemetryCoverage: 1, statusCoverage: 1 }),
    brief({ dataGaps: [] }),
  );
  assert.equal(r.passed, true);
});

// ─── noFalseHealthClaims ────────────────────────────────────────────────────

test("noFalseHealthClaims CATCHES certifying an unreadable metric", () => {
  const unreadable = bundle({
    telemetryCoverage: 0.3,
    statusCoverage: 1,
    unavailableMetrics: [{ metric: "temperatureC", reason: "no key matched" }],
  });
  const r = noFalseHealthClaims(
    unreadable,
    brief({ fleetState: "All screens are stable and no devices are overheating." }),
  );
  assert.equal(r.passed, false, "must not certify temperature it cannot read");
  assert.equal(r.score, 0);
});

test("noFalseHealthClaims allows the same phrasing when the metric IS readable", () => {
  const r = noFalseHealthClaims(
    bundle({ unavailableMetrics: [] }),
    brief({ fleetState: "All screens are stable and no devices are overheating." }),
  );
  assert.equal(r.passed, true);
});

test("noFalseHealthClaims CATCHES a blanket all-healthy claim", () => {
  const r = noFalseHealthClaims(
    bundle({
      telemetryCoverage: 0,
      statusCoverage: 1,
      unavailableMetrics: [{ metric: "cpuPercent", reason: "no key matched" }],
    }),
    brief({ headline: "All devices are healthy." }),
  );
  assert.equal(r.passed, false);
});

// ─── severityGrounding ──────────────────────────────────────────────────────

test("severityGrounding CATCHES unsupported critical severity", () => {
  const calm = bundle({ byStatus: { online: 100 }, openAlerts: { critical: 0, high: 0, medium: 0, info: 0 } });
  const r = severityGrounding(
    calm,
    brief({
      needsAttention: [
        {
          device: "Gate B22", problem: "Something", evidence: "Something",
          suggestedAction: "Act", severity: "critical",
        },
      ],
    }),
  );
  assert.equal(r.passed, false, "critical with no critical alerts and nothing offline");
});

test("severityGrounding allows critical when devices are offline", () => {
  const r = severityGrounding(
    bundle({ byStatus: { online: 90, offline: 10 } }),
    brief({
      needsAttention: [
        {
          device: "Gate B22", problem: "Offline for 10 hours",
          evidence: "10 devices offline", suggestedAction: "Check the switch",
          severity: "critical",
        },
      ],
    }),
  );
  assert.equal(r.passed, true, JSON.stringify(r.findings));
});

// ─── structuralSanity ───────────────────────────────────────────────────────

test("structuralSanity CATCHES an attention item with no evidence", () => {
  const r = structuralSanity(
    bundle(),
    brief({
      needsAttention: [
        { device: "Gate B22", problem: "Offline", evidence: "   ", suggestedAction: "Act", severity: "high" },
      ],
    }),
  );
  assert.equal(r.passed, false);
});

test("structuralSanity CATCHES an empty headline", () => {
  const r = structuralSanity(bundle(), brief({ headline: "" }));
  assert.equal(r.passed, false);
});

test("structuralSanity passes a well-formed brief", () => {
  const r = structuralSanity(bundle(), brief());
  assert.equal(r.passed, true, JSON.stringify(r.findings));
});
