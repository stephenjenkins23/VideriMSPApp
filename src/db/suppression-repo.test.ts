/**
 * Work-surface repository tests —
 *   `node --test dist/db/suppression-repo.test.js`
 *
 * Same approach as `action-log-repo.test.ts`: a stub pool that captures SQL and
 * parameters, no database and no migrations. What is guarded here is the SQL,
 * because every way of getting these particular statements wrong is silent:
 *
 *   - use `rule_id = $2` instead of `IS NOT DISTINCT FROM` and a whole-device
 *     incumbent is never superseded — the UPDATE matches nothing, the INSERT then
 *     trips the partial unique index, and "suppress it again" starts failing with
 *     a constraint error nobody can read;
 *   - forget the partial predicate on the revoke and a second click overwrites
 *     the first revoker, destroying the one fact the record exists to keep;
 *   - DELETE instead of UPDATE anywhere in here and the feature becomes
 *     destructive, which is the one thing it may never be;
 *   - drop `AND resolved_at IS NULL` from the scope read and a suppression writes
 *     lifecycle events against alerts that closed months ago;
 *   - order the alert event log newest-first and the lifecycle reads backwards,
 *     so "released, noted, claimed" describes a sequence that never happened.
 *
 * It also pins the two structural properties: un-acknowledge only fires on an
 * alert that IS acknowledged, and the create path is transactional.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool, PoolClient } from "pg";
import { Repository } from "./repository.js";

interface Captured { sql: string; values: unknown[] }

const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

function stubPool(opts: { rows?: Array<Record<string, unknown>>; rowCount?: number } = {}): {
  pool: Pool;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    captured.push({ sql, values });
    const rows = opts.rows ?? [];
    return { rows, rowCount: opts.rowCount ?? rows.length };
  };
  const pool = {
    query,
    async connect() {
      return { query, release() {} } as unknown as PoolClient;
    },
  } as unknown as Pool;
  return { pool, captured };
}

/** Every statement this section runs, so "nothing here deletes" is assertable. */
const allSql = (captured: Captured[]) => captured.map((c) => flat(c.sql)).join(" || ");

// ─── the non-negotiable: nothing here is destructive ─────────────────────────

test("no statement in the work surface ever DELETEs", async () => {
  const { pool, captured } = stubPool({ rows: [{ id: "s1" }], rowCount: 1 });
  const repo = new Repository(pool);

  await repo.createSuppression({
    deviceId: "d1", ruleId: null, reason: "lab unit, expected", intent: "lab",
    includeCriticalHigh: false, createdBy: "api:sam",
    expiresAt: new Date("2026-10-03T00:00:00Z"), neverExpires: false,
  });
  await repo.revokeSuppression("11111111-1111-1111-1111-111111111111", "api:jo", "back in service");
  await repo.unacknowledgeAlert("22222222-2222-2222-2222-222222222222");
  await repo.appendAlertEvent({
    alertId: "33333333-3333-3333-3333-333333333333", deviceId: "d1", kind: "note",
    body: "found the PSU unplugged", actor: "api:sam",
  });

  const sql = allSql(captured);
  assert.doesNotMatch(sql, /\bDELETE\b/i, "the work surface must never delete");
  assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
  // Un-suppression is an UPDATE of the revocation columns, and only those.
  assert.match(sql, /UPDATE alert_suppressions SET revoked_at = now\(\), revoked_by = \$2, revoked_reason = \$3/);
});

// ─── createSuppression ───────────────────────────────────────────────────────

test("creating a suppression supersedes the same-scope incumbent, in one transaction", async () => {
  const { pool, captured } = stubPool({ rows: [{ id: "new-id" }], rowCount: 1 });
  const repo = new Repository(pool);

  const result = await repo.createSuppression({
    deviceId: "d1", ruleId: null, reason: "lab unit, expected", intent: "lab",
    includeCriticalHigh: false, createdBy: "api:sam",
    expiresAt: new Date("2026-10-03T00:00:00Z"), neverExpires: false,
  });

  const statements = captured.map((c) => flat(c.sql));
  assert.equal(statements[0], "BEGIN");
  assert.equal(statements[statements.length - 1], "COMMIT");
  assert.equal(result.id, "new-id");
  // The incumbent was revoked, not deleted, and the revocation is attributed to
  // whoever superseded it — so the history reads as a sequence of decisions
  // rather than as one mutable row.
  assert.match(statements[1]!, /UPDATE alert_suppressions/);
  assert.match(statements[1]!, /revoked_reason = 'superseded by a newer suppression for the same scope'/);
  assert.equal(result.supersededId, "new-id"); // the stub returns the same row
});

test("the supersede predicate uses IS NOT DISTINCT FROM, not `=`", async () => {
  const { pool, captured } = stubPool({ rows: [{ id: "new-id" }], rowCount: 1 });
  const repo = new Repository(pool);
  await repo.createSuppression({
    deviceId: "d1", ruleId: null, reason: "lab unit, expected", intent: null,
    includeCriticalHigh: false, createdBy: "api:sam", expiresAt: new Date(), neverExpires: false,
  });
  const update = flat(captured[1]!.sql);
  // `rule_id = NULL` is never true, so an `=` here would leave every whole-device
  // incumbent in place and then trip the partial unique index on the INSERT.
  assert.match(update, /rule_id IS NOT DISTINCT FROM \$2/);
  assert.doesNotMatch(update, /rule_id = \$2/);
  // And only rows still in force are superseded; a revoked record is history.
  assert.match(update, /revoked_at IS NULL/);
  // Parameters bound in declaration order, with no gaps — a skipped placeholder
  // is a bind-count error at runtime that no stub returning canned rows notices.
  assert.deepEqual(captured[1]!.values, ["d1", null, "api:sam"]);
});

test("every suppression column is bound in order on the insert", async () => {
  const { pool, captured } = stubPool({ rows: [{ id: "new-id" }], rowCount: 1 });
  const repo = new Repository(pool);
  const expiresAt = new Date("2026-10-03T00:00:00Z");
  await repo.createSuppression({
    deviceId: "d1", ruleId: "offline-30d", reason: "asset scrapped, outage expected",
    intent: "eol", includeCriticalHigh: true, createdBy: "api:sam", expiresAt, neverExpires: false,
  });
  const insert = captured.find((c) => /INSERT INTO alert_suppressions/.test(c.sql))!;
  assert.deepEqual(insert.values, [
    "d1", "offline-30d", "asset scrapped, outage expected", "eol", true, "api:sam", expiresAt, false,
  ]);
});

test("a failed create rolls back rather than leaving a half-applied supersede", async () => {
  // Without the rollback, revoking the incumbent and then failing to insert the
  // replacement would leave the scope with NO suppression at all — a silent
  // un-mute, which is a surprise in the worse direction.
  const captured: Captured[] = [];
  const pool = {
    async connect() {
      return {
        async query(sql: string, values: unknown[] = []) {
          captured.push({ sql, values });
          if (/INSERT INTO alert_suppressions/.test(sql)) throw new Error("check constraint violated");
          return { rows: [{ id: "x" }], rowCount: 1 };
        },
        release() {},
      } as unknown as PoolClient;
    },
  } as unknown as Pool;

  await assert.rejects(
    new Repository(pool).createSuppression({
      deviceId: "d1", ruleId: null, reason: "lab unit, expected", intent: null,
      includeCriticalHigh: false, createdBy: "api:sam", expiresAt: new Date(), neverExpires: false,
    }),
    /check constraint violated/,
  );
  assert.equal(flat(captured[captured.length - 1]!.sql), "ROLLBACK");
});

// ─── revokeSuppression ──────────────────────────────────────────────────────

test("revoking is idempotent-safe: a second call cannot overwrite the first revoker", async () => {
  const { pool, captured } = stubPool({ rowCount: 0 });
  const repo = new Repository(pool);
  const revoked = await repo.revokeSuppression("11111111-1111-1111-1111-111111111111", "api:jo", null);
  // rowCount 0 means "already revoked", and the caller answers 409 rather than
  // reporting a no-op as success.
  assert.equal(revoked, false);
  // The partial predicate is what makes that true.
  assert.match(flat(captured[0]!.sql), /WHERE id = \$1::uuid AND revoked_at IS NULL/);
});

// ─── listSuppressions ───────────────────────────────────────────────────────

test("active-only is the default, and lapsed records are opt-in", async () => {
  const { pool, captured } = stubPool();
  const repo = new Repository(pool);

  await repo.listSuppressions();
  assert.match(flat(captured[0]!.sql), /WHERE revoked_at IS NULL/);

  await repo.listSuppressions({ includeLapsed: true });
  // No revocation predicate: the `lapsed` block of the view is how re-escalation
  // is reported, and you cannot report what you did not load.
  assert.doesNotMatch(flat(captured[1]!.sql), /revoked_at IS NULL/);
});

test("expiry is NOT evaluated in SQL, so the boundary stays testable", async () => {
  const { pool, captured } = stubPool();
  await new Repository(pool).listSuppressions({ includeLapsed: true });
  const sql = flat(captured[0]!.sql);
  // A `expires_at > now()` here would make the expiry boundary depend on the
  // database clock and untestable without one. The pure classifier owns it.
  assert.doesNotMatch(sql, /expires_at [<>]/);
  assert.doesNotMatch(sql, /now\(\)/);
  // Every column the classifier needs must come back, or expiry silently
  // evaluates against undefined.
  for (const column of [
    "expires_at", "never_expires", "revoked_at", "revoked_by", "revoked_reason",
    "include_critical_high", "intent", "reason", "created_by", "created_at",
  ]) {
    assert.match(sql, new RegExp(column), `${column} must be selected`);
  }
});

test("a device filter is bound, not interpolated", async () => {
  const { pool, captured } = stubPool();
  await new Repository(pool).listSuppressions({ deviceId: "d1'; DROP TABLE alerts; --" });
  assert.match(flat(captured[0]!.sql), /device_id = \$1/);
  assert.deepEqual(captured[0]!.values, ["d1'; DROP TABLE alerts; --"]);
});

// ─── openAlertIdsForScope ───────────────────────────────────────────────────

test("scope reads cover OPEN alerts only, and a null rule means the whole device", async () => {
  const { pool, captured } = stubPool({ rows: [{ id: "a1" }, { id: "a2" }] });
  const repo = new Repository(pool);

  const ids = await repo.openAlertIdsForScope("d1", null);
  assert.deepEqual(ids, ["a1", "a2"]);
  const sql = flat(captured[0]!.sql);
  // Without this, a suppression writes lifecycle events against alerts that
  // closed months ago.
  assert.match(sql, /a\.resolved_at IS NULL/);
  // One predicate serving both scopes, so the two can never disagree about what
  // "the whole device" means.
  assert.match(sql, /\$2::text IS NULL OR a\.rule_id = \$2/);
  assert.deepEqual(captured[0]!.values, ["d1", null]);

  await repo.openAlertIdsForScope("d1", "offline-30d");
  assert.deepEqual(captured[1]!.values, ["d1", "offline-30d"]);
});

// ─── the alert lifecycle ────────────────────────────────────────────────────

test("un-acknowledge only fires on an alert that IS acknowledged and open", async () => {
  const { pool, captured } = stubPool({ rowCount: 1 });
  const repo = new Repository(pool);
  assert.equal(await repo.unacknowledgeAlert("22222222-2222-2222-2222-222222222222"), true);
  const sql = flat(captured[0]!.sql);
  // Both columns cleared — leaving `acknowledged_by` behind would make the row
  // read as claimed by a name with no timestamp.
  assert.match(sql, /SET acknowledged_at = NULL, acknowledged_by = NULL/);
  // A "release" that silently did nothing must not read as success.
  assert.match(sql, /acknowledged_at IS NOT NULL/);
  assert.match(sql, /resolved_at IS NULL/);
});

test("the lifecycle log reads OLDEST first — a story told forwards", async () => {
  const { pool, captured } = stubPool({ rows: [] });
  await new Repository(pool).alertEvents("33333333-3333-3333-3333-333333333333");
  const sql = flat(captured[0]!.sql);
  // Newest-first here would render "released, noted, claimed", which is a
  // different sequence of events from the one that happened. The `id` tiebreak
  // keeps two events written in the same millisecond in insertion order.
  assert.match(sql, /ORDER BY created_at, id/);
  assert.doesNotMatch(sql, /created_at DESC/);
});

test("an event binds every column in order, and a missing optional is NULL not empty", async () => {
  const { pool, captured } = stubPool({ rows: [{ id: "7" }] });
  const repo = new Repository(pool);
  const id = await repo.appendAlertEvent({
    alertId: "33333333-3333-3333-3333-333333333333",
    deviceId: "d1",
    kind: "acknowledge",
    actor: "api:sam",
  });
  assert.equal(id, 7);
  // NULLs, not empty strings: "no note was written" and "an empty note was
  // written" are different facts and the CHECK on notes depends on the difference.
  assert.deepEqual(captured[0]!.values, [
    "33333333-3333-3333-3333-333333333333", "d1", "acknowledge", null, null, "api:sam", null,
  ]);
  assert.match(flat(captured[0]!.sql), /INSERT INTO alert_events/);
  assert.match(flat(captured[0]!.sql), /RETURNING id/);
});

test("note counts are batched over the page, not fetched per row", async () => {
  const { pool, captured } = stubPool({ rows: [{ alert_id: "a1", n: "3" }] });
  const repo = new Repository(pool);
  const counts = await repo.alertNoteCounts(["a1", "a2"]);
  assert.equal(captured.length, 1, "one query for the whole page");
  assert.equal(counts.get("a1"), 3);
  // Absent means zero notes, and the caller renders 0 — a real zero, we counted.
  assert.equal(counts.get("a2"), undefined);
  // Notes only. Counting the acknowledgement in this badge would make it
  // disagree with the list the drawer renders.
  assert.match(flat(captured[0]!.sql), /kind = 'note'/);
});

test("an empty page asks the database nothing", async () => {
  const { pool, captured } = stubPool();
  const counts = await new Repository(pool).alertNoteCounts([]);
  assert.equal(counts.size, 0);
  assert.equal(captured.length, 0, "`= ANY('{}')` is a pointless round trip");
});

test("alertScope distinguishes a resolved alert from a missing one", async () => {
  // The caller needs the difference: a note on a resolved alert is allowed
  // ("this came back twice, it is the switch not the panel"), a note on a
  // non-existent one is a 404.
  const resolved = stubPool({ rows: [{ device_id: "d1", resolved_at: new Date() }] });
  assert.deepEqual(await new Repository(resolved.pool).alertScope("x"), {
    deviceId: "d1", open: false,
  });
  const open = stubPool({ rows: [{ device_id: "d1", resolved_at: null }] });
  assert.deepEqual(await new Repository(open.pool).alertScope("x"), { deviceId: "d1", open: true });
  const missing = stubPool({ rows: [] });
  assert.equal(await new Repository(missing.pool).alertScope("x"), null);
});
