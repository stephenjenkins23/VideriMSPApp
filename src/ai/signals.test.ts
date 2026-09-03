/**
 * Deterministic device-id resolution — `node --test dist/ai/signals.test.js`
 *
 * The bug being pinned, in the live tenant's own words: the action plan's
 * top-ranked item was "Investigate site-level fault at Videri Sales, 39 devices"
 * with `deviceIds: []` and five devices named in prose, while the correlation
 * finding it cited carried all 39 ids. So the product's best output was a
 * paragraph a technician could not enumerate.
 *
 * Four properties are asserted, because each is a distinct way the old design
 * failed or could fail:
 *
 *   1. An item that cites a signal GETS THAT SIGNAL'S DEVICES. The join, not a
 *      prompt instruction.
 *   2. An item whose ids cannot be resolved SAYS SO. `deviceIds: []` with no
 *      reason reads as "no devices affected" — the original lie.
 *   3. `affectedCount` NEVER disagrees with `deviceIds.length`, and where the
 *      model's own figure differed, the response names which is authoritative.
 *   4. The legacy prose path REFUSES rather than guesses. Matching a device by
 *      name is how the brief opened a HEALTHY twin of a broken device (13 names
 *      are shared by 30 devices on this tenant), so names are not match keys and
 *      an uncorroborated prose match yields no list at all.
 *
 * Pure: no database, no Anthropic call, no device.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attentionSignals,
  correlationSignals,
  describeSignals,
  proofOfPlaySignals,
  remediationSignals,
  resolveDeviceIds,
  rollupSignals,
  signalRefs,
  siteNameIndex,
  type PlanSignal,
} from "./signals.js";

// ─── the tenant's real shapes, small enough to reason about ─────────────────

const ids = (prefix: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`);

/** The finding behind the headline item: a site cluster carrying every id. */
const SALES = {
  id: "venue::site::g-sales",
  kind: "venue",
  affectedDeviceIds: ids("sales", 39),
  summary: "39 of 78 devices at Videri Sales are offline or failing together.",
};
const MONTREAL = {
  id: "venue::site::g-montreal",
  kind: "venue",
  affectedDeviceIds: ids("mtl", 31),
  summary: "31 of 31 devices at Montreal Office are offline or failing together.",
};
const FIRMWARE = {
  id: "firmware::6.1.2-release-1186-6c381545",
  kind: "firmware-cohort",
  affectedDeviceIds: ids("fw", 13),
  summary: "Firmware 6.1.2-release-1186-6c381545 is failing at 100% vs a 56% fleet baseline.",
};

const DEVICES = [
  { site: { uuid: "g-sales", name: "Videri Sales" } },
  { site: { uuid: "g-montreal", name: "Montreal Office" } },
  { site: null },
];

const rec = (id: string, kind: string, category: string) => ({
  id,
  deviceIds: [id.split("::")[0]!],
  deviceLabel: `Canvas ${id.split("::")[0]}`,
  kind,
  category,
  symptom: "backlight off inside its ON window",
});

const RECS = [
  rec("d1::display-off", "auto-safe", "display"),
  rec("d2::display-off", "auto-safe", "display"),
  rec("d3::storage-full", "manual", "telemetry"),
];

// Cohort sizes deliberately DISTINCT (3 vs 1): the legacy prose path
// corroborates a match against the item's own count, so equal-sized cohorts
// would make the fixture, not the code, decide the outcome.
const GAPS = [
  { deviceId: "g1", gap: true, reason: "screen off" },
  { deviceId: "g2", gap: true, reason: "screen off" },
  { deviceId: "g3", gap: true, reason: "screen off" },
  { deviceId: "g4", gap: true, reason: "screen black" },
  { deviceId: "g5", gap: false, reason: null },
];

const ROLLUP_GROUPS = [
  { uuid: "g-sales", name: "Videri Sales", offline30d: 39, totalCanvases: 78 },
];

const catalog = (): PlanSignal[] => [
  ...correlationSignals([SALES, MONTREAL, FIRMWARE], siteNameIndex(DEVICES)),
  ...remediationSignals(RECS),
  ...proofOfPlaySignals(GAPS),
  ...rollupSignals(ROLLUP_GROUPS),
];

// ─── 1. the join ────────────────────────────────────────────────────────────

test("an item that cites a finding's ref gets all 39 of its device ids", () => {
  const resolved = resolveDeviceIds(
    {
      source: "correlation.findings venue 'Videri Sales'",
      sourceRefs: ["correlation/venue::site::g-sales"],
      affectedCount: 39,
    },
    catalog(),
  );

  assert.equal(resolved.deviceIds.length, 39, "the headline item is now enumerable");
  assert.deepEqual(resolved.deviceIds, SALES.affectedDeviceIds);
  assert.equal(resolved.resolution.basis, "cited-refs");
  assert.equal(resolved.resolution.reason, null, "resolved means no reason to give");
  assert.equal(resolved.resolution.countNote, null, "39 and 39 agree, so nothing to reconcile");
});

test("an item citing several refs gets the deduped UNION, in rank order", () => {
  const overlap: PlanSignal[] = [
    {
      ref: "a",
      describes: "a",
      deviceIds: ["x", "y"],
      reason: null,
      matchKeys: [],
    },
    { ref: "b", describes: "b", deviceIds: ["y", "z"], reason: null, matchKeys: [] },
  ];
  const resolved = resolveDeviceIds(
    { source: "a and b", sourceRefs: ["a", "b"], affectedCount: 3 },
    overlap,
  );
  assert.deepEqual(resolved.deviceIds, ["x", "y", "z"], "deduped, first signal's order first");
  assert.equal(resolved.affectedCount, 3);
});

test("remediation buckets resolve to every device under them, not just the ranked ones", () => {
  const resolved = resolveDeviceIds(
    { source: "remediation.summary byKind auto-safe", sourceRefs: ["remediation/kind::auto-safe"], affectedCount: 2 },
    catalog(),
  );
  assert.deepEqual(resolved.deviceIds, ["d1", "d2"]);

  const category = resolveDeviceIds(
    { source: "display recommendations", sourceRefs: ["remediation/category::display"], affectedCount: 2 },
    catalog(),
  );
  assert.deepEqual(category.deviceIds, ["d1", "d2"]);
});

test("proof-of-play gap cohorts are enumerable — the counts had ids behind them all along", () => {
  const all = resolveDeviceIds(
    { source: "proofOfPlay.summary.gaps", sourceRefs: ["proof-of-play/gaps"], affectedCount: 4 },
    catalog(),
  );
  assert.deepEqual(all.deviceIds, ["g1", "g2", "g3", "g4"], "and never the non-gap device");

  const byReason = resolveDeviceIds(
    { source: "screens off", sourceRefs: ["proof-of-play/gaps::screen off"], affectedCount: 3 },
    catalog(),
  );
  assert.deepEqual(byReason.deviceIds, ["g1", "g2", "g3"]);
});

// ─── 2. the honest unresolvable ─────────────────────────────────────────────

test("a signal that CANNOT name devices resolves to a reason, not to an empty array", () => {
  // The aggregator rollups are canvas counts from the platform's group metrics.
  // They are not our device rows, and pretending otherwise is the whole bug.
  const resolved = resolveDeviceIds(
    { source: "rollups.worstGroups 'Videri Sales'", sourceRefs: ["rollups/group::g-sales"], affectedCount: 39 },
    catalog(),
  );
  assert.deepEqual(resolved.deviceIds, []);
  assert.equal(resolved.resolution.basis, null);
  assert.match(resolved.resolution.reason!, /canvas counts/i);
  assert.match(resolved.resolution.reason!, /no device ids/i);
  assert.equal(resolved.affectedCount, 39, "the COUNT is real; only the list is unavailable");
});

test("INVARIANT: deviceIds is empty only ever WITH a reason", () => {
  const cases: Parameters<typeof resolveDeviceIds>[0][] = [
    { source: "no refs, no match", affectedCount: 5 },
    { source: "cites nothing real", sourceRefs: ["correlation/venue::site::g-nope"], affectedCount: 5 },
    { source: "rollup only", sourceRefs: ["rollups/group::g-sales"], affectedCount: 5 },
    { source: "prose that names nothing" },
  ];
  for (const item of [...cases, { source: "empty catalog", affectedCount: 1 }]) {
    const signals = item.source === "empty catalog" ? [] : catalog();
    const resolved = resolveDeviceIds(item, signals);
    if (resolved.deviceIds.length === 0) {
      assert.ok(
        resolved.resolution.reason && resolved.resolution.reason.length > 20,
        `no reason recorded for: ${item.source}`,
      );
      assert.equal(resolved.resolution.basis, null, "no basis to claim when nothing resolved");
    }
  }
});

test("an item citing a ref that was never supplied says so rather than resolving to nothing", () => {
  const resolved = resolveDeviceIds(
    { source: "invented", sourceRefs: ["correlation/venue::site::g-vanished"], affectedCount: 4 },
    catalog(),
  );
  assert.deepEqual(resolved.deviceIds, []);
  assert.match(resolved.resolution.reason!, /not a signal supplied to this run/i);
});

test("a run with NO signals at all blames the assembly, not the fleet", () => {
  const resolved = resolveDeviceIds({ source: "anything", affectedCount: 9 }, []);
  assert.match(resolved.resolution.reason!, /assembly gap, not a fleet with no affected devices/i);
});

// ─── 3. count agreement ─────────────────────────────────────────────────────

test("affectedCount is REWRITTEN to the resolved set, and both figures are reported", () => {
  const resolved = resolveDeviceIds(
    {
      source: "correlation.findings venue 'Videri Sales'",
      sourceRefs: ["correlation/venue::site::g-sales"],
      // The model's own figure, wrong by four.
      affectedCount: 35,
    },
    catalog(),
  );
  assert.equal(resolved.affectedCount, 39, "the list a technician can open is authoritative");
  assert.equal(resolved.affectedCount, resolved.deviceIds.length);
  assert.match(resolved.resolution.countNote!, /says 35/);
  assert.match(resolved.resolution.countNote!, /holds 39/);
  assert.match(resolved.resolution.countNote!, /RESOLVED SET IS AUTHORITATIVE/);
});

test("INVARIANT: whenever ids are present, affectedCount equals deviceIds.length", () => {
  const signals = catalog();
  for (const ref of signalRefs(signals)) {
    for (const claimed of [0, 1, 39, 1000]) {
      const resolved = resolveDeviceIds(
        { source: "x", sourceRefs: [ref], affectedCount: claimed },
        signals,
      );
      if (resolved.deviceIds.length > 0) {
        assert.equal(
          resolved.affectedCount,
          resolved.deviceIds.length,
          `${ref} disagreed with its own list`,
        );
        if (claimed !== resolved.deviceIds.length) {
          assert.ok(resolved.resolution.countNote, `${ref} silently rewrote the count`);
        }
      }
    }
  }
});

// ─── 4. the legacy prose path refuses rather than guesses ───────────────────

test("the STORED plan's prose resolves where the numbers corroborate it", () => {
  // Verbatim from the live `action_plans` row (2026-09-01T15:09:40Z), which is
  // the payload this change exists to fix and cannot be regenerated for free.
  const resolved = resolveDeviceIds(
    {
      source: "correlation.findings venue 'Videri Sales' (39 of 78, confidence 0.85)",
      affectedCount: 39,
    },
    catalog(),
  );
  assert.equal(resolved.deviceIds.length, 39);
  assert.equal(resolved.resolution.basis, "inferred-from-source", "a weaker basis, and labelled");
  assert.deepEqual(resolved.resolution.refs, ["correlation/venue::site::g-sales"]);
});

test("prose that names a signal it merely QUOTED does not drag that cohort in", () => {
  // Live item #4: "…byKind auto-safe = 11 and proofOfPlay.summary.byReason
  // 'screen off' = 22". The naive union hands a technician 33 devices for an
  // 11-device job. The item's own count settles which set is the scope.
  const resolved = resolveDeviceIds(
    {
      source: "remediation.summary byKind auto-safe = 2 and proofOfPlay.summary.byReason 'screen off' = 3",
      affectedCount: 2,
    },
    catalog(),
  );
  assert.deepEqual(resolved.resolution.refs, ["remediation/kind::auto-safe"]);
  assert.deepEqual(resolved.deviceIds, ["d1", "d2"]);
});

test("prose whose numbers do NOT corroborate any matched set gets no list", () => {
  // Live item #5: "correlation.findings firmware-cohort (8 findings, 100% vs
  // 56% baseline)", affectedCount 62 — it names no version, so which eight?
  const resolved = resolveDeviceIds(
    { source: "correlation.findings firmware-cohort (8 findings, 100% vs 56% baseline)", affectedCount: 62 },
    catalog(),
  );
  assert.deepEqual(resolved.deviceIds, [], "a guess here is a wrong worklist");
  assert.match(resolved.resolution.reason!, /only in prose/i);
});

test("prose that matches two cohorts ambiguously refuses instead of picking one", () => {
  const twins: PlanSignal[] = [
    {
      ref: "correlation/venue::site::a",
      describes: "site A",
      deviceIds: ids("a", 3),
      reason: null,
      matchKeys: ["NYC Office"],
    },
    {
      ref: "correlation/venue::site::b",
      describes: "site B",
      deviceIds: ids("b", 3),
      reason: null,
      matchKeys: ["NYC Office North"],
    },
  ];
  const resolved = resolveDeviceIds(
    { source: "correlation.findings venue 'NYC Office North'", affectedCount: 3 },
    twins,
  );
  assert.deepEqual(resolved.deviceIds, []);
  assert.match(resolved.resolution.reason!, /ambiguous/i);
  assert.match(resolved.resolution.reason!, /NYC Office/);
});

test("a device NAME is never a match key — this is the healthy-twin bug", () => {
  // 13 names on this tenant are shared by 30 devices, and 17 carry stray
  // whitespace. The brief's client used to resolve `device` by name and opened a
  // HEALTHY twin of a broken screen. Names are display text; ids are identity.
  const signals = attentionSignals([
    { id: "dev-broken", name: "Lobby Panel", status: "offline", openAlertCount: 3 },
    { id: "dev-healthy", name: "Lobby Panel", status: "online", openAlertCount: 0 },
  ]);
  assert.deepEqual(
    signals.flatMap((s) => s.matchKeys),
    ["dev-broken", "dev-healthy"],
    "the shared name must not be a key",
  );

  const byName = resolveDeviceIds({ source: "Lobby Panel is dark" }, signals);
  assert.deepEqual(byName.deviceIds, [], "a name match would be a coin flip between two devices");
  assert.match(byName.resolution.reason!, /only in prose/i);

  const byRef = resolveDeviceIds({ source: "x", sourceRefs: ["attention/device::dev-broken"] }, signals);
  assert.deepEqual(byRef.deviceIds, ["dev-broken"], "the ref opens the BROKEN one, every time");
});

test("with no count to corroborate, one prose match resolves and two refuse", () => {
  const signals = attentionSignals([
    { id: "only", name: "Panel", status: "offline", openAlertCount: 1 },
    { id: "other", name: "Panel", status: "offline", openAlertCount: 1 },
  ]);
  assert.deepEqual(resolveDeviceIds({ source: "device only is dark" }, signals).deviceIds, ["only"]);
  const both = resolveDeviceIds({ source: "devices only and other are dark" }, signals);
  assert.deepEqual(both.deviceIds, []);
  assert.match(both.resolution.reason!, /no count to choose between them/i);
});

test("a match key must land on a token boundary, so 'sales' does not match 'wholesales'", () => {
  const signals: PlanSignal[] = [
    {
      ref: "correlation/venue::site::g",
      describes: "site",
      deviceIds: ["x"],
      reason: null,
      matchKeys: ["Sales"],
    },
  ];
  assert.deepEqual(resolveDeviceIds({ source: "the Wholesales cohort", affectedCount: 1 }, signals).deviceIds, []);
  assert.deepEqual(resolveDeviceIds({ source: "the 'Sales' cohort", affectedCount: 1 }, signals).deviceIds, ["x"]);
});

// ─── the payload the model actually sees ────────────────────────────────────

test("the model is shown refs and counts, and NEVER a device id", () => {
  const signals = catalog();
  const descriptors = describeSignals(signals);
  const json = JSON.stringify(descriptors);

  for (const id of [...SALES.affectedDeviceIds, ...MONTREAL.affectedDeviceIds, "g1", "d1"]) {
    assert.ok(!json.includes(`"${id}"`), `device id ${id} leaked into the prompt payload`);
  }
  // 39 uuids per finding would cost more input tokens than the rest of the plan
  // input, and the join makes them unnecessary.
  const sales = descriptors.find((d) => d.ref === "correlation/venue::site::g-sales")!;
  assert.equal(sales.deviceCount, 39, "the size IS shown, so affectedCount is never estimated");
  assert.equal(sales.deviceIdsAvailable, true);

  const rollup = descriptors.find((d) => d.ref === "rollups/group::g-sales")!;
  assert.equal(rollup.deviceCount, null, "null, never 0 — it was not measured, not zero");
  assert.equal(rollup.deviceIdsAvailable, false);
  assert.match(rollup.reason!, /canvas counts/i);
});

test("every ref is unique, so an enum over them can never be ambiguous", () => {
  const refs = signalRefs(catalog());
  assert.equal(new Set(refs).size, refs.length);
});

test("a finding's ref is derived from its stable id, so a stored plan's refs still mean something", () => {
  const [sales] = correlationSignals([SALES], siteNameIndex(DEVICES));
  assert.equal(sales!.ref, "correlation/venue::site::g-sales");
  // Keyed by uuid — a display name can be renamed or blank and is not identity —
  // but the NAME is a legacy prose match key, because that is what prose names.
  assert.deepEqual(sales!.matchKeys, ["g-sales", "Videri Sales"]);
});
