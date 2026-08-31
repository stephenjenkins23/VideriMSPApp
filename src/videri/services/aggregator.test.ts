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
  // groupsTotal/truncated default to "the platform said nothing" for a direct
  // call on the pure summariser — it is handed rollups, not a group listing.
  assert.deepEqual(res.meta, {
    groupsRead: 2, groupsFailed: 0, groupsTotal: null, truncated: false,
  });
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
  assert.deepEqual(res.meta, {
    groupsRead: 1, groupsFailed: 4, groupsTotal: null, truncated: false,
  });
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
  assert.deepEqual(res.meta, {
    groupsRead: 2, groupsFailed: 0, groupsTotal: 2, truncated: false,
  });
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
  assert.deepEqual(res.meta, {
    groupsRead: 1, groupsFailed: 1, groupsTotal: 2, truncated: false,
  });
});

test("a tenant that fits in one page costs exactly one call", async () => {
  const all: RawGroup[] = Array.from({ length: 12 }, (_, i) => ({ uuid: `g${i}`, displayName: `G${i}` }));
  const { http, calls } = fakeHttp(all, () => ({ current: { totalCanvasesCount: 1 } }), { total: 12 });
  const res = await new AggregatorService(http).fleetRollups();
  assert.equal(res.meta.groupsRead, 12);
  assert.equal(res.meta.groupsTotal, 12);
  assert.equal(res.meta.truncated, false);
  assert.equal(calls.filter((p) => p === "/v1/groups").length, 1);
});

// ─── the group pagination trap ─────────────────────────────────────────────
//
// Two dangerous behaviours on `rpm /v1/groups`, both measured live 2026-08-31:
//
//   1. `count` is capped at 100. count=101 and above return 400 BadRequestError
//      "Invalid queries" — so the old "re-ask with count=meta.total" strategy was
//      one group-creation spree away from hard-failing the whole rollup.
//   2. `page`, `pageNumber`, `size`, `limit`, `offset`, `skip`, `from`, `cursor`,
//      `after` and `index` are ALL silently ignored — the window never moves and
//      `meta.start` stays 0. A paginator written the conventional way reads the
//      first page forever. **`startIndex` is the one that works**, and it comes
//      back echoed in `meta.start`.
//
// These tests pin both: the ceiling, and that we page by startIndex.

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

test("listGroups pages by startIndex, capped at 100, and never sends an ignored param", async () => {
  const first = Array.from({ length: 40 }, (_, i) => ({ uuid: `g${i}` }));
  const { http, queries } = recordingHttp({ pages: [first], total: 40 });
  const groups = await new AggregatorService(http).listGroups();

  assert.equal(groups.length, 40);
  assert.equal(queries.length, 1, "one page was enough");
  assert.deepEqual(
    queries[0],
    { count: 100, startIndex: 0 },
    "count is the 100 ceiling and the offset is startIndex — nothing else",
  );
  for (const q of queries) {
    for (const ignored of ["page", "pageNumber", "size", "offset", "limit", "skip", "cursor"]) {
      assert.equal(ignored in (q ?? {}), false, `${ignored} is silently ignored by rpm — never send it`);
    }
  }
});

test("count NEVER exceeds 100 — above that the route 400s and the rollup dies", async () => {
  // The regression this guards: a 137-group tenant asked for count=137 and got a
  // 400 BadRequestError, taking the entire fleet rollup with it.
  const full = Array.from({ length: 100 }, (_, i) => ({ uuid: `g${i}` }));
  const tail = Array.from({ length: 37 }, (_, i) => ({ uuid: `g${100 + i}` }));
  const { http, queries } = recordingHttp({ pages: [full, tail], total: 137 });
  await new AggregatorService(http).listGroups();
  for (const q of queries) {
    assert.ok(Number(q?.["count"]) <= 100, `count ${String(q?.["count"])} exceeds the 100 ceiling`);
  }
});

test("a tenant larger than one page is walked by startIndex until complete", async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ uuid: `g${i}` }));
  const tail = Array.from({ length: 37 }, (_, i) => ({ uuid: `g${100 + i}` }));
  const { http, queries } = recordingHttp({ pages: [full, tail], total: 137 });
  const listing = await new AggregatorService(http).listGroupsPaged();

  assert.equal(listing.groups.length, 137, "the whole tenant was read, not just the first page");
  assert.equal(listing.groupsTotal, 137);
  assert.equal(listing.truncated, false, "a complete read is not truncated");
  assert.deepEqual(queries[0], { count: 100, startIndex: 0 });
  assert.deepEqual(queries[1], { count: 100, startIndex: 100 }, "offset advances by what came back");
  assert.equal(queries.length, 2, "and it stops as soon as the total is covered");
});

test("a short page is the last page — no pointless extra round-trip", async () => {
  // The route fills a page it can fill, so fewer than `count` back means the end.
  const page = Array.from({ length: 60 }, (_, i) => ({ uuid: `g${i}` }));
  const { http, queries } = recordingHttp({ pages: [page], total: 60 });
  const listing = await new AggregatorService(http).listGroupsPaged();
  assert.equal(listing.groups.length, 60);
  assert.equal(queries.length, 1);
  assert.equal(listing.truncated, false);
});

test("a uuid repeated across pages is deduped, never double-counted", async () => {
  // The route does not promise a stable sort (paging at count=40 returned the 94
  // groups in a different ORDER than count=100 did), so overlapping windows are
  // possible. A duplicated group would inflate every fleet total built from it.
  const full = Array.from({ length: 100 }, (_, i) => ({ uuid: `g${i}` }));
  const overlapping = [{ uuid: "g99" }, { uuid: "g100" }];
  const { http } = recordingHttp({ pages: [full, overlapping], total: 101 });
  const listing = await new AggregatorService(http).listGroupsPaged();
  assert.equal(listing.groups.length, 101, "100 + 1 new, not 102");
  assert.equal(new Set(listing.groups.map((g) => g.uuid)).size, 101);
});

test("hitting the page-call cap reports honest truncation, never a silent short list", async () => {
  // The platform claims 100,000 groups and every page comes back full. The walk
  // must stop on OUR bound and say the list is a floor — an under-read presented
  // as complete is exactly the failure this flag exists to prevent.
  const full = Array.from({ length: 100 }, (_, i) => ({ uuid: `g${i}` }));
  const { http, queries } = recordingHttp({ pages: [full], total: 100_000 });
  const listing = await new AggregatorService(http).listGroupsPaged();

  assert.equal(listing.truncated, true, "truncation must be reported");
  assert.equal(listing.groupsTotal, 100_000, "the platform's claim rides along");
  assert.ok(listing.groups.length < 100_000, "and our count is the honest floor");
  assert.ok(queries.length <= 25, `the walk must be bounded, made ${queries.length} calls`);
});

test("a truncated group list travels into the rollup meta", async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ uuid: `g${i}` }));
  const { http } = recordingHttp({ pages: [full], total: 100_000 });
  const res = await new AggregatorService(http).fleetRollups(8);
  // A fleet total summed from a knowingly-partial group list is a floor, and the
  // meta is the only place the UI can learn that.
  assert.equal(res.meta.truncated, true);
  assert.equal(res.meta.groupsTotal, 100_000);
  assert.equal(res.meta.groupsRead, 100);
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
  assert.deepEqual(res.meta, {
    groupsRead: 0, groupsFailed: 0, groupsTotal: 0, truncated: false,
  });
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
  assert.deepEqual(res.meta, {
    groupsRead: 0, groupsFailed: 6, groupsTotal: 6, truncated: false,
  });
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
