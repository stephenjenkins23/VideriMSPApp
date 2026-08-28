/**
 * AI eval CLI.
 *
 *   npm run eval                      # 3 repetitions, graders only
 *   npm run eval -- --reps 5 --judge  # add LLM-as-judge
 *   npm run eval -- --save-baseline   # record the current result as the baseline
 *
 * Exits non-zero on failure or regression, so it can gate a release.
 * Requires an Anthropic credential; the graders themselves are unit-tested
 * separately in graders.test.ts and need no credential.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { runEvals, renderReport, compareToBaseline, type EvalReport } from "./harness.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};

const BASELINE = "eval-baseline.json";

const report = await runEvals({
  repetitions: value("reps", 3),
  judge: flag("judge"),
  onProgress: (m) => console.log(m),
});

console.log(renderReport(report));

let regressed = false;
if (existsSync(BASELINE)) {
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as EvalReport;
  const comparison = compareToBaseline(report, baseline);
  regressed = comparison.regressed;
  if (comparison.notes.length > 0) {
    console.log("BASELINE COMPARISON");
    for (const note of comparison.notes) console.log(`  ${note}`);
    console.log("");
  } else {
    console.log("No change against baseline.\n");
  }
} else {
  console.log(`No ${BASELINE} found — run with --save-baseline to establish one.\n`);
}

if (flag("save-baseline")) {
  writeFileSync(BASELINE, JSON.stringify(report, null, 2));
  console.log(`Baseline written to ${BASELINE}.\n`);
}

process.exit(report.passed && !regressed ? 0 : 1);
