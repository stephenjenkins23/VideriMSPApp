/**
 * Device action log repository tests —
 *   `node --test dist/db/action-log-repo.test.js`
 *
 * Same approach as repository.test.ts and screen-verdict-repo.test.ts: a stub
 * pool that captures SQL and parameters, no database and no migrations.
 *
 * What is guarded here is the SQL, because every way of getting an audit query
 * wrong is silent and plausible:
 *
 *   - drop a WHERE clause and "everything we did to device X" returns the whole
 *     fleet's history under that device's heading;
 *   - bind the filters in a different order than they are appended and the query
 *     runs, matches the wrong rows, and errors nowhere;
 *   - make the window closed on both ends and two adjacent windows both contain
 *     the boundary row;
 *   - use an INNER JOIN for the device name and every action against a device
 *     that has since been removed vanishes from the audit — exactly the rows a
 *     dispute is about;
 *   - order by id and a log written across a clock adjustment reads out of order.
 *
 * It also pins the two properties that make this table an audit trail rather
 * than another time series: the insert never throws, and the prune has a floor.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { AUDIT_MIN_RETAIN_DAYS, AUDIT_RETAIN_DAYS, Repository } from "./repository.js";

interface Captured { sql: string; values: unknown[] }

function stubPool(opts: { rows?: Array<Record<string, unknown>>; fail?: string } = {}): {
  pool: Pool;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      captured.push({ sql, values });
      if (opts.fail) throw new Error(opts.fail);
      // The totals query is an aggregate; the page query returns rows.
      if (sql.includes("count(*)")) {
        return { rows: [{ n: "3", oldest: new Date("2026-09-01T00:00:00Z"), newest: new Date("2026-09-02T00:00:00Z") }], rowCount: 1 };
      }
      return { rows: opts.rows ?? [], rowCount: (opts.rows ?? []).length };
    },
  } as unknown as Pool;
  return { pool, captured };
}

const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

// ─── recordDeviceAction ─────────────────────────────────────────────────────

test("an action is inserted with every audit column bound in order", async () => {
  const { pool, captured } = stubPool({ rows: [{ id: "42" }] });
  const startedAt = new Date("2026-09-02T10:00:00Z");
  const finishedAt = new Date("2026-09-02T10:00:04Z");

  const result = await new Repository(pool).recordDeviceAction({
    action: "brightness_write", verb: "set_brightness", deviceId: "1000152",
    requestedValue: "70%", observedValue: null,
    params: { arg: "set_brightness:=179" }, detail: { mode: "verify" },
    outcome: "rolled_back", actor: "api:stephen", actorIp: "10.0.0.4",
    startedAt, finishedAt, durationMs: 4000, error: "did not verify",
  });

  const sql = flat(captured[0]!.sql);
  assert.match(sql, /INSERT INTO device_action_log/);
  assert.match(sql, /RETURNING id/);
  assert.deepEqual(captured[0]!.values, [
    "brightness_write", "set_brightness", "1000152", "70%", null,
    '{"arg":"set_brightness:=179"}', '{"mode":"verify"}',
    "rolled_back", "api:stephen", "10.0.0.4", startedAt, finishedAt, 4000, "did not verify",
  ]);
  assert.deepEqual(result, { id: 42, error: null });
});

test("an unreadable value is stored as NULL, never as a zero", async () => {
  const { pool, captured } = stubPool({ rows: [{ id: "1" }] });
  await new Repository(pool).recordDeviceAction({
    action: "brightness_write", deviceId: "d1", outcome: "refused",
    requestedValue: "70%", actor: "api:token", startedAt: new Date(),
  });
  const values = captured[0]!.values;
  // observed_value is the 5th column; a 0 here would read as a blanked panel.
  assert.equal(values[4], null);
  assert.notEqual(values[4], 0);
});

test("recordDeviceAction NEVER throws — it returns the failure for the caller to log", async () => {
  // The device operation must survive a missing table, a broken connection, or
  // anything else the insert can hit.
  const { pool } = stubPool({ fail: 'relation "device_action_log" does not exist' });
  const result = await new Repository(pool).recordDeviceAction({
    action: "brightness_write", deviceId: "d1", outcome: "verified",
    actor: "api:token", startedAt: new Date(),
  });
  assert.equal(result.id, null);
  assert.match(result.error!, /device_action_log/);
});

// ─── listDeviceActions: the four questions ──────────────────────────────────

const list = async (filters: Parameters<Repository["listDeviceActions"]>[0]) => {
  const { pool, captured } = stubPool();
  const result = await new Repository(pool).listDeviceActions(filters);
  // [0] is the totals aggregate, [1] is the page.
  return { result, totals: captured[0]!, page: captured[1]!, captured };
};

test("no filters means no WHERE clause at all", async () => {
  const { totals, page } = await list({ page: 1, limit: 50 });
  assert.doesNotMatch(flat(totals.sql), /WHERE/);
  assert.doesNotMatch(flat(page.sql), /WHERE l\./);
});

test("each filter contributes its own predicate, and only its own", async () => {
  for (const [filters, predicate] of [
    [{ deviceId: "1000152" }, /l\.device_id = \$1/],
    [{ actor: "api:stephen" }, /l\.actor = \$1/],
    [{ action: "brightness_write" }, /l\.action = \$1/],
    [{ outcome: ["failed" as const] }, /l\.outcome = ANY\(\$1::text\[\]\)/],
  ] as Array<[Partial<Parameters<Repository["listDeviceActions"]>[0]>, RegExp]>) {
    const { totals } = await list({ page: 1, limit: 50, ...filters });
    assert.match(flat(totals.sql), predicate);
  }
});

test("the time window is HALF-OPEN, so two adjacent windows never share a row", async () => {
  const since = new Date("2026-09-01T00:00:00Z");
  const until = new Date("2026-09-02T00:00:00Z");
  const { totals } = await list({ page: 1, limit: 50, since, until });
  const sql = flat(totals.sql);
  assert.match(sql, /l\.started_at >= \$1/);
  assert.match(sql, /l\.started_at < \$2/);
  assert.doesNotMatch(sql, /started_at <= /);
  assert.deepEqual(totals.values, [since, until]);
});

test("filters combine with AND and bind in the order they are appended", async () => {
  const since = new Date("2026-09-01T00:00:00Z");
  const { totals, page } = await list({
    page: 2, limit: 10,
    deviceId: "1000152", actor: "api:stephen", outcome: ["failed", "rolled_back"],
    action: "brightness_write", since,
  });
  const sql = flat(totals.sql);
  assert.match(
    sql,
    /WHERE l\.device_id = \$1 AND l\.actor = \$2 AND l\.outcome = ANY\(\$3::text\[\]\) AND l\.action = \$4 AND l\.started_at >= \$5/,
  );
  assert.deepEqual(totals.values, [
    "1000152", "api:stephen", ["failed", "rolled_back"], "brightness_write", since,
  ]);
  // The page query reuses the same predicates and appends LIMIT/OFFSET after them.
  assert.match(flat(page.sql), /LIMIT \$6 OFFSET \$7/);
  assert.deepEqual(page.values.slice(5), [10, 10]);
});

test("the page is ordered newest-first with an id tiebreak, never by id alone", async () => {
  const { page } = await list({ page: 1, limit: 50 });
  const sql = flat(page.sql);
  // started_at is what a human reads an audit by; the id only breaks ties within
  // the same instant.
  assert.match(sql, /ORDER BY l\.started_at DESC, l\.id DESC/);
});

test("the device name is a LEFT JOIN, so an action against a removed device is never lost", async () => {
  const { page } = await list({ page: 1, limit: 50 });
  const sql = flat(page.sql);
  assert.match(sql, /LEFT JOIN devices d ON d\.id = l\.device_id/);
  assert.doesNotMatch(sql, /\bJOIN devices d\b(?! ON d\.id = l\.device_id)/);
  // And an audit read is never narrowed by retirement: what we did to a device
  // that has since been decommissioned is exactly what gets disputed.
  assert.doesNotMatch(sql, /retired_at/);
});

test("the total and the matched span come from ONE aggregate over the filtered set", async () => {
  const { result, totals } = await list({ page: 1, limit: 50, deviceId: "1000152" });
  const sql = flat(totals.sql);
  assert.match(sql, /count\(\*\)::text AS n/);
  assert.match(sql, /MIN\(l\.started_at\) AS oldest/);
  assert.match(sql, /MAX\(l\.started_at\) AS newest/);
  // Derived from the match, not from the page.
  assert.equal(result.totalItems, 3);
  assert.equal(result.oldestAt!.toISOString(), "2026-09-01T00:00:00.000Z");
});

test("OFFSET is derived from the page number, not passed through", async () => {
  const { page } = await list({ page: 4, limit: 25 });
  assert.deepEqual(page.values, [25, 75]);
});

// ─── retention ──────────────────────────────────────────────────────────────

test("the audit log's default bound is two years — an order of magnitude past the metrics windows", async () => {
  const { pool, captured } = stubPool();
  await new Repository(pool).pruneDeviceActionLog();
  assert.equal(AUDIT_RETAIN_DAYS, 730);
  assert.match(flat(captured[0]!.sql), /DELETE FROM device_action_log WHERE started_at </);
  assert.deepEqual(captured[0]!.values, ["730"]);
});

test("the audit log cannot be pruned to a metrics-length window, even on request", async () => {
  const { pool, captured } = stubPool();
  const repo = new Repository(pool);
  // 90 days is the LONGEST window pruneTimeSeries uses. It is still far too
  // short for the record of what we changed on a customer's estate.
  await assert.rejects(() => repo.pruneDeviceActionLog(90), /Refusing to prune/);
  await assert.rejects(() => repo.pruneDeviceActionLog(14), /no less than 365 days/);
  assert.equal(captured.length, 0, "nothing was deleted");
  // The floor itself is a year.
  assert.equal(AUDIT_MIN_RETAIN_DAYS, 365);
  assert.equal(await repo.pruneDeviceActionLog(AUDIT_MIN_RETAIN_DAYS), 0);
});

test("the audit log is NOT swept by pruneTimeSeries", async () => {
  // pruneTimeSeries runs nightly and unattended. An audit trail must not be
  // deleted by the same code path that trims CPU readings, and a future tweak to
  // a metrics window must not be able to shorten it.
  const { pool, captured } = stubPool();
  await new Repository(pool).pruneTimeSeries({});
  const tables = captured.map((c) => /DELETE FROM ([a-z_]+)/i.exec(c.sql)?.[1]);
  assert.ok(!tables.includes("device_action_log"), tables.join(","));
});
