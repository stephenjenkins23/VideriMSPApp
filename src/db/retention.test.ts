/**
 * Retention tests — `node --test dist/db/retention.test.js`
 *
 * `pruneTimeSeries` is six DELETEs behind one label→statement helper, and every
 * way of getting it wrong deletes the wrong rows in silence:
 *
 *   - hand `run("poller_runs", …)` the fleet_snapshots statement and both labels
 *     still appear in the returned record, both counts are plausible, nothing
 *     errors, and the retention report is simply about the wrong tables (this was
 *     one review away from shipping);
 *   - drive fleet_snapshots off `snapshotsDays` (30) instead of
 *     `fleetSnapshotsDays` (90) and the deepest COMPUTED history we hold is
 *     pruned three times sooner than the raw samples it summarises, which is the
 *     wrong asymmetry and invisible until a trend window comes up short;
 *   - drop the keep-newest subquery from a latest-state table and an offline
 *     device's last known configuration disappears — for exactly the devices
 *     someone is trying to diagnose.
 *
 * So the fake pool below records (target table, sql, params) per statement and
 * returns a row count DERIVED FROM THE TARGET TABLE. That makes a label/table
 * swap show up as a wrong number in the returned record, not just as a wrong
 * string. No database is touched and nothing is deleted anywhere.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { Repository } from "./repository.js";

interface Statement {
  /** The table this DELETE actually targets, parsed out of the SQL. */
  table: string;
  sql: string;
  values: unknown[];
}

/** A distinct, recognisable row count per table. */
const ROWS: Record<string, number> = {
  health_samples: 1_000_001,
  poller_runs: 2_000_002,
  fleet_snapshots: 3_000_003,
  alerts: 4_000_004,
  device_settings: 5_000_005,
  compliance_results: 6_000_006,
};

function fakePool(): { pool: Pool; statements: Statement[] } {
  const statements: Statement[] = [];
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      const table = /DELETE FROM ([a-z_]+)/i.exec(sql)?.[1] ?? "?";
      statements.push({ table, sql, values });
      return { rows: [], rowCount: ROWS[table] ?? 0 };
    },
  } as unknown as Pool;
  return { pool, statements };
}

const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

/**
 * label → the table it must delete from. `alerts_resolved` is the one label that
 * differs from its table, because it prunes a SUBSET of `alerts`.
 */
const LABEL_TO_TABLE: Record<string, string> = {
  health_samples: "health_samples",
  poller_runs: "poller_runs",
  fleet_snapshots: "fleet_snapshots",
  alerts_resolved: "alerts",
  device_settings: "device_settings",
  compliance_results: "compliance_results",
};

/** Runs a prune and indexes what happened by the DELETE's target table. */
async function prune(opts: Parameters<Repository["pruneTimeSeries"]>[0] = {}) {
  const { pool, statements } = fakePool();
  const deleted = await new Repository(pool).pruneTimeSeries(opts);
  const byTable = new Map(statements.map((s) => [s.table, s]));
  return {
    deleted,
    statements,
    /** The statement that targeted `table`, asserted to exist exactly once. */
    on: (table: string): Statement => {
      const hits = statements.filter((s) => s.table === table);
      assert.equal(hits.length, 1, `expected exactly one DELETE against ${table}, saw ${hits.length}`);
      return hits[0]!;
    },
    byTable,
  };
}

// ─── label → table, one to one ───────────────────────────────────────────────

test("every retention label reports the table it actually deleted from", async () => {
  // The row counts are table-specific, so a swapped pair of labels lands the
  // wrong number under the wrong key and this fails.
  const { deleted } = await prune();

  for (const [label, table] of Object.entries(LABEL_TO_TABLE)) {
    assert.equal(
      deleted[label], ROWS[table],
      `label "${label}" must report rows deleted from ${table}`,
    );
  }
  // No extra keys: an unlabelled DELETE is a prune nobody can audit.
  assert.deepEqual(Object.keys(deleted).sort(), Object.keys(LABEL_TO_TABLE).sort());
});

test("each prune targets a different table — no table is pruned twice, none is missed", async () => {
  const { statements } = await prune();
  const tables = statements.map((s) => s.table);
  assert.equal(tables.length, 6);
  assert.equal(new Set(tables).size, 6, "two labels sharing a table means one table is unpruned");
  assert.deepEqual(
    [...tables].sort(),
    [...new Set(Object.values(LABEL_TO_TABLE))].sort(),
  );
});

// ─── fleet_snapshots has its OWN window ──────────────────────────────────────

test("fleet_snapshots is pruned at fleetSnapshotsDays (90), not the 30-day snapshot window", async () => {
  // fleet_snapshots was previously never pruned at all; the risk in fixing it was
  // reaching for `snapshotsDays`, which governs device_settings and
  // compliance_results. 90 vs 30 is a 3x difference in retained trend history.
  const { on } = await prune();

  assert.deepEqual(on("fleet_snapshots").values, ["90"]);
  assert.deepEqual(on("device_settings").values, ["30"]);
  assert.deepEqual(on("compliance_results").values, ["30"]);
  assert.notDeepEqual(
    on("fleet_snapshots").values, on("device_settings").values,
    "fleet_snapshots must not inherit the latest-state window",
  );
});

test("fleetSnapshotsDays defaults to the SAMPLE window, so computed history is never shallower than the raw samples that made it", async () => {
  const { on } = await prune();
  assert.deepEqual(on("fleet_snapshots").values, on("health_samples").values);
});

test("each knob drives exactly one window, so no two are wired to the same option", async () => {
  // Deliberately distinct values: any cross-wiring shows up as a wrong string.
  const { on } = await prune({
    samplesDays: 91,
    pollerRunsDays: 15,
    resolvedAlertsDays: 181,
    snapshotsDays: 31,
    fleetSnapshotsDays: 92,
  });

  assert.deepEqual(on("health_samples").values, ["91"]);
  assert.deepEqual(on("poller_runs").values, ["15"]);
  assert.deepEqual(on("alerts").values, ["181"]);
  assert.deepEqual(on("fleet_snapshots").values, ["92"]);
  assert.deepEqual(on("device_settings").values, ["31"]);
  assert.deepEqual(on("compliance_results").values, ["31"]);
});

test("overriding fleetSnapshotsDays moves only fleet_snapshots", async () => {
  const { on } = await prune({ fleetSnapshotsDays: 7 });
  assert.deepEqual(on("fleet_snapshots").values, ["7"]);
  // Everything else stays on its default.
  assert.deepEqual(on("health_samples").values, ["90"]);
  assert.deepEqual(on("poller_runs").values, ["14"]);
  assert.deepEqual(on("alerts").values, ["180"]);
  assert.deepEqual(on("device_settings").values, ["30"]);
  assert.deepEqual(on("compliance_results").values, ["30"]);
});

test("fleet_snapshots is pruned on its own time column, computed_at", async () => {
  // `observed_at` does not exist on that table; the statement would simply error
  // every night and the table would keep growing.
  const { on } = await prune();
  const sql = flat(on("fleet_snapshots").sql);
  assert.ok(/WHERE computed_at </.test(sql), sql);
  assert.ok(!/observed_at/.test(sql));
});

// ─── the two retention semantics stay distinct ───────────────────────────────

test("pure time-series tables prune unconditionally; latest-state tables keep the newest row per device", async () => {
  const { on } = await prune();

  // Latest-state: the keep-newest correlated subquery is what preserves an
  // offline device's last known configuration regardless of age.
  for (const [table, column] of [
    ["device_settings", "observed_at"],
    ["compliance_results", "evaluated_at"],
  ] as const) {
    const sql = flat(on(table).sql);
    assert.ok(
      sql.includes(`< (SELECT MAX(${column}) FROM ${table}`),
      `${table} must keep the newest row per device: ${sql}`,
    );
    assert.ok(sql.includes("WHERE device_id ="), `${table} must scope the keep to one device`);
  }

  // Pure time series: no keep-newest clause, or the tables never shrink.
  for (const table of ["health_samples", "poller_runs", "fleet_snapshots"]) {
    assert.ok(!/SELECT MAX\(/i.test(on(table).sql), `${table} is a pure time series`);
  }
});

test("an OPEN alert is never pruned, whatever its age", async () => {
  const { on } = await prune({ resolvedAlertsDays: 0 });
  const sql = flat(on("alerts").sql);
  assert.ok(sql.includes("resolved_at IS NOT NULL"),
    "the resolved-only guard is the only thing protecting open alerts");
  assert.ok(/resolved_at < now\(\)/.test(sql), "and the age must be measured from resolution");
  // Even a zero-day window only reaches resolved rows.
  assert.deepEqual(on("alerts").values, ["0"]);
});

test("every window is a bound parameter, never interpolated into the statement", async () => {
  const { statements } = await prune({ samplesDays: 91, fleetSnapshotsDays: 92 });
  for (const statement of statements) {
    assert.equal(statement.values.length, 1, statement.sql);
    assert.equal(typeof statement.values[0], "string");
    assert.ok(statement.sql.includes("$1::text"), statement.sql);
    assert.ok(!/'\s*\d+\s*days'/.test(statement.sql), `interpolated interval: ${statement.sql}`);
  }
});

test("a table with nothing to prune reports 0, not a missing key", async () => {
  // The retention log filters on `> 0`; an undefined would read as "not run".
  const pool = {
    async query() { return { rows: [], rowCount: null }; },
  } as unknown as Pool;
  const deleted = await new Repository(pool).pruneTimeSeries({});
  for (const label of Object.keys(LABEL_TO_TABLE)) {
    assert.equal(deleted[label], 0, `${label} must report 0 rather than being absent`);
  }
});
