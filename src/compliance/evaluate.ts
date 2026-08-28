/**
 * Compliance evaluation — pure, no I/O.
 *
 * Compares a device's actual settings against its template and produces a score
 * plus per-check detail. Same discipline as the alerting evaluator: a subtle bug
 * here either nags operators about non-problems or quietly passes a misconfigured
 * screen, and both destroy trust in the number.
 *
 * THE INVARIANT
 * A check is only scored when the field genuinely exists on the device. Missing
 * field → `notApplicable`, excluded from the denominator. This is what stops a
 * Videri Canvas being marked non-compliant for having no HDMI input, and it is
 * why the score is a share of *applicable* checks rather than of all checks.
 */

import type { ComplianceCheck, ComplianceTemplate, Comparator } from "./templates.js";
import type { DeviceClass } from "../domain/types.js";

export type CheckVerdict = "pass" | "drift" | "notApplicable";

export interface CheckResult {
  checkId: string;
  kind: "calibrated" | "policy";
  field: string;
  label: string;
  verdict: CheckVerdict;
  expected: string;
  actual: string | null;
  weight: number;
  rationale: string;
  /** Populated for notApplicable, so the UI can explain the omission. */
  reason?: string;
}

export interface ComplianceResult {
  deviceId: string;
  templateId: string;
  /**
   * 0–100 over applicable CALIBRATED checks only — deviation from what the fleet
   * overwhelmingly does. This is the number an operator acts on, and it is kept
   * clean of policy aspirations most of the fleet has not adopted yet.
   */
  score: number;
  /** 0–100 over applicable POLICY checks. A remediation backlog, not drift. */
  policyScore: number | null;
  checksTotal: number;
  checksPassed: number;
  checksNotApplicable: number;
  results: CheckResult[];
  /** Drifted checks, heaviest first — what the UI and AI layer lead with. */
  drift: CheckResult[];
}

/** Reads a dotted path out of the settings object. `undefined` = absent. */
/**
 * Fields the device does not report but which are computable from what it does.
 *
 * These exist because some settings are only meaningful relative to a per-device
 * maximum. `volume` is the case that forced it: 11 means 73% on a Canvas
 * (max_volume 15) and 11% on a TCL (max_volume 100). Comparing the raw number
 * across classes silently compares different things.
 *
 * A derived field returns `undefined` when its inputs are missing, so it falls
 * through the normal absence gate to `notApplicable` rather than inventing a 0.
 */
const DERIVED_FIELDS: Record<string, (s: Record<string, unknown>) => unknown> = {
  volume_percent: (s) => {
    const v = s["volume"];
    const max = s["max_volume"];
    if (typeof v !== "number" || typeof max !== "number" || max <= 0) return undefined;
    return Math.round((v / max) * 100);
  },
};

export function readPath(settings: unknown, path: string): unknown {
  if (path in DERIVED_FIELDS && settings !== null && typeof settings === "object") {
    return DERIVED_FIELDS[path]!(settings as Record<string, unknown>);
  }
  let node: unknown = settings;
  for (const segment of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment];
    if (node === undefined) return undefined;
  }
  return node;
}

const describe = (c: Comparator): string => {
  switch (c.kind) {
    case "equals": return String(c.value);
    case "oneOf": return `one of ${c.values.join(", ")}`;
    case "range": return `${c.min}–${c.max}`;
    case "notEmpty": return "any non-empty value";
  }
};

/**
 * `"unavailable"` and `""` are the platform's nulls (docs/06 §3.4). Treated as
 * absent, so a device reporting a sentinel is not scored against that check.
 */
const isAbsentValue = (v: unknown): boolean =>
  v === undefined ||
  v === null ||
  (typeof v === "string" && ["", "unavailable", "not set", "n/a"].includes(v.trim().toLowerCase()));

function satisfies(actual: unknown, expected: Comparator): boolean {
  switch (expected.kind) {
    case "equals":
      // Compare loosely across the string/number/bool boundary: the platform
      // returns "0500" as a string and brightness as a number, and a strict
      // === would flag every check on type alone.
      if (typeof expected.value === "boolean") {
        if (typeof actual === "boolean") return actual === expected.value;
        if (typeof actual === "string") return actual.toLowerCase() === String(expected.value);
        return false;
      }
      return String(actual) === String(expected.value);
    case "oneOf":
      return expected.values.some((v) => String(v) === String(actual));
    case "range": {
      const n = typeof actual === "number" ? actual : Number(actual);
      return Number.isFinite(n) && n >= expected.min && n <= expected.max;
    }
    case "notEmpty":
      return !isAbsentValue(actual);
  }
}

function evaluateCheck(
  check: ComplianceCheck,
  settings: unknown,
  deviceClass: DeviceClass,
): CheckResult {
  const base = {
    checkId: check.id,
    kind: check.kind ?? ("calibrated" as const),
    field: check.field,
    label: check.label,
    expected: describe(check.expected),
    weight: check.weight,
    rationale: check.rationale,
  };

  // 1. Class gate — this hardware does not have the capability at all.
  if (check.appliesTo !== "all" && !check.appliesTo.includes(deviceClass)) {
    return {
      ...base,
      verdict: "notApplicable",
      actual: null,
      reason: `Not applicable to ${deviceClass} hardware.`,
    };
  }

  const actual = readPath(settings, check.field);

  // 2. Field gate — the class allows it but this unit did not report it. Still
  //    not a failure: absence of a reading is not evidence of misconfiguration.
  if (isAbsentValue(actual)) {
    return {
      ...base,
      verdict: "notApplicable",
      actual: null,
      reason: `Device did not report "${check.field}".`,
    };
  }

  return {
    ...base,
    verdict: satisfies(actual, check.expected) ? "pass" : "drift",
    actual: typeof actual === "object" ? JSON.stringify(actual) : String(actual),
  };
}

export function evaluateCompliance(
  deviceId: string,
  deviceClass: DeviceClass,
  settings: unknown,
  template: ComplianceTemplate,
): ComplianceResult {
  const results = template.checks.map((c) => evaluateCheck(c, settings, deviceClass));

  const applicable = results.filter((r) => r.verdict !== "notApplicable");
  const calibrated = applicable.filter((r) => r.kind === "calibrated");
  const policy = applicable.filter((r) => r.kind === "policy");

  const weighted = (rs: CheckResult[]) => {
    const total = rs.reduce((s, r) => s + r.weight, 0);
    const passed = rs.filter((r) => r.verdict === "pass").reduce((s, r) => s + r.weight, 0);
    // No applicable checks scores 100, not 0. A device we cannot assess is not a
    // non-compliant device — reporting 0% would make unassessable hardware look
    // like the worst in the fleet.
    return total === 0 ? null : Math.round((passed / total) * 100);
  };

  const score = weighted(calibrated) ?? 100;
  const policyScore = weighted(policy);
  const passed = applicable.filter((r) => r.verdict === "pass");

  return {
    deviceId,
    templateId: template.id,
    score,
    policyScore,
    checksTotal: applicable.length,
    checksPassed: passed.length,
    checksNotApplicable: results.length - applicable.length,
    results,
    drift: applicable
      .filter((r) => r.verdict === "drift")
      .sort((a, b) => b.weight - a.weight),
  };
}

/** Compliance banding, matching the prototype's badges. */
export function complianceBand(score: number): "compliant" | "minor-drift" | "non-compliant" {
  if (score >= 95) return "compliant";
  if (score >= 75) return "minor-drift";
  return "non-compliant";
}
