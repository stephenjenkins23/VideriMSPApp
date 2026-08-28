/**
 * The AI eval harness.
 *
 * LLM output is non-deterministic, so a single pass proves nothing. Every case
 * runs N times and we report a **pass rate**, not a pass. Safety graders are
 * required to pass on every repetition — a check that fails one run in five is a
 * check that fails in production.
 *
 * Results are written to a baseline file so successive releases can be compared,
 * which is what turns this from a test into regression protection.
 */

import Anthropic from "@anthropic-ai/sdk";
import { generateFleetBrief, type FleetBrief } from "../ai/brief.js";
import { ALL_GRADERS, type GraderResult } from "./graders.js";
import { EVAL_CASES, type EvalCase } from "./fixtures.js";
import { judgeBrief, judgeMean, type Judgement } from "./judge.js";

export interface RepetitionResult {
  repetition: number;
  brief?: FleetBrief;
  graders: GraderResult[];
  expectationFailures: string[];
  judgement?: Judgement;
  error?: string;
}

export interface CaseResult {
  name: string;
  why: string;
  repetitions: RepetitionResult[];
  /** Per-grader pass rate across repetitions, 0–1. */
  graderPassRates: Record<string, number>;
  /** Mean judge score across repetitions, if the judge ran. */
  judgeMean: number | null;
  /** True only if every must-pass grader passed on every repetition. */
  passed: boolean;
  failureSummary: string[];
}

export interface EvalReport {
  ranAt: string;
  model: string;
  repetitions: number;
  judged: boolean;
  cases: CaseResult[];
  passed: boolean;
  totals: { cases: number; casesPassed: number; graderRuns: number; graderFailures: number };
}

export interface RunOptions {
  repetitions?: number;
  judge?: boolean;
  cases?: EvalCase[];
  client?: Anthropic;
  onProgress?: (message: string) => void;
}

export async function runEvals({
  repetitions = 3,
  judge = false,
  cases = EVAL_CASES,
  client = new Anthropic(),
  onProgress = () => {},
}: RunOptions = {}): Promise<EvalReport> {
  const results: CaseResult[] = [];
  let graderRuns = 0;
  let graderFailures = 0;

  for (const evalCase of cases) {
    onProgress(`▶ ${evalCase.name}`);
    const reps: RepetitionResult[] = [];

    for (let i = 1; i <= repetitions; i++) {
      try {
        const { brief } = await generateFleetBrief(evalCase.bundle, { client });
        const graders = ALL_GRADERS.map((g) => g(evalCase.bundle, brief));
        const expectationFailures = evalCase.expect?.(brief) ?? [];
        const judgement = judge ? await judgeBrief(evalCase.bundle, brief, client) : undefined;

        reps.push({
          repetition: i,
          brief,
          graders,
          expectationFailures,
          ...(judgement ? { judgement } : {}),
        });

        const failed = graders.filter((g) => !g.passed).map((g) => g.grader);
        onProgress(
          `    rep ${i}/${repetitions} — ${failed.length === 0 ? "clean" : `failed: ${failed.join(", ")}`}` +
            `${expectationFailures.length > 0 ? ` | expectations: ${expectationFailures.length}` : ""}`,
        );
      } catch (error) {
        reps.push({
          repetition: i,
          graders: [],
          expectationFailures: [],
          error: (error as Error).message,
        });
        onProgress(`    rep ${i}/${repetitions} — ERROR: ${(error as Error).message}`);
      }
    }

    results.push(summariseCase(evalCase, reps, (runs, failures) => {
      graderRuns += runs;
      graderFailures += failures;
    }));
  }

  const casesPassed = results.filter((c) => c.passed).length;
  return {
    ranAt: new Date().toISOString(),
    model: "claude-opus-5",
    repetitions,
    judged: judge,
    cases: results,
    passed: casesPassed === results.length,
    totals: { cases: results.length, casesPassed, graderRuns, graderFailures },
  };
}

function summariseCase(
  evalCase: EvalCase,
  reps: RepetitionResult[],
  tally: (runs: number, failures: number) => void,
): CaseResult {
  const graderNames = [...new Set(reps.flatMap((r) => r.graders.map((g) => g.grader)))];
  const graderPassRates: Record<string, number> = {};
  const failureSummary: string[] = [];

  for (const name of graderNames) {
    const runs = reps.map((r) => r.graders.find((g) => g.grader === name)).filter(Boolean) as GraderResult[];
    const passes = runs.filter((g) => g.passed).length;
    graderPassRates[name] = runs.length === 0 ? 0 : passes / runs.length;
    tally(runs.length, runs.length - passes);

    if (evalCase.mustPass.includes(name) && passes < runs.length) {
      const examples = runs
        .flatMap((g) => g.findings)
        .filter((f) => f.severity === "fail")
        .slice(0, 3)
        .map((f) => f.message);
      failureSummary.push(
        `${name} passed only ${passes}/${runs.length} repetitions` +
          (examples.length > 0 ? ` — e.g. ${examples.join(" | ")}` : ""),
      );
    }
  }

  for (const rep of reps) {
    if (rep.error) failureSummary.push(`rep ${rep.repetition} errored: ${rep.error}`);
    for (const failure of rep.expectationFailures) {
      failureSummary.push(`rep ${rep.repetition} expectation: ${failure}`);
    }
  }

  const judgements = reps.map((r) => r.judgement).filter(Boolean) as Judgement[];
  const judgeAvg =
    judgements.length === 0
      ? null
      : judgements.reduce((sum, j) => sum + judgeMean(j), 0) / judgements.length;

  // Safety graders must be clean on EVERY repetition — a 4/5 pass rate on
  // "did not invent numbers" is a failure, not a good score.
  const mustPassClean = evalCase.mustPass.every((name) => (graderPassRates[name] ?? 0) === 1);
  const noErrors = reps.every((r) => !r.error);
  const noExpectationFailures = reps.every((r) => r.expectationFailures.length === 0);

  return {
    name: evalCase.name,
    why: evalCase.why,
    repetitions: reps,
    graderPassRates,
    judgeMean: judgeAvg,
    passed: mustPassClean && noErrors && noExpectationFailures,
    failureSummary,
  };
}

/** Human-readable report. */
export function renderReport(report: EvalReport): string {
  const lines: string[] = [
    "",
    "═".repeat(78),
    `AI EVAL REPORT — ${report.model} — ${report.repetitions} repetition(s) per case`,
    `${report.ranAt}${report.judged ? " — judge enabled" : ""}`,
    "═".repeat(78),
    "",
  ];

  for (const c of report.cases) {
    lines.push(`${c.passed ? "PASS" : "FAIL"}  ${c.name}`);
    const rates = Object.entries(c.graderPassRates)
      .map(([n, r]) => `${n} ${(r * 100).toFixed(0)}%`)
      .join("   ");
    if (rates) lines.push(`      ${rates}`);
    if (c.judgeMean !== null) lines.push(`      judge mean ${c.judgeMean.toFixed(2)}/5`);
    for (const f of c.failureSummary) lines.push(`      ! ${f}`);
    lines.push("");
  }

  const { cases, casesPassed, graderRuns, graderFailures } = report.totals;
  lines.push(
    "─".repeat(78),
    `${casesPassed}/${cases} cases passed · ${graderRuns - graderFailures}/${graderRuns} grader runs clean`,
    report.passed ? "RESULT: PASS" : "RESULT: FAIL",
    "",
  );
  return lines.join("\n");
}

/** Compare against a stored baseline so a release cannot silently regress. */
export function compareToBaseline(
  current: EvalReport,
  baseline: EvalReport,
): { regressed: boolean; notes: string[] } {
  const notes: string[] = [];

  for (const c of current.cases) {
    const before = baseline.cases.find((b) => b.name === c.name);
    if (!before) {
      notes.push(`NEW case "${c.name}" — no baseline to compare.`);
      continue;
    }
    if (before.passed && !c.passed) notes.push(`REGRESSION: "${c.name}" passed in baseline, fails now.`);

    for (const [grader, rate] of Object.entries(c.graderPassRates)) {
      const prior = before.graderPassRates[grader];
      if (prior !== undefined && rate < prior - 0.001) {
        notes.push(
          `REGRESSION: "${c.name}" / ${grader} ${(prior * 100).toFixed(0)}% → ${(rate * 100).toFixed(0)}%.`,
        );
      }
    }

    if (c.judgeMean !== null && before.judgeMean !== null && c.judgeMean < before.judgeMean - 0.35) {
      notes.push(
        `Judge score dropped on "${c.name}": ${before.judgeMean.toFixed(2)} → ${c.judgeMean.toFixed(2)}. ` +
          `Judge scores are noisy — read the output before treating this as real.`,
      );
    }
  }

  return { regressed: notes.some((n) => n.startsWith("REGRESSION")), notes };
}
