/**
 * Correlation engine tests — `node --test dist/intelligence/correlation.test.js`
 *
 * The engine's whole value is trust across the fleet: a bogus cluster invented
 * from degenerate location data, or a firmware verdict drawn from a sample of
 * two, poisons the "correlated findings" surface. So every correlation is tested
 * for its positive case, its threshold boundary, and its honest-null / honest-
 * note behaviour — most importantly the degenerate-location note (feed an
 * all-LONDON fleet, assert a note, NOT a giant venue cluster).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { correlate, type Finding, type Note } from "./correlation.js";
import type { DeviceView } from "./remediation.js";

const NOW = new Date("2026-08-31T12:00:00Z");

/** A healthy, online device with everything readable and nothing wrong. */
const dev = (over: Partial<DeviceView> = {}): DeviceView => ({
  id: "dev-1",
  name: "Lobby North",
  status: "online",
  lastOnlineTime: "2026-08-31T11:59:00Z",
  city: "New York",
  // Site defaults to unresolved: the city-dimension cases below exercise the
  // fallback path, and the site cases set it explicitly.
  groupId: null,
  site: null,
  firmwareCurrent: "7.0",
  firmwareBehind: false,
  screen: { isBlackScreen: false, showingLogo: false, nowPlayingId: "c1" },
  telemetry: {
    observedAt: "2026-08-31T11:59:00Z",
    cpuPercent: 20,
    ramUsedPercent: 40,
    storageUsedPercent: 55,
    rssiDbm: -50,
    ntpOffsetMs: 2,
  },
  drift: [],
  brightnessRaw: 128,
  // Live panel state + schedule (screen-state.ts). Null = unread, so no display
  // verdict fires from this fixture unless a case sets it.
  currentBrightnessRaw: null,
  displayOn: null,
  brightnessScheduleEnabled: null,
  autoBrightnessEnabled: null,
  turnOnTime: null,
  turnOffTime: null,
  timezone: null,
  ...over,
});

/** Every reading unknown — the honest-null stress case. */
const allNull = (over: Partial<DeviceView> = {}): DeviceView => ({
  id: "dev-null",
  name: null,
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
  // Live panel state + schedule (screen-state.ts). Null = unread, so no display
  // verdict fires from this fixture unless a case sets it.
  currentBrightnessRaw: null,
  displayOn: null,
  brightnessScheduleEnabled: null,
  autoBrightnessEnabled: null,
  turnOnTime: null,
  turnOffTime: null,
  timezone: null,
  ...over,
});

/** N devices, each override applied, ids made unique. */
const many = (n: number, base: (i: number) => Partial<DeviceView>): DeviceView[] =>
  Array.from({ length: n }, (_, i) => dev({ id: `d-${i}`, ...base(i) }));

const findingOf = (fs: Finding[], kind: Finding["kind"]): Finding | undefined =>
  fs.find((f) => f.kind === kind);
const noteOf = (ns: Note[], kind: Note["kind"]): Note | undefined =>
  ns.find((n) => n.kind === kind);

// ── the honest-data invariants (load-bearing) ────────────────────────────────

test("an empty fleet is an empty report, not an error", () => {
  const r = correlate([], NOW);
  assert.deepEqual(r.findings, []);
  assert.equal(r.devicesConsidered, 0);
});

test("all-null devices yield no findings", () => {
  const r = correlate([allNull({ id: "a" }), allNull({ id: "b" }), allNull({ id: "c" })], NOW);
  assert.deepEqual(r.findings, []);
});

// ── US-2.1 venue + the degenerate-location note ──────────────────────────────

test("degenerate all-LONDON location emits an honest note, NOT a venue cluster", () => {
  // Every device offline AND co-located, which would otherwise be a huge cluster —
  // but with one distinct location it is placeholder data, so we refuse.
  const fleet = many(20, () => ({ city: "LONDON", status: "offline" }));
  const r = correlate(fleet, NOW);
  assert.ok(noteOf(r.notes, "location-degenerate"), "degenerate-location note expected");
  assert.equal(findingOf(r.findings, "venue"), undefined, "no venue cluster from degenerate data");
});

test("near-degenerate location (top share > 90%) also emits the note, not a cluster", () => {
  // 3 distinct values but LONDON covers 19/21 (>90%).
  const fleet = [
    ...many(19, () => ({ city: "LONDON", status: "offline" })),
    dev({ id: "n1", city: "NORWICH", status: "offline" }),
    dev({ id: "l1", city: "LEEDS", status: "offline" }),
  ];
  const r = correlate(fleet, NOW);
  assert.ok(noteOf(r.notes, "location-degenerate"));
  assert.equal(findingOf(r.findings, "venue"), undefined);
});

test("no location data at all emits the location-absent note", () => {
  const r = correlate([allNull({ id: "a" }), allNull({ id: "b" })], NOW);
  assert.ok(noteOf(r.notes, "location-absent"));
});

test("non-degenerate locations DO cluster co-located failing devices", () => {
  // Four well-distributed sites; only Boston has a failing cluster (>=3).
  const fleet = [
    ...many(3, (i) => ({ id: `bos-${i}`, city: "Boston", status: "offline" })),
    dev({ id: "ny-1", city: "New York" }),
    dev({ id: "ny-2", city: "New York" }),
    dev({ id: "ch-1", city: "Chicago" }),
    dev({ id: "sf-1", city: "San Francisco" }),
  ];
  const r = correlate(fleet, NOW);
  const venue = findingOf(r.findings, "venue");
  assert.ok(venue, "venue cluster expected");
  assert.equal(venue!.affectedDeviceIds.length, 3);
  assert.deepEqual(new Set(venue!.affectedDeviceIds), new Set(["bos-0", "bos-1", "bos-2"]));
});

test("venue needs >= 3 co-located failing devices (boundary)", () => {
  // Only 2 failing at Boston — below MIN_VENUE_CLUSTER.
  const fleet = [
    dev({ id: "bos-1", city: "Boston", status: "offline" }),
    dev({ id: "bos-2", city: "Boston", status: "offline" }),
    dev({ id: "ny-1", city: "New York" }),
    dev({ id: "ny-2", city: "New York" }),
    dev({ id: "ch-1", city: "Chicago" }),
    dev({ id: "sf-1", city: "San Francisco" }),
  ];
  const r = correlate(fleet, NOW);
  assert.equal(findingOf(r.findings, "venue"), undefined);
});

// ── US-2.1 venue on the SITE dimension (group hierarchy) ─────────────────────
//
// The rewire: venue clustering now keys on `site` — the depth-1 ancestor of the
// device's group in the rpm group tree — because that is the only dimension on
// this tenant that discriminates (10 real buckets over 234 devices, against a
// city field that is 99.6% "LONDON"). City survives strictly as the fallback when
// no site resolved. These cases pin: site wins when present, real clusters come
// out of it, the degenerate guard still applies to it, and the fallback is
// announced rather than silent.

/** A device placed at a site, with the city left degenerate on purpose. */
const sited = (id: string, site: string, over: Partial<DeviceView> = {}): DeviceView =>
  dev({
    id,
    groupId: `${site}-child`,
    site: { uuid: site, name: site.toUpperCase() },
    city: "LONDON",
    ...over,
  });

test("several devices failing at one SITE produce a real venue finding", () => {
  // The headline outcome of the rewire: before it, this fleet produced nothing but
  // the degenerate-city note, because every device is "LONDON".
  const fleet = [
    ...[0, 1, 2, 3].map((i) => sited(`sales-${i}`, "sales", { status: "offline" })),
    sited("tech-0", "techops"),
    sited("tech-1", "techops"),
    sited("mtl-0", "montreal"),
  ];
  const r = correlate(fleet, NOW);
  const venue = findingOf(r.findings, "venue");
  assert.ok(venue, "venue finding expected from the site dimension");
  assert.equal(venue!.id, "venue::site::sales", "keyed by group uuid, not display name");
  assert.equal(venue!.affectedDeviceIds.length, 4);
  assert.match(venue!.summary, /4 of 4 devices at SALES/);
  assert.match(venue!.rationale, /joined on group_id/);
  // And the city note is NOT emitted — the city path never ran.
  assert.equal(noteOf(r.notes, "location-degenerate"), undefined);
  assert.equal(noteOf(r.notes, "site-absent"), undefined);
});

test("a site cluster carries severity and confidence scaled by how much is dark", () => {
  const fleet = [
    ...Array.from({ length: 10 }, (_, i) => sited(`s-${i}`, "sales", { status: "offline" })),
    ...[0, 1, 2].map((i) => sited(`t-${i}`, "techops")),
    sited("m-0", "montreal"),
  ];
  const venue = findingOf(correlate(fleet, NOW).findings, "venue");
  assert.equal(venue!.severity, "critical", "10+ devices dark at one site");
  assert.equal(venue!.confidence, 0.85);
});

test("devices failing at DIFFERENT sites are separate findings, not one blob", () => {
  const fleet = [
    ...[0, 1, 2].map((i) => sited(`a-${i}`, "sales", { status: "offline" })),
    ...[0, 1, 2].map((i) => sited(`b-${i}`, "techops", { status: "offline" })),
    ...[0, 1, 2].map((i) => sited(`c-${i}`, "montreal")),
  ];
  const venues = correlate(fleet, NOW).findings.filter((f) => f.kind === "venue");
  assert.equal(venues.length, 2);
  assert.deepEqual(
    new Set(venues.map((v) => v.id)),
    new Set(["venue::site::sales", "venue::site::techops"]),
  );
});

test("two failing devices at a site is a device problem, not a site problem", () => {
  const fleet = [
    ...[0, 1].map((i) => sited(`a-${i}`, "sales", { status: "offline" })),
    ...[0, 1, 2].map((i) => sited(`b-${i}`, "techops")),
    sited("c-0", "montreal"),
  ];
  assert.equal(findingOf(correlate(fleet, NOW).findings, "venue"), undefined);
});

test("a device with a group_id we could not resolve is not clustered anywhere", () => {
  // Honest null: `site: null` means "we do not know where this is", so it must not
  // be counted into any bucket — not even a bucket of its own.
  const fleet = [
    ...[0, 1, 2].map((i) => sited(`a-${i}`, "sales", { status: "offline" })),
    ...[0, 1, 2].map((i) => sited(`b-${i}`, "techops")),
    sited("c-0", "montreal"),
    dev({ id: "orphan-1", groupId: "ghost", site: null, status: "offline", city: "LONDON" }),
    dev({ id: "orphan-2", groupId: "ghost", site: null, status: "offline", city: "LONDON" }),
    dev({ id: "orphan-3", groupId: null, site: null, status: "offline", city: "LONDON" }),
  ];
  const venues = correlate(fleet, NOW).findings.filter((f) => f.kind === "venue");
  assert.equal(venues.length, 1);
  assert.deepEqual(new Set(venues[0]!.affectedDeviceIds), new Set(["a-0", "a-1", "a-2"]));
});

test("a single-site tenant is degenerate on site too, and says so instead of clustering", () => {
  // The same guard the city field trips: one bucket covering everything is not a
  // venue, whichever dimension produced it.
  const fleet = Array.from({ length: 12 }, (_, i) =>
    sited(`s-${i}`, "sales", { status: "offline" }),
  );
  const r = correlate(fleet, NOW);
  assert.ok(noteOf(r.notes, "site-degenerate"), "degenerate-site note expected");
  assert.match(noteOf(r.notes, "site-degenerate")!.message, /1 distinct site/);
  assert.equal(findingOf(r.findings, "venue"), undefined);
});

test("one site covering >90% of the placed fleet is degenerate too", () => {
  const fleet = [
    ...Array.from({ length: 19 }, (_, i) => sited(`s-${i}`, "sales", { status: "offline" })),
    sited("t-0", "techops", { status: "offline" }),
    sited("m-0", "montreal", { status: "offline" }),
  ];
  const r = correlate(fleet, NOW);
  assert.ok(noteOf(r.notes, "site-degenerate"));
  assert.equal(findingOf(r.findings, "venue"), undefined);
});

test("a site whose display name is empty falls back to its uuid as a label", () => {
  // Device 1000015's group has a populated id and an EMPTY name; a cluster there
  // must still be reportable rather than reading as "devices at ''".
  const fleet = [
    ...[0, 1, 2].map((i) =>
      dev({ id: `n-${i}`, groupId: "g", site: { uuid: "abc-123", name: null }, status: "offline" }),
    ),
    ...[0, 1, 2].map((i) => sited(`b-${i}`, "techops")),
    sited("c-0", "montreal"),
  ];
  const venue = findingOf(correlate(fleet, NOW).findings, "venue");
  assert.ok(venue);
  assert.match(venue!.summary, /at abc-123/);
});

test("no site on any device falls back to the CITY dimension and announces it", () => {
  // The fallback path: the group tree was unreadable (or the tenant has no
  // groups), so the engine says so AND still tries the city field.
  const fleet = [
    ...many(3, (i) => ({ id: `bos-${i}`, city: "Boston", status: "offline" })),
    dev({ id: "ny-1", city: "New York" }),
    dev({ id: "ch-1", city: "Chicago" }),
    dev({ id: "sf-1", city: "San Francisco" }),
  ];
  const r = correlate(fleet, NOW);
  assert.ok(noteOf(r.notes, "site-absent"), "the fallback must be announced, not silent");
  const venue = findingOf(r.findings, "venue");
  assert.ok(venue, "the city dimension still produced its cluster");
  assert.equal(venue!.id, "venue::city::Boston", "and it is namespaced by dimension");
});

test("the real tenant shape — all-LONDON with sites — yields a site finding, not the city note", () => {
  // 234 of 250 devices resolve to 10 sites; the other 16 carry no group. This is
  // the end-to-end shape the rewire exists for.
  const fleet = [
    ...Array.from({ length: 78 }, (_, i) =>
      sited(`sales-${i}`, "sales", { status: i < 5 ? "offline" : "online" }),
    ),
    ...Array.from({ length: 56 }, (_, i) => sited(`tech-${i}`, "techops")),
    ...Array.from({ length: 31 }, (_, i) => sited(`mtl-${i}`, "montreal")),
    ...Array.from({ length: 31 }, (_, i) => sited(`nyc-${i}`, "nyc")),
    ...Array.from({ length: 16 }, (_, i) =>
      dev({ id: `nogroup-${i}`, groupId: null, site: null, city: "LONDON" }),
    ),
  ];
  const r = correlate(fleet, NOW);
  const venue = findingOf(r.findings, "venue");
  assert.ok(venue, "a real venue finding, which the city dimension could never give");
  assert.equal(venue!.affectedDeviceIds.length, 5);
  assert.equal(venue!.severity, "high");
  assert.equal(noteOf(r.notes, "location-degenerate"), undefined, "city path must not run");
  assert.equal(noteOf(r.notes, "site-degenerate"), undefined);
});

// ── US-2.2 firmware cohort ───────────────────────────────────────────────────

test("a firmware version failing far above baseline is flagged", () => {
  // 6 devices on 6.0 all offline (100%); 20 on 7.0 healthy (0%). Baseline ~23%.
  const fleet = [
    ...many(6, (i) => ({ id: `old-${i}`, firmwareCurrent: "6.0", status: "offline", city: `C${i}` })),
    ...many(20, (i) => ({ id: `new-${i}`, firmwareCurrent: "7.0", city: `C${i}` })),
  ];
  const r = correlate(fleet, NOW);
  const fw = findingOf(r.findings, "firmware-cohort");
  assert.ok(fw, "firmware finding expected");
  assert.equal(fw!.affectedDeviceIds.length, 6);
  assert.ok(fw!.summary.includes("6.0"));
});

test("a small cohort (< 5) is never blamed, however bad", () => {
  // 4 devices on 6.0 all offline; big healthy 7.0 fleet. Cohort below MIN size.
  const fleet = [
    ...many(4, (i) => ({ id: `old-${i}`, firmwareCurrent: "6.0", status: "offline", city: `C${i}` })),
    ...many(20, (i) => ({ id: `new-${i}`, firmwareCurrent: "7.0", city: `C${i}` })),
  ];
  const r = correlate(fleet, NOW);
  assert.equal(findingOf(r.findings, "firmware-cohort"), undefined);
});

test("a cohort only marginally worse than baseline is not flagged", () => {
  // 10 on 6.0 with 3 failing (30%); 10 on 7.0 with 2 failing (20%). Baseline 25%,
  // cohort 30% — delta 5 points, below the 20-point bar.
  const fleet = [
    ...many(3, (i) => ({ id: `o-off-${i}`, firmwareCurrent: "6.0", status: "offline", city: `A${i}` })),
    ...many(7, (i) => ({ id: `o-ok-${i}`, firmwareCurrent: "6.0", city: `B${i}` })),
    ...many(2, (i) => ({ id: `n-off-${i}`, firmwareCurrent: "7.0", status: "offline", city: `C${i}` })),
    ...many(8, (i) => ({ id: `n-ok-${i}`, firmwareCurrent: "7.0", city: `D${i}` })),
  ];
  const r = correlate(fleet, NOW);
  assert.equal(findingOf(r.findings, "firmware-cohort"), undefined);
});

test("null-firmware devices are excluded from cohorts and baseline", () => {
  // All firmware null → nothing to compare, no finding, no crash.
  const fleet = many(10, (i) => ({ id: `x-${i}`, firmwareCurrent: null, status: "offline" }));
  const r = correlate(fleet, NOW);
  assert.equal(findingOf(r.findings, "firmware-cohort"), undefined);
});

// ── US-2.3 symptom co-occurrence ─────────────────────────────────────────────

test("black screen + high RAM/CPU on >=2 devices → resource-linked finding", () => {
  const fleet = [
    dev({ id: "r1", city: "C1", screen: { isBlackScreen: true, showingLogo: false, nowPlayingId: null },
      telemetry: { observedAt: "t", cpuPercent: 30, ramUsedPercent: 95, storageUsedPercent: 50, rssiDbm: -50, ntpOffsetMs: 0 } }),
    dev({ id: "r2", city: "C2", screen: { isBlackScreen: true, showingLogo: false, nowPlayingId: null },
      telemetry: { observedAt: "t", cpuPercent: 99, ramUsedPercent: 40, storageUsedPercent: 50, rssiDbm: -50, ntpOffsetMs: 0 } }),
  ];
  const r = correlate(fleet, NOW);
  const f = r.findings.find((x) => x.id === "symptom::black-screen+resource");
  assert.ok(f, "resource-linked finding expected");
  assert.equal(f!.severity, "high");
  assert.equal(f!.affectedDeviceIds.length, 2);
});

test("black screen with healthy readable telemetry on >=2 devices → content-linked", () => {
  const fleet = [
    dev({ id: "c1", city: "C1", screen: { isBlackScreen: true, showingLogo: false, nowPlayingId: null } }),
    dev({ id: "c2", city: "C2", screen: { isBlackScreen: true, showingLogo: false, nowPlayingId: null } }),
  ];
  const r = correlate(fleet, NOW);
  const f = r.findings.find((x) => x.id === "symptom::black-screen+content");
  assert.ok(f, "content-linked finding expected");
  assert.equal(f!.severity, "medium");
  assert.equal(r.findings.find((x) => x.id === "symptom::black-screen+resource"), undefined);
});

test("black screens with only null telemetry yield a note, not a guessed cause", () => {
  const fleet = [
    dev({ id: "b1", city: "C1", telemetry: null, screen: { isBlackScreen: true, showingLogo: false, nowPlayingId: null } }),
    dev({ id: "b2", city: "C2", telemetry: null, screen: { isBlackScreen: true, showingLogo: false, nowPlayingId: null } }),
  ];
  const r = correlate(fleet, NOW);
  assert.ok(noteOf(r.notes, "symptom-telemetry-absent"));
  assert.equal(r.findings.find((x) => x.kind === "symptom-cooccurrence"), undefined);
});

test("a single black-screen+resource device does not make a fleet finding", () => {
  const fleet = [
    dev({ id: "r1", city: "C1", screen: { isBlackScreen: true, showingLogo: false, nowPlayingId: null },
      telemetry: { observedAt: "t", cpuPercent: 99, ramUsedPercent: 40, storageUsedPercent: 50, rssiDbm: -50, ntpOffsetMs: 0 } }),
    dev({ id: "ok", city: "C2" }),
  ];
  const r = correlate(fleet, NOW);
  assert.equal(r.findings.find((x) => x.kind === "symptom-cooccurrence"), undefined);
});

// ── US-2.4 temporal clustering ───────────────────────────────────────────────

test("many devices dropping in one short window → a correlated-drop finding", () => {
  // 4 devices offline within ~10 min, all recent.
  const fleet = [
    dev({ id: "t1", city: "C1", status: "offline", lastOnlineTime: "2026-08-31T11:50:00Z" }),
    dev({ id: "t2", city: "C2", status: "offline", lastOnlineTime: "2026-08-31T11:52:00Z" }),
    dev({ id: "t3", city: "C3", status: "offline", lastOnlineTime: "2026-08-31T11:55:00Z" }),
    dev({ id: "t4", city: "C4", status: "offline", lastOnlineTime: "2026-08-31T11:58:00Z" }),
  ];
  const r = correlate(fleet, NOW);
  const tc = findingOf(r.findings, "temporal-cluster");
  assert.ok(tc, "temporal cluster expected");
  assert.equal(tc!.affectedDeviceIds.length, 4);
});

test("offline drops spread far apart do not cluster", () => {
  // Three drops, each ~1h apart — none within the 30-min window together.
  const fleet = [
    dev({ id: "t1", city: "C1", status: "offline", lastOnlineTime: "2026-08-31T09:00:00Z" }),
    dev({ id: "t2", city: "C2", status: "offline", lastOnlineTime: "2026-08-31T10:00:00Z" }),
    dev({ id: "t3", city: "C3", status: "offline", lastOnlineTime: "2026-08-31T11:00:00Z" }),
  ];
  const r = correlate(fleet, NOW);
  assert.equal(findingOf(r.findings, "temporal-cluster"), undefined);
});

test("old offline drops (beyond the recent window) are ignored", () => {
  // Tight 3-device cluster, but 8+ hours ago — outside RECENT_OFFLINE_WINDOW.
  const fleet = [
    dev({ id: "t1", city: "C1", status: "offline", lastOnlineTime: "2026-08-31T03:00:00Z" }),
    dev({ id: "t2", city: "C2", status: "offline", lastOnlineTime: "2026-08-31T03:05:00Z" }),
    dev({ id: "t3", city: "C3", status: "offline", lastOnlineTime: "2026-08-31T03:10:00Z" }),
  ];
  const r = correlate(fleet, NOW);
  assert.equal(findingOf(r.findings, "temporal-cluster"), undefined);
});

test("temporal clustering ignores null lastOnlineTime and online devices", () => {
  const fleet = [
    dev({ id: "t1", city: "C1", status: "offline", lastOnlineTime: null }),
    dev({ id: "t2", city: "C2", status: "online", lastOnlineTime: "2026-08-31T11:55:00Z" }),
    dev({ id: "t3", city: "C3", status: "offline", lastOnlineTime: "2026-08-31T11:56:00Z" }),
  ];
  const r = correlate(fleet, NOW);
  assert.equal(findingOf(r.findings, "temporal-cluster"), undefined);
});

// ── ranking ──────────────────────────────────────────────────────────────────

test("findings rank by severity then affected-count", () => {
  // A critical venue (12 devices) and a high resource finding coexist; ordering
  // must put the critical first regardless of insertion order.
  const fleet = [
    // lastOnlineTime null so these offline devices form ONLY a venue cluster, not
    // also a temporal one — the test is about severity/count ordering.
    ...many(12, (i) => ({ id: `bos-${i}`, city: "Boston", status: "offline", lastOnlineTime: null })),
    ...many(5, (i) => ({ id: `ny-${i}`, city: "New York" })),
    ...many(4, (i) => ({ id: `ch-${i}`, city: "Chicago" })),
    ...many(4, (i) => ({ id: `sf-${i}`, city: "SF" })),
    dev({ id: "r1", city: "Miami", screen: { isBlackScreen: true, showingLogo: false, nowPlayingId: null },
      telemetry: { observedAt: "t", cpuPercent: 99, ramUsedPercent: 40, storageUsedPercent: 50, rssiDbm: -50, ntpOffsetMs: 0 } }),
    dev({ id: "r2", city: "Dallas", screen: { isBlackScreen: true, showingLogo: false, nowPlayingId: null },
      telemetry: { observedAt: "t", cpuPercent: 99, ramUsedPercent: 40, storageUsedPercent: 50, rssiDbm: -50, ntpOffsetMs: 0 } }),
  ];
  const r = correlate(fleet, NOW);
  assert.ok(r.findings.length >= 2);
  assert.equal(r.findings[0]!.severity, "critical");
  assert.equal(r.findings[0]!.kind, "venue");
  // Severity ranks are non-decreasing down the list.
  const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  for (let i = 1; i < r.findings.length; i++) {
    assert.ok(rank[r.findings[i - 1]!.severity] <= rank[r.findings[i]!.severity]);
  }
});
