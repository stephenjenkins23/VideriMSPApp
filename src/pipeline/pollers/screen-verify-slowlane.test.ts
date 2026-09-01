/**
 * Screen-verification slow-lane tests —
 *   `node --test dist/pipeline/pollers/screen-verify-slowlane.test.js`
 *
 * Everything here runs against a STUBBED screen reader and a STUBBED repo — no
 * device is ever commanded. The verdict vocabulary itself is covered in
 * intelligence/screen-verify.test.ts; what is covered here is the SHAPING (what
 * lands in `device_screen_verdict`) and the AGGREGATION (what the run reports),
 * because both fail silently:
 *
 *   turn an unanswered verb into `device_is_black = false` and the engine starts
 *     refuting claims nobody tested;
 *   count `contradicted` by subtraction and an unreachable device inflates the
 *     refutation count;
 *   treat an empty batch as a failure and the lane looks broken on the days it
 *     is working perfectly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ScreenStateReading, TelemetryRunner } from "../../videri/telemetry.js";
import {
  pollScreenVerifySlowLane,
  aggregateScreenVerifyRun,
  shapeScreenVerdict,
  type PersistedScreenVerdict,
  type ScreenVerifyRepo,
  type ScreenVerifyTarget,
} from "./screen-verify-slowlane.js";

const CLAIM_AT = new Date("2026-09-01T11:58:00Z");
const ANSWER_AT = new Date("2026-09-01T12:00:00Z");

const target = (n: number, over: Partial<ScreenVerifyTarget> = {}): ScreenVerifyTarget => ({
  id: `canvas-${n}`,
  deviceId: `100015${n}`,
  deviceJid: `100015${n}@videri`,
  playerId: `p${n}`,
  name: `Center Spark ${n}`,
  platformClaim: true,
  claimObservedAt: CLAIM_AT,
  ...over,
});

const reading = (over: Partial<ScreenStateReading> = {}): ScreenStateReading => ({
  isBlack: null, isShowingLogo: null, read: [], ...over,
});

/** The panel says it is lit — the case that refutes the platform. */
const litPanel = reading({ isBlack: false, isShowingLogo: false, read: ["is_blackscreen", "is_showing_logo"] });
/** The panel agrees it is black. */
const blackPanel = reading({ isBlack: true, read: ["is_blackscreen"] });
/** The panel said nothing usable. */
const silentPanel = reading();

/** In-memory repo capturing every saveScreenVerdict call. */
function stubRepo(opts: { failSaveFor?: Set<string> } = {}): ScreenVerifyRepo & {
  saved: Array<{ deviceId: string; v: PersistedScreenVerdict }>;
} {
  const saved: Array<{ deviceId: string; v: PersistedScreenVerdict }> = [];
  return {
    saved,
    async saveScreenVerdict(deviceId, v) {
      if (opts.failSaveFor?.has(deviceId)) throw new Error("db down");
      saved.push({ deviceId, v });
    },
  };
}

/** A reader over a fixed id→reading map; `throw` ids reject like a transport failure. */
const stubReader =
  (map: Record<string, ScreenStateReading | "throw">) =>
  (run: TelemetryRunner): Promise<ScreenStateReading> => {
    // The runner carries the device identity in this stub; call it once so a
    // poller that forgets to build one would fail here rather than pass quietly.
    return run("is_blackscreen").then((r) => {
      const v = map[r.message];
      if (v === "throw" || v === undefined) throw new Error("sync_command timeout");
      return v;
    });
  };

/** Runner that simply echoes which device it was bound to. */
const makeRunner = (t: ScreenVerifyTarget): TelemetryRunner => async () => ({
  code: "SUCCESS", message: t.id,
});

// ── shaping ─────────────────────────────────────────────────────────────────

test("a lit panel is shaped into a `contradicted` row carrying both observations", () => {
  const row = shapeScreenVerdict(target(1), litPanel, ANSWER_AT);

  assert.equal(row.verdict, "contradicted");
  assert.equal(row.platformClaim, true);
  assert.equal(row.deviceIsBlack, false);
  assert.equal(row.deviceIsShowingLogo, false);
  assert.deepEqual(row.verbsRead, ["is_blackscreen", "is_showing_logo"]);
  assert.equal(row.observedAt, ANSWER_AT);
  // The detail must date both sides — the engine's freshness gate depends on the
  // answer being later than the claim, and an operator has to be able to see it.
  assert.ok(row.detail.includes(CLAIM_AT.toISOString()));
  assert.ok(row.detail.includes(ANSWER_AT.toISOString()));
});

test("an agreeing panel is shaped into a `confirmed` row", () => {
  const row = shapeScreenVerdict(target(1), blackPanel, ANSWER_AT);
  assert.equal(row.verdict, "confirmed");
  assert.equal(row.deviceIsBlack, true);
});

test("a silent panel stores NULL, never false — the invariant of the table", () => {
  const row = shapeScreenVerdict(target(1), silentPanel, ANSWER_AT);

  assert.equal(row.verdict, "unanswered");
  assert.equal(row.deviceIsBlack, null, "false here would refute a claim we never tested");
  assert.equal(row.deviceIsShowingLogo, null);
  assert.deepEqual(row.verbsRead, [], "and nothing may claim to have been read");
});

test("a panel that answered the logo but not blackness is still `unanswered`", () => {
  // The partial case: one verb landed, the one under test did not. The logo is
  // recorded because we know it, and the verdict stays honest about blackness.
  const row = shapeScreenVerdict(
    target(1),
    reading({ isShowingLogo: true, read: ["is_showing_logo"] }),
    ANSWER_AT,
  );
  assert.equal(row.verdict, "unanswered");
  assert.equal(row.deviceIsBlack, null);
  assert.equal(row.deviceIsShowingLogo, true);
  assert.deepEqual(row.verbsRead, ["is_showing_logo"]);
});

// ── aggregation ─────────────────────────────────────────────────────────────

test("aggregateScreenVerifyRun counts each verdict directly, never by subtraction", () => {
  const t = aggregateScreenVerifyRun(5, [
    { verdict: "contradicted", answered: true, saved: true },
    { verdict: "confirmed", answered: true, saved: true },
    { verdict: "unanswered", answered: false, saved: true },
    { verdict: "contradicted", answered: true, saved: false }, // asked, save failed
  ]);

  assert.equal(t.contradicted, 2);
  assert.equal(t.confirmed, 1);
  assert.equal(t.unanswered, 1);
  assert.equal(t.rowsWritten, 3, "the failed save is not a row");
  // Yield is over the TARGETED denominator (5), so the device that threw counts
  // against us rather than disappearing.
  assert.equal(t.answerYield, 3 / 5);
});

test("aggregateScreenVerifyRun yields null for an empty batch, never 0%", () => {
  const t = aggregateScreenVerifyRun(0, []);
  assert.equal(t.answerYield, null, "0% would claim we asked and got nothing");
  assert.equal(t.contradicted, 0);
});

// ── the lane ────────────────────────────────────────────────────────────────

test("an empty target list is a clean no-op, not a failure", async () => {
  const repo = stubRepo();
  const logs: string[] = [];
  const result = await pollScreenVerifySlowLane(repo, [], makeRunner, {
    log: (m) => logs.push(m),
  });

  assert.equal(result.devicesTargeted, 0);
  assert.equal(result.batchesFailed, 0);
  assert.deepEqual(result.errors, []);
  assert.equal(result.telemetryYield, null);
  assert.equal(repo.saved.length, 0, "no device may be commanded when there is nothing to verify");
  assert.match(logs.join(" "), /correct result/, "the log must say so, not imply breakage");
});

test("a device with no JID is dropped rather than attempted", async () => {
  const repo = stubRepo();
  const result = await pollScreenVerifySlowLane(
    repo,
    [target(1, { deviceJid: null }), target(2)],
    makeRunner,
    { readScreen: stubReader({ "canvas-2": litPanel }) },
  );

  assert.equal(result.devicesTargeted, 1, "an un-addressable device is not a target");
  assert.deepEqual(repo.saved.map((s) => s.deviceId), ["canvas-2"]);
});

test("the lane persists one verdict per device and reports the refutation count", async () => {
  const repo = stubRepo();
  const result = await pollScreenVerifySlowLane(
    repo,
    [target(1), target(2), target(3)],
    makeRunner,
    {
      concurrency: 2,
      now: () => ANSWER_AT,
      readScreen: stubReader({
        "canvas-1": litPanel,
        "canvas-2": blackPanel,
        "canvas-3": silentPanel,
      }),
    },
  );

  assert.equal(result.devicesTargeted, 3);
  assert.equal(result.batchesOk, 3);
  assert.equal(result.rowsWritten, 3);
  assert.equal(result.totals.contradicted, 1);
  assert.equal(result.totals.confirmed, 1);
  assert.equal(result.totals.unanswered, 1);
  // Two of three panels answered is_blackscreen.
  assert.equal(result.telemetryYield, 2 / 3);
  assert.equal(repo.saved.length, 3);
});

test("an unreachable device is a failure, not a verdict", async () => {
  const repo = stubRepo();
  const result = await pollScreenVerifySlowLane(repo, [target(1), target(2)], makeRunner, {
    readScreen: stubReader({ "canvas-1": litPanel, "canvas-2": "throw" }),
  });

  assert.equal(result.batchesOk, 1);
  assert.equal(result.batchesFailed, 1);
  assert.equal(result.totals.contradicted, 1, "the timeout must not become a refutation");
  assert.equal(result.totals.unanswered, 0, "nor an `unanswered` row we never wrote");
  assert.equal(repo.saved.length, 1);
  assert.equal(result.telemetryYield, 1 / 2);
  assert.match(result.errors.join(" "), /timeout/);
});

test("repeated identical transport failures collapse to one line with a count", async () => {
  const repo = stubRepo();
  const result = await pollScreenVerifySlowLane(
    repo,
    [target(1), target(2), target(3)],
    makeRunner,
    { readScreen: stubReader({}) },
  );

  assert.equal(result.batchesFailed, 3);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!, /×3/);
});

test("a save failure is reported without being counted as a device failure", async () => {
  const repo = stubRepo({ failSaveFor: new Set(["canvas-1"]) });
  const result = await pollScreenVerifySlowLane(repo, [target(1)], makeRunner, {
    readScreen: stubReader({ "canvas-1": litPanel }),
  });

  assert.equal(result.batchesOk, 1, "we did learn the answer");
  assert.equal(result.batchesFailed, 0);
  assert.equal(result.rowsWritten, 0, "but nothing was recorded");
  assert.equal(result.telemetryYield, 1, "the panel answered, so yield is honest at 100%");
  // Load-bearing: the engine reads rows, so an unsaved refutation means the
  // critical still fires. That has to be visible in the run.
  assert.match(result.errors.join(" "), /save failed/);
});

test("the result is shaped for poller_runs like every other lane", async () => {
  const repo = stubRepo();
  const result = await pollScreenVerifySlowLane(repo, [target(1)], makeRunner, {
    readScreen: stubReader({ "canvas-1": litPanel }),
  });

  assert.equal(result.poller, "screen-verify-slowlane");
  assert.ok(result.startedAt instanceof Date);
  assert.equal(typeof result.durationMs, "number");
});
