/**
 * Pipeline tests — `node --test dist/pipeline/pipeline.test.js`
 *
 * No database, no API. The repository tests drive a stub pool that captures SQL
 * and parameters, which is enough to assert the invariants that actually matter:
 * ambiguous values never get persisted, and every write is idempotent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { chunk, mapSettled } from "./batching.js";
import { Scheduler } from "./scheduler.js";
import { Repository } from "../db/repository.js";
import type { HealthSample, Observed } from "../domain/types.js";

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── batching ───────────────────────────────────────────────────────────────

test("chunk splits evenly and keeps the remainder", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 10), []);
  assert.deepEqual(chunk([1], 5), [[1]]);
  assert.throws(() => chunk([1], 0), /chunk size/);
});

test("mapSettled isolates failures instead of aborting the sweep", async () => {
  const { ok, failures } = await mapSettled([1, 2, 3, 4], 2, async (n) => {
    if (n % 2 === 0) throw new Error(`boom ${n}`);
    return n * 10;
  });

  // A poll tick covers the whole fleet — one bad batch must not lose the rest.
  assert.deepEqual(ok.sort((a, b) => a - b), [10, 30]);
  assert.equal(failures.length, 2);
  assert.match(failures[0]!.error.message, /boom/);
});

test("mapSettled respects the concurrency ceiling", async () => {
  let active = 0;
  let peak = 0;
  await mapSettled(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await sleep(5);
    active -= 1;
  });
  assert.ok(peak <= 3, `peak concurrency was ${peak}, expected <= 3`);
});

// ─── scheduler ──────────────────────────────────────────────────────────────

test("runOnce fires every task exactly once, in order", async () => {
  const order: string[] = [];
  const scheduler = new Scheduler(
    [
      { name: "a", intervalMs: 1000, handler: async () => void order.push("a") },
      { name: "b", intervalMs: 1000, handler: async () => void order.push("b") },
    ],
    silent,
    false, // keepAlive off: a forgotten timer must not hang the test runner
  );
  await scheduler.runOnce();
  assert.deepEqual(order, ["a", "b"]);
});

test("a task that throws does not take down the scheduler", async () => {
  const order: string[] = [];
  const scheduler = new Scheduler(
    [
      { name: "bad", intervalMs: 1000, handler: async () => { throw new Error("nope"); } },
      { name: "good", intervalMs: 1000, handler: async () => void order.push("good") },
    ],
    silent,
    false, // keepAlive off: a forgotten timer must not hang the test runner
  );
  await scheduler.runOnce();
  // The next tick retries; one failing poller must not stop the pipeline.
  assert.deepEqual(order, ["good"]);
});

test("overlapping ticks are skipped, not stacked", async () => {
  let started = 0;
  const warnings: string[] = [];
  const scheduler = new Scheduler(
    [{ name: "slow", intervalMs: 10, handler: async () => { started += 1; await sleep(120); } }],
    { ...silent, warn: (m) => warnings.push(m) },
    false,
  );

  scheduler.start();
  await sleep(90);
  await scheduler.stop();

  // Stacking ticks is how a briefly-slow API becomes a self-inflicted outage.
  assert.equal(started, 1, `handler started ${started} times; overlap guard failed`);
  assert.ok(warnings.some((w) => w.includes("still running")));
});

test("stop() waits for in-flight work", async () => {
  let finished = false;
  const scheduler = new Scheduler(
    [{ name: "t", intervalMs: 10_000, handler: async () => { await sleep(60); finished = true; } }],
    silent,
    false, // keepAlive off: a forgotten timer must not hang the test runner
  );
  scheduler.start();
  await sleep(10);
  await scheduler.stop();
  assert.equal(finished, true, "stop() returned before the handler completed");
});

// ─── repository ─────────────────────────────────────────────────────────────

interface Captured { sql: string; values: unknown[] }

function stubPool(): { pool: Pool; captured: Captured[] } {
  const captured: Captured[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      captured.push({ sql, values });
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  return { pool, captured };
}

const observed = <T>(value: T | null, extra: Partial<Observed<T>> = {}): Observed<T> => ({
  value,
  provenance: { kind: "inferred", sourceKey: "x.y", container: "super_props" },
  ...extra,
});

function sample(over: Partial<HealthSample> = {}): HealthSample {
  const base: HealthSample = {
    deviceId: "canvas-1",
    observedAt: new Date("2026-08-25T10:00:00Z"),
    presence: { value: "online", provenance: { kind: "documented", field: "presence" } },
    isScreenOn: { value: true, provenance: { kind: "documented", field: "is_screen_on" } },
    isBlackScreen: { value: false, provenance: { kind: "documented", field: "is_black_screen" } },
    showingLogo: { value: false, provenance: { kind: "documented", field: "showing_logo" } },
    downloading: { value: false, provenance: { kind: "documented", field: "downloading" } },
    softwareUpdateStatus: { value: null, provenance: { kind: "unavailable", reason: "absent" } },
    pingQuality: { value: "no", provenance: { kind: "documented", field: "ping_quality" } },
    playbackQuality: { value: "ok", provenance: { kind: "documented", field: "playback_quality" } },
    nowPlayingType: { value: "ad", provenance: { kind: "documented", field: "status.current.type" } },
    nowPlayingId: { value: "e1128b15", provenance: { kind: "documented", field: "status.current.id" } },
    cpuPercent: observed(42),
    ramPercent: observed(70),
    temperatureC: observed(55),
    wifiSignalDbm: observed(-60),
    packetLossPercent: observed(0.4),
    jitterMs: observed(6),
    ntpSyncPercent: observed(97),
    storagePercent: observed(50),
    uptimeSeconds: observed(1000),
  };
  return { ...base, ...over };
}

test("insertHealthSamples is idempotent and tags its source", async () => {
  const { pool, captured } = stubPool();
  await new Repository(pool).insertHealthSamples([sample()], "metrics");

  assert.equal(captured.length, 1);
  assert.match(captured[0]!.sql, /ON CONFLICT \(device_id, observed_at, source\) DO NOTHING/);
  assert.ok(captured[0]!.values.includes("metrics"));
});

test("an AMBIGUOUS value is never persisted", async () => {
  const { pool, captured } = stubPool();
  await new Repository(pool).insertHealthSamples(
    [sample({ cpuPercent: observed(0.684, { ambiguous: "could be 0.684% or 68.4%" }) })],
    "metrics",
  );

  const values = captured[0]!.values;
  // 0.684 might really be 68.4 — persisting it would poison every trend and
  // threshold that reads the column afterwards. It must land as NULL...
  assert.equal(values.includes(0.684), false, "ambiguous value leaked into the insert");

  // ...but the fact must survive in provenance so it can be reprocessed.
  const provenance = values.find(
    (v): v is string => typeof v === "string" && v.includes("cpuPercent"),
  );
  assert.ok(provenance, "provenance blob missing");
  assert.match(provenance, /"ambiguous":true/);
});

test("provenance records unavailable fields distinctly from resolved ones", async () => {
  const { pool, captured } = stubPool();
  await new Repository(pool).insertHealthSamples(
    [sample({ cpuPercent: { value: null, provenance: { kind: "unavailable", reason: "no key" } } })],
    "status",
  );

  const provenance = JSON.parse(
    captured[0]!.values.find(
      (v): v is string => typeof v === "string" && v.startsWith("{"),
    )!,
  ) as Record<string, { unavailable?: boolean; key?: string }>;

  assert.equal(provenance["cpuPercent"]?.unavailable, true);
  assert.equal(provenance["ramPercent"]?.key, "x.y");
});

test("upsertDevices refreshes fields but preserves first_seen_at", async () => {
  const { pool, captured } = stubPool();
  await new Repository(pool).upsertDevices([
    {
      id: "c1", deviceId: "d1", deviceJid: "d1@canvas.videri.internal", name: "Lobby",
      deviceClass: "canvas", modelType: "V4", productName: null, vendor: null,
      serialNo: null, tenantCode: "T", groupId: null, groupName: null, accountName: null,
      location: "NY", latitude: 40.7, longitude: -74, timezone: "America/New_York",
      orientation: "landscape", screenWidth: 1920, screenHeight: 1080,
      firmwareCurrent: "3.4.1", firmwareLatest: "3.4.1", licenseStatus: "active",
      components: { "com.videri.icanvasplayer": { current: "3.4.1", latest: "3.4.1" } },
      firmwareBuildId: "dpc4xx-vle1.9.20.1001", firmwareIncrementalVersion: "1001",
      licenseExpiration: null, firstActivated: null, lastOnlineTime: null,
      statusChangedTime: null, tags: ["lobby"],
      metafields: { NAME: "Lobby North", CITY: "NEW YORK" }, city: "NEW YORK",
    },
  ]);

  const sql = captured[0]!.sql;
  assert.match(sql, /ON CONFLICT \(id\) DO UPDATE/);
  assert.match(sql, /last_synced_at = now\(\)/);
  assert.equal(/first_seen_at\s*=/.test(sql), false, "first_seen_at must not be overwritten");
});

test("empty input writes nothing at all", async () => {
  const { pool, captured } = stubPool();
  const repo = new Repository(pool);
  await repo.upsertDevices([]);
  await repo.insertHealthSamples([], "metrics");
  await repo.upsertDataUsage([]);
  await repo.storeRawPayloads([]);
  await repo.recordDiscoveredKeys([]);
  assert.equal(captured.length, 0);
});

test("invalid timestamps become NULL rather than Invalid Date", async () => {
  const { pool, captured } = stubPool();
  await new Repository(pool).upsertDevices([
    {
      id: "c2", deviceId: null, deviceJid: null, name: null, deviceClass: "unknown",
      modelType: null, productName: null, vendor: null, serialNo: null, tenantCode: null,
      groupId: null, groupName: null, accountName: null, location: null, latitude: null,
      longitude: null, timezone: null, orientation: null, screenWidth: null,
      screenHeight: null, firmwareCurrent: null, firmwareLatest: null, licenseStatus: null,
      components: {}, firmwareBuildId: null, firmwareIncrementalVersion: null,
      metafields: {}, city: null,
      licenseExpiration: "not-a-date", firstActivated: "", lastOnlineTime: null,
      statusChangedTime: null, tags: [],
    },
  ]);

  const invalidDates = captured[0]!.values.filter(
    (v) => v instanceof Date && Number.isNaN(v.getTime()),
  );
  assert.equal(invalidDates.length, 0, "an Invalid Date would abort the whole batch in pg");
});

// ─────────────────────────────────────────────────────────────────────────────
// The daemon must actually stay running
//
// It did not. Every timer was unref()'d, so once the startup burst of work
// finished Node had nothing holding the event loop and exited with "Detected
// unsettled top-level await" — after logging "started 9 task(s)", which made it
// look healthy. Continuous collection therefore never happened: SLA collection
// coverage sat near 1% and no device was ever claimable.
// ─────────────────────────────────────────────────────────────────────────────

test("a started scheduler keeps the event loop alive", async () => {
  const scheduler = new Scheduler(
    [{ name: "tick", intervalMs: 50_000, runOnStart: false, handler: async () => {} }],
    silent,
  );
  scheduler.start();
  // A ref'd timer is the whole mechanism: without it the process exits before
  // the first interval elapses.
  const refd = scheduler.pendingTimerCount();
  assert.ok(refd > 0, "start() must leave a pending timer");
  assert.ok(scheduler.keepsProcessAlive(), "daemon timers must hold the event loop");
  await scheduler.stop();
  assert.equal(scheduler.pendingTimerCount(), 0, "stop() must clear every timer");
});

test("keepAlive:false still schedules, it just does not hold the loop", async () => {
  const scheduler = new Scheduler(
    [{ name: "tick", intervalMs: 50_000, runOnStart: false, handler: async () => {} }],
    silent,
    false,
  );
  scheduler.start();
  assert.ok(scheduler.pendingTimerCount() > 0);
  assert.equal(scheduler.keepsProcessAlive(), false);
  await scheduler.stop();
});
