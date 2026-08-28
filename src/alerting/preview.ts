/**
 * Rule preview — answer "what would this threshold actually do?" before saving.
 *
 * The hardest part of configurable alerting is not the editor, it is confidence.
 * A threshold typed blind either floods the queue or fires never, and the operator
 * discovers which at 3am. So a candidate rule is evaluated against the real
 * current fleet, in memory, persisting nothing.
 *
 * This also catches the specific mistake that produced a useless compliance score
 * earlier in the project: a threshold that matches almost the whole fleet is not
 * a detector, it is a definition.
 */

import type { Repository } from "../db/repository.js";
import { evaluateRule } from "./evaluate.js";
import { validateRule, type AlertRule } from "./rules.js";
import { requiredWindowSeconds } from "./rules.js";
import type { DeviceRow, SampleRow } from "./evaluate.js";

export interface RulePreview {
  ruleId: string;
  valid: boolean;
  problems: string[];
  devicesEvaluated: number;
  wouldFire: number;
  /**
   * Devices whose input for this rule does not exist, so the rule could not be
   * judged either way. Distinct from `heldBelowThreshold` — see Verdict.unreadable.
   */
  notJudgeable: number;
  /** Devices that WERE judged and simply did not meet the threshold. */
  heldBelowThreshold: number;
  /** Most common reason among devices that did not fire, whatever the category. */
  topSkipReason: string | null;
  /** Share of the fleet that would fire, 0–1. */
  fireRate: number;
  /** Verdict on whether this is a useful detector. */
  assessment: string;
  /** A handful of concrete examples, with their evidence. */
  examples: Array<{ device: string; evidence: string }>;
}

export async function previewRule(repo: Repository, rule: AlertRule): Promise<RulePreview> {
  const problems = validateRule(rule);
  if (problems.length > 0) {
    return {
      ruleId: rule.id, valid: false, problems, devicesEvaluated: 0, wouldFire: 0,
      notJudgeable: 0, heldBelowThreshold: 0, topSkipReason: null, fireRate: 0,
      assessment: "Rule is invalid and was not evaluated.", examples: [],
    };
  }

  const input = await repo.loadEvaluationInput(requiredWindowSeconds([rule]), 240);
  const now = new Date();
  let fire = 0, unreadable = 0, belowThreshold = 0;
  const reasons = new Map<string, number>();
  const examples: Array<{ device: string; evidence: string }> = [];

  for (const [, entry] of input) {
    const verdict = evaluateRule(rule, {
      device: entry.device as DeviceRow,
      samples: entry.samples as SampleRow[],
      now,
    });
    if (verdict.firing) {
      fire += 1;
      if (examples.length < 5) {
        examples.push({ device: entry.device.name ?? entry.device.id, evidence: verdict.evidence });
      }
    } else {
      // The critical distinction: a device with no readable input was never
      // judged, whereas a device that was judged and came back fine is real
      // evidence of health. Counting them together would let a structurally
      // dead rule look like a quiet, healthy fleet.
      if (verdict.unreadable) unreadable += 1;
      else belowThreshold += 1;
      if (verdict.skipped) reasons.set(verdict.skipped, (reasons.get(verdict.skipped) ?? 0) + 1);
    }
  }

  const total = input.size;
  const rate = total === 0 ? 0 : fire / total;
  const topSkip = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  // Thresholds chosen from experience on this fleet, not arbitrary.
  let assessment: string;
  if (total === 0) {
    assessment = "No devices to evaluate.";
  } else if (fire === 0 && unreadable === total) {
    assessment =
      "Fires on nothing, and no device could even be judged — the input this rule " +
      "reads is unavailable. This rule will stay permanently silent.";
  } else if (fire === 0 && unreadable > 0) {
    assessment =
      `Fires on nothing right now, and ${unreadable} of ${total} devices cannot be ` +
      `judged at all because this rule's input is missing on them. Coverage, not ` +
      `health — do not read this as ${total} devices being fine.`;
  } else if (fire === 0) {
    assessment =
      `Fires on nothing, and all ${total} devices were genuinely judged. The fleet ` +
      `is clean on this condition — or the threshold is set beyond reach.`;
  } else if (rate > 0.5) {
    assessment =
      `Fires on ${Math.round(rate * 100)}% of the fleet. That is a definition, not a ` +
      `detector — an alert most devices trigger gets muted. Consider tightening it, ` +
      `or treating it as a policy target scored separately.`;
  } else if (rate > 0.2) {
    assessment =
      `Fires on ${Math.round(rate * 100)}% of the fleet — high. Reasonable for a ` +
      `rollout backlog, noisy as a page.`;
  } else {
    assessment = `Fires on ${fire} of ${total} devices. A usable detector.`;
  }

  return {
    ruleId: rule.id, valid: true, problems: [],
    devicesEvaluated: total, wouldFire: fire, notJudgeable: unreadable,
    heldBelowThreshold: belowThreshold,
    topSkipReason: topSkip, fireRate: Number(rate.toFixed(4)),
    assessment, examples,
  };
}
