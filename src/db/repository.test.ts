/**
 * Repository tests for the SLOW-LANE rotation and persistence (US-4.5) —
 *   `node --test dist/db/repository.test.js`
 *
 * `pipeline.test.ts` covers the health-sample write path. This file covers the
 * schedule slow lane's two repository methods, which had no tests: target
 * SELECTION and snapshot PERSISTENCE. Both run against a stub pool that captures
 * SQL and parameters — no database, no migrations.
 *
 * Selection is the part worth guarding hardest, because every way of getting it
 * wrong is silent:
 *
 *   - drop the `NULLS FIRST` and a device we have never fetched sinks below every
 *     device we have, so it is never fetched and coverage plateaus;
 *   - drop the `d.id` tiebreak and a fleet of never-fetched devices ties on NULL,
 *     so successive ticks may re-pick the same arbitrary batch and the sweep never
 *     completes;
 *   - copy the telemetry lane's `presence = 'online'` filter in and fleet-wide
 *     proof-of-play quietly shrinks to the online estate, while still presenting
 *     its coverage as fleet-wide.
 *
 * None of those would fail an existing test or raise an error at runtime — they
 * would just make the numbers wrong. Hence asserting the statement itself.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { Repository } from "./repository.js";

interface Captured {
  sql: string;
  values: unknown[];
}

function stubPool(rows: Array<Record<string, unknown>> = []): {
  pool: Pool;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      captured.push({ sql, values });
      return { rows, rowCount: rows.length };
    },
  } as unknown as Pool;
  return { pool, captured };
}

/** Collapse whitespace so multi-line SQL can be matched readably. */
const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

// ─── scheduleSlowLaneTargets: fleet rotation ─────────────────────────────────

test("scheduleSlowLaneTargets orders never-fetched devices first, then stalest", async () => {
  const { pool, captured } = stubPool();
  await new Repository(pool).scheduleSlowLaneTargets(50);

  const sql = flat(captured[0]!.sql);
  // NULLS FIRST is what puts a device we have never read at the front of the queue.
  assert.match(sql, /ORDER BY latest\.observed_at ASC NULLS FIRST/);
  // The lateral picks each device's NEWEST snapshot, so "stalest device" means
  // stalest most-recent-read, not stalest row ever written.
  assert.match(sql, /FROM device_schedule s WHERE s\.device_id = d\.id ORDER BY observed_at DESC LIMIT 1/);
});

test("scheduleSlowLaneTargets breaks ties deterministically so the sweep actually completes", async () => {
  // Before the first sweep every device ties on NULL. Without a stable secondary
  // key the same arbitrary batch can be returned tick after tick and the fleet is
  // never covered.
  const { pool, captured } = stubPool();
  await new Repository(pool).scheduleSlowLaneTargets(50);
  assert.match(flat(captured[0]!.sql), /ORDER BY latest\.observed_at ASC NULLS FIRST, d\.id/);
});

test("scheduleSlowLaneTargets is NOT online-only — that is the point of the lane", async () => {
  // A canvas has a platform schedule whether or not it is reachable; the publisher
  // read is a control-plane call, not a device command. Filtering by presence here
  // would shrink fleet-wide coverage to the online estate while still reporting it
  // as fleet-wide.
  const { pool, captured } = stubPool();
  await new Repository(pool).scheduleSlowLaneTargets(50);

  const sql = captured[0]!.sql;
  assert.equal(/presence/.test(sql), false, "must not filter on presence");
  assert.equal(/'online'/.test(sql), false, "must not filter to the online estate");
  assert.equal(/device_jid/.test(sql), false, "no JID is needed for a control-plane read");
  assert.equal(/health_samples/.test(sql), false, "reachability is irrelevant to a schedule");
});

test("the telemetry lane, by contrast, IS deliberately online-only and JID-bound", async () => {
  // Documents the intended asymmetry, so the two lanes cannot be "unified" by
  // accident in either direction.
  const { pool, captured } = stubPool();
  await new Repository(pool).telemetrySlowLaneTargets(50);
  const sql = flat(captured[0]!.sql);
  assert.match(sql, /d\.device_jid IS NOT NULL/, "a demo_command needs a JID to route");
  assert.match(sql, /presence = 'online'/, "an offline device would burn timeouts to learn nothing");
  assert.match(sql, /ORDER BY latest\.observed_at ASC NULLS FIRST/, "same rotation idea");
});

test("scheduleSlowLaneTargets binds its batch size as a parameter, keeping the tick bounded", async () => {
  const { pool, captured } = stubPool();
  await new Repository(pool).scheduleSlowLaneTargets(120);
  assert.match(flat(captured[0]!.sql), /LIMIT \$1/);
  assert.deepEqual(captured[0]!.values, [120], "the batch size is never interpolated");
});

test("scheduleSlowLaneTargets shapes rows to id and honest-null name", async () => {
  const { pool } = stubPool([
    { id: "canvas-1", name: "Lobby North" },
    { id: "canvas-2", name: null },
  ]);
  const targets = await new Repository(pool).scheduleSlowLaneTargets(50);
  assert.deepEqual(targets, [
    { id: "canvas-1", name: "Lobby North" },
    { id: "canvas-2", name: null },
  ]);
});

test("scheduleSlowLaneTargets on an empty fleet is an empty batch, not an error", async () => {
  const { pool } = stubPool([]);
  assert.deepEqual(await new Repository(pool).scheduleSlowLaneTargets(50), []);
});

// ─── saveSchedule: snapshot persistence ──────────────────────────────────────

const snapshot = (over: Partial<Parameters<Repository["saveSchedule"]>[1]> = {}) => ({
  date: "2026-08-31",
  scheduledCount: 2,
  hasActiveSchedule: true,
  scheduledItems: [{ assetUuid: "a1" }, { assetUuid: "a2" }],
  fetchedAt: new Date("2026-08-31T12:00:00Z"),
  ...over,
});

test("saveSchedule persists the snapshot with its items as jsonb", async () => {
  const { pool, captured } = stubPool();
  await new Repository(pool).saveSchedule("canvas-1", snapshot());

  const { sql, values } = captured[0]!;
  assert.match(flat(sql), /INSERT INTO device_schedule/);
  assert.match(sql, /\$5::jsonb/, "the items column is cast, so a JSON string is stored as jsonb");
  assert.deepEqual(values, [
    "canvas-1",
    "2026-08-31",
    2,
    true,
    JSON.stringify([{ assetUuid: "a1" }, { assetUuid: "a2" }]),
    new Date("2026-08-31T12:00:00Z"),
  ]);
});

test("saveSchedule carries the fetch instant as a Date, so the row's age is real", async () => {
  // `fetched_at` is the whole basis for reporting staleness downstream. A
  // stringified or now()-defaulted value would present a stale snapshot as fresh.
  const fetchedAt = new Date("2026-08-31T09:30:00Z");
  const { pool, captured } = stubPool();
  await new Repository(pool).saveSchedule("canvas-1", snapshot({ fetchedAt }));

  const bound = captured[0]!.values[5];
  assert.ok(bound instanceof Date, "fetchedAt must be bound as a Date, not a string");
  assert.equal((bound as Date).toISOString(), "2026-08-31T09:30:00.000Z");
  assert.equal(/now\(\)/.test(captured[0]!.sql), false, "the fetch time is never defaulted to now()");
});

test("an empty schedule is persisted as an empty array, not as NULL or a skipped write", async () => {
  // "We read this canvas and nothing was scheduled" is a real observation and must
  // land in the table — otherwise the device looks never-fetched and the rotation
  // keeps re-picking it forever.
  const { pool, captured } = stubPool();
  await new Repository(pool).saveSchedule(
    "canvas-1",
    snapshot({ scheduledCount: 0, hasActiveSchedule: false, scheduledItems: [] }),
  );

  assert.equal(captured.length, 1, "an empty read still writes a row");
  assert.equal(captured[0]!.values[2], 0);
  assert.equal(captured[0]!.values[3], false);
  assert.equal(captured[0]!.values[4], "[]", "an empty item list, never null");
});

test("saveSchedule writes one row per call and touches nothing else", async () => {
  // The slow lane's only write. A stray UPDATE to devices here would make a read
  // lane mutate fleet state.
  const { pool, captured } = stubPool();
  await new Repository(pool).saveSchedule("canvas-1", snapshot());
  assert.equal(captured.length, 1);
  assert.equal(/UPDATE|DELETE|DROP/i.test(captured[0]!.sql), false);
  assert.match(captured[0]!.sql, /^\s*INSERT INTO device_schedule/);
});

test("saveSchedule honours the schedule date it was handed rather than deriving one", async () => {
  const { pool, captured } = stubPool();
  await new Repository(pool).saveSchedule("canvas-1", snapshot({ date: "2026-01-01" }));
  assert.equal(captured[0]!.values[1], "2026-01-01");
});
