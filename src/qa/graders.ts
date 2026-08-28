/**
 * Deterministic graders for AI output.
 *
 * The important idea in this file: **most of what can go wrong with an LLM in
 * this product is programmatically checkable.** We do not need a model to judge
 * whether the brief invented a number — we can extract every numeral from the
 * output and verify it appears in the input. Reserve the expensive, noisy
 * LLM-as-judge for genuinely subjective properties (see judge.ts).
 *
 * These graders run with no API key and no database, so they belong in CI.
 */

import type { FleetBundle } from "../ai/bundle.js";
import type { FleetBrief } from "../ai/brief.js";

export interface Finding {
  severity: "fail" | "warn";
  message: string;
}

export interface GraderResult {
  grader: string;
  /** 0–1. 1 is clean. */
  score: number;
  passed: boolean;
  findings: Finding[];
}

export type Grader = (bundle: FleetBundle, brief: FleetBrief) => GraderResult;

// ─── helpers ────────────────────────────────────────────────────────────────

/** Every string the model produced, flattened. */
function briefText(brief: FleetBrief): string[] {
  return [
    brief.headline,
    brief.fleetState,
    ...brief.changes,
    ...brief.dataGaps,
    ...brief.needsAttention.flatMap((a) => [a.device, a.problem, a.evidence, a.suggestedAction]),
  ];
}

const NUMBER_RE = /-?\d+(?:\.\d+)?/g;

function numbersIn(text: string): number[] {
  return [...text.matchAll(NUMBER_RE)].map((m) => Number(m[0])).filter(Number.isFinite);
}

/**
 * The set of numbers the model is *allowed* to state: everything present in the
 * bundle, plus values a reasonable analyst would derive from it (list lengths and
 * simple percentages). Anything outside this set was invented.
 */
function groundedNumbers(bundle: FleetBundle): Set<number> {
  const grounded = new Set<number>();
  const add = (n: number) => {
    if (Number.isFinite(n)) {
      grounded.add(n);
      grounded.add(Math.round(n));
      grounded.add(Number(n.toFixed(1)));
    }
  };

  const walk = (node: unknown): void => {
    if (typeof node === "number") return add(node);
    if (typeof node === "string") {
      // Firmware strings like "2.1.4" legitimise 2, 1, 4 and 2.1.
      for (const n of numbersIn(node)) add(n);
      return;
    }
    if (Array.isArray(node)) {
      add(node.length); // "14 devices went offline" is derivable from a list
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object") {
      const entries = Object.entries(node as Record<string, unknown>);
      add(entries.length);
      for (const [, v] of entries) walk(v);
    }
  };
  walk(bundle);

  // Percentages derived against the fleet total are fair game.
  const total = bundle.overview.totalDevices;
  if (total > 0) {
    const counts = [
      ...Object.values(bundle.overview.byStatus),
      ...Object.values(bundle.overview.byDeviceClass),
      ...Object.values(bundle.overview.openAlerts),
      bundle.attention.length,
      bundle.firmware.devicesBehind,
    ];
    for (const c of counts) {
      add((c / total) * 100);
      add(Math.round((c / total) * 100));
    }
    add(bundle.overview.telemetryCoverage * 100);
    add(Math.round(bundle.overview.telemetryCoverage * 100));
    add(Math.round((1 - bundle.overview.telemetryCoverage) * 100));
  }
  return grounded;
}

const near = (needle: number, haystack: Set<number>): boolean => {
  if (haystack.has(needle)) return true;
  for (const candidate of haystack) {
    if (Math.abs(candidate - needle) < 0.051) return true;
  }
  return false;
};

// ─── graders ────────────────────────────────────────────────────────────────

/**
 * Every number in the output must be traceable to the input.
 *
 * This is the single highest-value AI check in the product. A fleet brief that
 * invents "23 devices offline" is worse than no brief: an operator will act on
 * it. Hallucinated figures are the failure mode most likely to destroy trust,
 * and they are fully mechanically detectable.
 */
export const numericGrounding: Grader = (bundle, brief) => {
  const grounded = groundedNumbers(bundle);
  const findings: Finding[] = [];
  let stated = 0;

  for (const text of briefText(brief)) {
    for (const n of numbersIn(text)) {
      stated += 1;
      if (!near(n, grounded)) {
        findings.push({
          severity: "fail",
          message: `Ungrounded number ${n} in: "${text.slice(0, 120)}"`,
        });
      }
    }
  }

  const score = stated === 0 ? 1 : 1 - findings.length / stated;
  return { grader: "numericGrounding", score, passed: findings.length === 0, findings };
};

/**
 * When coverage is incomplete, the brief must say so.
 *
 * Silence about a gap reads as an all-clear. This is the property that makes the
 * difference between a brief an operator can trust and one that quietly omits
 * half the fleet.
 */
export const gapDisclosure: Grader = (bundle, brief) => {
  const findings: Finding[] = [];
  const hasGaps =
    bundle.overview.unavailableMetrics.length > 0 || bundle.overview.telemetryCoverage < 0.999;

  if (hasGaps && brief.dataGaps.length === 0) {
    findings.push({
      severity: "fail",
      message: `Coverage is ${(bundle.overview.telemetryCoverage * 100).toFixed(1)}% with ${bundle.overview.unavailableMetrics.length} unavailable metric(s), but dataGaps is empty.`,
    });
  }

  // Each named unavailable metric should be acknowledged somewhere.
  const disclosure = brief.dataGaps.join(" ").toLowerCase() + " " + brief.fleetState.toLowerCase();
  for (const { metric } of bundle.overview.unavailableMetrics) {
    const bare = metric.replace(/Percent|C$|Dbm|Ms$/g, "").toLowerCase();
    if (bare && !disclosure.includes(bare)) {
      findings.push({
        severity: "warn",
        message: `Unavailable metric "${metric}" is not mentioned in dataGaps or fleetState.`,
      });
    }
  }

  const fails = findings.filter((f) => f.severity === "fail").length;
  return {
    grader: "gapDisclosure",
    score: fails > 0 ? 0 : findings.length > 0 ? 0.6 : 1,
    passed: fails === 0,
    findings,
  };
};

/** Phrasings that assert a clean bill of health. */
const HEALTH_CLAIM_PATTERNS: Array<{ re: RegExp; metric: string }> = [
  { re: /\b(no|none of the|zero)\b[^.]{0,60}\b(overheat|hot|thermal|temperature)/i, metric: "temperatureC" },
  { re: /\btemperatures?\b[^.]{0,40}\b(normal|nominal|healthy|fine|within)/i, metric: "temperatureC" },
  { re: /\bcpu\b[^.]{0,40}\b(normal|nominal|healthy|fine|low|within)/i, metric: "cpuPercent" },
  { re: /\b(no|none of the|zero)\b[^.]{0,60}\bcpu\b/i, metric: "cpuPercent" },
  { re: /\b(memory|ram)\b[^.]{0,40}\b(normal|nominal|healthy|fine|within)/i, metric: "ramPercent" },
  { re: /\b(signal|wifi)\b[^.]{0,40}\b(good|strong|normal|healthy|fine)/i, metric: "wifiSignalDbm" },
  { re: /\ball (devices|screens) (are )?(healthy|fine|nominal|operating normally)/i, metric: "*" },
];

/**
 * The brief must not certify a metric it cannot read.
 *
 * "No devices are overheating" is a false statement when temperature is
 * unreadable — but it reads as reassurance, so nobody questions it. Given that
 * most of the Videri telemetry surface is undocumented, this is the most
 * dangerous thing our AI layer could say.
 */
export const noFalseHealthClaims: Grader = (bundle, brief) => {
  const unavailable = new Set(bundle.overview.unavailableMetrics.map((m) => m.metric));
  const findings: Finding[] = [];
  if (unavailable.size === 0) {
    return { grader: "noFalseHealthClaims", score: 1, passed: true, findings };
  }

  for (const text of briefText(brief)) {
    for (const { re, metric } of HEALTH_CLAIM_PATTERNS) {
      const relevant = metric === "*" ? unavailable.size > 0 : unavailable.has(metric);
      if (relevant && re.test(text)) {
        findings.push({
          severity: "fail",
          message: `Claims health for unreadable metric "${metric}": "${text.slice(0, 140)}"`,
        });
      }
    }
  }

  return {
    grader: "noFalseHealthClaims",
    score: findings.length === 0 ? 1 : 0,
    passed: findings.length === 0,
    findings,
  };
};

/**
 * Severity must be supported by the data. A "critical" item with no critical
 * alert and no offline device behind it is the model inflating urgency, which
 * trains operators to ignore the severity field entirely.
 */
export const severityGrounding: Grader = (bundle, brief) => {
  const findings: Finding[] = [];
  const criticalsAvailable =
    bundle.overview.openAlerts.critical + (bundle.overview.byStatus["offline"] ?? 0);

  const claimedCriticals = brief.needsAttention.filter((a) => a.severity === "critical").length;
  if (claimedCriticals > 0 && criticalsAvailable === 0) {
    findings.push({
      severity: "fail",
      message: `${claimedCriticals} item(s) marked critical, but the fleet has no critical alerts and no offline devices.`,
    });
  }

  if (bundle.attention.length === 0 && brief.needsAttention.length > 0) {
    findings.push({
      severity: "warn",
      message: `needsAttention has ${brief.needsAttention.length} item(s) but no devices were flagged in the bundle.`,
    });
  }

  const fails = findings.filter((f) => f.severity === "fail").length;
  return {
    grader: "severityGrounding",
    score: fails > 0 ? 0 : findings.length > 0 ? 0.7 : 1,
    passed: fails === 0,
    findings,
  };
};

/** Structural sanity that structured outputs alone does not guarantee. */
export const structuralSanity: Grader = (_bundle, brief) => {
  const findings: Finding[] = [];
  if (brief.headline.trim().length === 0) findings.push({ severity: "fail", message: "Empty headline." });
  if (brief.headline.length > 200)
    findings.push({ severity: "warn", message: `Headline is ${brief.headline.length} chars — too long to scan.` });
  if (brief.fleetState.trim().length < 20)
    findings.push({ severity: "fail", message: "fleetState is too short to be meaningful." });
  for (const item of brief.needsAttention) {
    if (!item.evidence.trim())
      findings.push({ severity: "fail", message: `"${item.device}" has no evidence.` });
  }
  const fails = findings.filter((f) => f.severity === "fail").length;
  return {
    grader: "structuralSanity",
    score: fails > 0 ? 0 : findings.length > 0 ? 0.8 : 1,
    passed: fails === 0,
    findings,
  };
};

export const ALL_GRADERS: Grader[] = [
  numericGrounding,
  gapDisclosure,
  noFalseHealthClaims,
  severityGrounding,
  structuralSanity,
];
