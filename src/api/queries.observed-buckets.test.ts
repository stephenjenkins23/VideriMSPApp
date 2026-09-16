/**
 * `observedBucketStarts()` — `node --test dist/api/queries.observed-buckets.test.js`
 *
 * A separate file because this one method decides what counts as OBSERVED, and
 * it used to exist verbatim in two route files. Two definitions of "observed"
 * would let the same window clear the churn observation gate on
 * `/api/trends/churn` and fail it on `/api/remediation`, so the two endpoints
 * would disagree about whether `applied` may be claimed at all.
 *
 * What is pinned here is therefore the PREDICATES — each one is a way the count
 * could silently inflate — plus the half-open bounds and the epoch-ms mapping.
 * Stub pool, no database.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { ReadQueries } from "./queries.js";

/** Answers the statement with `rows` and captures the SQL and its parameters. */
function stubPool(rows: Array<{ bucket: Date }>): {
  pool: Pool;
  calls: Array<{ text: string; values: unknown[] }>;
} {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    async query(text: string, values: unknown[]) {
      calls.push({ text, values });
      return { rows, rowCount: rows.length };
    },
  } as unknown as Pool;
  return { pool, calls };
}

test("every predicate that stops an 'observed' bucket being invented is present", async () => {
  const { pool, calls } = stubPool([]);
  await new ReadQueries(pool).observedBucketStarts(
    "2026-09-01T00:00:00.000Z",
    "2026-09-02T00:00:00.000Z",
    300,
  );
  const sql = calls[0]?.text ?? "";
  for (const needle of [
    // Buckets, not rows: a stalled poller catching up writes a dozen rows in one
    // minute, and a dozen rows from one minute is not a dozen observations.
    "SELECT DISTINCT time_bucket(make_interval(secs => $3::int), hs.observed_at)",
    // The 300s metrics poller writes rows with a NULL presence, so including it
    // would add buckets in which we learned nothing about whether a device was up.
    "hs.source = 'status'",
    "hs.presence IS NOT NULL",
    // Half-open, matching every other window in the product.
    "hs.observed_at >= $1::timestamptz",
    "hs.observed_at <  $2::timestamptz",
    // Retired devices are not fleet: their last samples would pad the coverage
    // of a window they were never in service for.
    "d.retired_at IS NULL",
    // The gate needs the buckets in order to see the SHAPE of the blind runs.
    "ORDER BY bucket",
  ]) {
    assert.ok(sql.includes(needle), needle);
  }
  assert.deepEqual(calls[0]?.values, ["2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z", 300]);
});

test("bucket starts come back as epoch ms, in the order the database ordered them", async () => {
  const { pool } = stubPool([
    { bucket: new Date("2026-09-01T00:00:00.000Z") },
    { bucket: new Date("2026-09-01T00:05:00.000Z") },
    { bucket: new Date("2026-09-01T00:15:00.000Z") },
  ]);
  const starts = await new ReadQueries(pool).observedBucketStarts(
    "2026-09-01T00:00:00.000Z",
    "2026-09-01T00:20:00.000Z",
    300,
  );
  assert.deepEqual(starts, [
    Date.parse("2026-09-01T00:00:00.000Z"),
    Date.parse("2026-09-01T00:05:00.000Z"),
    Date.parse("2026-09-01T00:15:00.000Z"),
  ]);
  // The 00:10 bucket is ABSENT rather than present-and-empty: a missing bucket is
  // time we were not looking, and that is what the gate reads it as.
  assert.equal(starts.length, 3);
});

test("a window we never sampled is an empty list, not a fabricated run of buckets", async () => {
  const { pool } = stubPool([]);
  assert.deepEqual(
    await new ReadQueries(pool).observedBucketStarts(
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      300,
    ),
    [],
  );
});
