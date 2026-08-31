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
