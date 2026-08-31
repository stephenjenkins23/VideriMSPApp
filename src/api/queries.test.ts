/**
 * Read-query SHAPING tests — `node --test dist/api/queries.test.js`
 *
 * `ReadQueries` is the boundary where pg row shapes become the API's contract, and
 * it is the last place a `null` can quietly become a `0`. The methods are not pure
 * — they issue SQL — so they run here against a stub pool that both RETURNS canned
 * rows and CAPTURES the SQL, which is enough to pin the two things that matter:
 *
 *   1. row → payload shaping: pg numeric strings coerced, unreadable metrics
 *      arriving as null, jsonb guarded, Dates rendered as ISO;
 *   2. the handful of SQL invariants that are silently catastrophic if edited —
 *      above all that proof-of-play coverage takes its NUMERATOR from the
 *      persisted-schedule join and its DENOMINATOR from the whole device table.
 *      Count both from the join and coverage is permanently 100%, which is a lie
 *      no downstream test could catch.
 *
 * No pool, no network: `stubPool` is a plain object.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { ReadQueries, type DeviceListFilters } from "./queries.js";

interface Captured {
  sql: string;
  values: unknown[];
}

type Responder = (sql: string) => Array<Record<string, unknown>> | undefined;

/** Captures every statement and answers from `responder`, defaulting to no rows. */
function stubPool(responder: Responder = () => undefined): {
  pool: Pool;
  captured: Captured[];
  sqlMatching: (needle: string | RegExp) => Captured[];
} {
  const captured: Captured[] = [];
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      captured.push({ sql, values });
      const rows = responder(sql) ?? [];
      return { rows, rowCount: rows.length };
    },
  } as unknown as Pool;
  return {
    pool,
    captured,
    sqlMatching: (needle) =>
      captured.filter((c) =>
        typeof needle === "string" ? c.sql.includes(needle) : needle.test(c.sql),
      ),
  };
}

const isCount = (sql: string) => sql.includes("COUNT(*)::text AS count");

// ─── popPersistedSchedules (US-4.5, fleet-wide persisted path) ────────────────

/** A row exactly as the persisted-schedule query returns it: Dates and jsonb. */
const scheduleRow = (over: Record<string, unknown> = {}) => ({
  id: "canvas-1",
  name: "Lobby North",
  scheduled_items: [
    { assetUuid: "a1", assetType: "image", durationMs: 10000, startTime: null, endTime: null, priority: 1, frequency: "loop" },
  ],
  scheduled_count: 1,
  schedule_observed_at: new Date("2026-08-31T12:05:00Z"),
  fetched_at: new Date("2026-08-31T12:00:00Z"),
  is_screen_on: true,
  is_black_screen: false,
  showing_logo: false,
  screen_observed_at: new Date("2026-08-31T12:04:00Z"),
  ...over,
});

const persistedPool = (rows: Array<Record<string, unknown>>, fleetCount: string | null = "10") =>
  stubPool((sql) => {
    if (isCount(sql)) return fleetCount === null ? [] : [{ count: fleetCount }];
    if (sql.includes("FROM device_schedule")) return rows;
    return [];
  });

test("popPersistedSchedules renders Date columns as ISO strings", async () => {
  const { pool } = persistedPool([scheduleRow()]);
  const { devices } = await new ReadQueries(pool).popPersistedSchedules();
  assert.equal(devices[0]!.fetchedAt, "2026-08-31T12:00:00.000Z");
  assert.equal(devices[0]!.scheduleObservedAt, "2026-08-31T12:05:00.000Z");
  assert.equal(devices[0]!.screenObservedAt, "2026-08-31T12:04:00.000Z");
});

test("a scheduled device with no screen sample yet is null screen-state, not a crash", async () => {
  // Screen-state is a LEFT JOIN: the device has a schedule but we have never
  // sampled its panel. The engine must receive nulls (→ "unknown"), and the
  // shaping must not throw on the missing Date.
  const { pool } = persistedPool([
    scheduleRow({
      is_screen_on: null,
      is_black_screen: null,
      showing_logo: null,
      screen_observed_at: null,
    }),
  ]);
  const { devices } = await new ReadQueries(pool).popPersistedSchedules();
  assert.equal(devices[0]!.isScreenOn, null);
  assert.equal(devices[0]!.isBlackScreen, null);
  assert.equal(devices[0]!.showingLogo, null);
  assert.equal(devices[0]!.screenObservedAt, null);
});

test("undefined screen columns normalise to null rather than leaking undefined", async () => {
  const row = scheduleRow();
  delete (row as Record<string, unknown>)["is_screen_on"];
  delete (row as Record<string, unknown>)["showing_logo"];
  const { pool } = persistedPool([row]);
  const { devices } = await new ReadQueries(pool).popPersistedSchedules();
  assert.equal(devices[0]!.isScreenOn, null);
  assert.equal(devices[0]!.showingLogo, null);
  // JSON.stringify would drop an undefined and the client would see no key at all.
  assert.equal("isScreenOn" in devices[0]!, true);
});

test("a null or non-array scheduled_items jsonb becomes an empty schedule, never invented events", async () => {
  for (const bad of [null, undefined, {}, "[]", 5]) {
    const { pool } = persistedPool([scheduleRow({ scheduled_items: bad })]);
    const { devices } = await new ReadQueries(pool).popPersistedSchedules();
    assert.deepEqual(
      devices[0]!.scheduledItems,
      [],
      `unexpected parse of scheduled_items = ${JSON.stringify(bad)}`,
    );
  }
});

test("scheduled_items jsonb passes through verbatim — the slow lane already filtered it to now", async () => {
  const items = [
    { assetUuid: "a1", assetType: "image", durationMs: 1, startTime: "08:00", endTime: "18:00", priority: 1, frequency: "loop" },
    { assetUuid: "a2", assetType: "video", durationMs: 2, startTime: null, endTime: null, priority: 2, frequency: "once" },
  ];
  const { pool } = persistedPool([scheduleRow({ scheduled_items: items, scheduled_count: 2 })]);
  const { devices } = await new ReadQueries(pool).popPersistedSchedules();
  assert.deepEqual(devices[0]!.scheduledItems, items);
  assert.equal(devices[0]!.scheduledCount, 2);
});

test("scheduled_count arrives as a number even when pg hands back a string", async () => {
  const { pool } = persistedPool([scheduleRow({ scheduled_count: "3" })]);
  const { devices } = await new ReadQueries(pool).popPersistedSchedules();
  assert.equal(devices[0]!.scheduledCount, 3);
  assert.equal(typeof devices[0]!.scheduledCount, "number");
});

test("a null device name falls back to no name, never to an empty string", async () => {
  const { pool } = persistedPool([scheduleRow({ name: null })]);
  const { devices } = await new ReadQueries(pool).popPersistedSchedules();
  assert.equal(devices[0]!.name, null);
});

test("fleetDevices is the honest denominator: the active fleet, not the join", async () => {
  // The invariant that makes proof-of-play coverage meaningful. If this count were
  // taken over the persisted-schedule join, coverage would read 100% forever.
  const { pool, captured } = persistedPool([scheduleRow({ id: "a" }), scheduleRow({ id: "b" })], "94");
  const res = await new ReadQueries(pool).popPersistedSchedules();

  assert.equal(res.fleetDevices, 94);
  assert.equal(res.devices.length, 2, "only devices with a snapshot are judged");

  const countStmt = captured.find((c) => isCount(c.sql));
  assert.ok(countStmt, "a fleet count statement was issued");
  assert.match(countStmt!.sql, /FROM devices\b/);
  assert.equal(
    /device_schedule/.test(countStmt!.sql),
    false,
    "the denominator must not be filtered by the schedule join",
  );
  // …but it IS filtered on retirement: a retired row is a device the platform no
  // longer has, and counting it would hold coverage permanently below 100% against
  // a device that can never get a schedule again.
  assert.match(
    countStmt!.sql,
    /retired_at IS NULL/,
    "the denominator must exclude retired devices",
  );
});

test("fleetDevices is 0 rather than NaN when the count row is missing", async () => {
  const { pool } = persistedPool([], null);
  const res = await new ReadQueries(pool).popPersistedSchedules();
  assert.equal(res.fleetDevices, 0);
  assert.ok(Number.isFinite(res.fleetDevices));
});

test("an empty device_schedule table yields no devices, which is what triggers the live fallback", async () => {
  const { pool } = persistedPool([], "94");
  const res = await new ReadQueries(pool).popPersistedSchedules();
  assert.deepEqual(res.devices, []);
  assert.equal(res.fleetDevices, 94, "the fleet is still reported — 0 of 94 covered");
});

test("the persisted-schedule read takes only the LATEST snapshot per device, stalest device first", async () => {
  const { pool, sqlMatching } = persistedPool([scheduleRow()]);
  await new ReadQueries(pool).popPersistedSchedules();
  const [stmt] = sqlMatching("FROM device_schedule");
  assert.ok(stmt, "the schedule join statement was issued");
  // One row per device: newest snapshot, LIMIT 1 inside the lateral.
  assert.match(stmt!.sql, /ORDER BY observed_at DESC LIMIT 1/);
  // Stalest snapshot surfaces first, so a partial sweep shows its weakest edge.
  assert.match(stmt!.sql, /ORDER BY sch\.observed_at ASC/);
  // An INNER lateral join: a device with no snapshot has nothing to judge and is
  // absent, rather than appearing as a device with an empty schedule.
  assert.match(stmt!.sql, /JOIN LATERAL[\s\S]*FROM device_schedule/);
  assert.equal(
    /LEFT JOIN LATERAL\s*\(\s*SELECT scheduled_items/.test(stmt!.sql),
    false,
    "device_schedule must be an inner join",
  );
});

test("the persisted read touches only our own tables and never caps its row count", async () => {
  // The whole point of US-4.5: no outbound calls, so no cap is needed and the
  // report can cover every device that has a snapshot.
  const { pool, sqlMatching } = persistedPool([scheduleRow()]);
  await new ReadQueries(pool).popPersistedSchedules();
  const [stmt] = sqlMatching("FROM device_schedule");
  assert.equal(
    /LIMIT \d+\s*$/.test(stmt!.sql.trim()),
    false,
    "the fleet-wide read must not be truncated",
  );
});

// ─── popScreenState (the bounded live-sample fallback) ────────────────────────

const screenRow = (over: Record<string, unknown> = {}) => ({
  id: "canvas-1",
  name: "Lobby North",
  is_screen_on: true,
  is_black_screen: false,
  showing_logo: false,
  observed_at: new Date("2026-08-31T12:00:00Z"),
  ...over,
});

test("popScreenState reports the full eligible total alongside the capped batch", async () => {
  // Truncation must be visible: 40 returned out of 900 eligible is reported as
  // such, never as "the fleet is 40 devices".
  const rows = Array.from({ length: 40 }, (_, i) => screenRow({ id: `c${i}` }));
  const { pool } = stubPool((sql) => (isCount(sql) ? [{ count: "900" }] : rows));
  const res = await new ReadQueries(pool).popScreenState(40);
  assert.equal(res.devices.length, 40);
  assert.equal(res.eligibleTotal, 900, "the tail is disclosed, not dropped");
});

test("popScreenState eligible total is 0, not NaN, when nothing is eligible", async () => {
  const { pool } = stubPool(() => []);
  const res = await new ReadQueries(pool).popScreenState(40);
  assert.equal(res.eligibleTotal, 0);
  assert.deepEqual(res.devices, []);
});

test("popScreenState applies the limit and the window to the SAME eligibility filter", async () => {
  // The count and the rows must share one definition of "eligible", or the
  // reported truncation describes a different population than the batch.
  const { pool, captured } = stubPool((sql) => (isCount(sql) ? [{ count: "5" }] : [screenRow()]));
  await new ReadQueries(pool).popScreenState(7, 12);
  assert.equal(captured.length, 2);
  for (const c of captured) {
    assert.match(c.sql, /hs\.observed_at IS NOT NULL/);
    assert.deepEqual(c.values, ["12"], "the window hours are bound as a parameter");
  }
  const rowsStmt = captured.find((c) => !isCount(c.sql))!;
  assert.match(rowsStmt.sql, /LIMIT 7/);
  assert.match(rowsStmt.sql, /ORDER BY hs\.observed_at DESC/, "freshest screen-state first");
});

test("popScreenState carries honest nulls for an unread panel", async () => {
  const { pool } = stubPool((sql) =>
    isCount(sql)
      ? [{ count: "1" }]
      : [screenRow({ is_screen_on: null, is_black_screen: null, showing_logo: null, observed_at: null })],
  );
  const res = await new ReadQueries(pool).popScreenState(10);
  assert.equal(res.devices[0]!.isScreenOn, null);
  assert.equal(res.devices[0]!.isBlackScreen, null);
  assert.equal(res.devices[0]!.showingLogo, null);
  assert.equal(res.devices[0]!.screenObservedAt, null);
});

// ─── device list shaping: numeric coercion and honest nulls ───────────────────

const filters = (over: Partial<DeviceListFilters> = {}): DeviceListFilters => ({
  page: 1,
  limit: 25,
  sort: "name",
  direction: "asc",
  ...over,
});

const listRow = (over: Record<string, unknown> = {}) => ({
  id: "canvas-1",
  name: "Lobby North",
  location: "New York, NY",
  city: "New York",
  device_class: "canvas",
  model_type: "V4",
  status: "online",
  last_online_time: new Date("2026-08-31T11:59:00Z"),
  firmware_current: "3.3.8",
  firmware_latest: "3.4.1",
  observed_at: new Date("2026-08-31T11:59:00Z"),
  presence: "online",
  is_screen_on: true,
  is_black_screen: false,
  showing_logo: false,
  cpu_percent: "42.5",
  ram_percent: "70",
  temperature_c: null,
  wifi_signal_dbm: "-60",
  critical: "0",
  high: "1",
  medium: "0",
  info: "1",
  total: "2",
  ...over,
});

const listPool = (rows: Array<Record<string, unknown>>, count = String(rows.length)) =>
  stubPool((sql) => (isCount(sql) ? [{ count }] : rows));

test("pg numeric strings are coerced to numbers in the device list", async () => {
  const { pool } = listPool([listRow()]);
  const { items } = await new ReadQueries(pool).devices(filters());
  assert.equal(items[0]!.latest.cpuPercent, 42.5);
  assert.equal(items[0]!.latest.ramPercent, 70);
  assert.equal(items[0]!.latest.wifiSignalDbm, -60);
  assert.equal(typeof items[0]!.latest.cpuPercent, "number");
});

test("HONEST NULL: an unreadable metric stays null and never becomes 0", async () => {
  const { pool } = listPool([
    listRow({ cpu_percent: null, ram_percent: null, temperature_c: null, wifi_signal_dbm: null }),
  ]);
  const { items } = await new ReadQueries(pool).devices(filters());
  assert.equal(items[0]!.latest.cpuPercent, null);
  assert.equal(items[0]!.latest.ramPercent, null);
  assert.equal(items[0]!.latest.temperatureC, null);
  assert.equal(items[0]!.latest.wifiSignalDbm, null);
});

test("pg's 'NaN' numeric is an honest null, not a NaN that JSON-encodes as null-by-accident", async () => {
  const { pool } = listPool([listRow({ cpu_percent: "NaN", ram_percent: "not-a-number" })]);
  const { items } = await new ReadQueries(pool).devices(filters());
  assert.equal(items[0]!.latest.cpuPercent, null);
  assert.equal(items[0]!.latest.ramPercent, null);
});

test("a genuine zero reading is preserved, because 0% is data", async () => {
  // The mirror of the honest-null rule: a real zero must survive. Coercing it to
  // null would hide a device that truly reports 0.
  const { pool } = listPool([listRow({ cpu_percent: "0", wifi_signal_dbm: "0" })]);
  const { items } = await new ReadQueries(pool).devices(filters());
  assert.equal(items[0]!.latest.cpuPercent, 0);
  assert.equal(items[0]!.latest.wifiSignalDbm, 0);
});

test("firmwareBehind is derived from the two versions, never read from the row", async () => {
  const behind = await new ReadQueries(
    listPool([listRow({ firmware_current: "3.3.8", firmware_latest: "3.4.1" })]).pool,
  ).devices(filters());
  assert.equal(behind.items[0]!.firmwareBehind, true);

  const level = await new ReadQueries(
    listPool([listRow({ firmware_current: "3.4.1", firmware_latest: "3.4.1" })]).pool,
  ).devices(filters());
  assert.equal(level.items[0]!.firmwareBehind, false);

  // Unknown on either side is not "behind" — an unread version is not a fault.
  const unknown = await new ReadQueries(
    listPool([listRow({ firmware_current: null, firmware_latest: "3.4.1" })]).pool,
  ).devices(filters());
  assert.equal(unknown.items[0]!.firmwareBehind, false);
});

test("alert counts are numbers, and an absent lateral row counts as zero alerts", async () => {
  const { pool } = listPool([
    listRow({ critical: null, high: null, medium: null, info: null, total: null }),
  ]);
  const { items } = await new ReadQueries(pool).devices(filters());
  // Here 0 is honest: the lateral counted open alerts and found none.
  assert.deepEqual(items[0]!.openAlerts, { critical: 0, high: 0, medium: 0, info: 0, total: 0 });
});

test("totalItems comes from the count query, so pagination cannot report the page size as the fleet", async () => {
  const rows = Array.from({ length: 25 }, (_, i) => listRow({ id: `c${i}` }));
  const { pool } = listPool(rows, "1247");
  const res = await new ReadQueries(pool).devices(filters({ page: 3, limit: 25 }));
  assert.equal(res.items.length, 25);
  assert.equal(res.totalItems, 1247);
});

test("page and limit become a LIMIT/OFFSET pair, and both queries share one WHERE", async () => {
  const { pool, captured } = listPool([listRow()], "100");
  await new ReadQueries(pool).devices(filters({ page: 3, limit: 20, status: "offline" }));
  const rowsStmt = captured.find((c) => !isCount(c.sql))!;
  const countStmt = captured.find((c) => isCount(c.sql))!;
  assert.match(rowsStmt.sql, /LIMIT 20 OFFSET 40/);
  assert.deepEqual(
    countStmt.values,
    rowsStmt.values,
    "the count must be filtered identically to the page, or totals lie",
  );
  assert.deepEqual(rowsStmt.values, ["offline"]);
});

test("a search term is parameterised, never concatenated into the SQL", async () => {
  const { pool, captured } = listPool([], "0");
  await new ReadQueries(pool).devices(filters({ search: "'; DROP TABLE devices --" }));
  for (const c of captured) {
    assert.equal(c.sql.includes("DROP TABLE"), false, "the term must not reach the statement text");
    assert.deepEqual(c.values, ["%'; DROP TABLE devices --%"]);
  }
});

test("totalItems is 0 rather than NaN when the count row is missing", async () => {
  const { pool } = stubPool(() => []);
  const res = await new ReadQueries(pool).devices(filters());
  assert.equal(res.totalItems, 0);
  assert.deepEqual(res.items, []);
});

// ─── telemetryAvailability (the "why is this tile empty" signal) ──────────────

test("telemetryAvailability reports readable-out-of-total per field", async () => {
  const { pool } = stubPool(() => [
    {
      total: "100",
      cpu_percent: "0",
      ram_percent: "0",
      temperature_c: "12",
      wifi_signal_dbm: "0",
      ntp_sync_percent: "0",
      storage_percent: "0",
      playback_quality: "95",
    },
  ]);
  const out = await new ReadQueries(pool).telemetryAvailability();

  // A field readable on 0 of 100 devices is the honest description of the bulk
  // feed carrying no hardware telemetry — it is why the UI greys a tile out
  // instead of drawing a flat line at zero.
  assert.deepEqual(out["cpu_percent"], { readable: 0, total: 100 });
  assert.deepEqual(out["playback_quality"], { readable: 95, total: 100 });
  assert.deepEqual(out["temperature_c"], { readable: 12, total: 100 });
  assert.equal("total" in out, false, "the denominator is not itself reported as a field");
});

test("telemetryAvailability with no samples at all reports nothing rather than 0-of-0 coverage", async () => {
  const { pool } = stubPool(() => []);
  const out = await new ReadQueries(pool).telemetryAvailability();
  assert.deepEqual(out, {});
});

test("telemetryAvailability distinguishes a zero-sample denominator from readable data", async () => {
  const { pool } = stubPool(() => [{ total: "0", cpu_percent: "0" }]);
  const out = await new ReadQueries(pool).telemetryAvailability();
  assert.deepEqual(out["cpu_percent"], { readable: 0, total: 0 });
});
