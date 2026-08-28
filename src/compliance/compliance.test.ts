/**
 * Compliance and SLA tests — `node --test dist/compliance/compliance.test.js`
 *
 * The invariants here were all learned from real data rather than designed up
 * front, so each test names the mistake it prevents.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCompliance, complianceBand, readPath } from "./evaluate.js";
import { DEFAULT_TEMPLATES, templateFor, validateTemplate, type ComplianceTemplate } from "./templates.js";
import { calibrate, describeDistribution, proposeCheck } from "./calibrate.js";
import { assessDevice, confidenceFor, buildFleetReport, UNMEASURABLE } from "../sla/coverage.js";

const template = (checks: ComplianceTemplate["checks"]): ComplianceTemplate => ({
  id: "t", name: "T", defaultFor: [], checks,
});

// ─── the not-applicable invariant ───────────────────────────────────────────

test("a class-inapplicable check is notApplicable, never a failure", () => {
  const t = template([{
    id: "input", kind: "calibrated", field: "current_source", label: "Input",
    expected: { kind: "equals", value: "ANDROID" }, weight: 3,
    appliesTo: ["tcl"], rationale: "x",
  }]);
  // A Videri Canvas has no input to switch. Scoring it here would make every
  // Canvas look non-compliant for lacking hardware it never had.
  const r = evaluateCompliance("c1", "canvas", {}, t);
  assert.equal(r.results[0]!.verdict, "notApplicable");
  assert.equal(r.checksTotal, 0);
  assert.equal(r.score, 100, "no applicable checks must score 100, not 0");
});

test("a field the device did not report is notApplicable, never a failure", () => {
  const t = template([{
    id: "vol", kind: "calibrated", field: "volume", label: "Volume",
    expected: { kind: "range", min: 0, max: 5 }, weight: 2,
    appliesTo: "all", rationale: "x",
  }]);
  const r = evaluateCompliance("c1", "tcl", { brightness: 100 }, t);
  assert.equal(r.results[0]!.verdict, "notApplicable");
  assert.match(r.results[0]!.reason ?? "", /did not report/);
});

test('the "unavailable" sentinel counts as absent, not as a wrong value', () => {
  const t = template([{
    id: "tz", kind: "calibrated", field: "timezone", label: "TZ",
    expected: { kind: "notEmpty" }, weight: 1, appliesTo: "all", rationale: "x",
  }]);
  const r = evaluateCompliance("c1", "tcl", { timezone: "unavailable" }, t);
  assert.equal(r.results[0]!.verdict, "notApplicable");
});

// ─── comparison semantics ───────────────────────────────────────────────────

test("compares across the string/number boundary", () => {
  // The platform returns "0500" as a string and brightness as a number. Strict
  // equality would flag the whole fleet on type alone.
  const t = template([{
    id: "off", kind: "calibrated", field: "turn_off_time", label: "Off",
    expected: { kind: "equals", value: "0500" }, weight: 1, appliesTo: "all", rationale: "x",
  }]);
  assert.equal(evaluateCompliance("c", "tcl", { turn_off_time: "0500" }, t).score, 100);
  assert.equal(evaluateCompliance("c", "tcl", { turn_off_time: "2100" }, t).score, 0);
});

test("boolean-as-string is handled", () => {
  const t = template([{
    id: "cec", kind: "calibrated", field: "cec_enabled", label: "CEC",
    expected: { kind: "equals", value: false }, weight: 1, appliesTo: "all", rationale: "x",
  }]);
  assert.equal(evaluateCompliance("c", "tcl", { cec_enabled: false }, t).score, 100);
  assert.equal(evaluateCompliance("c", "tcl", { cec_enabled: "false" }, t).score, 100);
  assert.equal(evaluateCompliance("c", "tcl", { cec_enabled: true }, t).score, 0);
});

test("readPath walks nested settings", () => {
  assert.equal(readPath({ color_table_offsets: { r: 7 } }, "color_table_offsets.r"), 7);
  assert.equal(readPath({ a: 1 }, "a.b.c"), undefined);
});

// ─── the calibrated / policy split ──────────────────────────────────────────

test("policy checks are scored separately from drift", () => {
  // The mistake this prevents: the first template version mixed an aspiration
  // (98% of the fleet violates it) into the drift score, producing 61% with
  // 109 of 110 devices "non-compliant" — a number nobody would read twice.
  const t = template([
    {
      id: "drift", kind: "calibrated", field: "color_saturation", label: "Sat",
      expected: { kind: "equals", value: 50 }, weight: 1, appliesTo: "all", rationale: "x",
    },
    {
      id: "aspiration", kind: "policy", field: "auto_on_off_enabled", label: "Sched",
      expected: { kind: "equals", value: true }, weight: 1, appliesTo: "all", rationale: "x",
    },
  ]);
  const r = evaluateCompliance("c", "tcl", { color_saturation: 50, auto_on_off_enabled: false }, t);
  assert.equal(r.score, 100, "drift score must ignore unmet policy");
  assert.equal(r.policyScore, 0, "policy gap is reported, separately");
});

test("checks default to calibrated when kind is omitted", () => {
  const t = template([{
    id: "x", field: "a", label: "A", expected: { kind: "notEmpty" },
    weight: 1, appliesTo: "all", rationale: "x",
  }]);
  assert.equal(evaluateCompliance("c", "tcl", { a: "v" }, t).results[0]!.kind, "calibrated");
});

// ─── templates ──────────────────────────────────────────────────────────────

test("every shipped template is valid and has a class default", () => {
  for (const t of DEFAULT_TEMPLATES) {
    assert.deepEqual(validateTemplate(t), [], `template "${t.id}" is invalid`);
  }
  for (const cls of ["canvas", "spark-bridge", "tcl", "allsee", "allsee-shelf", "unknown"] as const) {
    assert.ok(templateFor(cls, null), `no default template for ${cls}`);
  }
});

test("an explicit assignment overrides the class default", () => {
  assert.equal(templateFor("canvas", "airport-extended")?.id, "airport-extended");
  assert.equal(templateFor("canvas", "does-not-exist")?.id, "retail-standard");
});

test("banding matches the prototype's badges", () => {
  assert.equal(complianceBand(100), "compliant");
  assert.equal(complianceBand(95), "compliant");
  assert.equal(complianceBand(80), "minor-drift");
  assert.equal(complianceBand(50), "non-compliant");
});

// ─── calibration ────────────────────────────────────────────────────────────

test("calibration reports strong consensus where the fleet agrees", () => {
  const snaps = Array.from({ length: 100 }, (_, i) => ({ turn_off_time: i < 95 ? "0500" : "2100" }));
  const p = proposeCheck(describeDistribution("turn_off_time", snaps.map((s) => s.turn_off_time)));
  assert.equal(p.consensus, "strong");
  assert.deepEqual(p.suggested, { kind: "equals", value: "0500" });
});

test("calibration REFUSES to suggest a check where the fleet has no consensus", () => {
  // Real case: brightness had 30 distinct values across 0–255. Enforcing any
  // target would have flagged 86% of devices for nothing.
  const values = Array.from({ length: 100 }, (_, i) => (i * 255) / 100);
  const p = proposeCheck(describeDistribution("brightness", values));
  assert.match(p.recommendation, /confirm the scale|no consensus|median/i);
});

test("calibration will not propose a check on an unreported field", () => {
  const p = proposeCheck(describeDistribution("nonexistent", [null, undefined, "unavailable"]));
  assert.equal(p.suggested, null);
  assert.equal(p.consensus, "none");
  assert.match(p.recommendation, /Do not build a check/);
});

test("calibrate returns one proposal per requested field", () => {
  const out = calibrate([{ timezone: "UTC" }, { timezone: "UTC" }], ["timezone", "volume"]);
  assert.equal(out.length, 2);
});

// ─── SLA coverage ───────────────────────────────────────────────────────────

const agg = (over: Partial<Parameters<typeof assessDevice>[0]> = {}) => ({
  deviceId: "d1", name: "D1",
  observedBuckets: 288, onlineBuckets: 285, expectedBuckets: 288,
  longestGapSeconds: 0, stalenessSeconds: 60, ...over,
});

test("uptime is computed over OBSERVED time, not the whole window", () => {
  // The mistake this prevents: dividing by expectedBuckets charges the device
  // for OUR collection gaps, understating its uptime and misassigning blame.
  const d = assessDevice(agg({ observedBuckets: 100, onlineBuckets: 100, expectedBuckets: 288 }), 300);
  assert.equal(d.observedUptime, 1, "100% of observed time was online");
  assert.ok(d.collectionCoverage < 0.4, "but coverage is poor");
  assert.equal(d.claimable, false, "so no external claim may be made");
});

test("a claim requires high coverage, and says so when it cannot be made", () => {
  const good = assessDevice(agg(), 300);
  assert.equal(good.claimable, true);
  assert.match(good.statement, /Online for/);

  const poor = assessDevice(agg({ observedBuckets: 4, onlineBuckets: 4 }), 300);
  assert.equal(poor.claimable, false);
  assert.match(poor.statement, /NOT CLAIMABLE/);
});

test("a device with no readings cannot have uptime asserted", () => {
  const d = assessDevice(agg({ observedBuckets: 0, onlineBuckets: 0, stalenessSeconds: null }), 300);
  assert.equal(d.observedUptime, null);
  assert.equal(d.claimable, false);
  assert.match(d.statement, /cannot be asserted/);
});

test("confidence bands are conservative", () => {
  assert.equal(confidenceFor(1), "high");
  assert.equal(confidenceFor(0.95), "medium");
  assert.equal(confidenceFor(0.7), "low");
  assert.equal(confidenceFor(0.2), "none");
});

test("fleet uptime is averaged over CLAIMABLE devices only", () => {
  const devices = [
    assessDevice(agg({ deviceId: "good", onlineBuckets: 288 }), 300),
    // Barely observed and fully offline — must not drag the fleet figure down,
    // because we cannot defend a number that includes it.
    assessDevice(agg({ deviceId: "unseen", observedBuckets: 2, onlineBuckets: 0 }), 300),
  ];
  const r = buildFleetReport(24, 300, devices, []);
  assert.equal(r.devicesClaimable, 1);
  assert.equal(r.fleetObservedUptimeClaimable, 1);
  assert.ok(r.warnings.some((w) => w.includes("do not have sufficient collection coverage")));
});

test("fleet-wide silence is attributed to OUR collector, not a fleet outage", () => {
  const r = buildFleetReport(24, 300, [assessDevice(agg(), 300)], [
    { from: "2026-08-25T01:00:00Z", to: "2026-08-25T03:00:00Z", durationSeconds: 7200, devicesReporting: 0 },
  ]);
  const warning = r.warnings.find((w) => w.includes("blind window"));
  assert.ok(warning, "a fleet-wide gap must be warned about");
  assert.match(warning, /our own collector stopped, not a fleet outage/);
});

test("unmeasurable dimensions are enumerated with SLA impact", () => {
  assert.ok(UNMEASURABLE.length >= 6);
  for (const d of UNMEASURABLE) {
    assert.ok(d.dimension && d.reason && d.slaImpact, `${d.dimension} is missing a field`);
  }
  // Thermal is the clearest example of a clause that cannot be instrumented.
  assert.ok(UNMEASURABLE.some((d) => /Thermal/i.test(d.dimension)));
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-device scales, and class-specific fields
//
// Both came out of the live settings-field audit (evidence/settings-field-audit.txt):
// `max_volume` is 100 on TCL but 15 on Canvas and AllSee, and `cec_enabled` /
// `source_auto_switch` are returned by TCL alone.
// ─────────────────────────────────────────────────────────────────────────────

test("volume is scored against the device's own maximum, not a fixed scale", () => {
  // Volume 11 is nearly full blast on a 15-step Canvas and near-silent on a
  // 100-step TCL. The same raw number must not produce the same verdict.
  assert.equal(readPath({ volume: 11, max_volume: 15 }, "volume_percent"), 73);
  assert.equal(readPath({ volume: 11, max_volume: 100 }, "volume_percent"), 11);
});

test("a derived field with missing inputs is absent, never zero", () => {
  // Inventing 0 here would certify a device as muted on no evidence.
  assert.equal(readPath({ volume: 11 }, "volume_percent"), undefined);
  assert.equal(readPath({ max_volume: 15 }, "volume_percent"), undefined);
  assert.equal(readPath({ volume: 5, max_volume: 0 }, "volume_percent"), undefined);
});

test("TCL-only checks are not applied to AllSee or Canvas", () => {
  const tclOnly = ["source-auto-switch-off", "cec-disabled"];
  for (const tpl of DEFAULT_TEMPLATES) {
    for (const check of tpl.checks) {
      if (!tclOnly.includes(check.id)) continue;
      assert.notEqual(check.appliesTo, "all", `${check.id} must be class-scoped`);
      const classes = check.appliesTo as string[];
      assert.deepEqual(classes, ["tcl"], `${check.id} is scoped to ${classes.join(",")}`);
    }
  }
});

test("every template field is one a device actually reports", () => {
  // The fields observed live across canvas, tcl and allsee, plus the derived
  // ones. A template naming anything outside this set is scoring nothing.
  const OBSERVED = new Set([
    "turn_on_time", "turn_off_time", "auto_on_off_enabled", "timezone",
    "daily_reboot_time", "daily_reboot_enabled", "display_on", "brightness",
    "auto_brightness_enabled", "custom_logo", "storage_target_free_percent",
    "storage_max_percent", "color_table_offsets", "color_saturation",
    "current_brightness", "brightness_schedule_enabled", "res_w", "res_h",
    "framerate", "default_scale_type", "volume", "max_volume",
    "available_audio_outputs", "current_audio_output", "current_source",
    "available_sources", "source_auto_switch", "cec_enabled", "android_id",
    "available_hdmi_resolutions", "custom_hdmi_resolution",
    "default_hdmi_resolution", "hdmi_delayed_start", "available_timezones",
    "current_hdmi_resolution", "hdmi_negotiation_mode",
    // derived
    "volume_percent",
  ]);
  for (const tpl of DEFAULT_TEMPLATES) {
    for (const check of tpl.checks) {
      const top = check.field.split(".")[0]!;
      assert.ok(
        OBSERVED.has(top),
        `${tpl.id}:${check.id} reads "${check.field}", which no device was observed to report`,
      );
    }
  }
});
