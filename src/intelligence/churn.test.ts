/**
 * Churn engine tests — `node --test dist/intelligence/churn.test.js`
 *
 * The cause ladder IS the product here, so every rung is tested directly, and
 * three classes of test carry the rest of the file:
 *
 *   1. **Every departure cause, one test each, in ladder order.** A ladder whose
 *      rungs are only ever exercised together cannot be shown to be ordered, and
 *      the order is a claim: "we cannot see it" must outrank every inference
 *      drawn from facts we cannot refresh, and `applied` — the only cause that
 *      asserts the world improved — must be reachable ONLY when everything
 *      cheaper has been tried.
 *
 *   2. **A gap in our own collection must never become good news.** A window
 *      straddling a real measured collector hole (the 2h05m one on 2026-08-28,
 *      taken from the live `vfi` database) must degrade `applied` to
 *      `unobserved-window`, and a window we watched not at all must refuse
 *      attribution outright with `byCause: null` — never a map of zeros.
 *
 *   3. **The watermark boundary in both directions.** An item already in the set
 *      AT the watermark is not new; a reading stamped exactly AT the watermark
 *      does not date an arrival; a missing watermark yields a labelled full set
 *      with a NULL new-count; and every other malformed watermark is refused
 *      rather than defaulted, because a defaulted watermark reports the entire
 *      queue as new.
 *
 * Plus the count invariant this codebase has broken three times: `byCause` must
 * be counted over exactly the `left` array beside it, and `movement.from` over
 * exactly the filtered prior set.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHURN_GATES,
  analyzeChurn,
  buildFirstLook,
  judgeObservation,
  judgeWatermark,
  observationFrom,
  type ChurnObservationVerdict,
  type PriorItem,
} from "./churn.js";
import type { DeviceView, Recommendation } from "./remediation.js";

/**
 * Fixed instants against a 09:00–17:00 America/New_York schedule, so nothing
 * here depends on when the suite runs.
 *
 *   BEFORE_OPEN  07:00 EDT — outside the ON window
 *   MIDDAY       12:00 EDT — inside
 *   AFTER_CLOSE  18:00 EDT — outside
 */
const BEFORE_OPEN = new Date("2026-08-28T11:00:00Z");
const MIDDAY = new Date("2026-08-28T16:00:00Z");
const AFTER_CLOSE = new Date("2026-08-28T22:00:00Z");

/** A reachable device with everything readable and a lit panel. */
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
  telemetry: {
    observedAt: "2026-08-28T15:00:00Z",
    cpuPercent: 20,
    ramUsedPercent: 40,
    storageUsedPercent: 55,
    rssiDbm: -50,
    ntpOffsetMs: 2,
  },
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

/** Live evidence of a dark panel — the only thing a display rule may fire on. */
const DARK = { currentBrightnessRaw: 0, displayOn: false } as const;

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

const prior = (id: string, over: Partial<PriorItem> = {}): PriorItem => ({ id, ...over });

/** A window we watched completely: every bucket present. */
const fullyObserved = (from: Date, to: Date, bucketSeconds = 300): ChurnObservationVerdict => {
  const starts: number[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += bucketSeconds * 1000) starts.push(t);
  return judgeObservation(
    observationFrom(from.toISOString(), to.toISOString(), bucketSeconds, starts),
  );
};

/** A window we did not watch at all. */
const neverObserved = (from: Date, to: Date): ChurnObservationVerdict =>
  judgeObservation(observationFrom(from.toISOString(), to.toISOString(), 300, []));

const churn = (
  args: {
    previous: PriorItem[];
    current: Recommendation[];
    devices: DeviceView[];
    verdict?: ChurnObservationVerdict;
    from?: Date;
    to?: Date;
  },
) => {
  const from = args.from ?? MIDDAY;
  const to = args.to ?? AFTER_CLOSE;
  return analyzeChurn({
    previous: { observedAt: from.toISOString(), items: args.previous },
    current: { observedAt: to.toISOString(), recommendations: args.current },
    devices: args.devices,
    kind: "auto-safe",
    verdict: args.verdict ?? fullyObserved(from, to),
  });
};

// ─── window observation: the arithmetic that decides what we may claim ───────

test("observationFrom counts only buckets inside the window, half-open at the top", () => {
  const from = new Date("2026-08-28T12:00:00Z");
  const to = new Date("2026-08-28T13:00:00Z");
  const observation = observationFrom(from.toISOString(), to.toISOString(), 300, [
    from.getTime() - 300_000, // before the window
    from.getTime(), // the lower bound is inside
    to.getTime(), // the upper bound is NOT
  ]);
  assert.equal(observation.expectedBuckets, 12);
  assert.equal(observation.observedBuckets, 1, "one bucket, not three");
});

test("the gap is measured from the window edges, not only between readings", () => {
  const from = new Date("2026-08-28T12:00:00Z");
  const to = new Date("2026-08-28T16:00:00Z");
  // One reading, three hours in: a between-readings-only detector would score
  // this as perfect continuity because there is no pair to compare.
  const observation = observationFrom(from.toISOString(), to.toISOString(), 300, [
    from.getTime() + 3 * 3600_000,
  ]);
  assert.equal(observation.longestGapSeconds, 3 * 3600);
  assert.equal(judgeObservation(observation).clearsGates, false);
});

test("the TRAILING edge counts too — collection that stopped mid-window is a blind run", () => {
  // This is the live shape of this deployment: the collector stopped on
  // 2026-09-04 and any window reaching "now" is blind at its far end. A gap
  // detector that only looked backwards from the last reading would score the
  // stoppage as perfect continuity right up to the moment it quit.
  const from = new Date("2026-08-28T12:00:00Z");
  const to = new Date("2026-08-28T16:00:00Z");
  const starts: number[] = [];
  for (let t = from.getTime(); t < from.getTime() + 3600_000; t += 300_000) starts.push(t);
  const observation = observationFrom(from.toISOString(), to.toISOString(), 300, starts);
  assert.equal(observation.observedBuckets, 12);
  assert.equal(observation.longestGapSeconds, 3 * 3600, "the three hours after we stopped");
  assert.equal(judgeObservation(observation).clearsGates, false);
});

test("a window nobody observed is BLIND, and blind refuses attribution rather than zeroing it", () => {
  const verdict = neverObserved(MIDDAY, AFTER_CLOSE);
  assert.equal(verdict.blind, true);
  assert.equal(verdict.clearsGates, false);
  assert.match(verdict.reason ?? "", /No device reported at all/);
  assert.match(verdict.reason ?? "", /not a quiet fleet/);

  const report = churn({
    previous: [prior("dev-1::display-off")],
    current: [],
    devices: [device()],
    verdict,
  });
  assert.equal(report.byCause, null, "null, never a map of zeros");
  assert.equal(report.byArrivalCause, null);
  assert.equal(report.left[0]?.cause, null);
  assert.match(report.left[0]?.blockedBy ?? "", /No device reported at all/);
  assert.match(report.headline, /we will not say why/);
});

test("a window straddling the measured 2026-08-28 collector hole degrades `applied`, never interpolates", () => {
  // The real hole, from the live `vfi` database: no device reported between
  // 10:45 and 12:50 America/New_York on 2026-08-28 (7,500s).
  const from = new Date("2026-08-28T14:00:00Z"); // 10:00 EDT
  const to = new Date("2026-08-28T18:00:00Z"); // 14:00 EDT
  const holeStart = new Date("2026-08-28T14:45:00Z").getTime();
  const holeEnd = new Date("2026-08-28T16:50:00Z").getTime();
  const starts: number[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += 300_000) {
    if (t >= holeStart && t < holeEnd) continue;
    starts.push(t);
  }
  const verdict = judgeObservation(observationFrom(from.toISOString(), to.toISOString(), 300, starts));
  assert.equal(verdict.blind, false, "we did look, just not throughout");
  assert.equal(verdict.clearsGates, false);
  assert.equal(verdict.observation.longestGapSeconds, 7_500, "the real 2h05m hole");

  // A device whose symptom has cleared. Without the gate this reads `applied`.
  const report = churn({
    previous: [prior("dev-1::display-off")],
    current: [],
    devices: [device()],
    verdict,
    from,
    to,
  });
  assert.equal(report.left[0]?.cause, "unobserved-window");
  assert.match(report.left[0]?.detail ?? "", /not reporting it as fixed/);
  assert.match(report.left[0]?.detail ?? "", /not as good news/);
  assert.equal(report.byCause?.value.applied, 0);
  assert.equal(report.byCause?.value["unobserved-window"], 1);
  // ...and the figure says we could not name a cause for it.
  assert.equal(report.byCause?.coverage.measured, 0);
  assert.equal(report.byCause?.coverage.inScope, 1);
  // Over a 4h window the hole is 52% of the buckets, so the coverage rung is
  // what bites; the run-length rung is exercised separately below, where a hole
  // this size is invisible to a ratio.
  assert.ok(
    report.notes.some((n) => /watched 23 of 48 buckets/.test(n)),
    report.notes.join(" | "),
  );
});

test("a long window hides a real hole from the coverage ratio, so the run-length gate catches it", () => {
  // 7 days at 300s = 2,016 buckets. The same 2h hole is 1.2% of them: coverage
  // reads 98.8% and a ratio alone would wave it through.
  const from = new Date("2026-08-22T00:00:00Z");
  const to = new Date("2026-08-29T00:00:00Z");
  const holeStart = new Date("2026-08-25T10:00:00Z").getTime();
  const holeEnd = new Date("2026-08-25T12:00:00Z").getTime();
  const starts: number[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += 300_000) {
    if (t >= holeStart && t < holeEnd) continue;
    starts.push(t);
  }
  const verdict = judgeObservation(observationFrom(from.toISOString(), to.toISOString(), 300, starts));
  assert.equal(verdict.observation.collectorCoverage, 0.988);
  assert.ok((verdict.observation.collectorCoverage ?? 0) > CHURN_GATES.minCollectorCoverage);
  assert.equal(verdict.clearsGates, false, "the ratio passed; the run length did not");
  assert.match(verdict.reason ?? "", /unbroken 2\.0h run/);

  const report = churn({
    previous: [prior("dev-1::display-off")],
    current: [],
    devices: [device()],
    verdict,
    from,
    to,
  });
  assert.equal(report.left[0]?.cause, "unobserved-window");
});

test("a gap in coverage does NOT suppress schedule-window-closed — it needs no continuous observation", () => {
  const report = churn({
    previous: [prior("dev-1::display-off")],
    current: [],
    devices: [device(DARK)],
    verdict: judgeObservation(
      observationFrom(MIDDAY.toISOString(), AFTER_CLOSE.toISOString(), 300, []),
    ),
    from: MIDDAY,
    to: AFTER_CLOSE,
  });
  // Blind is the hard floor and outranks even the schedule, so use a merely
  // thin window instead: one reading, at the very start.
  const thin = judgeObservation(
    observationFrom(MIDDAY.toISOString(), AFTER_CLOSE.toISOString(), 300, [MIDDAY.getTime()]),
  );
  assert.equal(report.left[0]?.cause, null, "blind refuses everything");
  const thinReport = churn({
    previous: [prior("dev-1::display-off")],
    current: [],
    devices: [device(DARK)],
    verdict: thin,
  });
  assert.equal(thin.clearsGates, false);
  assert.equal(thinReport.left[0]?.cause, "schedule-window-closed");
});

// ─── the departure ladder, rung by rung ─────────────────────────────────────

test("cause: device-retired — the device is not in the fleet at all", () => {
  const report = churn({ previous: [prior("dev-9::display-off")], current: [], devices: [device()] });
  assert.equal(report.left[0]?.cause, "device-retired");
  assert.match(report.left[0]?.detail ?? "", /stopped being ours to look at/);
});

test("cause: device-unreachable outranks every inference from facts we cannot refresh", () => {
  // This device's schedule ALSO closed, and its panel ALSO reads lit. Neither
  // may be reported: we cannot see it, so we say so.
  const report = churn({
    previous: [prior("dev-1::display-off")],
    current: [],
    devices: [device({ status: "offline" })],
  });
  assert.equal(report.left[0]?.cause, "device-unreachable");
  assert.match(report.left[0]?.detail ?? "", /Nothing was fixed/);
  assert.match(report.left[0]?.detail ?? "", /last online at 2026-08-28T15:55:00Z/);
});

test("cause: intent-excluded — demoted out of the one-click set, not resolved", () => {
  const demoted = rec("dev-1::display-off", {
    kind: "manual",
    demotedByIntent: true,
    intent: {
      kind: "lab",
      strength: "strong",
      source: "device-name",
      matchedText: "Lab",
      rationale: "The name contains 'Lab'.",
      alsoMatched: [],
    },
  });
  const report = churn({
    previous: [prior("dev-1::display-off", { kind: "auto-safe" })],
    current: [demoted],
    devices: [device(DARK)],
  });
  assert.equal(report.left[0]?.cause, "intent-excluded");
  assert.match(report.left[0]?.detail ?? "", /Demoted,\s+not resolved/);
  assert.equal(report.movement.value.to, 0, "it is no longer in the auto-safe set");
});

test("cause: schedule-window-closed — the 20 → 2 cause, stated as such", () => {
  const devices = Array.from({ length: 18 }, (_, i) =>
    device({ id: `dev-${i}`, name: `Panel ${i}`, ...DARK }),
  );
  const previous = devices.map((d) => prior(`${d.id}::display-off`));
  // Two devices with no schedule stay dark-unexpected and keep their item.
  const kept = [
    device({ id: "keep-1", brightnessScheduleEnabled: false, ...DARK }),
    device({ id: "keep-2", brightnessScheduleEnabled: false, ...DARK }),
  ];
  const report = churn({
    previous: [...previous, prior("keep-1::display-off"), prior("keep-2::display-off")],
    current: [rec("keep-1::display-off"), rec("keep-2::display-off")],
    devices: [...devices, ...kept],
  });
  assert.equal(report.movement.value.from, 20);
  assert.equal(report.movement.value.to, 2);
  assert.equal(report.byCause?.value["schedule-window-closed"], 18);
  assert.equal(report.byCause?.value.applied, 0);
  assert.match(report.headline, /20 → 2/);
  assert.match(report.headline, /18 left because their schedule closed, not because they were fixed/);
  for (const item of report.left) {
    assert.match(item.detail ?? "", /This was not fixed/);
  }
});

test("cause: superseded — the work changed shape, it did not go away", () => {
  const report = churn({
    previous: [prior("dev-1::display-off")],
    current: [rec("dev-1::compliance::brightness", { category: "compliance" })],
    devices: [device({ brightnessScheduleEnabled: false, ...DARK })],
  });
  assert.equal(report.left[0]?.cause, "superseded");
  assert.match(report.left[0]?.detail ?? "", /compliance::brightness/);
  assert.equal(report.stillPresent, 0);
  assert.equal(report.entered.length, 1, "the replacement is itself an arrival");
});

test("cause: applied — the symptom cleared, and it does not claim WE cleared it", () => {
  const report = churn({
    previous: [prior("dev-1::display-off")],
    current: [],
    devices: [device()], // lit, reachable, inside its window, nothing recommended
    from: MIDDAY,
    to: new Date(MIDDAY.getTime() + 3600_000),
  });
  assert.equal(report.left[0]?.cause, "applied");
  assert.match(report.left[0]?.detail ?? "", /the CONDITION cleared, not that VFI's write/);
  assert.match(report.left[0]?.detail ?? "", /api\/audit/);
  assert.equal(report.byCause?.value.applied, 1);
  assert.equal(report.byCause?.coverage.measured, 1, "a named cause counts as measured");
});

test("cause: undetermined always names the reading it was missing", () => {
  const report = churn({
    previous: [prior("dev-1::display-off")],
    current: [],
    devices: [
      device({
        currentBrightnessRaw: null,
        displayOn: null,
        brightnessScheduleEnabled: null,
        turnOnTime: null,
        turnOffTime: null,
      }),
    ],
  });
  const item = report.left[0];
  assert.equal(item?.cause, "undetermined");
  assert.ok((item?.unreadable.length ?? 0) > 0, "an undetermined with no obstacle is an `other` bucket");
  assert.match(item?.unreadable.join("; ") ?? "", /current_brightness/);
  assert.match(item?.detail ?? "", /not an item that was fixed/);
  // And it is NOT counted as a named cause.
  assert.equal(report.byCause?.coverage.measured, 0);
  assert.equal(report.byCause?.value.undetermined, 1);
});

test("an undetermined departure with every reading present is flagged as OUR bug, not a fleet fact", () => {
  // Dark inside its window with no recommendation anywhere: the engine would
  // have emitted one, so the caller's current set and ours disagree.
  const report = churn({
    previous: [prior("dev-1::display-off")],
    current: [],
    devices: [device(DARK)],
    from: MIDDAY,
    to: new Date(MIDDAY.getTime() + 3600_000),
  });
  assert.equal(report.left[0]?.cause, "undetermined");
  assert.deepEqual(report.left[0]?.unreadable, []);
  assert.ok(
    report.notes.some((n) => /hole rather than the data/.test(n)),
    report.notes.join(" | "),
  );
});

test("a prior id with no device in it is undetermined, not silently dropped", () => {
  const report = churn({ previous: [prior("no-separator-here")], current: [], devices: [device()] });
  assert.equal(report.left.length, 1);
  assert.equal(report.left[0]?.cause, "undetermined");
  assert.match(report.left[0]?.unreadable.join(";") ?? "", /deviceId/);
});

// ─── arrivals ───────────────────────────────────────────────────────────────

test("arrival: schedule-window-opened — newly actionable, not newly broken", () => {
  const report = churn({
    previous: [],
    current: [rec("dev-1::display-off")],
    devices: [device(DARK)],
    from: BEFORE_OPEN,
    to: MIDDAY,
  });
  assert.equal(report.entered[0]?.cause, "schedule-window-opened");
  assert.match(report.entered[0]?.detail ?? "", /newly actionable/);
  assert.match(report.headline, /1 entered since you looked/);
});

test("arrival: symptom-first-observed only when the reading is stamped INSIDE the window", () => {
  const inside = device({
    brightnessScheduleEnabled: false,
    telemetry: { ...device().telemetry!, observedAt: "2026-08-28T20:00:00Z" },
  });
  const report = churn({
    previous: [],
    current: [rec("dev-1::compliance::brightness")],
    devices: [inside],
  });
  assert.equal(report.entered[0]?.cause, "symptom-first-observed");
  assert.equal(report.byArrivalCause?.coverage.measured, 1);
});

test("watermark boundary: a reading stamped exactly AT the watermark does not date an arrival", () => {
  const atBoundary = device({
    brightnessScheduleEnabled: false,
    telemetry: { ...device().telemetry!, observedAt: MIDDAY.toISOString() },
  });
  const report = churn({
    previous: [],
    current: [rec("dev-1::compliance::brightness")],
    devices: [atBoundary],
    from: MIDDAY,
  });
  assert.equal(
    report.entered[0]?.cause,
    "undetermined",
    "a reading we already had at the watermark cannot show the symptom is new",
  );
  assert.match(report.entered[0]?.detail ?? "", /not answerable from stored data/);
});

test("an item already in the set AT the watermark is not new", () => {
  const report = churn({
    previous: [prior("dev-1::display-off", { severity: "high" })],
    current: [rec("dev-1::display-off")],
    devices: [device(DARK)],
  });
  assert.equal(report.entered.length, 0);
  assert.equal(report.left.length, 0);
  assert.equal(report.stillPresent, 1);
  assert.deepEqual(report.changed, []);
  assert.match(report.headline, /the same 1 item\(s\) you last saw/);
});

test("severity movement on an item present in both reads is reported as changed", () => {
  const report = churn({
    previous: [prior("dev-1::display-off", { severity: "low" })],
    current: [rec("dev-1::display-off", { severity: "critical" })],
    devices: [device(DARK)],
  });
  assert.equal(report.changed?.length, 1);
  assert.equal(report.changed?.[0]?.severityFrom, "low");
  assert.equal(report.changed?.[0]?.severityTo, "critical");
});

test("no severities in the prior read means `changed` is null with a reason, never an empty list", () => {
  const report = churn({
    previous: [prior("dev-1::display-off")],
    current: [rec("dev-1::display-off")],
    devices: [device(DARK)],
  });
  assert.equal(report.changed, null, "an empty array would read as `nothing moved`");
  assert.match(report.changedReason ?? "", /cannot say whether/);
});

// ─── counts are computed from the collection they are published beside ──────

test("byCause is counted over exactly the `left` array, and sums to it", () => {
  const devices = [
    device({ id: "a", ...DARK }), // schedule closed
    device({ id: "b", status: "offline" }), // unreachable
    device({ id: "c" }), // lit → applied
    device({ id: "d", currentBrightnessRaw: null, displayOn: null }), // undetermined
  ];
  const report = churn({
    previous: devices.map((d) => prior(`${d.id}::display-off`)),
    current: [],
    devices,
  });
  const values = Object.values(report.byCause?.value ?? {});
  assert.equal(
    values.reduce((a, b) => a + b, 0),
    report.left.length,
    "every departure carries exactly one cause",
  );
  assert.equal(report.byCause?.coverage.inScope, report.left.length);
  assert.equal(report.byCause?.coverage.unit, "recommendations");
  assert.ok((report.byCause?.basis.length ?? 0) > 0, "no bare number reaches the payload");
});

test("movement is counted from the FILTERED sets — a manual prior item is not in the auto-safe `from`", () => {
  const report = churn({
    previous: [
      prior("dev-1::display-off", { kind: "auto-safe" }),
      prior("dev-1::display-off-scheduled", { kind: "manual" }),
    ],
    current: [rec("dev-1::display-off"), rec("dev-1::logo-fallback", { kind: "manual" })],
    devices: [device(DARK)],
  });
  assert.equal(report.movement.value.from, 1, "the manual item is not in the auto-safe baseline");
  assert.equal(report.movement.value.to, 1, "nor in the auto-safe current set");
  assert.equal(report.left.length, 0);
  assert.equal(report.entered.length, 0);
});

test("an empty prior set says so rather than letting the whole current set read as a surge", () => {
  const report = churn({
    previous: [],
    current: [rec("dev-1::display-off")],
    devices: [device(DARK)],
  });
  assert.ok(
    report.notes.some((n) => /your baseline being empty, not evidence of a surge/.test(n)),
    report.notes.join(" | "),
  );
});

// ─── the watermark itself ───────────────────────────────────────────────────

test("a missing watermark is a labelled FIRST LOOK with a null new-count", () => {
  const verdict = judgeWatermark(undefined, MIDDAY, false);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.problem, "missing");
  const report = buildFirstLook(
    "auto-safe",
    MIDDAY.toISOString(),
    [rec("dev-1::display-off"), rec("dev-2::logo-fallback", { kind: "manual" })],
    verdict,
    null,
  );
  assert.equal(report.firstLook, true);
  assert.equal(report.newSince, null, "null — not the total, and not zero");
  assert.match(report.newSinceReason, /not as 1/);
  assert.match(report.newSinceReason, /not as 0/);
  assert.equal(report.total.value, 1, "the count is of the filtered set");
  assert.deepEqual(report.ids, ["dev-1::display-off"]);
  assert.match(report.headline, /full set, not a diff/);
});

test("an unparseable, future or over-age watermark is refused rather than defaulted", () => {
  assert.equal(judgeWatermark("yesterday", MIDDAY, true).problem, "unparseable");
  assert.equal(
    judgeWatermark(new Date(MIDDAY.getTime() + 3600_000).toISOString(), MIDDAY, true).problem,
    "in-the-future",
  );
  assert.equal(
    judgeWatermark(new Date(MIDDAY.getTime() - 40 * 86_400_000).toISOString(), MIDDAY, true).problem,
    "older-than-ceiling",
  );
  for (const problem of ["unparseable", "in-the-future", "older-than-ceiling"]) {
    const verdict = judgeWatermark(
      problem === "unparseable"
        ? "yesterday"
        : problem === "in-the-future"
          ? new Date(MIDDAY.getTime() + 3600_000).toISOString()
          : new Date(MIDDAY.getTime() - 40 * 86_400_000).toISOString(),
      MIDDAY,
      true,
    );
    assert.equal(verdict.at, null, problem);
    assert.ok((verdict.message?.length ?? 0) > 0, problem);
  }
});

test("a watermark with no prior set is refused, because we store no recommendation snapshots", () => {
  const verdict = judgeWatermark(BEFORE_OPEN.toISOString(), MIDDAY, false);
  assert.equal(verdict.problem, "no-prior-set");
  assert.match(verdict.message ?? "", /persist no\s+recommendation snapshots/);
});

test("clock skew inside tolerance is clamped forward, not turned into a negative window", () => {
  const skewed = new Date(MIDDAY.getTime() + 30_000).toISOString();
  const verdict = judgeWatermark(skewed, MIDDAY, true);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.at?.getTime(), MIDDAY.getTime());
});

test("the watermark basis says what it is measured against", () => {
  const verdict = judgeWatermark(undefined, MIDDAY, false);
  assert.match(verdict.basis, /absolute instant/);
  assert.match(verdict.basis, /NOT against the age of the underlying device readings/);
  assert.match(verdict.basis, /half-open/);
});

test("the gates are published with the verdict so a reader can argue with them", () => {
  const verdict = fullyObserved(MIDDAY, AFTER_CLOSE);
  assert.equal(verdict.gates, CHURN_GATES);
  assert.equal(verdict.clearsGates, true);
  assert.equal(verdict.reason, null);
  assert.equal(verdict.observation.collectorCoverage, 1);
});

// ─── the schedule rungs are gated on the RULE, not just on the clock ────────

test("cause: schedule-window-opened — the informational off-per-schedule item stops applying", () => {
  // The mirror of the 20 → 2 cause, and a real departure reason: without this
  // rung the item lands on `superseded`, which names the wrong mechanism.
  const report = analyzeChurn({
    previous: {
      observedAt: BEFORE_OPEN.toISOString(),
      items: [prior("dev-1::display-off-scheduled", { kind: "manual" })],
    },
    current: {
      observedAt: MIDDAY.toISOString(),
      recommendations: [rec("dev-1::compliance::auto_on_off_enabled", { kind: "manual" })],
    },
    devices: [device(DARK)],
    kind: "manual",
    verdict: fullyObserved(BEFORE_OPEN, MIDDAY),
  });
  assert.equal(report.left[0]?.cause, "schedule-window-opened");
  assert.match(report.left[0]?.detail ?? "", /Nothing was fixed; the window moved/);
});

test("a schedule boundary is only ever blamed for rules whose existence the schedule decides", () => {
  // A volume-compliance item that vanished while the window happened to close.
  // Blaming the schedule would be a true coincidence stated as a cause.
  const report = analyzeChurn({
    previous: {
      observedAt: MIDDAY.toISOString(),
      items: [prior("dev-1::compliance::volume_percent", { kind: "manual" })],
    },
    current: { observedAt: AFTER_CLOSE.toISOString(), recommendations: [] },
    devices: [device(DARK)],
    kind: "manual",
    verdict: fullyObserved(MIDDAY, AFTER_CLOSE),
  });
  assert.notEqual(report.left[0]?.cause, "schedule-window-closed");
  assert.equal(report.left[0]?.cause, "undetermined");
  assert.match(report.left[0]?.unreadable.join("; ") ?? "", /drift list is empty/);
});

test("`applied` is never inferred from an item's mere absence — the reading must still be readable", () => {
  // The bug this guards: a `storage-full` item vanishes both when the disk was
  // cleared and when the telemetry read failed. Only one is good news.
  const lost = device({
    brightnessScheduleEnabled: false,
    telemetry: { ...device().telemetry!, storageUsedPercent: null },
  });
  const report = churn({
    previous: [prior("dev-1::storage-full")],
    current: [],
    devices: [lost],
  });
  assert.equal(report.left[0]?.cause, "undetermined");
  assert.match(report.left[0]?.unreadable.join("; ") ?? "", /storage_used_percent/);
  assert.equal(report.byCause?.value.applied, 0);

  // Same departure, with the reading present: now it is a clearance.
  const readable = churn({
    previous: [prior("dev-1::storage-full")],
    current: [],
    devices: [device({ brightnessScheduleEnabled: false })],
  });
  assert.equal(readable.left[0]?.cause, "applied");
});

test("a compliance departure is judged against the drift list we actually hold", () => {
  const drifting = [{ kind: "value", label: "Volume", field: "volume_percent" }];
  // The field no longer drifts, and we DO hold a compliance result: cleared.
  const cleared = churn({
    previous: [prior("dev-1::compliance::volume_percent")],
    current: [],
    devices: [
      device({
        brightnessScheduleEnabled: false,
        drift: [{ kind: "value", label: "Reboot", field: "daily_reboot_enabled" }],
      }),
    ],
  });
  assert.equal(cleared.left[0]?.cause, "applied");

  // The field STILL drifts, so the item's absence is not the world improving —
  // it is a hole in our ladder, and it says so.
  const stillDrifting = churn({
    previous: [prior("dev-1::compliance::volume_percent")],
    current: [],
    devices: [device({ brightnessScheduleEnabled: false, drift: drifting })],
  });
  assert.equal(stillDrifting.left[0]?.cause, "undetermined");
  assert.deepEqual(stillDrifting.left[0]?.unreadable, []);
  assert.match(stillDrifting.left[0]?.detail ?? "", /gap in our cause ladder/);
});

test("the schedule rungs state the assumption they rest on", () => {
  const report = churn({
    previous: [prior("dev-1::display-off")],
    current: [],
    devices: [device(DARK)],
  });
  assert.equal(report.left[0]?.cause, "schedule-window-closed");
  assert.match(report.left[0]?.detail ?? "", /stated\s+rather than verified/);
});

test("arrival: schedule-window-closed — the off-per-schedule item exists only while the window is shut", () => {
  const report = analyzeChurn({
    previous: { observedAt: MIDDAY.toISOString(), items: [] },
    current: {
      observedAt: AFTER_CLOSE.toISOString(),
      recommendations: [rec("dev-1::display-off-scheduled", { kind: "manual", severity: "low" })],
    },
    devices: [device(DARK)],
    kind: "manual",
    verdict: fullyObserved(MIDDAY, AFTER_CLOSE),
  });
  assert.equal(report.entered[0]?.cause, "schedule-window-closed");
  assert.match(report.entered[0]?.detail ?? "", /nothing about the device changed/);
  assert.equal(report.byArrivalCause?.coverage.measured, 1, "a dated arrival counts as measured");
});

test("no bare number reaches the payload: every figure carries a basis and a coverage block", () => {
  // The same invariant reports.test.ts enforces on `Figure<T>`. A churn number
  // without its measurement basis is exactly the "20 → 2" this epic replaced.
  const report = churn({
    previous: [prior("dev-1::display-off")],
    current: [rec("dev-2::display-off", { deviceIds: ["dev-2"] })],
    devices: [device(DARK), device({ id: "dev-2", ...DARK })],
  });
  for (const [name, figure] of [
    ["movement", report.movement],
    ["byCause", report.byCause],
    ["byArrivalCause", report.byArrivalCause],
  ] as const) {
    assert.ok(figure, name);
    assert.ok(figure.basis.length > 20, `${name} basis`);
    assert.ok(figure.coverage.note.length > 20, `${name} coverage note`);
    assert.equal(typeof figure.coverage.measured, "number", name);
    assert.equal(typeof figure.coverage.inScope, "number", name);
  }
  // Both sides of the comparison are stated, and the earlier one is labelled as
  // the caller's own unverified claim.
  assert.equal(report.reads.previous.attestedBy, "caller");
  assert.equal(report.reads.current.attestedBy, "self");
  assert.equal(report.reads.previous.count, 1);
  assert.equal(report.reads.current.count, 1);
  assert.equal(report.window.observation.collectorCoverage, 1);
  assert.ok(report.basis.includes("diff, not the queue"));
});
