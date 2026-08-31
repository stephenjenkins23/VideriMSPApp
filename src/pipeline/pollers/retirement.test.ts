/**
 * Device retirement tests — `node --test dist/pipeline/pollers/retirement.test.js`
 *
 * Two failure modes, pulling in opposite directions:
 *
 *   - Not retiring: 250 rows against a 249-device fleet, so every published total
 *     is inflated by a device that no longer exists (the bug this fixes).
 *   - Over-retiring: a half-finished sweep marks most of the fleet as gone in one
 *     tick and the whole product reads as an outage.
 *
 * The planner is deliberately asymmetric about that — un-retire always, retire
 * only on positive evidence of a complete sweep — and these tests pin every guard
 * plus the poller wiring that supplies them. Nothing here can hard-delete a row;
 * there is no DELETE path to test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { planRetirement, type SweepCoverage } from "./retirement.js";
import { pollDevices } from "./devices.js";
import type { Repository } from "../../db/repository.js";
import type { CanvasService, DeviceSweepPage } from "../../videri/services/canvas.js";
import type { Device } from "../../domain/types.js";

const COMPLETE: SweepCoverage = { assignedToGroupTrue: true, assignedToGroupFalse: true };

const ids = (n: number, prefix = "d"): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`);

// ── the happy path: exactly the measured bug ──────────────────────────────────

test("a complete sweep retires the device it did not see", () => {
  // The real case: 250 active rows, 249 returned, row 1035066 absent.
  const active = [...ids(249), "1035066"];
  const plan = planRetirement({
    seen: ids(249),
    active,
    retired: [],
    coverage: COMPLETE,
    batchesFailed: 0,
  });
  assert.deepEqual(plan.retire, ["1035066"]);
  assert.deepEqual(plan.unretire, []);
  assert.equal(plan.blockedReason, null);
});

test("a sweep that saw everything retires nothing", () => {
  const plan = planRetirement({
    seen: ids(249),
    active: ids(249),
    retired: [],
    coverage: COMPLETE,
    batchesFailed: 0,
  });
  assert.deepEqual(plan.retire, []);
  assert.equal(plan.blockedReason, null);
});

// ── un-retiring: always safe, always applied ─────────────────────────────────

test("a retired device that reappears is un-retired", () => {
  const plan = planRetirement({
    seen: ["a", "gone-and-back"],
    active: ["a"],
    retired: ["gone-and-back", "still-gone"],
    coverage: COMPLETE,
    batchesFailed: 0,
  });
  assert.deepEqual(plan.unretire, ["gone-and-back"]);
  assert.deepEqual(plan.retire, [], "and the one still absent is left retired, not re-retired");
});

test("un-retiring happens even when the sweep was PARTIAL", () => {
  // Seeing a device live is positive evidence it exists; that does not depend on
  // how much of the rest of the fleet we managed to read. Refusing here would
  // leave a live device excluded from every count until a clean sweep landed.
  const plan = planRetirement({
    seen: ["back"],
    active: ["a", "b"],
    retired: ["back"],
    coverage: { assignedToGroupTrue: true, assignedToGroupFalse: false },
    batchesFailed: 0,
  });
  assert.deepEqual(plan.unretire, ["back"]);
  assert.deepEqual(plan.retire, []);
});

// ── the partial-sweep guard (the dangerous direction) ────────────────────────

test("a sweep missing the assigned_to_group=false leg retires NOTHING", () => {
  // Neither value of assigned_to_group means "all": 233 + 16 = 249. A sweep that
  // only did the `true` leg is missing 16 real devices, and retiring them would
  // delete a sixth of the fleet from every count.
  const plan = planRetirement({
    seen: ids(233),
    active: ids(249),
    retired: [],
    coverage: { assignedToGroupTrue: true, assignedToGroupFalse: false },
    batchesFailed: 0,
  });
  assert.deepEqual(plan.retire, []);
  assert.match(plan.blockedReason!, /assigned_to_group=false/);
  assert.match(plan.blockedReason!, /not evidence of deletion/);
});

test("a sweep missing the assigned_to_group=true leg retires NOTHING", () => {
  const plan = planRetirement({
    seen: ids(16),
    active: ids(249),
    retired: [],
    coverage: { assignedToGroupTrue: false, assignedToGroupFalse: true },
    batchesFailed: 0,
  });
  assert.deepEqual(plan.retire, []);
  assert.match(plan.blockedReason!, /assigned_to_group=true/);
});

test("neither leg finishing retires nothing and names both", () => {
  const plan = planRetirement({
    seen: [],
    active: ids(10),
    retired: [],
    coverage: { assignedToGroupTrue: false, assignedToGroupFalse: false },
    batchesFailed: 0,
  });
  assert.deepEqual(plan.retire, []);
  assert.match(plan.blockedReason!, /assigned_to_group=true and assigned_to_group=false/);
});

test("a failed upsert batch blocks retirement even on a complete sweep", () => {
  const plan = planRetirement({
    seen: ids(200),
    active: ids(249),
    retired: [],
    coverage: COMPLETE,
    batchesFailed: 1,
  });
  assert.deepEqual(plan.retire, []);
  assert.match(plan.blockedReason!, /upsert batch/);
});

test("a clean sweep that returned zero devices is a failed read, not an empty fleet", () => {
  // Both legs can 200 with empty content. Believing that would retire the entire
  // fleet in one tick.
  const plan = planRetirement({
    seen: [],
    active: ids(249),
    retired: [],
    coverage: COMPLETE,
    batchesFailed: 0,
  });
  assert.deepEqual(plan.retire, []);
  assert.match(plan.blockedReason!, /treated as a failed read/);
});

test("a mass disappearance above the ceiling is refused with the numbers in the reason", () => {
  // 100 of 249 absent from an apparently-clean sweep is a platform hiccup, not a
  // decommission of 40% of the estate.
  const plan = planRetirement({
    seen: ids(149),
    active: ids(249),
    retired: [],
    coverage: COMPLETE,
    batchesFailed: 0,
  });
  assert.deepEqual(plan.retire, []);
  assert.match(plan.blockedReason!, /100 of 249/);
  assert.match(plan.blockedReason!, /refusing to mass-retire/);
});

test("the ceiling is a fraction, so a batch decommission just under it is allowed", () => {
  const plan = planRetirement({
    seen: ids(210),
    active: ids(249),
    retired: [],
    coverage: COMPLETE,
    batchesFailed: 0,
  });
  assert.equal(plan.retire.length, 39, "39 of 249 is under the 20% (49) ceiling");
  assert.equal(plan.blockedReason, null);
});

test("the ceiling is configurable and a stricter one blocks the same plan", () => {
  const args = {
    seen: ids(240),
    active: ids(249),
    retired: [],
    coverage: COMPLETE,
    batchesFailed: 0,
  };
  assert.equal(planRetirement(args).retire.length, 9);
  assert.deepEqual(planRetirement({ ...args, maxRetireFraction: 0.01 }).retire, []);
});

test("a one-device tenant can still retire its one gone device", () => {
  // max(1, floor(0.2 * 1)) — the fraction protects a fleet, not a fleet of one.
  const plan = planRetirement({
    seen: ["someone-else"],
    active: ["only"],
    retired: [],
    coverage: COMPLETE,
    batchesFailed: 0,
  });
  assert.deepEqual(plan.retire, ["only"]);
});

test("an empty registry is a no-op, not a crash", () => {
  const plan = planRetirement({
    seen: [],
    active: [],
    retired: [],
    coverage: COMPLETE,
    batchesFailed: 0,
  });
  assert.deepEqual(plan, { retire: [], unretire: [], blockedReason: null });
});

// ── the poller wiring ────────────────────────────────────────────────────────

const device = (id: string): Device =>
  ({ id, deviceId: id, deviceJid: `${id}@x`, name: id, deviceClass: "canvas" }) as unknown as Device;

/** A canvas stub that yields the given pages, including the leg-complete markers. */
function fakeCanvas(pages: DeviceSweepPage[], throwAfter?: number): CanvasService {
  return {
    async *sweepDevices() {
      let i = 0;
      for (const page of pages) {
        if (throwAfter !== undefined && i === throwAfter) throw new Error("canvases 500");
        i += 1;
        yield page;
      }
    },
  } as unknown as CanvasService;
}

/** A repository stub recording what retirement was applied. */
function fakeRepo(state: { active: string[]; retired: string[] }, opts: { upsertThrows?: boolean } = {}) {
  const applied: Array<{ retire: readonly string[]; unretire: readonly string[] }> = [];
  const repo = {
    async upsertDevices(devices: Device[]) {
      if (opts.upsertThrows) throw new Error("insert failed");
      return devices.length;
    },
    async deviceRetirementState() {
      return state;
    },
    async applyRetirement(retire: readonly string[], unretire: readonly string[]) {
      applied.push({ retire, unretire });
      return { retired: retire.length, unretired: unretire.length };
    },
  } as unknown as Repository;
  return { repo, applied };
}

const page = (assignedToGroup: boolean, devices: Device[]): DeviceSweepPage => ({
  assignedToGroup,
  devices,
  legComplete: false,
});
const legDone = (assignedToGroup: boolean): DeviceSweepPage => ({
  assignedToGroup,
  devices: [],
  legComplete: true,
});

test("pollDevices retires the absent device after both legs complete", async () => {
  const canvas = fakeCanvas([
    page(true, [device("a"), device("b")]),
    legDone(true),
    page(false, [device("c")]),
    legDone(false),
  ]);
  const { repo, applied } = fakeRepo({ active: ["a", "b", "c", "ghost"], retired: [] });

  const result = await pollDevices(canvas, repo);

  assert.equal(result.devicesTargeted, 3);
  assert.equal(result.retirement.sweepComplete, true);
  assert.equal(result.retirement.retired, 1);
  assert.deepEqual(applied[0]!.retire, ["ghost"]);
  assert.equal(result.retirement.blockedReason, null);
});

test("pollDevices un-retires a device that came back", async () => {
  const canvas = fakeCanvas([page(true, [device("a")]), legDone(true), legDone(false)]);
  const { repo, applied } = fakeRepo({ active: [], retired: ["a"] });

  const result = await pollDevices(canvas, repo);
  assert.equal(result.retirement.unretired, 1);
  assert.deepEqual(applied[0]!.unretire, ["a"]);
});

test("pollDevices retires nothing when pagination throws mid-sweep", async () => {
  // The generator throws before the second leg's completion marker, so coverage
  // stays incomplete and the fleet is left alone.
  const canvas = fakeCanvas(
    [page(true, [device("a")]), legDone(true), page(false, [device("c")]), legDone(false)],
    2,
  );
  const { repo, applied } = fakeRepo({ active: ["a", "b", "c"], retired: [] });

  const result = await pollDevices(canvas, repo);
  assert.equal(result.retirement.sweepComplete, false);
  assert.equal(result.retirement.retired, 0);
  assert.deepEqual(applied[0]!.retire, []);
  assert.ok(result.errors.some((e) => e.includes("retirement skipped")));
  assert.ok(result.errors.some((e) => e.includes("listDevices failed")));
});

test("pollDevices counts a device it saw but failed to upsert as SEEN, and still blocks", async () => {
  // Two invariants at once: a write failure must not make a live device look
  // absent, and it must also block retirement for the tick.
  const canvas = fakeCanvas([page(true, [device("a")]), legDone(true), legDone(false)]);
  const { repo, applied } = fakeRepo({ active: ["a", "ghost"], retired: [] }, { upsertThrows: true });

  const result = await pollDevices(canvas, repo);
  assert.equal(result.batchesFailed, 1);
  assert.deepEqual(applied[0]!.retire, [], "nothing retired on a tick with a failed write");
  assert.match(result.retirement.blockedReason!, /upsert batch/);
});

test("a retirement reconcile failure is reported, not swallowed, and does not fail the poll", async () => {
  const canvas = fakeCanvas([page(true, [device("a")]), legDone(true), legDone(false)]);
  const repo = {
    async upsertDevices(devices: Device[]) {
      return devices.length;
    },
    async deviceRetirementState() {
      throw new Error("db down");
    },
  } as unknown as Repository;

  const result = await pollDevices(canvas, repo);
  assert.equal(result.rowsWritten, 1, "the upserts still counted");
  assert.equal(result.retirement.retired, 0);
  assert.ok(result.errors.some((e) => e.includes("retirement reconcile failed")));
});
