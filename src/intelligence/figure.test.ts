/**
 * The shared `Figure<T>` wrapper — `node --test dist/intelligence/figure.test.js`
 *
 * This file exists because the wrapper used to exist three times (once in
 * `routes/reports.ts`, once copied into `churn.ts`, once surfaced again through
 * the remediation summary) and nothing tested the wrapper itself — only payloads
 * that happened to contain one. So a divergence between the copies could only be
 * caught by whichever payload test noticed first, and a field added to one copy
 * and not the other would have been caught by nothing at all.
 *
 * What is pinned here is the invariant the whole wrapper exists for: a number
 * never arrives without its denominator, and the "could not be measured" case is
 * words, never a zero. Pure; no pool, no clock.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFigureOf, type Figure } from "./figure.js";

/** Two vocabularies, because the whole point of the parameter is that they differ. */
type ReportUnit = "screens" | "time-buckets";
const reportFigure = makeFigureOf<ReportUnit>({
  screens: "screen(s)",
  "time-buckets": "time bucket(s) of the window",
});

type ChurnUnit = "recommendations" | "time-buckets";
const churnishFigure = makeFigureOf<ChurnUnit>({
  recommendations: "recommendation(s)",
  "time-buckets": "time bucket(s) of the window between the two reads",
});

test("a figure carries its value, its basis and the coverage it was measured under", () => {
  const f = reportFigure(142, "Presence buckets from health_samples.", 142, 248, "screens");
  assert.equal(f.value, 142);
  assert.equal(f.basis, "Presence buckets from health_samples.");
  assert.deepEqual(Object.keys(f), ["value", "basis", "coverage"]);
  assert.deepEqual(Object.keys(f.coverage), ["measured", "inScope", "unit", "share", "note"]);
  assert.equal(f.coverage.measured, 142);
  assert.equal(f.coverage.inScope, 248);
  assert.equal(f.coverage.unit, "screens");
});

test("share is measured/inScope to four places — and null, never 0, when nothing is in scope", () => {
  assert.equal(reportFigure(1, "b", 142, 248, "screens").coverage.share, 0.5726);
  assert.equal(reportFigure(1, "b", 1, 3, "screens").coverage.share, 0.3333);
  // The honest-nulls rule at the arithmetic level: 0/0 is unknown, and a 0 here
  // would read as "we measured nothing of a real population".
  assert.equal(reportFigure(0, "b", 0, 0, "screens").coverage.share, null);
});

test("a partial measurement says so in words, and says the remainder is not counted as zero", () => {
  const note = reportFigure(1, "b", 142, 248, "screens").coverage.note;
  assert.match(note, /Computed from 142 of 248 screen\(s\) in scope/);
  assert.match(note, /the other 106 could not be measured/);
  assert.match(note, /never counted as zero/);
});

test("a complete measurement and an empty scope each get their own sentence", () => {
  assert.equal(
    reportFigure(1, "b", 248, 248, "screens").coverage.note,
    "Computed from all 248 screen(s) in scope.",
  );
  assert.equal(
    reportFigure(1, "b", 0, 0, "screens").coverage.note,
    "There are no screen(s) in scope, so there was nothing to measure.",
  );
});

test("an explicit note wins — a caller with a better sentence is not overruled", () => {
  const f = reportFigure(1, "b", 1, 2, "screens", "Only the 1 screen with a snapshot could say.");
  assert.equal(f.coverage.note, "Only the 1 screen with a snapshot could say.");
});

test("the unit vocabulary is the caller's: the same code labels differently per domain", () => {
  // This is why the vocabulary stayed local when the wrapper was lifted. The
  // report's window and the window between two churn reads are different things,
  // so welding the two labels into one union would have rewritten payload text.
  assert.match(
    reportFigure(1, "b", 3, 4, "time-buckets").coverage.note,
    /time bucket\(s\) of the window in scope/,
  );
  assert.match(
    churnishFigure(1, "b", 3, 4, "time-buckets").coverage.note,
    /time bucket\(s\) of the window between the two reads in scope/,
  );
});

test("the value is carried unchanged, whatever shape it is", () => {
  const tally: Figure<Record<string, number>, ChurnUnit> = churnishFigure(
    { applied: 0, superseded: 2 },
    "b",
    2,
    2,
    "recommendations",
  );
  assert.deepEqual(tally.value, { applied: 0, superseded: 2 });
  // A null value is a legitimate figure: "we could not read this, and here is
  // the coverage that explains why" is the case the wrapper was built for.
  assert.equal(reportFigure(null, "b", 0, 248, "screens").value, null);
});
