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

// ─── never device rows ───────────────────────────────────────────────────────

test("no prune ever deletes a device row", async () => {
  // Standing rule in this project: device rows are RETIRED — soft, reversible,
  // `retired_at` — and never hard-deleted (see pollers/devices.ts). Retention
  // adding a `DELETE FROM devices` would silently destroy the registry rows an
  // offline device's whole history hangs off. Now that these lanes are observed
  // rather than invisible, this is the one thing that must not change with them.
  const { statements } = await prune();
  for (const statement of statements) {
    assert.notEqual(statement.table, "devices", statement.sql);
    assert.ok(!/DELETE FROM devices\b/i.test(statement.sql), statement.sql);
  }
});

// ─── the lanes can now report that they ran ──────────────────────────────────
//
// `retention` and `prune-raw` DELETE rows and recorded nothing, so a successful
// prune and a prune that never happened were identical in the database: the lane
// registry had to declare them `observability: "none"` and pipeline-health
// reported UNKNOWN. Note what that zero was NOT: with no `record()` call, zero
// poller_runs rows is evidence WE CANNOT TELL, not evidence the lane never ran.
//
// What is pinned below is only the recording — nothing about WHAT is deleted,
// which the tests above own and which did not change.

import {
  runRetentionLane,
  runPruneRawLane,
  toRetentionRun,
  toPruneRawRun,
  RETENTION_POLLER,
  PRUNE_RAW_POLLER,
  PRUNE_RAW_RETAIN_DAYS,
} from "./retention.js";
import type { PollerResult } from "../pipeline/pollers/types.js";

/** Collects what the lane recorded. */
function recorder(): { record: (r: PollerResult) => Promise<void>; runs: PollerResult[] } {
  const runs: PollerResult[] = [];
  return { record: async (r) => { runs.push(r); }, runs };
}

/** Distinct counts per table, so a swap lands a recognisable wrong number. */
const RETENTION_COUNTS = {
  health_samples: 11,
  poller_runs: 22,
  fleet_snapshots: 33,
  alerts_resolved: 44,
  device_settings: 55,
  compliance_results: 66,
};
const RETENTION_TOTAL = Object.values(RETENTION_COUNTS).reduce((a, b) => a + b, 0);
/** Deliberately unlike any retention count or their sum. */
const RAW_COUNT = 907;

const silent = () => {};
/** Monotonic clock, so durationMs is asserted rather than hoped for. */
const clock = (stepMs: number) => { let t = 5_000; return () => { const n = t; t += stepMs; return n; }; };

test("each prune lane records exactly one run, under its OWN name", async () => {
  const retention = recorder();
  const raw = recorder();

  await runRetentionLane({ prune: async () => ({ ...RETENTION_COUNTS }), record: retention.record, log: silent });
  await runPruneRawLane({ prune: async () => RAW_COUNT, record: raw.record, log: silent });

  assert.equal(retention.runs.length, 1, "one row per run — not zero, not two");
  assert.equal(raw.runs.length, 1);
  assert.equal(retention.runs[0]!.poller, RETENTION_POLLER);
  assert.equal(raw.runs[0]!.poller, PRUNE_RAW_POLLER);
  assert.equal(RETENTION_POLLER, "retention");
  assert.equal(PRUNE_RAW_POLLER, "prune-raw");
});

test("a swap between the two lanes is caught: each reports its OWN count", async () => {
  // The precedent this guards is real: a retention change handed
  // `run("poller_runs", …)` the fleet_snapshots DELETE. The SQL worked, both
  // labels appeared, both counts were plausible, and the report was about the
  // wrong tables. One level up, `retention` recording prune-raw's count would be
  // just as quiet — so the counts here are deliberately unmistakable.
  const shared = recorder();
  await runRetentionLane({ prune: async () => ({ ...RETENTION_COUNTS }), record: shared.record, log: silent });
  await runPruneRawLane({ prune: async () => RAW_COUNT, record: shared.record, log: silent });

  const byPoller = new Map(shared.runs.map((r) => [r.poller, r]));
  assert.equal(byPoller.get("retention")!.rowsWritten, RETENTION_TOTAL);
  assert.equal(byPoller.get("prune-raw")!.rowsWritten, RAW_COUNT);
  // And neither carries the other's number.
  assert.notEqual(byPoller.get("retention")!.rowsWritten, RAW_COUNT);
  assert.notEqual(byPoller.get("prune-raw")!.rowsWritten, RETENTION_TOTAL);
  // Nor the other's batch count: six tables vs one statement.
  assert.equal(byPoller.get("retention")!.batchesOk, 6);
  assert.equal(byPoller.get("prune-raw")!.batchesOk, 1);
});

test("rowsWritten means rows DELETED, summed over the tables this lane pruned", async () => {
  // poller_runs has no rows_deleted column. For a lane whose whole output is
  // deletion, the rows it removed are what every consumer means by the volume
  // of work — stated here so the meaning is pinned rather than assumed.
  const { record, runs } = recorder();
  await runRetentionLane({ prune: async () => ({ health_samples: 3, poller_runs: 4 }), record, log: silent });
  assert.equal(runs[0]!.rowsWritten, 7);
  // …and the per-table breakdown is recorded, so the total can be audited back
  // to the tables it came from.
  assert.ok(
    runs[0]!.errors.some((e) => /health_samples=3/.test(e) && /poller_runs=4/.test(e)),
    JSON.stringify(runs[0]!.errors),
  );
});

test("a zero-by-nature prune is distinguishable from a prune that could not look", async () => {
  // This is the whole point of recording these lanes. Both runs report
  // rowsWritten 0; only one of them means "nothing needed doing".
  const checked = recorder();
  const blind = recorder();

  await runRetentionLane({
    prune: async () => ({
      health_samples: 0, poller_runs: 0, fleet_snapshots: 0,
      alerts_resolved: 0, device_settings: 0, compliance_results: 0,
    }),
    record: checked.record, log: silent,
  });
  await runRetentionLane({
    prune: async () => { throw new Error("relation health_samples does not exist"); },
    record: blind.record, log: silent,
  });

  const measured = checked.runs[0]!;
  const unknown = blind.runs[0]!;

  assert.equal(measured.rowsWritten, 0);
  assert.equal(unknown.rowsWritten, 0, "identical in the count — which is why it cannot be the signal");

  assert.equal(measured.batchesOk, 6, "six windows were checked");
  assert.equal(measured.batchesFailed, 0);
  assert.equal(unknown.batchesOk, 0, "nothing completed, so nothing was checked");
  assert.equal(unknown.batchesFailed, 1);

  assert.ok(measured.errors.some((e) => /a measured zero/.test(e)), JSON.stringify(measured.errors));
  assert.ok(unknown.errors.some((e) => /prune failed: relation health_samples does not exist/.test(e)));
  assert.ok(!unknown.errors.some((e) => /a measured zero/.test(e)),
    "a failed prune must never claim it checked anything");
});

test("prune-raw distinguishes its two zeros the same way", async () => {
  const checked = recorder();
  const blind = recorder();
  await runPruneRawLane({ prune: async () => 0, record: checked.record, log: silent });
  await runPruneRawLane({
    prune: async () => { throw new Error("deadlock detected"); },
    record: blind.record, log: silent,
  });

  assert.deepEqual(
    [checked.runs[0]!.batchesOk, checked.runs[0]!.batchesFailed], [1, 0],
    "the DELETE ran and found nothing old enough",
  );
  assert.deepEqual([blind.runs[0]!.batchesOk, blind.runs[0]!.batchesFailed], [0, 1]);
  assert.ok(checked.runs[0]!.errors.some((e) => /a measured zero/.test(e)));
  assert.ok(blind.runs[0]!.errors.some((e) => /deadlock detected/.test(e)));
  assert.ok(checked.runs[0]!.errors.some((e) => new RegExp(`${PRUNE_RAW_RETAIN_DAYS} days`).test(e)));
});

test("neither lane targets a device, and the run row says the zero is by nature", async () => {
  const { record, runs } = recorder();
  await runRetentionLane({ prune: async () => ({ health_samples: 1 }), record, log: silent });
  await runPruneRawLane({ prune: async () => 1, record, log: silent });

  for (const run of runs) {
    assert.equal(run.devicesTargeted, 0, `${run.poller} prunes tables, not devices`);
    // Honest nulls: no telemetry is read, so 0.0 (which reads as "collected
    // nothing") would be a different and false claim.
    assert.equal(run.telemetryYield, null);
  }
  assert.ok(
    runs.find((r) => r.poller === "retention")!.errors
      .some((e) => /no device row was deleted/.test(e)),
    "the retention row must state that no device row was touched",
  );
});

test("a recording failure does not abort the prune, and does not throw", async () => {
  // These run on the daemon. Bookkeeping must never be able to break the work —
  // `record()` in run-poller.ts already swallows its own failures for this
  // reason, and the lane holds the property whatever `record` it is handed.
  let pruned = 0;
  const exploding = async () => { throw new Error("poller_runs insert failed"); };

  const retention = await runRetentionLane({
    prune: async () => { pruned += 1; return { health_samples: 5 }; },
    record: exploding, log: silent,
  });
  const raw = await runPruneRawLane({
    prune: async () => { pruned += 1; return 6; },
    record: exploding, log: silent,
  });

  assert.equal(pruned, 2, "both prunes must have run despite recording failing");
  // The lane still returns the run it tried to record, so the caller and the log
  // still have it.
  assert.equal(retention.rowsWritten, 5);
  assert.equal(raw.rowsWritten, 6);
});

test("both lanes record the run they actually performed, timed", async () => {
  const { record, runs } = recorder();
  await runRetentionLane({
    prune: async () => ({ health_samples: 1 }), record, log: silent, now: clock(250),
  });
  await runPruneRawLane({ prune: async () => 1, record, log: silent, now: clock(90) });

  assert.equal(runs[0]!.durationMs, 250);
  assert.equal(runs[1]!.durationMs, 90);
  for (const run of runs) assert.ok(run.startedAt instanceof Date);
});

test("the log line is unchanged in shape — the run row is the new part", async () => {
  // A prune that deletes nothing stayed quiet in the log and still does; the
  // measured zero now lives in the run row, which is where it is durable.
  const lines: string[] = [];
  await runRetentionLane({
    prune: async () => ({ health_samples: 0, poller_runs: 0 }),
    record: async () => {}, log: (m) => lines.push(m),
  });
  await runPruneRawLane({ prune: async () => 0, record: async () => {}, log: (m) => lines.push(m) });

  assert.deepEqual(lines, ["[retention] nothing to prune"], "prune-raw stays silent on a quiet night");
});

test("the pure builders hardcode their own lane name", () => {
  // No argument decides the name, so no caller can pass the wrong one.
  const outcome = { startedAt: new Date(), durationMs: 1, error: null };
  assert.equal(toRetentionRun({ ...outcome, counts: { health_samples: 1 } }).poller, "retention");
  assert.equal(toPruneRawRun({ ...outcome, counts: 1 }).poller, "prune-raw");
});
