/**
 * Collector availability — the WIRING.
 *   `node --test dist/api/routes/collector.http.test.js`
 *
 * `collector.test.ts` pins the assembly and the verdict. This file covers the
 * part it cannot: that the route reaches the right reads and nothing else, that
 * it is credentialled and enveloped like every other endpoint, and — the one
 * that actually matters here — that the SHARED reads are the ones it uses.
 *
 * Three ways a route that only assembles goes wrong:
 *   1. it re-queries the fleet figure its own way, and now two endpoints
 *      disagree about whether a window is claimable at all;
 *   2. it asks for a lookback that is not the window it reports, so the coverage
 *      it prints was measured over a different period than the one named;
 *   3. it swallows an unreadable database and answers 200 with a half-built body
 *      — or leaks the SQL error, which discloses schema.
 *
 * Everything runs through `app.inject()` against a stubbed pool and repository.
 * No database, no control plane, no device: this endpoint is a read-only report
 * about US, and the server is built with no `videri` client to prove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { Repository } from "../../db/repository.js";
import { buildServer } from "../server.js";

const TOKEN = "test-token-at-least-16-chars";
const auth = { authorization: `Bearer ${TOKEN}` };
const URL = "/api/collector/availability";

interface Recorded {
  /** Every SQL statement the route caused, in order. */
  sql: string[];
  /** Every repository method it called, with its options. */
  repo: Array<{ method: string; options: unknown }>;
  /** Bucket size and bounds the fleet figure was asked for. */
  bucketParams: unknown[] | null;
}

function harness({
  fleetBuckets = 1793,
  failOn,
}: { fleetBuckets?: number; failOn?: "laneObservations" | "availabilityBuckets" } = {}) {
  const recorded: Recorded = { sql: [], repo: [], bucketParams: null };

  const pool = {
    async query(sql: string, params?: unknown[]) {
      recorded.sql.push(sql);
      if (sql.includes("MAX(observed_at)")) {
        return { rows: [{ newest: new Date("2026-09-04T15:07:04.235Z") }], rowCount: 1 };
      }
      if (sql.includes("DISTINCT ON (poller)")) return { rows: [], rowCount: 0 };
      if (sql.includes("time_bucket")) {
        if (failOn === "availabilityBuckets") {
          throw new Error('relation "health_samples" does not exist');
        }
        recorded.bucketParams = params ?? null;
        return {
          rows: [{ scope: "fleet", device_id: null, buckets: String(fleetBuckets), online_buckets: null }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;

  const repo = {
    async pollerRunHistory(options: unknown) {
      recorded.repo.push({ method: "pollerRunHistory", options });
      return [];
    },
    async laneObservations(options: unknown) {
      recorded.repo.push({ method: "laneObservations", options });
      if (failOn === "laneObservations") throw new Error('relation "poller_runs" does not exist');
      return [];
    },
  } as unknown as Repository;

  return {
    recorded,
    app: buildServer({ pool, repo, auth: { token: TOKEN, allowAnonymous: false } }),
  };
}

test("collector availability is credentialled like every other data endpoint", async () => {
  const server = await harness().app;
  const res = await server.inject({ method: "GET", url: URL });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "unauthorized");
  await server.close();
});

test("it answers in the standard envelope, and the envelope dates the fleet data", async () => {
  const server = await harness().app;
  const res = await server.inject({ method: "GET", url: `${URL}?windowHours=720`, headers: auth });
  assert.equal(res.statusCode, 200);

  const body = res.json();
  assert.deepEqual(Object.keys(body).sort(), ["data", "meta"]);
  assert.ok(body.meta.freshness, "a report about our collection still carries fleet freshness");
  // A report is not a paginated collection.
  assert.equal(body.meta.page, undefined);
  assert.equal(body.data.scope, "vfi-collector");
  assert.equal(body.data.window.hours, 720);
  await server.close();
});

test("the fleet figure comes from the SHARED bucket read, over the window it reports", async () => {
  const { app, recorded } = harness({ fleetBuckets: 1793 });
  const server = await app;
  const res = await server.inject({
    method: "GET",
    url: `${URL}?windowHours=720&bucketSeconds=300`,
    headers: auth,
  });
  const data = res.json().data;

  // The number is the one `availabilityBuckets` returned — not a second count.
  assert.equal(data.fleet.observedBuckets, 1793);
  assert.equal(data.window.expectedBuckets, 8640);
  assert.ok(Math.abs(data.fleet.collectorUp.value - 1793 / 8640) < 1e-9);

  // And it was asked for exactly the window the payload names, at the bucket
  // size the caller asked for. A lookback that does not match the reported
  // window is how a figure ends up measured over a different period.
  assert.deepEqual(recorded.bucketParams, [data.window.from, data.window.to, 300]);
  const bucketSql = recorded.sql.filter((s) => s.includes("time_bucket"));
  assert.equal(bucketSql.length, 1, "one read of the fleet figure, one definition of observed");
  assert.ok(bucketSql[0]!.includes("source = 'status'"), "the same presence predicate as the SLA report");

  // Per-lane coverage comes from the pipeline-health engine's own two reads,
  // over the same lookback.
  const methods = recorded.repo.map((c) => c.method).sort();
  assert.deepEqual(methods, ["laneObservations", "pollerRunHistory"]);
  for (const call of recorded.repo) {
    assert.equal((call.options as { lookbackHours: number }).lookbackHours, 720);
  }
  await server.close();
});

test("the per-lane gap floors are multiples of each lane's OWN configured interval", async () => {
  const { app, recorded } = harness();
  const server = await app;
  await server.inject({ method: "GET", url: `${URL}?windowHours=720`, headers: auth });

  const call = recorded.repo.find((c) => c.method === "laneObservations");
  const minGap = (call!.options as { minGapSeconds: Record<string, number> }).minGapSeconds;
  // The daily-lane trap, pinned at the boundary where it is actually decided: a
  // flat floor would treat data-usage's normal day as a hole and miss every one
  // of status's real 20-minute ones.
  assert.equal(minGap["data-usage"], 2 * 86400);
  assert.equal(minGap["status"], 2 * 120);
  assert.equal(minGap["snapshot"], 2 * 300);
  await server.close();
});

test("a bad window is the caller's problem, and says so", async () => {
  const server = await harness().app;
  for (const query of ["windowHours=0", "windowHours=100000", "bucketSeconds=1", "windowHours=abc"]) {
    const res = await server.inject({ method: "GET", url: `${URL}?${query}`, headers: auth });
    assert.equal(res.statusCode, 400, query);
    assert.equal(res.json().error, "bad_request");
  }
  await server.close();
});

test("an unreadable fleet figure is a 500 that discloses nothing", async () => {
  const server = await harness({ failOn: "availabilityBuckets" }).app;
  const res = await server.inject({ method: "GET", url: URL, headers: auth });
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error, "internal_error");
  assert.doesNotMatch(res.payload, /health_samples/, "a SQL error must not disclose schema");
  await server.close();
});

test("an unreadable coverage read degrades to unknown rather than blanking the page", async () => {
  // `loadPipelineHealth` catches this one itself: coverage is ADDITIVE, so the
  // rest of the report still stands and every lane says which half is missing.
  // Pinned here because the value of that behaviour is only visible end to end.
  const server = await harness({ failOn: "laneObservations" }).app;
  const res = await server.inject({ method: "GET", url: `${URL}?windowHours=720`, headers: auth });
  assert.equal(res.statusCode, 200);

  const data = res.json().data;
  assert.equal(data.lanes.length, 16, "the roster comes from the registry, not from the read");
  for (const lane of data.lanes) {
    assert.equal(lane.coverage.value, null, `${lane.lane} must be unknown, never 0%`);
  }
  assert.equal(data.verdict.claimable, false);
  assert.match(data.pipelineSummary, /coverage could not be read/);
  await server.close();
});

test("the default window is a week, and on a stale database it refuses", async () => {
  // The live shape of this exact bug: collection stopped 2026-09-04, so the
  // default one-week lookback holds nothing. 0% would read as an estate outage.
  const server = await harness({ fleetBuckets: 0 }).app;
  const res = await server.inject({ method: "GET", url: URL, headers: auth });
  const data = res.json().data;

  assert.equal(data.window.hours, 168);
  assert.equal(data.fleet.windowHasNoObservations, true);
  assert.equal(data.fleet.collectorUp.value, null, "no share is stated for an empty window");
  assert.equal(data.fleet.lastCollectionAt, "2026-09-04T15:07:04.235Z");
  assert.ok(data.fleet.blindSinceSeconds > 0);
  assert.equal(data.verdict.claimable, false);
  assert.equal(data.verdict.cause, "ours");
  assert.match(data.verdict.refusal, /Declining to state an availability figure/);
  await server.close();
});
