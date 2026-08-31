/**
 * Schedule slow-lane poller tests —
 *   `node --test dist/pipeline/pollers/schedule-slowlane.test.js`
 *
 * Everything here runs against a STUBBED reader and a STUBBED repo — no live
 * publisher is ever called. The reader returns the same `ScheduledEvent` shapes
 * `normalizeEvents` produces, so the pure `scheduledNow` window logic is
 * exercised; the stubbed repo just records saves. The window/gap engine itself
 * is covered in intelligence/proof-of-play.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ScheduledEvent } from "../../intelligence/proof-of-play.js";
import {
  pollScheduleSlowLane,
  aggregateScheduleRun,
  type ScheduleReader,
  type ScheduleSlowLaneRepo,
  type ScheduleSlowLaneTarget,
  type PersistedSchedule,
} from "./schedule-slowlane.js";

// ── stubs ────────────────────────────────────────────────────────────────────

/** An always-on event — the shape publisher v1 returns for the demo tenant. */
const alwaysOn: ScheduledEvent = {
  assetUuid: "a1", assetType: "image", durationMs: 10000,
  startTime: null, endTime: null, priority: 1, frequency: "loop",
};

/** A morning-only daypart (08:00–12:00 UTC), so `scheduledNow` actually filters. */
const morningOnly: ScheduledEvent = {
  assetUuid: "a2", assetType: "image", durationMs: 5000,
  startTime: "08:00", endTime: "12:00", priority: 1, frequency: "loop",
};

const target = (n: number): ScheduleSlowLaneTarget => ({ id: `canvas-${n}`, name: `Canvas ${n}` });

/** In-memory repo capturing every saveSchedule call. */
function stubRepo(opts: { failSaveFor?: Set<string> } = {}): ScheduleSlowLaneRepo & {
  saved: Array<{ deviceId: string; s: PersistedSchedule }>;
} {
  const saved: Array<{ deviceId: string; s: PersistedSchedule }> = [];
  return {
    saved,
    async saveSchedule(deviceId, s) {
      if (opts.failSaveFor?.has(deviceId)) throw new Error("db down");
      saved.push({ deviceId, s });
    },
  };
}

/** A reader over a fixed id→events map; unknown/`throw` ids reject. */
function stubReader(map: Record<string, ScheduledEvent[] | "throw">): ScheduleReader {
  return async (t) => {
    const v = map[t.id];
    if (v === "throw" || v === undefined) throw new Error("publisher 500");
    return v;
  };
}

// noon UTC — inside morningOnly? no (08:00–12:00, 12:00 is the edge). Use 10:00.
const AT = new Date("2026-08-31T10:00:00Z");

// ── pure helpers ───────────────────────────────────────────────────────────

test("aggregateScheduleRun counts saves, scheduled devices, and yield honestly", () => {
  const r = aggregateScheduleRun(4, [
    { hadSchedule: true, saved: true },
    { hadSchedule: true, saved: false }, // read ok, save failed
    { hadSchedule: false, saved: true }, // saved an empty schedule
  ]);
  assert.equal(r.rowsWritten, 2);
  assert.equal(r.devicesWithSchedule, 2);
  // Yield is over the TARGETED denominator (4), not the outcomes (3).
  assert.equal(r.scheduleYield, 0.5);
});

test("aggregateScheduleRun yields null for an empty batch", () => {
  assert.equal(aggregateScheduleRun(0, []).scheduleYield, null);
});

// ── poller behaviour ─────────────────────────────────────────────────────────

test("reads, computes scheduled-now, and saves a full batch", async () => {
  const repo = stubRepo();
  const targets = [target(1), target(2)];
  const result = await pollScheduleSlowLane(
    repo,
    targets,
    stubReader({ "canvas-1": [alwaysOn], "canvas-2": [morningOnly] }),
    { at: AT, concurrency: 2 },
  );

  assert.equal(result.poller, "schedule-slowlane");
  assert.equal(result.devicesTargeted, 2);
  assert.equal(result.batchesOk, 2);
  assert.equal(result.batchesFailed, 0);
  assert.equal(result.rowsWritten, 2);
  assert.equal(result.telemetryYield, 1); // both had an active schedule at 10:00
  assert.equal(repo.saved.length, 2);
  // The snapshot carries the scheduled-now set and its fetch instant.
  const s1 = repo.saved.find((r) => r.deviceId === "canvas-1")!.s;
  assert.equal(s1.hasActiveSchedule, true);
  assert.equal(s1.scheduledCount, 1);
  assert.equal(s1.date, "2026-08-31");
  assert.deepEqual(s1.fetchedAt, AT);
});

test("an out-of-window schedule saves as inactive and counts against yield", async () => {
  const repo = stubRepo();
  // 14:00 UTC is outside morningOnly's 08:00–12:00 window → scheduled-now empty.
  const result = await pollScheduleSlowLane(
    repo,
    [target(1)],
    stubReader({ "canvas-1": [morningOnly] }),
    { at: new Date("2026-08-31T14:00:00Z") },
  );
  assert.equal(result.batchesOk, 1); // it did not throw
  assert.equal(result.rowsWritten, 1); // an empty schedule is still persisted
  assert.equal(result.telemetryYield, 0); // but nothing was scheduled now
  assert.equal(repo.saved[0]!.s.hasActiveSchedule, false);
  assert.equal(repo.saved[0]!.s.scheduledCount, 0);
});

test("a device with no events is a valid empty read, not a failure", async () => {
  const repo = stubRepo();
  const result = await pollScheduleSlowLane(repo, [target(1)], stubReader({ "canvas-1": [] }), {
    at: AT,
  });
  assert.equal(result.batchesOk, 1);
  assert.equal(result.batchesFailed, 0);
  assert.equal(result.rowsWritten, 1);
  assert.equal(result.telemetryYield, 0);
});

test("an unreadable canvas is a failure, never faked as an empty schedule", async () => {
  const repo = stubRepo();
  const targets = [target(1), target(2)];
  const result = await pollScheduleSlowLane(
    repo,
    targets,
    stubReader({ "canvas-1": [alwaysOn], "canvas-2": "throw" }),
    { at: AT },
  );
  assert.equal(result.batchesOk, 1);
  assert.equal(result.batchesFailed, 1);
  assert.equal(result.rowsWritten, 1);
  assert.equal(result.telemetryYield, 0.5);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!, /publisher 500/);
});

test("collapses repeated identical read failures into one counted line", async () => {
  const repo = stubRepo();
  const targets = [target(1), target(2), target(3)];
  const result = await pollScheduleSlowLane(
    repo,
    targets,
    stubReader({ "canvas-1": "throw", "canvas-2": "throw", "canvas-3": "throw" }),
    { at: AT },
  );
  assert.equal(result.batchesFailed, 3);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!, /publisher 500 \(×3\)/);
});

test("a save failure is recorded but does not sink the read", async () => {
  const repo = stubRepo({ failSaveFor: new Set(["canvas-2"]) });
  const targets = [target(1), target(2)];
  const result = await pollScheduleSlowLane(
    repo,
    targets,
    stubReader({ "canvas-1": [alwaysOn], "canvas-2": [alwaysOn] }),
    { at: AT },
  );
  assert.equal(result.batchesOk, 2); // both read fine
  assert.equal(result.rowsWritten, 1); // only one persisted
  assert.equal(result.telemetryYield, 1); // both had an active schedule
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!, /canvas-2: save failed: db down/);
});

test("an empty target list is a clean no-op", async () => {
  const repo = stubRepo();
  const result = await pollScheduleSlowLane(repo, [], stubReader({}), { at: AT });
  assert.equal(result.devicesTargeted, 0);
  assert.equal(result.telemetryYield, null);
  assert.equal(repo.saved.length, 0);
});

test("honours an explicit schedule date over the evaluation instant's date", async () => {
  const repo = stubRepo();
  await pollScheduleSlowLane(repo, [target(1)], stubReader({ "canvas-1": [alwaysOn] }), {
    at: AT,
    date: "2026-01-01",
  });
  assert.equal(repo.saved[0]!.s.date, "2026-01-01");
});

test("the default schedule date is the evaluation instant's UTC date, across the day seam", async () => {
  // The publisher endpoint is per-date, so the date the poller asks for must track
  // the instant it is evaluating — including either side of midnight UTC, where
  // taking a local date would ask for the wrong day's schedule.
  const late = stubRepo();
  await pollScheduleSlowLane(late, [target(1)], stubReader({ "canvas-1": [alwaysOn] }), {
    at: new Date("2026-08-31T23:59:00Z"),
  });
  assert.equal(late.saved[0]!.s.date, "2026-08-31");

  const early = stubRepo();
  await pollScheduleSlowLane(early, [target(1)], stubReader({ "canvas-1": [alwaysOn] }), {
    at: new Date("2026-09-01T00:01:00Z"),
  });
  assert.equal(early.saved[0]!.s.date, "2026-09-01");
});

test("the reader is asked for the same date the snapshot records", async () => {
  // A mismatch here would persist a snapshot labelled with a date whose schedule
  // was never actually read — a silently wrong row rather than an error.
  const repo = stubRepo();
  const asked: Array<{ id: string; date: string }> = [];
  const reader: ScheduleReader = async (t, date) => {
    asked.push({ id: t.id, date });
    return [alwaysOn];
  };
  await pollScheduleSlowLane(repo, [target(1)], reader, { at: AT });
  assert.deepEqual(asked, [{ id: "canvas-1", date: "2026-08-31" }]);
  assert.equal(repo.saved[0]!.s.date, "2026-08-31");
});

test("the publisher fan-out never exceeds its concurrency ceiling", async () => {
  // One publisher call per canvas and no documented rate limit anywhere in the
  // Videri API, so a fleet-sized tick must stay pinned to the ceiling we set.
  const repo = stubRepo();
  const targets = Array.from({ length: 25 }, (_, i) => target(i));
  let inFlight = 0;
  let peak = 0;
  const reader: ScheduleReader = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    return [alwaysOn];
  };

  const result = await pollScheduleSlowLane(repo, targets, reader, { at: AT, concurrency: 4 });
  assert.equal(result.batchesOk, 25, "every canvas was still read");
  assert.ok(peak <= 4, `peak in-flight ${peak} exceeded the ceiling of 4`);
  assert.ok(peak > 1, "and the sweep is actually parallel, not serialised");
});

test("distinct failure reasons are reported separately, never merged into one line", async () => {
  // The collapse is for REPEATED identical failures. Two different faults are two
  // different operator actions, so merging them would hide one of them.
  const repo = stubRepo();
  const reader: ScheduleReader = async (t) => {
    if (t.id === "canvas-1") throw new Error("publisher 500");
    if (t.id === "canvas-2") throw new Error("canvas not found");
    return [alwaysOn];
  };
  const result = await pollScheduleSlowLane(repo, [target(1), target(2), target(3)], reader, {
    at: AT,
  });

  assert.equal(result.batchesFailed, 2);
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.some((e) => /publisher 500/.test(e)));
  assert.ok(result.errors.some((e) => /canvas not found/.test(e)));
  // Neither is counted as a repeat.
  for (const e of result.errors) assert.equal(/×/.test(e), false);
});

test("a whole-batch failure is a zero yield with every canvas accounted for", async () => {
  // The honest shape of "the publisher is down": yield 0 over the full targeted
  // denominator, nothing written, and no device silently dropped from the count.
  const repo = stubRepo();
  const targets = [target(1), target(2), target(3)];
  const result = await pollScheduleSlowLane(repo, targets, stubReader({}), { at: AT });

  assert.equal(result.devicesTargeted, 3);
  assert.equal(result.batchesOk, 0);
  assert.equal(result.batchesFailed, 3, "failures are counted, not dropped");
  assert.equal(result.rowsWritten, 0);
  assert.equal(result.telemetryYield, 0);
  assert.equal(repo.saved.length, 0, "nothing was persisted from an unreadable sweep");
});

test("the run reports its own identity and duration for the poller_runs record", async () => {
  const repo = stubRepo();
  const result = await pollScheduleSlowLane(repo, [target(1)], stubReader({ "canvas-1": [alwaysOn] }), {
    at: AT,
  });
  assert.equal(result.poller, "schedule-slowlane");
  assert.ok(Number.isFinite(result.durationMs), "duration is always recorded");
  assert.ok(result.durationMs >= 0);
});

test("an empty target list records a duration and no yield, so it is not read as a 0% sweep", async () => {
  const repo = stubRepo();
  const result = await pollScheduleSlowLane(repo, [], stubReader({}), { at: AT });
  assert.equal(result.telemetryYield, null, "null, never a fabricated 0% coverage");
  assert.equal(result.batchesOk, 0);
  assert.equal(result.batchesFailed, 0);
  assert.deepEqual(result.errors, []);
  assert.ok(Number.isFinite(result.durationMs));
});

test("every scheduled item that covers now is persisted, not just the count", async () => {
  // The gap detector reasons over the ITEMS, so a snapshot that kept only the
  // count would leave the fleet-wide path with nothing to judge.
  const repo = stubRepo();
  await pollScheduleSlowLane(
    repo,
    [target(1)],
    stubReader({ "canvas-1": [alwaysOn, morningOnly] }),
    { at: AT }, // 10:00 — both windows cover it
  );
  const saved = repo.saved[0]!.s;
  assert.equal(saved.scheduledCount, 2);
  assert.equal(saved.scheduledItems.length, 2);
  assert.deepEqual(saved.scheduledItems.map((i) => i.assetUuid).sort(), ["a1", "a2"]);
});

test("out-of-window items are excluded from the persisted snapshot, not just uncounted", async () => {
  const repo = stubRepo();
  await pollScheduleSlowLane(
    repo,
    [target(1)],
    stubReader({ "canvas-1": [alwaysOn, morningOnly] }),
    { at: new Date("2026-08-31T14:00:00Z") }, // morningOnly has closed
  );
  const saved = repo.saved[0]!.s;
  assert.equal(saved.scheduledCount, 1);
  assert.deepEqual(saved.scheduledItems.map((i) => i.assetUuid), ["a1"]);
  assert.equal(saved.hasActiveSchedule, true);
});
