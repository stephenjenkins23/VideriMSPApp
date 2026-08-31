/**
 * Aggregator rollup tests — `node --test dist/videri/services/aggregator.test.js`
 *
 * The summation is pure, so it is tested directly: null-guarding a missing
 * `current`, summing the five live fields, and worst-offline-first ordering. The
 * service is exercised against a stubbed fetcher so partial-failure counting is
 * asserted without a network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AggregatorService,
  groupRollupFromMetrics,
  summariseRollups,
  type GroupMetrics,
  type GroupRollup,
  type RawGroup,
} from "./aggregator.js";

const rollup = (over: Partial<GroupRollup> = {}): GroupRollup => ({
  uuid: "g",
  name: "G",
  active: true,
  totalCanvases: 0,
  offline30d: 0,
  offline6mo: 0,
  noEvents: 0,
  singleContent: 0,
  ...over,
});

// ─── pure extraction ──────────────────────────────────────────────────────────

test("groupRollupFromMetrics maps the five live counts under `current`", () => {
  const raw: GroupMetrics = {
    current: {
      totalCanvasesCount: 10,
      thirtyDaysMoreOfflineCanvasesCount: 4,
      sixMonthsMoreOfflineCanvasesCount: 2,
      canvasesWithNoEventsCount: 1,
      canvasesWithSingleContentCount: 3,
      // Degenerate on this tenant — must not appear in the rollup.
      scheduleExpiringInSevenDaysCount: 0,
      totalAccountsCount: 0,
    },
    lastMonth: null,
  };
  const g = groupRollupFromMetrics({ uuid: "u1", displayName: "Lobby", active: true }, raw);
  assert.deepEqual(g, {
    uuid: "u1",
    name: "Lobby",
    active: true,
    totalCanvases: 10,
    offline30d: 4,
    offline6mo: 2,
    noEvents: 1,
    singleContent: 3,
  });
});

test("groupRollupFromMetrics null-guards a null `current` to zeros, not NaN", () => {
  const g = groupRollupFromMetrics({ uuid: "u2" }, { current: null, lastMonth: null });
  assert.deepEqual(g, {
    uuid: "u2",
    name: null,
    active: null,
    totalCanvases: 0,
    offline30d: 0,
    offline6mo: 0,
    noEvents: 0,
    singleContent: 0,
  });
});

test("groupRollupFromMetrics null-guards absent fields and a null payload", () => {
  assert.equal(groupRollupFromMetrics({ uuid: "u3" }, null).offline30d, 0);
  assert.equal(groupRollupFromMetrics({ uuid: "u4" }, undefined).totalCanvases, 0);
  // A stray null count coerces to 0 rather than propagating.
  const g = groupRollupFromMetrics(
    { uuid: "u5" },
    { current: { totalCanvasesCount: null, thirtyDaysMoreOfflineCanvasesCount: 7 } },
  );
  assert.equal(g.totalCanvases, 0);
  assert.equal(g.offline30d, 7);
});

// ─── pure summation ───────────────────────────────────────────────────────────

test("summariseRollups sums the five fields across groups", () => {
  const res = summariseRollups(
    [
      rollup({ totalCanvases: 10, offline30d: 4, offline6mo: 2, noEvents: 1, singleContent: 3 }),
      rollup({ totalCanvases: 5, offline30d: 1, offline6mo: 1, noEvents: 0, singleContent: 2 }),
    ],
    0,
  );
  assert.deepEqual(res.fleet, {
    totalCanvases: 15,
    offline30d: 5,
    offline6mo: 3,
    noEvents: 1,
    singleContent: 5,
  });
  assert.deepEqual(res.meta, { groupsRead: 2, groupsFailed: 0 });
});

test("summariseRollups sorts drill-down worst-offline-first", () => {
  const res = summariseRollups(
    [
      rollup({ uuid: "a", name: "A", offline30d: 1, offline6mo: 9 }),
      rollup({ uuid: "b", name: "B", offline30d: 5, offline6mo: 0 }),
      rollup({ uuid: "c", name: "C", offline30d: 5, offline6mo: 3 }),
    ],
    0,
  );
  // 30d desc first (b/c both 5, ahead of a=1), then 6mo desc breaks b vs c.
  assert.deepEqual(res.groups.map((g) => g.uuid), ["c", "b", "a"]);
});

test("summariseRollups breaks a full tie by name for a stable order", () => {
  const res = summariseRollups(
    [
      rollup({ uuid: "z", name: "Zeta", offline30d: 2, offline6mo: 2 }),
      rollup({ uuid: "a", name: "Alpha", offline30d: 2, offline6mo: 2 }),
    ],
    0,
  );
  assert.deepEqual(res.groups.map((g) => g.name), ["Alpha", "Zeta"]);
});

test("summariseRollups records groupsFailed and does not fabricate them into the sum", () => {
  const res = summariseRollups([rollup({ totalCanvases: 8, offline30d: 3 })], 4);
  assert.equal(res.fleet.totalCanvases, 8);
  assert.deepEqual(res.meta, { groupsRead: 1, groupsFailed: 4 });
});

// ─── service against a stubbed fetcher ────────────────────────────────────────

/** Minimal fake VideriHttp: list groups, then per-group metrics from a map. */
function fakeHttp(
  groups: RawGroup[],
  metrics: (uuid: string) => GroupMetrics,
  opts: { total?: number; firstPage?: RawGroup[] } = {},
) {
  const calls: string[] = [];
  let groupCalls = 0;
  const http = {
    async request(_service: string, path: string, _reqOpts?: { query?: { count?: number } }) {
      calls.push(path);
      if (path === "/v1/groups") {
        const total = opts.total ?? groups.length;
        // First page may under-read (subset); the widened re-ask returns all.
        const page = opts.firstPage && groupCalls === 0 ? opts.firstPage : groups;
        groupCalls++;
        return { groups: page, meta: { total } };
      }
      const m = /\/groups\/([^/]+)\/metrics$/.exec(path);
      if (m) return metrics(decodeURIComponent(m[1]!));
      throw new Error(`unexpected path ${path}`);
    },
  } as unknown as import("../http.js").VideriHttp;
  return { http, calls };
}

test("fleetRollups sums a clean fan-out and reports zero failures", async () => {
  const groups: RawGroup[] = [
    { uuid: "g1", displayName: "One", active: true },
    { uuid: "g2", displayName: "Two", active: true },
  ];
  const { http } = fakeHttp(groups, (uuid) => ({
    current: {
      totalCanvasesCount: uuid === "g1" ? 10 : 5,
      thirtyDaysMoreOfflineCanvasesCount: uuid === "g1" ? 4 : 1,
    },
  }));
  const res = await new AggregatorService(http).fleetRollups();
  assert.equal(res.fleet.totalCanvases, 15);
  assert.equal(res.fleet.offline30d, 5);
  assert.deepEqual(res.meta, { groupsRead: 2, groupsFailed: 0 });
});

test("fleetRollups counts a failed group in groupsFailed, not silently dropped", async () => {
  const groups: RawGroup[] = [
    { uuid: "ok", displayName: "Ok" },
    { uuid: "boom", displayName: "Boom" },
  ];
  const { http } = fakeHttp(groups, (uuid) => {
    if (uuid === "boom") throw new Error("metrics 500");
    return { current: { totalCanvasesCount: 7, thirtyDaysMoreOfflineCanvasesCount: 2 } };
  });
  const res = await new AggregatorService(http).fleetRollups();
  assert.equal(res.fleet.totalCanvases, 7);
  assert.deepEqual(res.meta, { groupsRead: 1, groupsFailed: 1 });
});

test("listGroups re-asks with count=total when the first page under-reads", async () => {
  const all: RawGroup[] = Array.from({ length: 12 }, (_, i) => ({ uuid: `g${i}`, displayName: `G${i}` }));
  const { http, calls } = fakeHttp(all, () => ({ current: { totalCanvasesCount: 1 } }), {
    total: 12,
    firstPage: all.slice(0, 10),
  });
  const res = await new AggregatorService(http).fleetRollups();
  // Widened re-ask happened, so all 12 groups were read.
  assert.equal(res.meta.groupsRead, 12);
  assert.equal(calls.filter((p) => p === "/v1/groups").length, 2);
});

// ─── the `count=`-only pagination trap ────────────────────────────────────────
//
// `rpm /v1/groups` silently IGNORES `page`, `size` and `offset` and defaults to
// ~10 groups. That is the single most dangerous behaviour on this route: a
// paginator written the conventional way returns 10 of 94 groups and the fleet
// total comes out ~90% short with no error anywhere. The tests above only counted
// calls; these pin the actual query parameters.

/** Records the query object handed to every `/v1/groups` request. */
function recordingHttp(opts: { pages: RawGroup[][]; total?: number }) {
  const queries: Array<Record<string, unknown> | undefined> = [];
  let page = 0;
  const http = {
    async request(_service: string, path: string, reqOpts?: { query?: Record<string, unknown> }) {
      if (path === "/v1/groups") {
        queries.push(reqOpts?.query);
        const groups = opts.pages[Math.min(page, opts.pages.length - 1)] ?? [];
        page++;
        return {
          groups,
          ...(opts.total === undefined ? {} : { meta: { total: opts.total } }),
        };
      }
      return { current: { totalCanvasesCount: 1 } };
    },
  } as unknown as import("../http.js").VideriHttp;
  return { http, queries, groupCalls: () => queries.length };
}

test("listGroups asks for a wide first page by count, and never by page/size/offset", async () => {
  const first = Array.from({ length: 40 }, (_, i) => ({ uuid: `g${i}` }));
  const { http, queries } = recordingHttp({ pages: [first], total: 40 });
  const groups = await new AggregatorService(http).listGroups();

  assert.equal(groups.length, 40);
  assert.equal(queries.length, 1, "one wide page was enough");
  assert.deepEqual(queries[0], { count: 100 }, "the first ask is a wide count, nothing else");
  for (const q of queries) {
    for (const ignored of ["page", "size", "offset", "limit"]) {
      assert.equal(ignored in (q ?? {}), false, `${ignored} is silently ignored by rpm — never send it`);
    }
  }
});

test("the widened re-ask uses count=meta.total exactly, and stops at two calls", async () => {
  // A tenant larger than the 100-wide first page: the second ask must request the
  // reported total, and there must be no third call (no unbounded paginate loop).
  const firstPage = Array.from({ length: 100 }, (_, i) => ({ uuid: `g${i}` }));
  const everything = Array.from({ length: 137 }, (_, i) => ({ uuid: `g${i}` }));
  const { http, queries } = recordingHttp({ pages: [firstPage, everything], total: 137 });
  const groups = await new AggregatorService(http).listGroups();

  assert.equal(groups.length, 137, "the whole tenant was read, not just the first page");
  assert.equal(queries.length, 2, "at most two calls — never a paginate loop");
  assert.deepEqual(queries[0], { count: 100 });
  assert.deepEqual(queries[1], { count: 137 }, "re-ask must be count=meta.total");
});

test("a first page that already holds everything is not re-asked for", async () => {
  const all = Array.from({ length: 7 }, (_, i) => ({ uuid: `g${i}` }));
  const { http, queries } = recordingHttp({ pages: [all], total: 7 });
  assert.equal((await new AggregatorService(http).listGroups()).length, 7);
  assert.equal(queries.length, 1, "no pointless second round-trip");
});

test("an absent meta.total is trusted as complete rather than re-asked forever", async () => {
  // No `meta` at all: total falls back to what came back, so the page is taken as
  // the whole list. The alternative — re-asking on a missing total — would double
  // every call on a route that reports no meta.
  const all = Array.from({ length: 5 }, (_, i) => ({ uuid: `g${i}` }));
  const { http, queries } = recordingHttp({ pages: [all] });
  assert.equal((await new AggregatorService(http).listGroups()).length, 5);
  assert.equal(queries.length, 1);
});

test("a group list with no groups key is an empty list, not a crash", async () => {
  const { http } = recordingHttp({ pages: [[]] });
  assert.deepEqual(await new AggregatorService(http).listGroups(), []);
});

test("an empty tenant is an honest empty rollup, not a failure", async () => {
  const { http } = fakeHttp([], () => ({ current: { totalCanvasesCount: 1 } }));
  const res = await new AggregatorService(http).fleetRollups();
  assert.deepEqual(res.groups, []);
  assert.deepEqual(res.meta, { groupsRead: 0, groupsFailed: 0 });
  // Zero groups genuinely sums to zero — and `groupsRead: 0` is what tells the
  // caller this is an empty tenant rather than 94 groups that all failed.
  assert.equal(res.fleet.totalCanvases, 0);
});

// ─── bounded fan-out and addressing ──────────────────────────────────────────

test("the metrics fan-out never exceeds its concurrency ceiling", async () => {
  // No rate limit is documented anywhere in the Videri API and no operation
  // declares a 429, so we have no published budget to work to; parallelism must
  // stay where we set it.
  const groups = Array.from({ length: 30 }, (_, i) => ({ uuid: `g${i}` }));
  let inFlight = 0;
  let peak = 0;
  const http = {
    async request(_service: string, path: string) {
      if (path === "/v1/groups") return { groups, meta: { total: groups.length } };
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return { current: { totalCanvasesCount: 1 } };
    },
  } as unknown as import("../http.js").VideriHttp;

  const res = await new AggregatorService(http).fleetRollups(4);
  assert.equal(res.meta.groupsRead, 30, "every group was still read");
  assert.ok(peak <= 4, `peak in-flight ${peak} exceeded the ceiling of 4`);
  assert.ok(peak > 1, "and the fan-out is actually parallel, not serialised");
});

test("every group is read even when the whole fan-out fails, and all are counted", async () => {
  // The invariant: 94 failures must be visible as 94 failures. A total of 0 with
  // groupsRead 0 / groupsFailed 94 reads as "we could not see the fleet"; the same
  // total with groupsFailed 0 would read as "the fleet is empty".
  const groups = Array.from({ length: 6 }, (_, i) => ({ uuid: `g${i}` }));
  const { http } = fakeHttp(groups, () => {
    throw new Error("aggregator 500");
  });
  const res = await new AggregatorService(http).fleetRollups(3);
  assert.deepEqual(res.meta, { groupsRead: 0, groupsFailed: 6 });
  assert.equal(res.fleet.totalCanvases, 0);
  assert.deepEqual(res.groups, []);
});

test("a group uuid is URL-encoded into the metrics path", async () => {
  const paths: string[] = [];
  const http = {
    async request(_service: string, path: string) {
      paths.push(path);
      return { current: { totalCanvasesCount: 1 } };
    },
  } as unknown as import("../http.js").VideriHttp;
  await new AggregatorService(http).fetchGroupMetrics("a b/c?d");
  assert.equal(paths[0], "/api/v1/groups/a%20b%2Fc%3Fd/metrics");
});

test("summariseRollups never mutates the array it was handed", async () => {
  // The sort is on a copy: the caller's list (and the cached rollup upstream)
  // must keep its own order.
  const input = [
    rollup({ uuid: "a", name: "A", offline30d: 1 }),
    rollup({ uuid: "b", name: "B", offline30d: 9 }),
  ];
  const res = summariseRollups(input, 0);
  assert.deepEqual(input.map((g) => g.uuid), ["a", "b"], "input order preserved");
  assert.deepEqual(res.groups.map((g) => g.uuid), ["b", "a"]);
});

test("a negative or absurd count from the platform still sums arithmetically", async () => {
  // The platform has never returned a negative count, but if it does the sum must
  // stay a number rather than silently becoming NaN and rendering as "-".
  const res = summariseRollups(
    [rollup({ totalCanvases: -3, offline30d: 2 }), rollup({ totalCanvases: 10 })],
    0,
  );
  assert.equal(res.fleet.totalCanvases, 7);
  assert.ok(Number.isFinite(res.fleet.totalCanvases));
});

test("a non-numeric count from the platform is coerced to 0, never NaN in the sum", async () => {
  const g = groupRollupFromMetrics(
    { uuid: "u" },
    { current: { totalCanvasesCount: "12" as unknown as number, thirtyDaysMoreOfflineCanvasesCount: 5 } },
  );
  assert.equal(g.totalCanvases, 0, "a stray string is not silently trusted as a count");
  const res = summariseRollups([g], 0);
  assert.ok(Number.isFinite(res.fleet.totalCanvases));
  assert.equal(res.fleet.offline30d, 5, "the readable sibling field still contributes");
});
