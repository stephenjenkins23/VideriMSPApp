/**
 * Group hierarchy tests — `node --test dist/videri/services/group-hierarchy.test.js`
 *
 * The site dimension is now what venue correlation clusters on, so a wrong
 * depth-1 resolution does not fail loudly — it silently invents or hides venue
 * findings. These tests pin the tree walk (including the awkward shapes: dangling
 * parents, cycles, root-level groups, empty display names), the honest coverage
 * counters, and the cache's refusal to serve an empty index as if it were a read.
 *
 * The fixture mirrors the real VIDERISALES shape: a "Videri Prod" root with
 * top-level org units beneath it and deeper nesting under those.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GroupSiteCache,
  ancestorChain,
  buildGroupIndex,
  resolveSite,
  withSites,
} from "./group-hierarchy.js";
import type { RawGroup } from "./aggregator.js";
import type { DeviceView } from "../../intelligence/remediation.js";

/**
 * root
 *  ├─ sales            (depth 1)
 *  │   ├─ sales-emea   (depth 2)
 *  │   │   └─ sales-uk (depth 3)
 *  │   └─ sales-us     (depth 2)
 *  ├─ techops          (depth 1)
 *  └─ unnamed          (depth 1, empty displayName — the 1000015 case)
 */
const GROUPS: RawGroup[] = [
  { uuid: "root", displayName: "Videri Prod", parentUuid: null },
  { uuid: "sales", displayName: "Videri Sales", parentUuid: "root" },
  { uuid: "sales-emea", displayName: "EMEA", parentUuid: "sales" },
  { uuid: "sales-uk", displayName: "UK", parentUuid: "sales-emea" },
  { uuid: "sales-us", displayName: "US", parentUuid: "sales" },
  { uuid: "techops", displayName: "Techops", parentUuid: "root" },
  { uuid: "unnamed", displayName: "", parentUuid: "root" },
];

const index = buildGroupIndex(GROUPS);

const dev = (over: Partial<DeviceView> = {}): DeviceView => ({
  id: "d1",
  name: "Device",
  status: "online",
  lastOnlineTime: null,
  city: null,
  groupId: null,
  site: null,
  firmwareCurrent: null,
  firmwareBehind: false,
  screen: { isBlackScreen: null, showingLogo: null, nowPlayingId: null },
  telemetry: null,
  drift: [],
  brightnessRaw: null,
  ...over,
});

// ── the index ────────────────────────────────────────────────────────────────

test("buildGroupIndex keys every group by uuid and normalises the root's parent", () => {
  assert.equal(index.size, 7);
  assert.equal(index.get("root")!.parentUuid, null);
  assert.equal(index.get("sales-uk")!.parentUuid, "sales-emea");
});

test("an empty displayName becomes null, not an empty-string name", () => {
  // Device 1000015 has a real group_id whose display name is "". A "" name must
  // never be rendered as a site label — null makes the caller fall back to uuid.
  assert.equal(index.get("unnamed")!.name, null);
});

test("a group with no uuid is dropped rather than indexed under undefined", () => {
  const built = buildGroupIndex([{ uuid: "" }, { uuid: "ok" }] as RawGroup[]);
  assert.equal(built.size, 1);
  assert.ok(built.has("ok"));
});

test("an empty-string parentUuid is treated as no parent, not as a group named ''", () => {
  const built = buildGroupIndex([{ uuid: "a", parentUuid: "   " }]);
  assert.equal(built.get("a")!.parentUuid, null);
});

// ── the chain ────────────────────────────────────────────────────────────────

test("ancestorChain walks from the group to the root, root last", () => {
  assert.deepEqual(
    ancestorChain(index, "sales-uk").map((n) => n.uuid),
    ["sales-uk", "sales-emea", "sales", "root"],
  );
});

test("a cycle terminates the walk instead of looping forever", () => {
  const cyclic = buildGroupIndex([
    { uuid: "a", parentUuid: "b" },
    { uuid: "b", parentUuid: "a" },
  ]);
  const chain = ancestorChain(cyclic, "a");
  assert.deepEqual(chain.map((n) => n.uuid), ["a", "b"]);
  // And a cyclic tree has no meaningful root, so "b" is treated as the top and
  // "a" as the depth-1 site. What matters is that it RETURNS.
  assert.equal(resolveSite(cyclic, "a")!.uuid, "a");
});

test("a parentUuid pointing outside the list stops the walk at what we can see", () => {
  const partial = buildGroupIndex([{ uuid: "child", parentUuid: "missing-parent" }]);
  assert.deepEqual(ancestorChain(partial, "child").map((n) => n.uuid), ["child"]);
});

// ── depth-1 resolution ───────────────────────────────────────────────────────

test("a device deep in the tree rolls up to its DEPTH-1 ancestor, not its own group", () => {
  // The whole point of the rewire: 'UK' at depth 3 must report as 'Videri Sales'.
  assert.deepEqual(resolveSite(index, "sales-uk"), { uuid: "sales", name: "Videri Sales" });
  assert.deepEqual(resolveSite(index, "sales-us"), { uuid: "sales", name: "Videri Sales" });
});

test("a device already at depth 1 resolves to itself", () => {
  assert.deepEqual(resolveSite(index, "techops"), { uuid: "techops", name: "Techops" });
});

test("a device in the ROOT group has no site — null, never the root itself", () => {
  // "Videri Prod" is the tenant, not a venue. Clustering on it would be the same
  // one-giant-bucket mistake the city field makes.
  assert.equal(resolveSite(index, "root"), null);
});

test("a null, empty or unknown group_id resolves to null, never to a guess", () => {
  assert.equal(resolveSite(index, null), null);
  assert.equal(resolveSite(index, undefined), null);
  assert.equal(resolveSite(index, ""), null);
  assert.equal(resolveSite(index, "not-a-group"), null);
});

test("a site whose display name is empty still resolves, carrying a null name", () => {
  assert.deepEqual(resolveSite(index, "unnamed"), { uuid: "unnamed", name: null });
});

// ── attaching sites + honest coverage ────────────────────────────────────────

test("withSites attaches sites and reports honest coverage denominators", () => {
  const devices = [
    dev({ id: "a", groupId: "sales-uk" }),
    dev({ id: "b", groupId: "sales-us" }),
    dev({ id: "c", groupId: "techops" }),
    dev({ id: "d", groupId: null }),
    dev({ id: "e", groupId: "ghost-group" }),
    dev({ id: "f", groupId: "root" }),
  ];
  const { devices: out, coverage } = withSites(devices, index);

  assert.equal(out[0]!.site!.name, "Videri Sales");
  assert.equal(out[2]!.site!.name, "Techops");
  assert.equal(out[3]!.site, null);
  assert.deepEqual(coverage, {
    devices: 6,
    resolved: 3,
    // No group at all is a different unknown from a group we could not place.
    withoutGroupId: 1,
    unresolved: 2,
    sites: 2,
  });
});

test("withSites does not mutate the devices it was handed", () => {
  const input = [dev({ id: "a", groupId: "techops" })];
  const { devices: out } = withSites(input, index);
  assert.equal(input[0]!.site, null, "caller's array untouched");
  assert.equal(out[0]!.site!.uuid, "techops");
});

test("an empty fleet is empty coverage, not a divide-by-zero", () => {
  const { devices, coverage } = withSites([], index);
  assert.deepEqual(devices, []);
  assert.equal(coverage.devices, 0);
  assert.equal(coverage.sites, 0);
});

// ── the cache ────────────────────────────────────────────────────────────────

/** Fake http that counts `/v1/groups` reads and can be made to fail. */
function stubHttp(opts: { fail?: boolean } = {}) {
  let calls = 0;
  const http = {
    async request(_service: string, path: string) {
      if (path !== "/v1/groups") throw new Error(`unexpected path ${path}`);
      calls += 1;
      if (opts.fail) throw new Error("rpm 503");
      return { groups: GROUPS, meta: { total: GROUPS.length } };
    },
  } as unknown as import("../http.js").VideriHttp;
  return { http, calls: () => calls };
}

test("the group tree is read once and served from cache inside its TTL", async () => {
  // The reason the cache exists: correlation is a dashboard poll, and refetching
  // 94 groups per request is control-plane traffic for a tree that barely changes.
  const stub = stubHttp();
  let now = 1_000_000;
  const cache = new GroupSiteCache(stub.http, 60_000, () => now);

  const first = await cache.get();
  assert.equal(first.index!.size, 7);
  assert.equal(first.groupsRead, 7);
  assert.equal(first.ageSeconds, 0);

  now += 30_000;
  const second = await cache.get();
  assert.equal(stub.calls(), 1, "no second fetch inside the TTL");
  assert.equal(second.ageSeconds, 30, "and the mapping reports its own age");
});

test("past the TTL the tree is re-read rather than served stale forever", async () => {
  const stub = stubHttp();
  let now = 0;
  const cache = new GroupSiteCache(stub.http, 60_000, () => now);
  await cache.get();
  now = 60_001;
  const again = await cache.get();
  assert.equal(stub.calls(), 2);
  assert.equal(again.ageSeconds, 0);
});

test("a failed read yields index:null WITH a reason — never an empty index", async () => {
  // An empty index would resolve every device to no site, which reads as "no
  // venue is failing". Null is the honest "we could not look".
  const stub = stubHttp({ fail: true });
  const cache = new GroupSiteCache(stub.http);
  const result = await cache.get();
  assert.equal(result.index, null);
  assert.equal(result.groupsRead, 0);
  assert.match(result.reason!, /could not be read/);
});

test("a failure is not cached — the next request tries again", async () => {
  let fail = true;
  let calls = 0;
  const http = {
    async request() {
      calls += 1;
      if (fail) throw new Error("rpm 503");
      return { groups: GROUPS, meta: { total: GROUPS.length } };
    },
  } as unknown as import("../http.js").VideriHttp;
  const cache = new GroupSiteCache(http);

  assert.equal((await cache.get()).index, null);
  fail = false;
  assert.equal((await cache.get()).index!.size, 7);
  assert.equal(calls, 2);
});
