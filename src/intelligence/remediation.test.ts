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
  // `brightnessRaw` is the SCHEDULED base value; the live panel is
  // `currentBrightnessRaw` + `displayOn`. A lit screen by default.
  brightnessRaw: 128,
  currentBrightnessRaw: 200,
  displayOn: true,
  brightnessScheduleEnabled: true,
  autoBrightnessEnabled: false,
  turnOnTime: "0900",
  turnOffTime: "0500",
  timezone: "America/New_York",
  ...over,
});

/** Live evidence of a dark panel: what the display rule is actually allowed to fire on. */
const DARK = { currentBrightnessRaw: 0, displayOn: false } as const;

/**
 * Fixed evaluation instants for the default 0900-0500 America/New_York window.
 * IN_WINDOW is 12:00 EDT (inside), OFF_WINDOW is 07:00 EDT (inside the 05:00-09:00
 * dark gap). Hard-coded so these tests never depend on when they run.
 */
const IN_WINDOW = new Date("2026-08-31T16:00:00Z");
const OFF_WINDOW = new Date("2026-08-31T11:00:00Z");

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
  currentBrightnessRaw: null,
  displayOn: null,
  brightnessScheduleEnabled: null,
  autoBrightnessEnabled: null,
  turnOnTime: null,
  turnOffTime: null,
  timezone: null,
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

// ── US-1.2 dark panel — live evidence only, schedule-aware ───────────────────
//
// The regression these tests exist for: the rule used to fire on the stored
// `brightness` setting, which is the scheduled base value and reads 0 on 21 fully
// lit screens. Firing on it recommended a WRITE to working devices.

test("REGRESSION: brightness 0 but the panel is lit → NO display recommendation", () => {
  const recs = recommendationsFor(
    [healthy({ brightnessRaw: 0, currentBrightnessRaw: 255, displayOn: true })],
    IN_WINDOW,
  );
  assert.equal(find(recs, "::display-off"), undefined, "must not fire on the scheduled base value");
  assert.equal(find(recs, "::display-off-scheduled"), undefined);
  assert.deepEqual(recs, [], "a lit screen is not a finding at all");
});

test("dark panel INSIDE its ON window → auto-safe Restore brightness", () => {
  const recs = recommendationsFor([healthy({ brightnessRaw: 0, ...DARK })], IN_WINDOW);
  const r = find(recs, "::display-off");
  assert.ok(r, "display-off recommendation expected");
  assert.equal(r!.kind, "auto-safe");
  assert.equal(r!.severity, "high");
  assert.equal(r!.action, "Restore brightness");
  assert.ok(r!.confidence >= 0.8);
  // The rationale must say WHY this darkness is unexpected, in local terms.
  assert.match(r!.rationale, /09:00/);
  assert.match(r!.rationale, /America\/New_York/);
});

test("display_on false alone is enough, even with a non-zero current brightness", () => {
  const recs = recommendationsFor(
    [healthy({ currentBrightnessRaw: 200, displayOn: false })],
    IN_WINDOW,
  );
  assert.ok(find(recs, "::display-off"), "backlight off is dark, whatever value is retained");
});

test("current brightness 0 alone is enough, even with display_on true", () => {
  const recs = recommendationsFor(
    [healthy({ currentBrightnessRaw: 0, displayOn: true })],
    IN_WINDOW,
  );
  assert.ok(find(recs, "::display-off"));
});

test("dark panel with NO schedule enabled → auto-safe, and says nothing explains it", () => {
  const recs = recommendationsFor(
    [healthy({ ...DARK, brightnessScheduleEnabled: false })],
    IN_WINDOW,
  );
  const r = find(recs, "::display-off");
  assert.ok(r);
  assert.equal(r!.kind, "auto-safe");
  assert.match(r!.rationale, /No brightness schedule/i);
});

test("dark panel OUTSIDE its ON window → low, manual, informational only", () => {
  const recs = recommendationsFor([healthy({ brightnessRaw: 0, ...DARK })], OFF_WINDOW);
  assert.equal(find(recs, "::display-off"), undefined, "scheduled-off is NOT a fault");
  const r = find(recs, "::display-off-scheduled");
  assert.ok(r, "an informational item is expected");
  assert.equal(r!.severity, "low");
  assert.equal(r!.kind, "manual");
  assert.match(r!.symptom, /schedule/i);
  assert.match(r!.symptom, /09:00–05:00/);
  assert.doesNotMatch(r!.action, /Restore brightness/);
});

test("dark with a schedule we cannot evaluate → unknown → NO recommendation", () => {
  for (const over of [
    { turnOnTime: "nonsense", turnOffTime: "0500" },
    { turnOnTime: "0900", turnOffTime: null },
    { turnOnTime: "0900", turnOffTime: "0500", timezone: null },
    { turnOnTime: "0900", turnOffTime: "0500", timezone: "Not/AZone" },
    { turnOnTime: "9999", turnOffTime: "0500" },
  ]) {
    const recs = recommendationsFor([healthy({ ...DARK, ...over })], IN_WINDOW);
    assert.equal(find(recs, "::display-off"), undefined, JSON.stringify(over));
    assert.equal(find(recs, "::display-off-scheduled"), undefined, JSON.stringify(over));
  }
});

test("no live panel reading at all → NO display recommendation (honest null)", () => {
  const recs = recommendationsFor(
    [healthy({ brightnessRaw: 0, currentBrightnessRaw: null, displayOn: null })],
    IN_WINDOW,
  );
  assert.equal(find(recs, "::display-off"), undefined);
  assert.equal(find(recs, "::display-off-scheduled"), undefined);
});

test("a lit panel never fires either display rule, whatever the base value", () => {
  for (const brightnessRaw of [0, 5, 128, null]) {
    const recs = recommendationsFor([healthy({ brightnessRaw })], IN_WINDOW);
    assert.equal(find(recs, "::display-off"), undefined, `brightnessRaw=${brightnessRaw}`);
    assert.equal(find(recs, "::display-off-scheduled"), undefined, `brightnessRaw=${brightnessRaw}`);
  }
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

test("a dark panel suppresses the black-screen content-fault (darkness already explained)", () => {
  const recs = recommendationsFor(
    [
      healthy({
        ...DARK,
        status: "alert",
        screen: { isBlackScreen: true, showingLogo: false, nowPlayingId: null },
      }),
    ],
    IN_WINDOW,
  );
  assert.ok(find(recs, "::display-off"), "display-off should own the darkness");
  assert.equal(find(recs, "::black-screen"), undefined, "content fault must be suppressed");
});

test("a SCHEDULED-off panel also suppresses the black-screen content-fault", () => {
  const recs = recommendationsFor(
    [
      healthy({
        ...DARK,
        status: "alert",
        screen: { isBlackScreen: true, showingLogo: false, nowPlayingId: null },
      }),
    ],
    OFF_WINDOW,
  );
  assert.ok(find(recs, "::display-off-scheduled"));
  assert.equal(
    find(recs, "::black-screen"),
    undefined,
    "an off-by-schedule screen is not a content fault",
  );
});

test("a LIT panel does not suppress the black-screen content-fault", () => {
  const recs = recommendationsFor(
    [
      healthy({
        brightnessRaw: 0, // the old trigger — must not explain anything now
        status: "alert",
        screen: { isBlackScreen: true, showingLogo: false, nowPlayingId: null },
      }),
    ],
    IN_WINDOW,
  );
  assert.ok(find(recs, "::black-screen"), "black capture on a lit panel is still a content fault");
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
  // Live panel state unread, so nothing contradicts the drift: the stored value
  // differs from the template and brightness is the one write we hold.
  const recs = recommendationsFor([
    healthy({
      currentBrightnessRaw: null,
      displayOn: null,
      drift: [{ kind: "calibrated", label: "Brightness above minimum", field: "brightness" }],
    }),
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

const brightnessDrift = [
  { kind: "calibrated", label: "Brightness above minimum", field: "brightness" },
];

test("a dark-unexpected panel suppresses the duplicate brightness-value drift rec", () => {
  const recs = recommendationsFor([healthy({ ...DARK, drift: brightnessDrift })], IN_WINDOW);
  assert.ok(find(recs, "::display-off"));
  assert.equal(find(recs, "::compliance::brightness"), undefined);
});

test("a scheduled-off panel suppresses brightness-value drift (do not fight the schedule)", () => {
  const recs = recommendationsFor([healthy({ ...DARK, drift: brightnessDrift })], OFF_WINDOW);
  assert.equal(find(recs, "::compliance::brightness"), undefined);
});

test("REGRESSION: a LIT panel suppresses brightness-value drift (no write to a working screen)", () => {
  const recs = recommendationsFor(
    [healthy({ brightnessRaw: 0, drift: brightnessDrift })],
    IN_WINDOW,
  );
  assert.equal(
    find(recs, "::compliance::brightness"),
    undefined,
    "the stored base value drifting must not become a one-click on a lit panel",
  );
  assert.deepEqual(recs, []);
});

test("with no live panel reading, brightness drift is still surfaced as the one write we hold", () => {
  const recs = recommendationsFor(
    [healthy({ currentBrightnessRaw: null, displayOn: null, drift: brightnessDrift })],
    IN_WINDOW,
  );
  const r = find(recs, "::compliance::brightness");
  assert.ok(r, "drift is a real config finding even when live state is unknown");
  assert.equal(r!.kind, "auto-safe");
});

// ── US-1.1 ranking + summary ─────────────────────────────────────────────────

test("recommendations are ranked by severity then confidence", () => {
  const recs = recommendationsFor([
    healthy({ id: "a", ...DARK }), // high / 0.9
    healthy({ id: "b", telemetry: { ...healthy().telemetry!, ntpOffsetMs: 5000 } }), // low / 0.4
    healthy({ id: "c", telemetry: { ...healthy().telemetry!, storageUsedPercent: 95 } }), // medium / 0.8
  ], IN_WINDOW);
  const severities = recs.map((r) => r.severity);
  assert.deepEqual(severities, ["high", "medium", "low"]);
});

test("summary counts by kind and severity", () => {
  const recs = recommendationsFor([
    healthy({ id: "a", ...DARK }), // auto-safe / high
    healthy({ id: "c", telemetry: { ...healthy().telemetry!, storageUsedPercent: 95 } }), // manual / medium
  ], IN_WINDOW);
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
  assert.deepEqual(recommendationsFor([healthy({ status: "offline", ...DARK })], IN_WINDOW), []);
  assert.deepEqual(recommendationsFor([healthy({ status: "unknown", ...DARK })], IN_WINDOW), []);
});

test("deviceLabel falls back to id when name is null", () => {
  const recs = recommendationsFor([allNull({ ...DARK })], IN_WINDOW);
  const r = find(recs, "::display-off");
  assert.ok(r);
  assert.equal(r!.deviceLabel, "dev-null");
  assert.deepEqual(r!.deviceIds, ["dev-null"]);
});
