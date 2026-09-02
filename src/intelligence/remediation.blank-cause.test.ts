/**
 * Blank-cause ROUTING tests — `node --test dist/intelligence/remediation.blank-cause.test.js`
 *
 * remediation.test.ts covers the rules; this file covers the one thing that
 * matters about the refinement: that each cause of "the screen is showing
 * nothing" reaches the action that can actually change it, and none reaches an
 * action that cannot.
 *
 * The regression that motivates the whole file: `Shaun-SparkBridge+` (1027199) is
 * at current_brightness=255, display_on=true, is_black_screen=true — a panel at
 * FULL brightness rendering black. "Restore brightness" on that device is a
 * NO-OP, offered on a device that genuinely has a fault. So there are explicit
 * tests that a lit-but-black device produces NO brightness recommendation of any
 * kind, and that a panel-off-inside-window device still produces one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { recommendationsFor, summarize, type DeviceView, type Recommendation } from "./remediation.js";

/** Reachable, lit, showing content, both power signals agreeing. Nothing wrong. */
const device = (over: Partial<DeviceView> = {}): DeviceView => ({
  id: "dev-1",
  name: "Lobby North",
  status: "online",
  lastOnlineTime: "2026-08-31T12:00:00Z",
  city: "New York",
  groupId: null,
  site: null,
  firmwareCurrent: "7.0",
  firmwareBehind: false,
  screen: { isBlackScreen: false, showingLogo: false, isScreenOn: true, nowPlayingId: "c-1" },
  telemetry: null,
  drift: [],
  brightnessRaw: 128,
  currentBrightnessRaw: 255,
  displayOn: true,
  brightnessScheduleEnabled: true,
  autoBrightnessEnabled: false,
  turnOnTime: "0900",
  turnOffTime: "0500",
  timezone: "America/New_York",
  ...over,
});

/** A panel demonstrably off, both power signals agreeing it is off. */
const panelOff = (over: Partial<DeviceView> = {}): DeviceView =>
  device({
    currentBrightnessRaw: 0,
    displayOn: false,
    screen: { isBlackScreen: false, showingLogo: false, isScreenOn: false, nowPlayingId: null },
    ...over,
  });

/** The live content fault, as measured on 1027199. */
const litButBlack = (over: Partial<DeviceView> = {}): DeviceView =>
  device({
    id: "1027199",
    name: "Shaun-SparkBridge+",
    status: "alert",
    currentBrightnessRaw: 255,
    displayOn: true,
    screen: { isBlackScreen: true, showingLogo: false, isScreenOn: true, nowPlayingId: null },
    ...over,
  });

/** 12:00 EDT (inside the 0900–0500 window) / 07:00 EDT (outside it). */
const IN_WINDOW = new Date("2026-08-31T16:00:00Z");
const OFF_WINDOW = new Date("2026-08-31T11:00:00Z");

const find = (recs: Recommendation[], suffix: string): Recommendation | undefined =>
  recs.find((r) => r.id.endsWith(suffix));

/**
 * Anything that would push brightness at a device. Both the display-off
 * one-click and the brightness-value drift one-click qualify — a lit-but-black
 * panel must attract NEITHER.
 */
const brightnessRecs = (recs: Recommendation[]): Recommendation[] =>
  recs.filter(
    (r) =>
      /Restore brightness/i.test(r.action) ||
      (r.id.endsWith("::compliance::brightness") && r.kind === "auto-safe"),
  );

/** The five ids the blank-cause switch can emit — at most ONE per device. */
const BLANK_IDS = [
  "::display-off",
  "::display-off-scheduled",
  "::black-screen",
  "::logo-fallback",
  "::screen-signals-disagree",
];
const blankRecs = (recs: Recommendation[]): Recommendation[] =>
  recs.filter((r) => BLANK_IDS.some((s) => r.id.endsWith(s)));

// ── content-black → content advice, brightness SUPPRESSED ────────────────────

test("REGRESSION: a lit-but-black device produces NO brightness recommendation", () => {
  const recs = recommendationsFor([litButBlack()], IN_WINDOW);
  assert.deepEqual(brightnessRecs(recs), [], "brightness is already 255 — the write is a no-op");
  assert.equal(find(recs, "::display-off"), undefined);
  assert.equal(find(recs, "::display-off-scheduled"), undefined);
});

test("REGRESSION: not even a brightness DRIFT one-click reaches a lit-but-black device", () => {
  const recs = recommendationsFor(
    [
      litButBlack({
        brightnessRaw: 0,
        drift: [{ kind: "value", label: "Brightness", field: "brightness" }],
      }),
    ],
    IN_WINDOW,
  );
  assert.deepEqual(brightnessRecs(recs), []);
});

test("content-black → a content/player recommendation that says brightness would be a no-op", () => {
  const recs = recommendationsFor([litButBlack()], IN_WINDOW);
  const r = find(recs, "::black-screen");
  assert.ok(r, "the content fault must still be reported");
  assert.equal(r!.category, "content");
  assert.equal(r!.kind, "manual");
  assert.match(r!.action, /re-push content/i);
  assert.match(r!.symptom, /LIT panel/);
  assert.match(r!.rationale, /255\/255/, "quote the reading, so the claim is checkable");
  assert.match(r!.rationale, /no-op/, "say why brightness is not offered");
});

test("a black flag with no panel reading is still a content fault, without the lit claim", () => {
  const recs = recommendationsFor(
    [litButBlack({ currentBrightnessRaw: null, displayOn: null })],
    IN_WINDOW,
  );
  const r = find(recs, "::black-screen");
  assert.ok(r, "we must not lose a real fault because the settings snapshot is missing");
  assert.doesNotMatch(r!.rationale, /no-op/);
  assert.ok(r!.confidence < 0.8, "less evidence, less confidence");
  assert.deepEqual(brightnessRecs(recs), []);
});

// ── panel-off-unexpected → the brightness restore still fires ────────────────

test("REGRESSION: a panel-off device INSIDE its window still gets the brightness restore", () => {
  const recs = recommendationsFor([panelOff()], IN_WINDOW);
  const r = find(recs, "::display-off");
  assert.ok(r, "this is the one cause a brightness write addresses");
  assert.equal(r!.kind, "auto-safe");
  assert.equal(r!.action, "Restore brightness");
  assert.equal(r!.severity, "high");
  assert.equal(brightnessRecs(recs).length, 1);
});

test("panel-off-expected → at most a LOW informational item, never auto-safe, never a fault", () => {
  const recs = recommendationsFor([panelOff()], OFF_WINDOW);
  const r = find(recs, "::display-off-scheduled");
  assert.ok(r);
  assert.equal(r!.kind, "manual");
  assert.equal(r!.severity, "low");
  assert.doesNotMatch(r!.action, /Restore brightness/);
  assert.match(r!.rationale, /Not a fault/i);
  assert.deepEqual(brightnessRecs(recs), []);
});

// ── signals-disagree → a data-quality item, not a device action ──────────────

test("signals-disagree → a data-quality item, and NO device action (both directions)", () => {
  const shapes: Array<Partial<DeviceView>> = [
    // The live shape: 5 devices report display_on=false against is_screen_on=true.
    {
      currentBrightnessRaw: 0,
      displayOn: false,
      screen: { isBlackScreen: false, showingLogo: false, isScreenOn: true, nowPlayingId: null },
    },
    // The other direction (0 devices on the fleet today, but it must not act either).
    {
      currentBrightnessRaw: 255,
      displayOn: true,
      screen: { isBlackScreen: true, showingLogo: false, isScreenOn: false, nowPlayingId: null },
    },
  ];
  for (const over of shapes) {
    const recs = recommendationsFor([device(over)], IN_WINDOW);
    const r = find(recs, "::screen-signals-disagree");
    assert.ok(r, JSON.stringify(over));
    assert.equal(r!.category, "data-quality");
    assert.equal(r!.kind, "manual", "a data problem is never a one-click device write");
    assert.match(r!.symptom, /contradict/i);
    assert.match(r!.action, /reconcile/i);
    assert.match(r!.rationale, /no device action/i);
    // And nothing that touches the panel.
    assert.deepEqual(brightnessRecs(recs), []);
    assert.equal(find(recs, "::display-off"), undefined);
    assert.equal(find(recs, "::display-off-scheduled"), undefined);
    assert.equal(find(recs, "::black-screen"), undefined);
  }
});

test("the contradiction is REPORTED verbatim, without picking a winner", () => {
  const recs = recommendationsFor(
    [
      device({
        currentBrightnessRaw: 0,
        displayOn: false,
        screen: { isBlackScreen: false, showingLogo: false, isScreenOn: true, nowPlayingId: null },
      }),
    ],
    IN_WINDOW,
  );
  const r = find(recs, "::screen-signals-disagree")!;
  assert.match(r.symptom, /display_on=false/);
  assert.match(r.symptom, /is_screen_on=true/);
});

// ── unknown → nothing at all ─────────────────────────────────────────────────

test("unknown → no recommendation (honest null), even with content flags set", () => {
  // Unreachable, and with a schedule we cannot evaluate: both are `unknown`.
  const unreachable = recommendationsFor([litButBlack({ status: "offline" })], IN_WINDOW);
  assert.deepEqual(unreachable, []);
  const unjudgeable = recommendationsFor([panelOff({ timezone: null })], IN_WINDOW);
  assert.deepEqual(blankRecs(unjudgeable), []);
});

// ── no double-counting ───────────────────────────────────────────────────────

test("at most ONE blank-cause recommendation per device, whatever fires at once", () => {
  const everything: Array<[string, DeviceView, Date]> = [
    ["lit + black + logo", litButBlack({ screen: { isBlackScreen: true, showingLogo: true, isScreenOn: true, nowPlayingId: null } }), IN_WINDOW],
    ["off + black + logo, in window", panelOff({ screen: { isBlackScreen: true, showingLogo: true, isScreenOn: false, nowPlayingId: null } }), IN_WINDOW],
    ["off + black + logo, out of window", panelOff({ screen: { isBlackScreen: true, showingLogo: true, isScreenOn: false, nowPlayingId: null } }), OFF_WINDOW],
    ["disagree + black + logo", device({ currentBrightnessRaw: 0, displayOn: false, screen: { isBlackScreen: true, showingLogo: true, isScreenOn: true, nowPlayingId: null } }), IN_WINDOW],
  ];
  for (const [why, d, at] of everything) {
    const recs = blankRecs(recommendationsFor([d], at));
    assert.equal(recs.length, 1, `${why} → expected exactly one, got ${recs.map((r) => r.id).join(", ")}`);
  }
});

test("the darkness verdict and the blank cause never both bill the same device", () => {
  // A dark panel inside its window is `dark-unexpected` AND
  // `panel-off-unexpected`; only one recommendation may result.
  const recs = recommendationsFor(
    [panelOff({ drift: [{ kind: "value", label: "Brightness", field: "brightness" }] })],
    IN_WINDOW,
  );
  assert.equal(brightnessRecs(recs).length, 1, "the drift one-click must not duplicate the restore");
  assert.equal(recs.filter((r) => r.category === "display").length, 1);
});

// ── the fleet distribution, in miniature ─────────────────────────────────────

test("a mixed fleet routes each cause to its own action and nothing else", () => {
  const recs = recommendationsFor(
    [
      device({ id: "fine" }),
      litButBlack({ id: "content" }),
      panelOff({ id: "off-in" }),
      device({
        id: "disagree",
        currentBrightnessRaw: 0,
        displayOn: false,
        screen: { isBlackScreen: false, showingLogo: false, isScreenOn: true, nowPlayingId: null },
      }),
      device({
        id: "logo",
        screen: { isBlackScreen: false, showingLogo: true, isScreenOn: true, nowPlayingId: null },
      }),
      device({ id: "dark-unknown", status: "offline" }),
    ],
    IN_WINDOW,
  );
  assert.deepEqual(
    blankRecs(recs).map((r) => r.id).sort(),
    [
      "content::black-screen",
      "disagree::screen-signals-disagree",
      "logo::logo-fallback",
      "off-in::display-off",
    ].sort(),
  );
  // Exactly one brightness action across the whole fleet: the panel that is off
  // inside its window. The lit-but-black panel gets advice, not a no-op.
  assert.deepEqual(brightnessRecs(recs).map((r) => r.deviceIds[0]), ["off-in"]);
  const summary = summarize(recs);
  assert.equal(summary.byKind["auto-safe"], 1);
});
