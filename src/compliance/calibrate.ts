/**
 * Template calibration — derive expected values from what the fleet actually does.
 *
 * WHY THIS EXISTS
 * The first templates were written from the product document and scored 61%
 * average with 109 of 110 devices non-compliant. Investigating showed the fleet
 * was fine and the template was wrong in three ways: it assumed retail hours
 * (105 of 110 devices power off at 05:00), it assumed a power schedule was
 * enabled (103 of 110 have it off), and — a genuine scale error — it templated
 * brightness at 85 on a 0–100 scale when the device reports brightness on a
 * **0–255** scale with a fleet median of 107.
 *
 * A compliance score that flags 99% of the fleet is worse than no score: nobody
 * reads it twice. So templates must be calibrated against observed reality first,
 * and only then deliberately tightened where policy differs from practice.
 *
 * This module proposes a baseline; a human decides what to enforce. Calibration
 * describes what IS, policy declares what SHOULD BE, and the two must be
 * distinguishable — otherwise "compliance" just means "unchanged", which detects
 * nothing.
 */

import type { ComplianceCheck, Comparator } from "./templates.js";

export interface FieldDistribution {
  field: string;
  observed: number;
  distinct: number;
  /** Most common value and its share of the sample, 0–1. */
  modeValue: string | null;
  modeShare: number;
  /** For numeric fields. */
  min: number | null;
  max: number | null
  median: number | null;
  /** Every distinct value with its count, capped for readability. */
  values: Array<{ value: string; count: number }>;
}

export interface CalibrationProposal {
  field: string;
  /** What the fleet does now. */
  distribution: FieldDistribution;
  /** Suggested comparator derived from the distribution. */
  suggested: Comparator | null;
  /** Share of devices that would pass the suggestion, 0–1. */
  wouldPass: number;
  /**
   * How much of the fleet agrees on this setting. Low consensus means either
   * genuine variation by site — in which case it is a poor compliance check —
   * or real drift worth investigating.
   */
  consensus: "strong" | "weak" | "none";
  recommendation: string;
}

const NUMERIC_FIELDS = new Set([
  "brightness", "current_brightness", "color_saturation", "volume",
  "storage_target_free_percent", "storage_max_percent", "framerate",
  "color_table_offsets.r", "color_table_offsets.g", "color_table_offsets.b",
]);

export function describeDistribution(field: string, values: unknown[]): FieldDistribution {
  const present = values
    .filter((v) => v !== null && v !== undefined && v !== "" && v !== "unavailable")
    .map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v)));

  const counts = new Map<string, number>();
  for (const v of present) counts.set(v, (counts.get(v) ?? 0) + 1);

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const mode = sorted[0];

  const numeric = NUMERIC_FIELDS.has(field)
    ? present.map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
    : [];

  return {
    field,
    observed: present.length,
    distinct: counts.size,
    modeValue: mode?.[0] ?? null,
    modeShare: present.length === 0 ? 0 : (mode?.[1] ?? 0) / present.length,
    min: numeric.length > 0 ? numeric[0]! : null,
    max: numeric.length > 0 ? numeric[numeric.length - 1]! : null,
    median: numeric.length > 0 ? numeric[Math.floor(numeric.length / 2)]! : null,
    values: sorted.slice(0, 8).map(([value, count]) => ({ value, count })),
  };
}

/** Consensus thresholds — how much agreement makes a field worth enforcing. */
const STRONG = 0.9;
const WEAK = 0.6;

export function proposeCheck(dist: FieldDistribution): CalibrationProposal {
  const consensus: CalibrationProposal["consensus"] =
    dist.modeShare >= STRONG ? "strong" : dist.modeShare >= WEAK ? "weak" : "none";

  if (dist.observed === 0) {
    return {
      field: dist.field,
      distribution: dist,
      suggested: null,
      wouldPass: 0,
      consensus: "none",
      recommendation:
        `No device reported "${dist.field}". Do not build a check on it — an ` +
        `unreadable field yields notApplicable for every device and adds noise ` +
        `without adding signal.`,
    };
  }

  // Numeric with real spread → a band around the median, not the mode.
  if (dist.median !== null && dist.distinct > 3) {
    const spread = (dist.max ?? 0) - (dist.min ?? 0);
    // Tolerance scales with observed spread: a tight fleet gets a tight band.
    const tolerance = Math.max(5, Math.round(spread * 0.15));
    const suggested: Comparator = {
      kind: "range",
      min: dist.median - tolerance,
      max: dist.median + tolerance,
    };
    const inBand = dist.values.filter((v) => {
      const n = Number(v.value);
      return Number.isFinite(n) && n >= suggested.min && n <= suggested.max;
    });
    const passCount = inBand.reduce((s, v) => s + v.count, 0);
    return {
      field: dist.field,
      distribution: dist,
      suggested,
      wouldPass: passCount / dist.observed,
      consensus,
      recommendation:
        `Observed ${dist.min}–${dist.max}, median ${dist.median} across ${dist.observed} devices. ` +
        `Suggested band ${suggested.min}–${suggested.max}. ` +
        (spread > (dist.median || 1)
          ? `NOTE the wide spread — confirm the scale before enforcing (this field ` +
            `was previously mis-templated on a 0–100 assumption when the device ` +
            `reports 0–255).`
          : `Tighten deliberately if policy demands a narrower range.`),
    };
  }

  // Categorical / boolean → the modal value, if consensus supports it.
  const suggested: Comparator =
    dist.modeValue === "true" || dist.modeValue === "false"
      ? { kind: "equals", value: dist.modeValue === "true" }
      : { kind: "equals", value: dist.modeValue ?? "" };

  return {
    field: dist.field,
    distribution: dist,
    suggested: consensus === "none" ? null : suggested,
    wouldPass: dist.modeShare,
    consensus,
    recommendation:
      consensus === "strong"
        ? `${Math.round(dist.modeShare * 100)}% of devices report "${dist.modeValue}". ` +
          `Safe baseline — deviation is genuine drift.`
        : consensus === "weak"
          ? `Only ${Math.round(dist.modeShare * 100)}% agree on "${dist.modeValue}" ` +
            `(${dist.distinct} distinct values). Enforce only if this is a policy ` +
            `decision rather than site-by-site variation.`
          : `No consensus — ${dist.distinct} distinct values, top is only ` +
            `${Math.round(dist.modeShare * 100)}%. This field varies legitimately by ` +
            `site; a compliance check here would flag most of the fleet for nothing.`,
  };
}

/** Every field worth profiling, drawn from real payloads rather than a guess. */
export const CALIBRATION_FIELDS = [
  "timezone", "turn_on_time", "turn_off_time", "auto_on_off_enabled",
  "daily_reboot_enabled", "daily_reboot_time", "display_on",
  "brightness", "auto_brightness_enabled", "brightness_schedule_enabled",
  "color_saturation", "color_table_offsets.r", "color_table_offsets.g",
  "color_table_offsets.b", "volume", "current_source", "source_auto_switch",
  "cec_enabled", "custom_logo", "storage_target_free_percent", "storage_max_percent",
  "default_scale_type", "current_audio_output",
] as const;

export function calibrate(
  snapshots: Array<Record<string, unknown>>,
  fields: readonly string[] = CALIBRATION_FIELDS,
): CalibrationProposal[] {
  const read = (obj: unknown, path: string): unknown => {
    let node: unknown = obj;
    for (const seg of path.split(".")) {
      if (node === null || typeof node !== "object") return undefined;
      node = (node as Record<string, unknown>)[seg];
    }
    return node;
  };

  return fields
    .map((field) => proposeCheck(describeDistribution(field, snapshots.map((s) => read(s, field)))))
    .sort((a, b) => b.distribution.observed - a.distribution.observed);
}

/** Turn accepted proposals into checks, preserving the existing metadata. */
export function applyProposals(
  checks: ComplianceCheck[],
  proposals: CalibrationProposal[],
): ComplianceCheck[] {
  const byField = new Map(proposals.filter((p) => p.suggested).map((p) => [p.field, p.suggested!]));
  return checks.map((c) => (byField.has(c.field) ? { ...c, expected: byField.get(c.field)! } : c));
}
