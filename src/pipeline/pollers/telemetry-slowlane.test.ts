/**
 * Telemetry slow-lane poller tests —
 *   `node --test dist/pipeline/pollers/telemetry-slowlane.test.js`
 *
 * Everything here runs against a STUBBED runner and a STUBBED repo — no live
 * device is ever read. The stubbed runner answers demo_command verbs with the
 * same string shapes real hardware returns, so `readDeviceTelemetry`'s real
 * parse path is exercised end to end; the stubbed repo just records saves.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { DeviceTelemetry, TelemetryRunner } from "../../videri/telemetry.js";
import {
  pollTelemetrySlowLane,
  hasTelemetryValue,
  aggregateTelemetryRun,
  type TelemetrySlowLaneTarget,
  type TelemetrySlowLaneRepo,
} from "./telemetry-slowlane.js";

// ── stubs ────────────────────────────────────────────────────────────────────

/** A device that answers every field with a realistic, parseable payload. */
const HEALTHY: Record<string, { code: string; message: string }> = {
  meminfo: { code: "SUCCESS", message: "total: 4.00 GB free: 2.00 GB" },
  free_memory: { code: "SUCCESS", message: "free_memory=10000" },
  total_memory: { code: "SUCCESS", message: "total_memory=20000" },
  wifi_strength: { code: "SUCCESS", message: "RSSI=-48" },
  ops_chrony_stats_json: {
    code: "SUCCESS",
    message: '{"message_json":{"rms_offset_s":0.001,"reach":377,"ntp_server":"1.2.3.4"}}',
  },
  // Two distinct /proc/stat snapshots so CPU% resolves to a real number.
  read_proc_stat: { code: "SUCCESS", message: "Proc Stats: 100 0 100 800 0 0 0" },
};

/** Runner over a fixed verb→response map; unknown verbs come back as errors. */
function stubRunner(
  map: Record<string, { code: string; message: string }>,
  opts: { throwOnFirstCall?: boolean } = {},
): TelemetryRunner {
  let calls = 0;
  return async (arg: string) => {
    calls += 1;
    if (opts.throwOnFirstCall && calls === 1) throw new Error("ECONNRESET");
    // read_proc_stat is asked twice; advance the counters so the delta is > 0.
    if (arg === "read_proc_stat") {
      return calls > 6
        ? { code: "SUCCESS", message: "Proc Stats: 200 0 150 1200 0 0 0" }
        : map[arg] ?? { code: "ERROR", message: "" };
    }
    return map[arg] ?? { code: "ERROR", message: "not supported" };
  };
}

/** In-memory repo capturing every saveTelemetry call. */
function stubRepo(opts: { failSaveFor?: Set<string> } = {}): TelemetrySlowLaneRepo & {
  saved: Array<{ deviceId: string; t: DeviceTelemetry }>;
} {
  const saved: Array<{ deviceId: string; t: DeviceTelemetry }> = [];
  return {
    saved,
    async saveTelemetry(deviceId, t) {
      if (opts.failSaveFor?.has(deviceId)) throw new Error("db down");
      saved.push({ deviceId, t });
    },
  };
}

const target = (n: number, jid: string | null = `dev-${n}@x`): TelemetrySlowLaneTarget => ({
  id: `canvas-${n}`,
  deviceId: `dev-${n}`,
  deviceJid: jid,
  playerId: null,
});

// ── pure helpers ───────────────────────────────────────────────────────────

test("hasTelemetryValue is true only when a field resolved", () => {
  const empty = { read: [] } as unknown as DeviceTelemetry;
  const some = { read: ["meminfo"] } as unknown as DeviceTelemetry;
  assert.equal(hasTelemetryValue(empty), false);
  assert.equal(hasTelemetryValue(some), true);
});

test("aggregateTelemetryRun counts saves, values, and yield honestly", () => {
  const r = aggregateTelemetryRun(4, [
    { hadValue: true, saved: true },
    { hadValue: true, saved: false }, // read ok, save failed
    { hadValue: false, saved: true }, // saved an all-null reading
  ]);
  assert.equal(r.rowsWritten, 2);
  assert.equal(r.devicesWithValue, 2);
  // Yield is over the TARGETED denominator (4), not the outcomes (3).
  assert.equal(r.telemetryYield, 0.5);
});

test("aggregateTelemetryRun yields null for an empty batch", () => {
  assert.equal(aggregateTelemetryRun(0, []).telemetryYield, null);
});

// ── poller behaviour ─────────────────────────────────────────────────────────

test("reads and saves a full batch of healthy devices", async () => {
  const repo = stubRepo();
  const targets = [target(1), target(2), target(3)];
  const result = await pollTelemetrySlowLane(repo, targets, () => stubRunner(HEALTHY), {
    concurrency: 2,
  });

  assert.equal(result.poller, "telemetry-slowlane");
  assert.equal(result.devicesTargeted, 3);
  assert.equal(result.batchesOk, 3);
  assert.equal(result.batchesFailed, 0);
  assert.equal(result.rowsWritten, 3);
  assert.equal(result.telemetryYield, 1);
  assert.equal(repo.saved.length, 3);
  // The real parse path ran: a healthy device resolves RAM, storage, wifi, ntp.
  const t = repo.saved[0]!.t;
  assert.equal(t.ramUsedPercent, 50);
  assert.equal(t.rssiDbm, -48);
  assert.ok(t.read.includes("meminfo"));
  assert.equal(result.errors.length, 0);
});

test("skips un-addressable devices (no JID) without failing them", async () => {
  const repo = stubRepo();
  const targets = [target(1), target(2, null), target(3)];
  const result = await pollTelemetrySlowLane(repo, targets, () => stubRunner(HEALTHY));

  assert.equal(result.devicesTargeted, 2); // the null-JID device is dropped
  assert.equal(result.batchesOk, 2);
  assert.equal(repo.saved.length, 2);
});

test("a device that returns nothing counts against yield but is not a failure", async () => {
  const repo = stubRepo();
  // Empty map → every verb errors → readDeviceTelemetry returns all-null, read=[].
  const result = await pollTelemetrySlowLane(repo, [target(1)], () => stubRunner({}));

  assert.equal(result.batchesOk, 1); // it did not throw
  assert.equal(result.batchesFailed, 0);
  assert.equal(result.rowsWritten, 1); // an all-null reading is still saved
  assert.equal(result.telemetryYield, 0); // but yielded no data
});

test("an unreachable device is reported as a failure, not faked as success", async () => {
  const repo = stubRepo();
  const targets = [target(1), target(2)];
  const result = await pollTelemetrySlowLane(repo, targets, (t) =>
    stubRunner(HEALTHY, { throwOnFirstCall: t.id === "canvas-2" }),
  );

  assert.equal(result.devicesTargeted, 2);
  assert.equal(result.batchesOk, 1);
  assert.equal(result.batchesFailed, 1);
  assert.equal(result.rowsWritten, 1);
  assert.equal(result.telemetryYield, 0.5);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!, /ECONNRESET/);
});

test("collapses repeated identical read failures into one counted line", async () => {
  const repo = stubRepo();
  const targets = [target(1), target(2), target(3)];
  const result = await pollTelemetrySlowLane(repo, targets, () =>
    stubRunner(HEALTHY, { throwOnFirstCall: true }),
  );

  assert.equal(result.batchesFailed, 3);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!, /ECONNRESET \(×3\)/);
});

test("a save failure is recorded but does not sink the read", async () => {
  const repo = stubRepo({ failSaveFor: new Set(["canvas-2"]) });
  const targets = [target(1), target(2)];
  const result = await pollTelemetrySlowLane(repo, targets, () => stubRunner(HEALTHY));

  assert.equal(result.batchesOk, 2); // both read fine
  assert.equal(result.rowsWritten, 1); // only one persisted
  assert.equal(result.telemetryYield, 1); // both yielded data
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!, /canvas-2: save failed: db down/);
});

test("an empty target list is a clean no-op", async () => {
  const repo = stubRepo();
  const result = await pollTelemetrySlowLane(repo, [], () => stubRunner(HEALTHY));
  assert.equal(result.devicesTargeted, 0);
  assert.equal(result.telemetryYield, null);
  assert.equal(repo.saved.length, 0);
});

test("respects the injected readTelemetry seam", async () => {
  const repo = stubRepo();
  let seen = 0;
  const fakeRead = async (): Promise<DeviceTelemetry> => {
    seen += 1;
    return { read: ["meminfo"] } as unknown as DeviceTelemetry;
  };
  const result = await pollTelemetrySlowLane(repo, [target(1)], () => stubRunner({}), {
    readTelemetry: fakeRead,
  });
  assert.equal(seen, 1);
  assert.equal(result.telemetryYield, 1);
});
