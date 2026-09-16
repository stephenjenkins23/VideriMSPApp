/**
 * `summary.byCause` — `node --test dist/intelligence/remediation.by-cause.test.js`
 *
 * US-8.6.3 asks the remediation summary to say WHY the set moved, and the only
 * way this can be got wrong while still looking right is by answering it without
 * a baseline. So the properties guarded here are the two shapes of lie:
 *
 *   1. **A zeroed map read as "nothing left the set".** With no prior read to
 *      diff against there is no departure count, and `{applied: 0, …}` is not
 *      the honest rendering of that — null with the reason and the recipe is.
 *      A bare GET of this endpoint is exactly that case, so it is the default.
 *
 *   2. **A tally that disagrees with the departures it claims to describe.**
 *      The block is FOLDED from the churn engine's own figure, never recounted,
 *      so the numbers here and the itemised `left` list on /api/trends/churn are
 *      the same count or the fold is broken.
 *
 * The cause ladder itself is not retested here — it is churn.test.ts's product.
 * What is tested is the seam: the fold, the null, and the fact that a breakdown
 * scoped to one `kind` never poses as a summary of the whole list.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BY_CAUSE_HOW_TO_GET,
  byCauseFromChurn,
  summarize,
  type DeviceView,
  type Recommendation,
  type RemediationByCause,
  type RemediationByCauseAvailable,
  type RemediationByCauseUnavailable,
} from "./remediation.js";
import {
  analyzeChurn,
  judgeObservation,
  observationFrom,
  type ChurnObservationVerdict,
  type PriorItem,
} from "./churn.js";

/** 09:00–17:00 America/New_York, so the two instants straddle the close. */
const MIDDAY = new Date("2026-08-28T16:00:00Z");
const AFTER_CLOSE = new Date("2026-08-28T22:00:00Z");

const device = (over: Partial<DeviceView> = {}): DeviceView => ({
  id: "dev-1",
  name: "Lobby North",
  status: "online",
  lastOnlineTime: "2026-08-28T15:55:00Z",
  city: "New York",
  groupId: null,
  site: null,
  firmwareCurrent: "7.0",
  firmwareBehind: false,
  screen: { isBlackScreen: false, showingLogo: false, nowPlayingId: "content-1" },
  telemetry: null,
  drift: [],
  brightnessRaw: 128,
  currentBrightnessRaw: 200,
  displayOn: true,
  brightnessScheduleEnabled: true,
  autoBrightnessEnabled: false,
  turnOnTime: "0900",
  turnOffTime: "1700",
  timezone: "America/New_York",
  ...over,
});

const rec = (id: string, over: Partial<Recommendation> = {}): Recommendation => ({
  id,
  deviceIds: [id.slice(0, id.indexOf("::"))],
  deviceLabel: "Lobby North",
  category: "display",
  symptom: "Display is dark inside its scheduled ON window.",
  action: "Restore brightness",
  rationale: "We hold the verified brightness write.",
  severity: "high",
  confidence: 0.9,
  kind: "auto-safe",
  ...over,
});

const fullyObserved = (from: Date, to: Date): ChurnObservationVerdict => {
  const starts: number[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += 300_000) starts.push(t);
  return judgeObservation(observationFrom(from.toISOString(), to.toISOString(), 300, starts));
};

/**
 * Narrowing assertions. The block is a discriminated union on purpose — the
 * available side has a baseline and a window and the unavailable side has a
 * reason, and nothing should be able to read a field the other variant does not
 * have — so a test that wants one side asserts its way in.
 */
const mustTally = (block: RemediationByCause): RemediationByCauseAvailable => {
  assert.equal(block.available, true, "expected a real tally");
  if (!block.available) throw new Error("unreachable");
  return block;
};

const mustRefuse = (block: RemediationByCause): RemediationByCauseUnavailable => {
  assert.equal(block.available, false, "expected an explained null");
  if (block.available) throw new Error("unreachable");
  return block;
};

const neverObserved = (from: Date, to: Date): ChurnObservationVerdict =>
  judgeObservation(observationFrom(from.toISOString(), to.toISOString(), 300, []));

const report = (
  previous: PriorItem[],
  current: Recommendation[],
  devices: DeviceView[],
  verdict = fullyObserved(MIDDAY, AFTER_CLOSE),
) =>
  analyzeChurn({
    previous: { observedAt: MIDDAY.toISOString(), items: previous },
    current: { observedAt: AFTER_CLOSE.toISOString(), recommendations: current },
    devices,
    kind: "auto-safe",
    verdict,
  });

// ─── the default: no baseline, so no number ──────────────────────────────────

test("a summary with no baseline reports byCause as an explained null, not a zeroed map", () => {
  const block = mustRefuse(summarize([rec("dev-1::display-off")]).byCause);

  assert.equal(block.value, null, "a map of zeros would read as 'nothing left'");
  assert.equal(block.problem, "no-baseline");
  assert.equal(block.baseline, null);
  assert.match(block.reason, /no baseline/i);
  assert.match(block.reason, /No recommendation snapshot is stored/);
  assert.match(block.reason, /not for lack of movement/);
});

test("the null says exactly what to send to turn it into a number", () => {
  const block = mustRefuse(summarize([]).byCause);
  assert.equal(block.howToGet, BY_CAUSE_HOW_TO_GET);
  assert.match(block.howToGet, /since=/);
  assert.match(block.howToGet, /previous=/);
  // A caller sending the whole list against `churnKind=auto-safe` would inflate
  // the `from` end of the movement, so the recipe warns about it.
  assert.match(block.howToGet, /Send only the ids of the set named by `churnKind`/);
  assert.match(block.howToGet, /\/api\/trends\/churn/);
});

test("the key is always present — an absent key cannot be told from nothing to say", () => {
  assert.ok("byCause" in summarize([]), "byCause is a field, not an optional extra");
});

// ─── the fold ────────────────────────────────────────────────────────────────

test("a real departure folds into a tally with its cause named", () => {
  // Inside its ON window when the caller looked, outside it now: the 20 → 2
  // cause from docs/25 GAP-7.
  const folded = mustTally(byCauseFromChurn(report([{ id: "dev-1::display-off" }], [], [device()])));

  assert.equal(folded.problem, null);
  assert.equal(folded.value["schedule-window-closed"], 1);
  assert.equal(folded.value.applied, 0, "nothing was fixed; the window closed");
  assert.equal(folded.kind, "auto-safe");
  assert.deepEqual(folded.movement, { from: 1, to: 0, net: -1 });
  assert.match(folded.headline, /schedule closed, not because they were fixed/);
});

test("the caller's read is carried as the caller's — attested, never verified", () => {
  const folded = mustTally(byCauseFromChurn(report([{ id: "dev-1::display-off" }], [], [device()])));
  assert.equal(folded.baseline.attestedBy, "caller");
  assert.equal(folded.baseline.observedAt, MIDDAY.toISOString());
  assert.equal(folded.baseline.count, 1);
});

test("the tally is the engine's own figure, so it cannot disagree with the itemised diff", () => {
  const churn = report(
    [{ id: "dev-1::display-off" }, { id: "dev-2::display-off" }],
    [],
    [device()],
  );
  const folded = mustTally(byCauseFromChurn(churn));

  // Same object, not a recount: the shallow `value` is there for the UI and must
  // never be a second, drifting count.
  assert.equal(folded.value, churn.byCause?.value);
  assert.equal(folded.figure, churn.byCause);
  const summed = Object.values(folded.value).reduce((a, b) => a + b, 0);
  assert.equal(summed, churn.left.length, "every departure is counted exactly once");
  assert.equal(folded.figure.coverage.inScope, churn.left.length);
  // dev-2 is not in the fleet at all, which is a different fact from a screen we
  // cannot reach — and the fold must carry the distinction, not flatten it.
  assert.equal(folded.value["device-retired"], 1);
});

test("the window we measured it under travels with the figure", () => {
  const folded = mustTally(byCauseFromChurn(report([{ id: "dev-1::display-off" }], [], [device()])));
  assert.equal(folded.window.clearsGates, true);
  assert.equal(folded.window.observation.collectorCoverage, 1);
  assert.match(folded.figure.coverage.note, /named a device- or schedule-level cause for 1 of 1/);
});

// ─── the refusals ────────────────────────────────────────────────────────────

test("a window we watched not at all yields null with the collector's own reason", () => {
  const folded = mustRefuse(
    byCauseFromChurn(
      report([{ id: "dev-1::display-off" }], [], [device()], neverObserved(MIDDAY, AFTER_CLOSE)),
    ),
  );

  assert.equal(folded.value, null, "zeros here would turn our blind spot into good news");
  assert.equal(folded.problem, "unobserved-window");
  assert.match(folded.reason, /No device reported at all between the two reads/);
  assert.match(folded.reason, /gap in OUR collection, not a quiet fleet/);
});

// ─── scope: a breakdown of one set is not a summary of the list ──────────────

test("byCause is scoped to one kind while the summary totals the whole list", () => {
  const recs = [
    rec("dev-1::display-off"),
    rec("dev-9::storage-full", { kind: "manual", category: "telemetry" }),
  ];
  const summary = summarize(
    recs,
    byCauseFromChurn(report([{ id: "dev-1::display-off" }], recs, [device()])),
  );

  assert.equal(summary.total, 2, "the list is never filtered by asking about churn");
  assert.equal(summary.byKind["auto-safe"], 1);
  assert.equal(summary.byKind.manual, 1);
  const block = mustTally(summary.byCause);
  // The manual item is neither in the movement nor in the tally: `from`/`to`
  // count the auto-safe set only, which is what `kind` declares.
  assert.equal(block.kind, "auto-safe");
  assert.deepEqual(block.movement, { from: 1, to: 1, net: 0 });
  assert.equal(Object.values(block.value).reduce((a, b) => a + b, 0), 0);
});
