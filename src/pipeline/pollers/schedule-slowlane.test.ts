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
