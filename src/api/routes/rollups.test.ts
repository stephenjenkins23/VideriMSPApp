/**
 * Fleet count-rollup ENDPOINT tests (US-4.6) —
 *   `node --test dist/api/routes/rollups.test.js`
 *
 * `api.test.ts` covers the happy-path payload and the no-credentials 503. This
 * file covers what that file does not: the route's in-memory CACHE, which is the
 * only stateful thing in the whole read API and therefore the only place it can
 * lie about how old its answer is.
 *
 * Why the cache needs its own tests: computing a rollup fans out one aggregator
 * call PER GROUP (~94 on this tenant), so the route memoises for 30 minutes. That
 * buys three ways to be dishonest, each pinned below:
 *
 *   1. serving a cached rollup as if it were live (`cached`/`ageSeconds` must ride
 *      along, and must actually move as the snapshot ages);
 *   2. caching a FAILED fan-out as a fleet of zero canvases;
 *   3. leaking one server instance's rollup to another.
 *
 * Everything runs through `app.inject()` against a stubbed pool and a stubbed
 * Videri client that COUNTS its calls — no network, no devices, and no device
 * write of any kind (this endpoint is GET-only).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { Repository } from "../../db/repository.js";
import { buildServer } from "../server.js";
import type { VideriHttp } from "../../videri/http.js";
import type { GroupMetrics, RawGroup } from "../../videri/services/aggregator.js";

const TOKEN = "test-token-at-least-16-chars";
const auth = { authorization: `Bearer ${TOKEN}` };

/** The minimum pool the freshness envelope needs; no rollup data lives in pg. */
function stubPool(): Pool {
  return {
    async query(sql: string) {
      if (sql.includes("MAX(observed_at)")) {
        return { rows: [{ newest: new Date(Date.now() - 60_000) }], rowCount: 1 };
      }
      if (sql.includes("FROM poller_runs")) {
        return {
          rows: [{
            poller: "metrics",
            started_at: new Date(Date.now() - 60_000),
            duration_ms: 1000,
            batches_failed: 0,
            telemetry_yield: 0.9,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
}

interface VideriStub {
  videri: VideriHttp;
  /** Every path requested, in order — lets a test prove a fan-out did NOT re-fire. */
  calls: string[];
  /** How many times the group LIST was asked for = how many fan-outs happened. */
  fanOuts: () => number;
}

/**
 * A counting fake control plane. `failGroupList` makes the whole fan-out fail,
 * which is how the "never cache a failure" invariant is exercised.
 */
function stubVideri(opts: {
  groups?: RawGroup[];
  metrics?: (uuid: string) => GroupMetrics;
  failGroupList?: () => boolean;
} = {}): VideriStub {
  const calls: string[] = [];
  const groups = opts.groups ?? [{ uuid: "g1", displayName: "One", active: true }];
  const videri = {
    async request(_service: string, path: string) {
      calls.push(path);
      if (path === "/v1/groups") {
        if (opts.failGroupList?.()) throw new Error("rpm 503");
        return { groups, meta: { total: groups.length } };
      }
      const m = /\/groups\/([^/]+)\/metrics$/.exec(path);
      if (m) {
        const uuid = decodeURIComponent(m[1]!);
        return opts.metrics
          ? opts.metrics(uuid)
          : { current: { totalCanvasesCount: 10, thirtyDaysMoreOfflineCanvasesCount: 3 } };
      }
      throw new Error(`unexpected path ${path}`);
    },
  } as unknown as VideriHttp;
  return { videri, calls, fanOuts: () => calls.filter((p) => p === "/v1/groups").length };
}

const build = (videri?: VideriHttp) =>
  buildServer({
    pool: stubPool(),
    repo: {} as unknown as Repository,
    auth: { token: TOKEN, allowAnonymous: false },
    ...(videri ? { videri } : {}),
  });

const get = async (app: Awaited<ReturnType<typeof buildServer>>) => {
  const res = await app.inject({ method: "GET", url: "/api/fleet/rollups", headers: auth });
  return { statusCode: res.statusCode, body: res.json() as { data?: Record<string, unknown>; error?: string } };
};

// ─── cache freshness disclosure ───────────────────────────────────────────────

test("the first rollup is labelled uncached and carries its own collection instant", async () => {
  const stub = stubVideri();
  const app = await build(stub.videri);
  const { statusCode, body } = await get(app);

  assert.equal(statusCode, 200);
  assert.equal(body.data!["cached"], false, "a freshly computed rollup is not cached");
  assert.equal(typeof body.data!["collectedAt"], "string");
  assert.ok(Number.isFinite(body.data!["ageSeconds"] as number));
  assert.ok((body.data!["ageSeconds"] as number) < 5, "a just-computed rollup is seconds old");
  assert.equal(stub.fanOuts(), 1);
  await app.close();
});

test("a second request inside the TTL is served from cache WITHOUT re-firing the fan-out", async () => {
  // The load-bearing property: ~94 outbound calls per dashboard load would be a
  // self-inflicted rate problem against an API that documents no rate limit.
  const stub = stubVideri({
    groups: [
      { uuid: "g1", displayName: "One" },
      { uuid: "g2", displayName: "Two" },
      { uuid: "g3", displayName: "Three" },
    ],
  });
  const app = await build(stub.videri);

  const first = await get(app);
  const callsAfterFirst = stub.calls.length;
  const second = await get(app);

  assert.equal(second.statusCode, 200);
  assert.equal(second.body.data!["cached"], true, "the repeat must announce it is cached");
  assert.equal(first.body.data!["cached"], false);
  assert.equal(stub.calls.length, callsAfterFirst, "no additional control-plane calls");
  assert.equal(stub.fanOuts(), 1, "exactly one fan-out served both requests");
  // Same numbers, same collection instant — not a new reading dressed as one.
  assert.deepEqual(second.body.data!["fleet"], first.body.data!["fleet"]);
  assert.equal(second.body.data!["collectedAt"], first.body.data!["collectedAt"]);
  await app.close();
});

test("a cached rollup ages in the payload rather than being re-presented as live", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-31T12:00:00Z") });
  const stub = stubVideri();
  const app = await build(stub.videri);

  const first = await get(app);
  assert.equal(first.body.data!["ageSeconds"], 0);

  // 25 minutes later: still inside the 30-minute TTL, so still cached — but the
  // client is told it is looking at a 25-minute-old rollup.
  t.mock.timers.tick(25 * 60 * 1000);
  const later = await get(app);
  assert.equal(later.body.data!["cached"], true);
  assert.equal(later.body.data!["ageSeconds"], 1500, "age must grow with the wall clock");
  assert.equal(later.body.data!["collectedAt"], first.body.data!["collectedAt"]);
  assert.equal(stub.fanOuts(), 1);
  await app.close();
});

test("past the TTL the rollup is recomputed and reported uncached again", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-31T12:00:00Z") });
  const stub = stubVideri();
  const app = await build(stub.videri);

  await get(app);
  t.mock.timers.tick(30 * 60 * 1000 + 1000); // just past 30 minutes
  const refreshed = await get(app);

  assert.equal(refreshed.body.data!["cached"], false, "an expired rollup must be recomputed");
  assert.equal(refreshed.body.data!["ageSeconds"], 0);
  assert.equal(refreshed.body.data!["collectedAt"], "2026-08-31T12:30:01.000Z");
  assert.equal(stub.fanOuts(), 2, "the TTL expiry triggered exactly one more fan-out");
  await app.close();
});

// ─── never cache a failure, never cache across instances ──────────────────────

test("a failed fan-out is not cached as a fleet of zero canvases", async () => {
  // A 500 is the honest answer to "we could not read the aggregator". What must
  // NOT happen is that failure being memoised — the next request has to try again,
  // and must not be handed an empty rollup that reads as a healthy fleet of nil.
  let broken = true;
  const stub = stubVideri({ failGroupList: () => broken });
  const app = await build(stub.videri);

  const failed = await get(app);
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.body.error, "internal_error");
  assert.equal(failed.body.data, undefined, "no rollup payload is emitted on failure");

  broken = false;
  const recovered = await get(app);
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.body.data!["cached"], false, "the failure must not have been cached");
  assert.equal((recovered.body.data!["fleet"] as { totalCanvases: number }).totalCanvases, 10);
  assert.equal(stub.fanOuts(), 2, "the retry actually re-fanned-out");
  await app.close();
});

test("the cache is per server instance and never leaks between them", async () => {
  const a = stubVideri({ metrics: () => ({ current: { totalCanvasesCount: 10 } }) });
  const appA = await build(a.videri);
  await get(appA);

  const b = stubVideri({ metrics: () => ({ current: { totalCanvasesCount: 77 } }) });
  const appB = await build(b.videri);
  const fromB = await get(appB);

  assert.equal(fromB.body.data!["cached"], false, "a new instance starts with an empty cache");
  assert.equal((fromB.body.data!["fleet"] as { totalCanvases: number }).totalCanvases, 77);
  assert.equal(b.fanOuts(), 1, "instance B computed its own rollup");
  await appA.close();
  await appB.close();
});

// ─── payload contract alongside the cache ─────────────────────────────────────

test("no control plane is a 503 that computes and caches nothing", async () => {
  const app = await build(undefined);
  const first = await get(app);
  assert.equal(first.statusCode, 503);
  assert.equal(first.body.error, "no_control_plane");
  assert.equal(first.body.data, undefined, "never an empty rollup that reads as a zero fleet");
  // Still 503 on the repeat — no cached empty result took its place.
  const second = await get(app);
  assert.equal(second.statusCode, 503);
  assert.equal(second.body.error, "no_control_plane");
  await app.close();
});

test("a partial fan-out is served, and the cached copy keeps the failure count", async () => {
  // The failure count is the whole point of the meta block: a total built from
  // 2/3 groups must not be indistinguishable from one built from 3/3 — including
  // after it has been through the cache.
  const stub = stubVideri({
    groups: [{ uuid: "g1" }, { uuid: "g2" }, { uuid: "boom" }],
    metrics: (uuid) => {
      if (uuid === "boom") throw new Error("aggregator 500");
      return { current: { totalCanvasesCount: 4, thirtyDaysMoreOfflineCanvasesCount: 1 } };
    },
  });
  const app = await build(stub.videri);

  const first = await get(app);
  assert.equal(first.statusCode, 200, "a partial read is still worth serving");
  assert.deepEqual(first.body.data!["meta"], { groupsRead: 2, groupsFailed: 1 });
  assert.equal((first.body.data!["fleet"] as { totalCanvases: number }).totalCanvases, 8);

  const cached = await get(app);
  assert.equal(cached.body.data!["cached"], true);
  assert.deepEqual(
    cached.body.data!["meta"],
    { groupsRead: 2, groupsFailed: 1 },
    "the cached copy must not launder away the failed group",
  );
  await app.close();
});

test("the rollup carries the standard freshness envelope, distinct from its own age", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-31T12:00:00Z") });
  const stub = stubVideri();
  const app = await build(stub.videri);
  const res = await app.inject({ method: "GET", url: "/api/fleet/rollups", headers: auth });
  const body = res.json() as {
    data: Record<string, unknown>;
    meta: { freshness: { state: string; ageSeconds: number | null } };
  };

  // Two independent clocks, both disclosed: the poller data behind the envelope,
  // and the live aggregator fan-out this rollup came from.
  assert.ok(body.meta.freshness.state, "the poller freshness envelope is present");
  assert.equal(body.data["ageSeconds"], 0, "the rollup's own age is separate from it");
  assert.notEqual(body.data["collectedAt"], undefined);
  await app.close();
});

test("the endpoint requires a token like every other data route", async () => {
  const stub = stubVideri();
  const app = await build(stub.videri);
  const res = await app.inject({ method: "GET", url: "/api/fleet/rollups" });
  assert.equal(res.statusCode, 401);
  assert.equal(stub.calls.length, 0, "an unauthenticated request must not reach the control plane");
  await app.close();
});
