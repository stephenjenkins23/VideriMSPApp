/**
 * Remediation engine tests — `node --test dist/intelligence/remediation.test.js`
 *
 * The whole point of the engine is trust: a rule that fires on a null reading, or
 * fabricates a symptom from a zero, poisons the entire "recommended actions"
 * surface. So every rule is tested for both its positive case AND its
 * null-safety, and there is a dedicated test asserting an all-null device yields
 * nothing at all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recommendationsFor,
  summarize,
  type DeviceView,
  type Recommendation,
} from "./remediation.js";

/** A healthy, online device with everything readable and nothing wrong. */
const healthy = (over: Partial<DeviceView> = {}): DeviceView => ({
  id: "dev-1",
  name: "Lobby North",
  status: "online",
  lastOnlineTime: "2026-08-31T12:00:00Z",
  city: "New York",
  groupId: null,
  site: null,
  firmwareCurrent: "7.0",
  firmwareBehind: false,
  screen: { isBlackScreen: false, showingLogo: false, nowPlayingId: "content-1" },
  telemetry: {
    observedAt: "2026-08-31T12:00:00Z",
    cpuPercent: 20,
    ramUsedPercent: 40,
    storageUsedPercent: 55,
    rssiDbm: -50,
    ntpOffsetMs: 2,
  },
  drift: [],
  brightnessRaw: 128,
  ...over,
});

/** A device with every reading unknown — the honest-null stress case. */
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
  ...over,
});

const ids = (recs: Recommendation[]): string[] => recs.map((r) => r.id);
const find = (recs: Recommendation[], suffix: string): Recommendation | undefined =>
  recs.find((r) => r.id.endsWith(suffix));

// ── the null invariant (the load-bearing test) ──────────────────────────────

test("a device with all-null readings yields NO recommendations", () => {
  assert.deepEqual(recommendationsFor([allNull()]), []);
});

test("a fully healthy device yields NO recommendations", () => {
  assert.deepEqual(recommendationsFor([healthy()]), []);
});

// ── US-1.2 display-off / brightness 0 ────────────────────────────────────────

test("brightness 0 while online → auto-safe Restore brightness", () => {
  const recs = recommendationsFor([healthy({ brightnessRaw: 0 })]);
  const r = find(recs, "::display-off");
  assert.ok(r, "display-off recommendation expected");
  assert.equal(r!.kind, "auto-safe");
  assert.equal(r!.severity, "high");
  assert.equal(r!.action, "Restore brightness");
  assert.ok(r!.confidence >= 0.8);
});

test("null brightness never fires display-off", () => {
  const recs = recommendationsFor([healthy({ brightnessRaw: null })]);
  assert.equal(find(recs, "::display-off"), undefined);
});

test("a normal brightness value never fires display-off", () => {
  const recs = recommendationsFor([healthy({ brightnessRaw: 5 })]);
  assert.equal(find(recs, "::display-off"), undefined);
});

// ── US-1.3 black screen while online ─────────────────────────────────────────

test("black screen while online → manual content-fault advice", () => {
  const recs = recommendationsFor([
    healthy({ status: "alert", screen: { isBlackScreen: true, showingLogo: false, nowPlayingId: null } }),
  ]);
  const r = find(recs, "::black-screen");
  assert.ok(r);
  assert.equal(r!.kind, "manual");
  assert.equal(r!.category, "content");
  assert.match(r!.action, /re-push content/i);
});

test("black screen on an OFFLINE device is not advised (cannot act)", () => {
  const recs = recommendationsFor([
    healthy({ status: "offline", screen: { isBlackScreen: true, showingLogo: false, nowPlayingId: null } }),
  ]);
  assert.deepEqual(recs, []);
});

test("null black-screen flag never fires", () => {
  const recs = recommendationsFor([
    healthy({ screen: { isBlackScreen: null, showingLogo: false, nowPlayingId: null } }),
  ]);
  assert.equal(find(recs, "::black-screen"), undefined);
});

test("brightness 0 suppresses the black-screen content-fault (darkness already explained)", () => {
  const recs = recommendationsFor([
    healthy({
      brightnessRaw: 0,
      status: "alert",
      screen: { isBlackScreen: true, showingLogo: false, nowPlayingId: null },
    }),
  ]);
  assert.ok(find(recs, "::display-off"), "display-off should own the darkness");
  assert.equal(find(recs, "::black-screen"), undefined, "content fault must be suppressed");
});

// ── US-1.4 logo fallback ─────────────────────────────────────────────────────

test("logo fallback while online → manual playlist check", () => {
  const recs = recommendationsFor([
    healthy({ status: "warning", screen: { isBlackScreen: false, showingLogo: true, nowPlayingId: null } }),
  ]);
  const r = find(recs, "::logo-fallback");
  assert.ok(r);
  assert.equal(r!.kind, "manual");
  assert.match(r!.action, /playlist/i);
});

test("null logo flag never fires", () => {
  const recs = recommendationsFor([
    healthy({ screen: { isBlackScreen: false, showingLogo: null, nowPlayingId: null } }),
  ]);
  assert.equal(find(recs, "::logo-fallback"), undefined);
});

// ── US-1.5 telemetry rules ───────────────────────────────────────────────────

test("storage > 90% → manual clear-cache", () => {
  const recs = recommendationsFor([healthy({ telemetry: { ...healthy().telemetry!, storageUsedPercent: 95 } })]);
  const r = find(recs, "::storage-full");
  assert.ok(r);
  assert.equal(r!.kind, "manual");
  assert.match(r!.symptom, /95%/);
});

test("storage exactly 90% does NOT fire (strictly greater)", () => {
  const recs = recommendationsFor([healthy({ telemetry: { ...healthy().telemetry!, storageUsedPercent: 90 } })]);
  assert.equal(find(recs, "::storage-full"), undefined);
});

test("weak RSSI < -75 → manual weak-wifi", () => {
  const recs = recommendationsFor([healthy({ telemetry: { ...healthy().telemetry!, rssiDbm: -80 } })]);
  const r = find(recs, "::weak-wifi");
  assert.ok(r);
  assert.equal(r!.kind, "manual");
});

test("RSSI -127 (no radio / Ethernet) is NOT flagged as weak wifi", () => {
  const recs = recommendationsFor([healthy({ telemetry: { ...healthy().telemetry!, rssiDbm: -127 } })]);
  assert.equal(find(recs, "::weak-wifi"), undefined);
});

test("high CPU → manual resource-pressure", () => {
  const recs = recommendationsFor([healthy({ telemetry: { ...healthy().telemetry!, cpuPercent: 97 } })]);
  const r = find(recs, "::resource-pressure");
  assert.ok(r);
  assert.match(r!.symptom, /CPU 97%/);
  assert.ok(r!.confidence <= 0.6, "single-sample pressure must be modest confidence");
});

test("high RAM alone → resource-pressure names RAM", () => {
  const recs = recommendationsFor([healthy({ telemetry: { ...healthy().telemetry!, ramUsedPercent: 93 } })]);
  const r = find(recs, "::resource-pressure");
  assert.ok(r);
  assert.match(r!.symptom, /RAM 93%/);
});

test("NTP drift beyond threshold → LOW-confidence clock-drift", () => {
  const recs = recommendationsFor([healthy({ telemetry: { ...healthy().telemetry!, ntpOffsetMs: 5000 } })]);
  const r = find(recs, "::clock-drift");
  assert.ok(r);
  assert.equal(r!.severity, "low");
  assert.ok(r!.confidence <= 0.5);
});

test("null NTP offset NEVER fires clock-drift (never from a null)", () => {
  const recs = recommendationsFor([healthy({ telemetry: { ...healthy().telemetry!, ntpOffsetMs: null } })]);
  assert.equal(find(recs, "::clock-drift"), undefined);
});

test("a small NTP offset does not fire", () => {
  const recs = recommendationsFor([healthy({ telemetry: { ...healthy().telemetry!, ntpOffsetMs: 12 } })]);
  assert.equal(find(recs, "::clock-drift"), undefined);
});

test("null telemetry object yields no telemetry recommendations", () => {
  const recs = recommendationsFor([healthy({ telemetry: null })]);
  assert.deepEqual(ids(recs), []);
});

// ── US-1.6 compliance drift ──────────────────────────────────────────────────

test("brightness-value drift → auto-safe Apply expected", () => {
  const recs = recommendationsFor([
    healthy({ drift: [{ kind: "calibrated", label: "Brightness above minimum", field: "brightness" }] }),
  ]);
  const r = find(recs, "::compliance::brightness");
  assert.ok(r);
  assert.equal(r!.kind, "auto-safe");
  assert.match(r!.action, /Apply expected/);
});

test("non-brightness drift → manual", () => {
  const recs = recommendationsFor([
    healthy({ drift: [{ kind: "policy", label: "Power schedule enabled", field: "auto_on_off_enabled" }] }),
  ]);
  const r = find(recs, "::compliance::auto_on_off_enabled");
  assert.ok(r);
  assert.equal(r!.kind, "manual");
});

test("auto_brightness_enabled drift is manual, not auto-safe (no verified write for it)", () => {
  const recs = recommendationsFor([
    healthy({ drift: [{ kind: "calibrated", label: "Auto-brightness disabled", field: "auto_brightness_enabled" }] }),
  ]);
  const r = find(recs, "::compliance::auto_brightness_enabled");
  assert.ok(r);
  assert.equal(r!.kind, "manual");
});

test("brightness 0 suppresses the duplicate brightness-value drift rec", () => {
  const recs = recommendationsFor([
    healthy({
      brightnessRaw: 0,
      drift: [{ kind: "calibrated", label: "Brightness above minimum", field: "brightness" }],
    }),
  ]);
  assert.ok(find(recs, "::display-off"));
  assert.equal(find(recs, "::compliance::brightness"), undefined);
});

// ── US-1.1 ranking + summary ─────────────────────────────────────────────────

test("recommendations are ranked by severity then confidence", () => {
  const recs = recommendationsFor([
    healthy({ id: "a", brightnessRaw: 0 }), // high / 0.9
    healthy({ id: "b", telemetry: { ...healthy().telemetry!, ntpOffsetMs: 5000 } }), // low / 0.4
    healthy({ id: "c", telemetry: { ...healthy().telemetry!, storageUsedPercent: 95 } }), // medium / 0.8
  ]);
  const severities = recs.map((r) => r.severity);
  assert.deepEqual(severities, ["high", "medium", "low"]);
});

test("summary counts by kind and severity", () => {
  const recs = recommendationsFor([
    healthy({ id: "a", brightnessRaw: 0 }), // auto-safe / high
    healthy({ id: "c", telemetry: { ...healthy().telemetry!, storageUsedPercent: 95 } }), // manual / medium
  ]);
  const s = summarize(recs);
  assert.equal(s.total, 2);
  assert.equal(s.byKind["auto-safe"], 1);
  assert.equal(s.byKind.manual, 1);
  assert.equal(s.bySeverity.high, 1);
  assert.equal(s.bySeverity.medium, 1);
});

test("ids are stable and unique per device+rule", () => {
  const recs = recommendationsFor([
    healthy({
      id: "multi",
      telemetry: { ...healthy().telemetry!, storageUsedPercent: 95, rssiDbm: -80 },
    }),
  ]);
  const idSet = new Set(ids(recs));
  assert.equal(idSet.size, recs.length, "no duplicate ids");
  assert.ok(idSet.has("multi::storage-full"));
  assert.ok(idSet.has("multi::weak-wifi"));
});

test("offline / unknown devices produce nothing", () => {
  assert.deepEqual(recommendationsFor([healthy({ status: "offline", brightnessRaw: 0 })]), []);
  assert.deepEqual(recommendationsFor([healthy({ status: "unknown", brightnessRaw: 0 })]), []);
});

test("deviceLabel falls back to id when name is null", () => {
  const recs = recommendationsFor([allNull({ brightnessRaw: 0 })]);
  const r = find(recs, "::display-off");
  assert.ok(r);
  assert.equal(r!.deviceLabel, "dev-null");
  assert.deepEqual(r!.deviceIds, ["dev-null"]);
});
