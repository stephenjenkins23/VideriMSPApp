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
      telemetry: { observedAt: "2026-08-31T11:55:00Z", cpuPercent: 30, ramUsedPercent: 95, storageUsedPercent: 50, rssiDbm: -50, ntpOffsetMs: 0 } }),
    dev({ id: "r2", city: "C2", screen: { isBlackScreen: true, showingLogo: false, nowPlayingId: null },
      telemetry: { observedAt: "2026-08-31T11:55:00Z", cpuPercent: 99, ramUsedPercent: 40, storageUsedPercent: 50, rssiDbm: -50, ntpOffsetMs: 0 } }),
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
      telemetry: { observedAt: "2026-08-31T11:55:00Z", cpuPercent: 99, ramUsedPercent: 40, storageUsedPercent: 50, rssiDbm: -50, ntpOffsetMs: 0 } }),
    dev({ id: "ok", city: "C2" }),
  ];
  const r = correlate(fleet, NOW);
  assert.equal(r.findings.find((x) => x.kind === "symptom-cooccurrence"), undefined);
});

// Eligibility for symptom co-occurrence: reachable, and read recently enough.
// Both buckets assert a co-occurrence in the PRESENT, so a device we cannot reach
// or have not read lately must not be counted into one — the same error class as
// the unverifiable-claim finding, in the opposite direction.

/** A black-screen claim with healthy, readable, fresh telemetry. */
const blackHealthy = (id: string, city: string, over: Partial<DeviceView> = {}): DeviceView =>
  dev({
    id,
    city,
    screen: { isBlackScreen: true, showingLogo: false, nowPlayingId: null },
    ...over,
  });

/** Telemetry stamped `ageMs` before NOW, healthy values throughout. */
const telemetryAged = (ageMs: number): DeviceView["telemetry"] => ({
  observedAt: new Date(NOW.getTime() - ageMs).toISOString(),
  cpuPercent: 20,
  ramUsedPercent: 40,
  storageUsedPercent: 55,
  rssiDbm: -50,
  ntpOffsetMs: 2,
});

const HOUR = 3_600_000;

test("an UNREACHABLE black-screen device is excluded from symptom co-occurrence", () => {
  // The offline device has perfectly readable telemetry — that is exactly the trap.
  // Its screen flag and its CPU number are both last-known, not live.
  const fleet = [
    blackHealthy("live-1", "C1"),
    blackHealthy("live-2", "C2"),
    blackHealthy("gone", "C3", { status: "offline" }),
  ];
  const r = correlate(fleet, NOW);
  const f = r.findings.find((x) => x.id === "symptom::black-screen+content");
  assert.ok(f, "the two reachable devices still make the finding");
  assert.deepEqual(f!.affectedDeviceIds, ["live-1", "live-2"]);
  assert.ok(!f!.affectedDeviceIds.includes("gone"));
});

test("status 'unknown' counts as unreachable for symptom co-occurrence", () => {
  // Null presence is an unknown, never an implied "online".
  const fleet = [
    blackHealthy("live-1", "C1"),
    blackHealthy("live-2", "C2"),
    blackHealthy("nopresence", "C3", { status: "unknown" }),
  ];
  const r = correlate(fleet, NOW);
  const f = r.findings.find((x) => x.id === "symptom::black-screen+content");
  assert.deepEqual(f!.affectedDeviceIds, ["live-1", "live-2"]);
});

test("an unreachable high-CPU black screen is excluded from the RESOURCE bucket too", () => {
  const hot = (id: string, over: Partial<DeviceView> = {}): DeviceView =>
    dev({
      id,
      screen: { isBlackScreen: true, showingLogo: false, nowPlayingId: null },
      telemetry: { ...telemetryAged(5 * 60_000)!, cpuPercent: 99 },
      ...over,
    });
  const fleet = [hot("hot-1"), hot("hot-2"), hot("hot-gone", { status: "offline" })];
  const r = correlate(fleet, NOW);
  const f = r.findings.find((x) => x.id === "symptom::black-screen+resource");
  assert.deepEqual(f!.affectedDeviceIds, ["hot-1", "hot-2"]);
});

test("a bucket that falls below the minimum after exclusion emits NOTHING", () => {
  // One reachable + one unreachable = 1 eligible device, under
  // MIN_SYMPTOM_COOCCURRENCE. No weakened finding, and no invented note either:
  // readable telemetry DID exist, so the telemetry-absent note stays silent.
  const fleet = [
    blackHealthy("live-1", "C1"),
    blackHealthy("gone", "C2", { status: "offline" }),
  ];
  const r = correlate(fleet, NOW);
  assert.equal(r.findings.find((x) => x.kind === "symptom-cooccurrence"), undefined);
  assert.equal(noteOf(r.notes, "symptom-telemetry-absent"), undefined);
});

test("telemetry exactly at the 6h freshness bound is still eligible", () => {
  const at = telemetryAged(6 * HOUR);
  const fleet = [
    blackHealthy("edge-1", "C1", { telemetry: at }),
    blackHealthy("edge-2", "C2", { telemetry: at }),
  ];
  const r = correlate(fleet, NOW);
  const f = r.findings.find((x) => x.id === "symptom::black-screen+content");
  assert.ok(f, "6h old is inside the window");
  assert.equal(f!.affectedDeviceIds.length, 2);
});

test("telemetry a minute past the 6h bound is excluded, and takes the finding with it", () => {
  const at = telemetryAged(6 * HOUR + 60_000);
  const fleet = [
    blackHealthy("stale-1", "C1", { telemetry: at }),
    blackHealthy("stale-2", "C2", { telemetry: at }),
  ];
  const r = correlate(fleet, NOW);
  assert.equal(r.findings.find((x) => x.kind === "symptom-cooccurrence"), undefined);
  // Telemetry was readable, just old — so this is not the telemetry-absent case.
  assert.equal(noteOf(r.notes, "symptom-telemetry-absent"), undefined);
});

test("a stale reading is dropped while its fresh peers keep the finding", () => {
  const fleet = [
    blackHealthy("fresh-1", "C1", { telemetry: telemetryAged(10 * 60_000) }),
    blackHealthy("fresh-2", "C2", { telemetry: telemetryAged(2 * HOUR) }),
    blackHealthy("old", "C3", { telemetry: telemetryAged(30 * HOUR) }),
  ];
  const r = correlate(fleet, NOW);
  const f = r.findings.find((x) => x.id === "symptom::black-screen+content");
  assert.deepEqual(f!.affectedDeviceIds, ["fresh-1", "fresh-2"]);
});

test("telemetry with an unknown observedAt is not treated as fresh", () => {
  // An age we cannot compute is an unknown, not a zero. Values are readable, so
  // the old code would have bucketed both of these.
  const noStamp: DeviceView["telemetry"] = { ...telemetryAged(0)!, observedAt: null };
  const fleet = [
    blackHealthy("nostamp-1", "C1", { telemetry: noStamp }),
    blackHealthy("nostamp-2", "C2", { telemetry: noStamp }),
  ];
  const r = correlate(fleet, NOW);
  assert.equal(r.findings.find((x) => x.kind === "symptom-cooccurrence"), undefined);
});

test("the symptom rationale names its population, so it never reads as fleet-wide", () => {
  const fleet = [
    blackHealthy("live-1", "C1"),
    blackHealthy("live-2", "C2"),
    blackHealthy("gone", "C3", { status: "offline" }),
    blackHealthy("old", "C4", { telemetry: telemetryAged(20 * HOUR) }),
  ];
  const r = correlate(fleet, NOW);
  const f = r.findings.find((x) => x.id === "symptom::black-screen+content")!;
  assert.match(f.rationale, /REACH/);
  assert.match(f.rationale, /not a statement about the fleet/i);
  // The exclusions are declared, split by reason.
  assert.match(f.rationale, /1 unreachable/);
  assert.match(f.rationale, /1 stale reading/);
});

test("with no exclusions the rationale does not print an empty exclusion clause", () => {
  const fleet = [blackHealthy("live-1", "C1"), blackHealthy("live-2", "C2")];
  const r = correlate(fleet, NOW);
  const f = r.findings.find((x) => x.id === "symptom::black-screen+content")!;
  assert.ok(!/excluded/.test(f.rationale), f.rationale);
});

test("black screens with no readable telemetry ANYWHERE still yield the note", () => {
  // The note is a statement about the whole black-screen population, so the new
  // eligibility gates must not change when it fires.
  const fleet = [
    dev({ id: "b1", city: "C1", status: "offline", telemetry: null,
      screen: { isBlackScreen: true, showingLogo: false, nowPlayingId: null } }),
    dev({ id: "b2", city: "C2", telemetry: null,
      screen: { isBlackScreen: true, showingLogo: false, nowPlayingId: null } }),
  ];
  const r = correlate(fleet, NOW);
  assert.ok(noteOf(r.notes, "symptom-telemetry-absent"));
  assert.equal(r.findings.find((x) => x.kind === "symptom-cooccurrence"), undefined);
});

test("the symptom gate leaves venue, firmware, temporal and unverifiable untouched", () => {
  // Five offline devices at one city, on one firmware, dropped in one 8-minute
  // window, each claiming black WITH readable telemetry — i.e. exactly the devices
  // symptom co-occurrence now refuses. Every OTHER rule must still count them.
  const stuck = Array.from({ length: 5 }, (_, i) =>
    dev({
      id: `bos-${i}`,
      city: "Boston",
      status: "offline",
      firmwareCurrent: "6.0",
      lastOnlineTime: new Date(NOW.getTime() - (30 + i * 2) * 60_000).toISOString(),
      screen: { isBlackScreen: true, showingLogo: false, nowPlayingId: null },
    }),
  );
  const fleet = [
    ...stuck,
    blackHealthy("live-1", "Miami"),
    blackHealthy("live-2", "Dallas"),
    ...many(4, (i) => ({ id: `ny-${i}`, city: "New York" })),
    ...many(4, (i) => ({ id: `ch-${i}`, city: "Chicago" })),
    ...many(4, (i) => ({ id: `sf-${i}`, city: "SF" })),
  ];
  const r = correlate(fleet, NOW);
  const stuckIds = stuck.map((d) => d.id);

  const venue = r.findings.find((x) => x.id === "venue::city::Boston");
  assert.deepEqual(venue?.affectedDeviceIds, stuckIds);

  const firmware = r.findings.find((x) => x.id === "firmware::6.0");
  assert.deepEqual(firmware?.affectedDeviceIds, stuckIds);

  const temporal = findingOf(r.findings, "temporal-cluster");
  assert.ok(temporal, "temporal cluster expected");
  for (const id of stuckIds) assert.ok(temporal!.affectedDeviceIds.includes(id), id);

  const unverifiable = findingOf(r.findings, "unverifiable-claim");
  assert.deepEqual(unverifiable?.affectedDeviceIds, stuckIds);

  // And the symptom finding covers ONLY the two reachable, freshly read devices.
  const symptom = r.findings.find((x) => x.id === "symptom::black-screen+content");
  assert.deepEqual(symptom?.affectedDeviceIds, ["live-1", "live-2"]);
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
      telemetry: { observedAt: "2026-08-31T11:55:00Z", cpuPercent: 99, ramUsedPercent: 40, storageUsedPercent: 50, rssiDbm: -50, ntpOffsetMs: 0 } }),
    dev({ id: "r2", city: "Dallas", screen: { isBlackScreen: true, showingLogo: false, nowPlayingId: null },
      telemetry: { observedAt: "2026-08-31T11:55:00Z", cpuPercent: 99, ramUsedPercent: 40, storageUsedPercent: 50, rssiDbm: -50, ntpOffsetMs: 0 } }),
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

// ── data quality: unverifiable black-screen claims ───────────────────────────
// The load-bearing risk here is FRAMING, so the assertions cover it: exactly one
// finding (never per-device), never critical/high, and wording that calls the
// CLAIM unverifiable without ever asserting the screens are black or fine.

const BLACK = { isBlackScreen: true, showingLogo: false, nowPlayingId: null };

test("black-screen claims on unreachable devices produce ONE data-quality finding", () => {
  const fleet = [
    dev({ id: "u1", city: "C1", status: "offline", lastOnlineTime: "2026-08-30T12:00:00Z", screen: BLACK }),
    dev({ id: "u2", city: "C2", status: "unknown", lastOnlineTime: "2026-08-31T06:00:00Z", screen: BLACK }),
    dev({ id: "ok", city: "C3" }),
  ];
  const r = correlate(fleet, NOW);
  const uv = r.findings.filter((f) => f.kind === "unverifiable-claim");
  assert.equal(uv.length, 1, "one fleet-level finding, never one per device");
  assert.deepEqual(uv[0]!.affectedDeviceIds, ["u1", "u2"]);
  assert.equal(uv[0]!.id, "data-quality::unverifiable-black-screen::unreachable");
  // 'unknown' (presence IS NULL) is unreachable too, not a third state we skip.
  assert.match(uv[0]!.summary, /2 device\(s\) it cannot reach/);
});

test("the finding is never critical or high — it is a data defect, not a device fault", () => {
  const fleet = many(20, (i) => ({
    id: `u-${i}`,
    city: `C${i}`,
    status: "offline",
    lastOnlineTime: "2026-08-31T11:55:00Z",
    screen: BLACK,
  }));
  const r = correlate(fleet, NOW);
  const uv = findingOf(r.findings, "unverifiable-claim");
  assert.ok(uv);
  // Even at 20 devices the severity must not escalate — count is not fault weight.
  assert.ok(uv!.severity === "medium" || uv!.severity === "low", `got ${uv!.severity}`);
});

test("the wording blames the claim, not the screens, and defers to the offline alerts", () => {
  const fleet = [
    dev({ id: "u1", city: "C1", status: "offline", lastOnlineTime: "2026-08-01T12:00:00Z", screen: BLACK }),
  ];
  const uv = findingOf(correlate(fleet, NOW).findings, "unverifiable-claim");
  assert.ok(uv);
  assert.match(uv!.rationale, /UNVERIFIABLE/);
  assert.match(uv!.rationale, /neither confirm nor refute/);
  // (b) already covered elsewhere — must not be double-counted as new breakage.
  assert.match(uv!.rationale, /already covered by its own offline alert/);
  // Never an assertion in either direction about the panels.
  assert.match(uv!.rationale, /nothing here says they are fine/);
  // The window is stated plainly rather than implied.
  assert.match(uv!.rationale, /unreached for .* to .*/);
});

test("a REACHABLE black-screen claim is excluded — that one is verifiable", () => {
  // online and 'alert' are both reachable: screen-verify.ts asks those panels
  // directly, so surfacing them here would double-report a checkable claim.
  const fleet = [
    dev({ id: "on", city: "C1", screen: BLACK }),
    dev({ id: "al", city: "C2", status: "alert", screen: BLACK }),
  ];
  const r = correlate(fleet, NOW);
  assert.equal(findingOf(r.findings, "unverifiable-claim"), undefined);
});

test("an unreachable device with no black-screen claim is excluded", () => {
  // false = read and not black; null = never read. Neither is a claim.
  const fleet = [
    dev({ id: "d1", city: "C1", status: "offline", lastOnlineTime: "2026-08-31T11:50:00Z" }),
    dev({ id: "d2", city: "C2", status: "unknown", lastOnlineTime: null,
      screen: { isBlackScreen: null, showingLogo: null, nowPlayingId: null } }),
  ];
  const r = correlate(fleet, NOW);
  assert.equal(findingOf(r.findings, "unverifiable-claim"), undefined);
});

test("an empty set emits NOTHING — no zero-count finding", () => {
  const r = correlate([dev({ id: "ok", city: "C1" })], NOW);
  assert.equal(r.findings.filter((f) => f.kind === "unverifiable-claim").length, 0);
  const rEmpty = correlate([], NOW);
  assert.deepEqual(rEmpty.findings, []);
});

test("claims with no last-seen timestamp say the staleness is unknown, not zero", () => {
  const fleet = [
    dev({ id: "u1", city: "C1", status: "offline", lastOnlineTime: null, screen: BLACK }),
  ];
  const uv = findingOf(correlate(fleet, NOW).findings, "unverifiable-claim");
  assert.ok(uv);
  assert.match(uv!.rationale, /unknown/);
  assert.doesNotMatch(uv!.rationale, /unreached for 0/);
});

test("ranking still holds with the new kind in play", () => {
  const fleet = [
    // A critical venue cluster (12 dark at one site) plus 8 unverifiable claims.
    ...many(12, (i) => ({ id: `bos-${i}`, city: "Boston", status: "offline", lastOnlineTime: null })),
    ...many(4, (i) => ({ id: `ny-${i}`, city: "New York" })),
    ...many(4, (i) => ({ id: `ch-${i}`, city: "Chicago" })),
    ...many(8, (i) => ({ id: `uv-${i}`, city: `V${i}`, status: "offline",
      lastOnlineTime: null, screen: BLACK })),
  ];
  const r = correlate(fleet, NOW);
  assert.equal(r.findings[0]!.severity, "critical", "a real outage still leads");
  const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  for (let i = 1; i < r.findings.length; i++) {
    assert.ok(rank[r.findings[i - 1]!.severity] <= rank[r.findings[i]!.severity]);
  }
  const uv = findingOf(r.findings, "unverifiable-claim");
  assert.ok(uv, "and the data-quality finding still appears, below it");
  assert.ok(r.findings.indexOf(uv!) > 0);
});
