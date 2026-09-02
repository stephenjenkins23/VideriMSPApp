/**
 * Blank-cause classifier tests — `node --test dist/intelligence/blank-cause.test.js`
 *
 * "This screen is showing nothing" has causes that are measured by DIFFERENT
 * signals and want OPPOSITE actions, and the expensive failure is routing one to
 * the other's action. So these tests are weighted toward the precedence
 * decisions, not the happy paths:
 *
 *   - a LIT panel rendering black must NEVER come back brightness-actionable
 *     (the panel is already at 255; the write is a no-op on a real fault);
 *   - a panel off INSIDE its window must still be the brightness case;
 *   - two contradicting readings of panel power must beat both, in BOTH
 *     directions, and must produce no device action at all;
 *   - anything unread stays `unknown` — absence is never health.
 *
 * Live shapes these are built from (verified 2026-09-02): Shaun-SparkBridge+
 * (1027199) at current_brightness=255 / display_on=true / is_black_screen=true;
 * 26 reachable powered-off panels, ZERO of them flagged is_black_screen; 5
 * devices with display_on=false against is_screen_on=true.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blankCause,
  describeLitEvidence,
  isReachableStatus,
  screenPowerContradiction,
  type BlankCause,
  type ScreenBlankFacts,
} from "./screen-state.js";

const NY = "America/New_York";

/**
 * A reachable, fully lit panel showing content, on the fleet's most common
 * schedule shape. Both panel-power signals agree.
 */
const facts = (over: Partial<ScreenBlankFacts> = {}): ScreenBlankFacts => ({
  status: "online",
  currentBrightnessRaw: 255,
  displayOn: true,
  brightnessScheduleEnabled: true,
  turnOnTime: "0900",
  turnOffTime: "0500",
  timezone: NY,
  screen: { isBlackScreen: false, showingLogo: false, isScreenOn: true },
  ...over,
});

/** A panel that is demonstrably off, with BOTH power signals agreeing it is off. */
const dark = (over: Partial<ScreenBlankFacts> = {}): ScreenBlankFacts =>
  facts({
    currentBrightnessRaw: 0,
    displayOn: false,
    screen: { isBlackScreen: false, showingLogo: false, isScreenOn: false },
    ...over,
  });

/**
 * The live content fault: full brightness, backlight on, and the platform
 * reporting black RENDERED content.
 */
const litButBlack = (over: Partial<ScreenBlankFacts> = {}): ScreenBlankFacts =>
  facts({
    currentBrightnessRaw: 255,
    displayOn: true,
    screen: { isBlackScreen: true, showingLogo: false, isScreenOn: true },
    ...over,
  });

/** 12:00 EDT — inside the default 0900–0500 window. */
const IN_WINDOW = new Date("2026-08-31T16:00:00Z");
/** 07:00 EDT — inside the 05:00–09:00 dark gap, so OUTSIDE the ON window. */
const OFF_WINDOW = new Date("2026-08-31T11:00:00Z");

/** A UTC instant for a wall-clock time on 2026-08-31 in New York (EDT, UTC-4). */
const edt = (hour: number, minute = 0): Date =>
  new Date(Date.UTC(2026, 7, 31, hour + 4, minute));

// ── helpers ──────────────────────────────────────────────────────────────────

test("isReachableStatus: only offline/unknown are unreachable", () => {
  for (const s of ["online", "warning", "alert"]) assert.equal(isReachableStatus(s), true, s);
  for (const s of ["offline", "unknown"]) assert.equal(isReachableStatus(s), false, s);
});

test("describeLitEvidence only claims lit when it can SHOW lit", () => {
  assert.equal(
    describeLitEvidence(facts()),
    "the panel is at 255/255 and display_on is true",
  );
  assert.equal(describeLitEvidence(facts({ currentBrightnessRaw: 0 })), null);
  assert.equal(describeLitEvidence(facts({ currentBrightnessRaw: null })), null, "unread is not lit");
  assert.equal(describeLitEvidence(facts({ displayOn: null })), null, "unread is not lit");
  assert.equal(describeLitEvidence(facts({ displayOn: false })), null);
});

// ── signals-disagree, in BOTH directions ─────────────────────────────────────

test("screenPowerContradiction: the live shape (display_on=false vs is_screen_on=true)", () => {
  const c = screenPowerContradiction(
    facts({ displayOn: false, screen: { isBlackScreen: false, showingLogo: false, isScreenOn: true } }),
  );
  assert.match(c ?? "", /display_on=false/);
  assert.match(c ?? "", /is_screen_on=true/);
});

test("screenPowerContradiction: the other direction is reported too", () => {
  const c = screenPowerContradiction(
    facts({ displayOn: true, screen: { isBlackScreen: false, showingLogo: false, isScreenOn: false } }),
  );
  assert.match(c ?? "", /display_on=true/);
  assert.match(c ?? "", /is_screen_on=false/);
});

test("screenPowerContradiction is null when they agree", () => {
  assert.equal(screenPowerContradiction(facts()), null, "true/true");
  assert.equal(screenPowerContradiction(dark()), null, "false/false");
});

test("screenPowerContradiction is null when either side is unread — never a guess", () => {
  assert.equal(
    screenPowerContradiction(facts({ displayOn: null })),
    null,
    "no settings reading, so nothing to contradict",
  );
  assert.equal(
    screenPowerContradiction(
      facts({ screen: { isBlackScreen: false, showingLogo: false, isScreenOn: null } }),
    ),
    null,
    "no second opinion",
  );
});

test("an ABSENT is_screen_on behaves exactly like a null one (never like false)", () => {
  const absent = facts({ screen: { isBlackScreen: false, showingLogo: false } });
  const explicitNull = facts({
    screen: { isBlackScreen: false, showingLogo: false, isScreenOn: null },
  });
  assert.equal(screenPowerContradiction(absent), null);
  assert.deepEqual(blankCause(absent, IN_WINDOW), blankCause(explicitNull, IN_WINDOW));
});

test("blankCause: contradicting power signals → signals-disagree, and NO device action", () => {
  for (const [displayOn, isScreenOn] of [
    [false, true],
    [true, false],
  ] as Array<[boolean, boolean]>) {
    const r = blankCause(
      facts({
        displayOn,
        currentBrightnessRaw: displayOn ? 255 : 0,
        screen: { isBlackScreen: false, showingLogo: false, isScreenOn },
      }),
      IN_WINDOW,
    );
    assert.equal(r.cause, "signals-disagree", `display_on=${displayOn}/is_screen_on=${isScreenOn}`);
    assert.equal(r.brightnessActionApplicable, false, "we must not act off a contradiction");
    assert.equal(r.evidence.length, 1);
    assert.match(r.rationale, /disagree/i);
    assert.match(r.rationale, /no device action/i);
  }
});

// ── panel-off, and the window boundary ───────────────────────────────────────

test("panel off INSIDE its ON window → panel-off-unexpected, brightness IS the action", () => {
  const r = blankCause(dark(), IN_WINDOW);
  assert.equal(r.cause, "panel-off-unexpected");
  assert.equal(r.actionable, true);
  assert.equal(r.brightnessActionApplicable, true);
  assert.match(r.rationale, /09:00/);
  assert.match(r.rationale, /America\/New_York/);
  assert.match(r.rationale, /restoring brightness/i);
});

test("panel off OUTSIDE its ON window → panel-off-expected, not a fault, no action", () => {
  const r = blankCause(dark(), OFF_WINDOW);
  assert.equal(r.cause, "panel-off-expected");
  assert.equal(r.actionable, false);
  assert.equal(r.brightnessActionApplicable, false);
  assert.match(r.rationale, /Not a fault/i);
});

test("the on-window boundary is half-open: turn-on minute is IN, the minute before is OUT", () => {
  // 0900 with an overnight 0900→0500 wrap: 08:59 local is the last dark minute.
  assert.equal(blankCause(dark(), edt(8, 59)).cause, "panel-off-expected");
  assert.equal(blankCause(dark(), edt(9, 0)).cause, "panel-off-unexpected");
  // And the turn-off minute flips it back.
  assert.equal(blankCause(dark(), edt(4, 59)).cause, "panel-off-unexpected");
  assert.equal(blankCause(dark(), edt(5, 0)).cause, "panel-off-expected");
});

test("the boundary is judged in the DEVICE's zone, not the server's", () => {
  // 07:00 EDT is 12:00 UTC; a UTC device is inside its window at the same instant.
  assert.equal(blankCause(dark(), OFF_WINDOW).cause, "panel-off-expected");
  assert.equal(blankCause(dark({ timezone: "UTC" }), OFF_WINDOW).cause, "panel-off-unexpected");
});

test("either dark signal alone is enough for panel-off", () => {
  const byBrightness = dark({
    currentBrightnessRaw: 0,
    displayOn: null,
    screen: { isBlackScreen: false, showingLogo: false, isScreenOn: null },
  });
  const byBacklight = dark({
    currentBrightnessRaw: 200,
    displayOn: false,
    screen: { isBlackScreen: false, showingLogo: false, isScreenOn: false },
  });
  assert.equal(blankCause(byBrightness, IN_WINDOW).cause, "panel-off-unexpected");
  assert.equal(blankCause(byBacklight, IN_WINDOW).cause, "panel-off-unexpected");
  // Evidence names ONLY the reading we hold, never the one we did not read.
  assert.deepEqual(blankCause(byBrightness, IN_WINDOW).evidence, [
    "the panel reports current brightness 0",
  ]);
  assert.deepEqual(blankCause(byBacklight, IN_WINDOW).evidence, ["display_on is false"]);
});

test("panel off with NO schedule enabled → unexpected, and says nothing explains it", () => {
  const r = blankCause(dark({ brightnessScheduleEnabled: false }), IN_WINDOW);
  assert.equal(r.cause, "panel-off-unexpected");
  assert.equal(r.brightnessActionApplicable, true);
  assert.match(r.rationale, /No brightness schedule/i);
});

test("panel off with the schedule flag UNREAD is still unexpected — only true buys an exemption", () => {
  const r = blankCause(dark({ brightnessScheduleEnabled: null }), OFF_WINDOW);
  assert.equal(r.cause, "panel-off-unexpected", "an unread flag is not an excuse");
});

test("panel off with a schedule we cannot evaluate → unknown, never a guess", () => {
  for (const over of [
    { turnOnTime: "nonsense" },
    { turnOffTime: null },
    { timezone: null },
    { timezone: "Not/AZone" },
    { turnOnTime: "0900", turnOffTime: "0900" }, // degenerate window
  ] as Array<Partial<ScreenBlankFacts>>) {
    const r = blankCause(dark(over), IN_WINDOW);
    assert.equal(r.cause, "unknown", JSON.stringify(over));
    assert.equal(r.actionable, false);
    assert.equal(r.brightnessActionApplicable, false);
    // Still reports WHAT we measured, even though we cannot judge it.
    assert.ok(r.evidence.length > 0, "the darkness reading is still named");
  }
});

// ── content-black — the case the whole module exists for ─────────────────────

test("LIT panel + is_black_screen → content-black, brightness EXPLICITLY not applicable", () => {
  const r = blankCause(litButBlack(), IN_WINDOW);
  assert.equal(r.cause, "content-black");
  assert.equal(r.actionable, true);
  assert.equal(r.brightnessActionApplicable, false, "brightness is already 255 — a no-op");
  assert.equal(r.panelLitConfirmed, true);
  assert.match(r.rationale, /255\/255/);
  assert.match(r.rationale, /lit/);
  assert.match(r.rationale, /no-op/);
});

test("content-black holds at any non-zero brightness, and names the real number", () => {
  const r = blankCause(litButBlack({ currentBrightnessRaw: 1 }), IN_WINDOW);
  assert.equal(r.cause, "content-black");
  assert.match(r.rationale, /1\/255/, "the rationale must quote the reading we hold");
});

test("is_black_screen with NO panel reading is content-black but does NOT claim lit", () => {
  const r = blankCause(
    facts({
      currentBrightnessRaw: null,
      displayOn: null,
      screen: { isBlackScreen: true, showingLogo: false, isScreenOn: null },
    }),
    IN_WINDOW,
  );
  assert.equal(r.cause, "content-black");
  assert.equal(r.panelLitConfirmed, false, "we cannot show it is lit, so we must not say so");
  assert.equal(r.brightnessActionApplicable, false, "nor is there evidence brightness would help");
  assert.doesNotMatch(r.rationale, /no-op/, "no no-op claim without a brightness reading");
  assert.match(r.rationale, /will not claim/i);
});

test("a lit panel with display_on unread cannot be 'confirmed lit'", () => {
  const r = blankCause(
    facts({
      currentBrightnessRaw: 255,
      displayOn: null,
      screen: { isBlackScreen: true, showingLogo: false, isScreenOn: null },
    }),
    IN_WINDOW,
  );
  assert.equal(r.cause, "content-black");
  assert.equal(r.panelLitConfirmed, false, "brightness alone does not prove the backlight is on");
});

// ── showing-logo ─────────────────────────────────────────────────────────────

test("lit panel + showing_logo → showing-logo, a content gap not a panel fault", () => {
  const r = blankCause(
    facts({ screen: { isBlackScreen: false, showingLogo: true, isScreenOn: true } }),
    IN_WINDOW,
  );
  assert.equal(r.cause, "showing-logo");
  assert.equal(r.actionable, true);
  assert.equal(r.brightnessActionApplicable, false);
  assert.match(r.rationale, /playlist/i);
});

// ── PRECEDENCE — the design, asserted ────────────────────────────────────────

test("PRECEDENCE 1: unreachable beats every flag we hold", () => {
  for (const status of ["offline", "unknown"]) {
    const r = blankCause(litButBlack({ status }), IN_WINDOW);
    assert.equal(r.cause, "unknown", status);
    assert.equal(r.actionable, false);
    assert.equal(r.brightnessActionApplicable, false);
    assert.deepEqual(r.evidence, [`presence is ${status}`]);
  }
});

test("PRECEDENCE 1: unreachable beats a power contradiction too", () => {
  const r = blankCause(
    facts({
      status: "offline",
      displayOn: false,
      screen: { isBlackScreen: false, showingLogo: false, isScreenOn: true },
    }),
    IN_WINDOW,
  );
  assert.equal(r.cause, "unknown");
});

test("PRECEDENCE 2: a power contradiction beats panel-off — the 5-device live shape", () => {
  // Without this, display_on=false alone would route these into
  // panel-off-unexpected and we would recommend a brightness write while the
  // status feed insists the panel is already on.
  const r = blankCause(
    facts({
      currentBrightnessRaw: 0,
      displayOn: false,
      screen: { isBlackScreen: false, showingLogo: false, isScreenOn: true },
    }),
    IN_WINDOW,
  );
  assert.equal(r.cause, "signals-disagree");
  assert.equal(r.brightnessActionApplicable, false);
});

test("PRECEDENCE 2: a power contradiction beats content-black as well", () => {
  // content-black ASSERTS the panel is lit; that assertion rests on display_on,
  // so a contradiction there blocks it.
  const r = blankCause(
    litButBlack({ screen: { isBlackScreen: true, showingLogo: false, isScreenOn: false } }),
    IN_WINDOW,
  );
  assert.equal(r.cause, "signals-disagree");
});

test("PRECEDENCE 3: a dark panel beats the content flags — no light, nothing visible", () => {
  const both = dark({
    screen: { isBlackScreen: true, showingLogo: true, isScreenOn: false },
  });
  assert.equal(blankCause(both, IN_WINDOW).cause, "panel-off-unexpected");
  assert.equal(blankCause(both, OFF_WINDOW).cause, "panel-off-expected");
});

test("PRECEDENCE 4: on a lit panel, showing-logo beats content-black (more specific)", () => {
  const r = blankCause(
    litButBlack({ screen: { isBlackScreen: true, showingLogo: true, isScreenOn: true } }),
    IN_WINDOW,
  );
  assert.equal(r.cause, "showing-logo");
});

test("PRECEDENCE 5: nothing readable at all is unknown, never 'fine'", () => {
  const r = blankCause(
    facts({
      currentBrightnessRaw: null,
      displayOn: null,
      brightnessScheduleEnabled: null,
      turnOnTime: null,
      turnOffTime: null,
      timezone: null,
      screen: { isBlackScreen: null, showingLogo: null, isScreenOn: null },
    }),
    IN_WINDOW,
  );
  assert.equal(r.cause, "unknown");
  assert.match(r.rationale, /no settings snapshot/i);
  assert.match(r.rationale, /not evidence the screen is fine/i);
});

// ── not-blank, and the global invariant ──────────────────────────────────────

test("a lit panel showing content is not-blank and not actionable", () => {
  const r = blankCause(facts(), IN_WINDOW);
  assert.equal(r.cause, "not-blank");
  assert.equal(r.actionable, false);
  assert.equal(r.brightnessActionApplicable, false);
  assert.equal(r.panelLitConfirmed, true);
});

test("a lit panel with UNREAD content flags is still not-blank (we did read the panel)", () => {
  const r = blankCause(
    facts({ screen: { isBlackScreen: null, showingLogo: null, isScreenOn: null } }),
    IN_WINDOW,
  );
  assert.equal(r.cause, "not-blank");
});

test("INVARIANT: brightness is applicable for panel-off-unexpected and NOTHING else", () => {
  const cases: Array<[BlankCause, ScreenBlankFacts, Date]> = [
    ["not-blank", facts(), IN_WINDOW],
    ["panel-off-unexpected", dark(), IN_WINDOW],
    ["panel-off-expected", dark(), OFF_WINDOW],
    ["content-black", litButBlack(), IN_WINDOW],
    [
      "showing-logo",
      facts({ screen: { isBlackScreen: false, showingLogo: true, isScreenOn: true } }),
      IN_WINDOW,
    ],
    [
      "signals-disagree",
      facts({ displayOn: false, screen: { isBlackScreen: false, showingLogo: false, isScreenOn: true } }),
      IN_WINDOW,
    ],
    ["unknown", facts({ status: "offline" }), IN_WINDOW],
  ];
  // Every cause in the taxonomy is exercised here — if one is added without a
  // fixture, this fails rather than leaving a branch untested.
  const seen = new Set<BlankCause>();
  for (const [expected, f, at] of cases) {
    const r = blankCause(f, at);
    assert.equal(r.cause, expected, `expected ${expected}, got ${r.cause}`);
    assert.equal(
      r.brightnessActionApplicable,
      expected === "panel-off-unexpected",
      `${expected} must ${expected === "panel-off-unexpected" ? "" : "NOT "}be brightness-actionable`,
    );
    // A cause we cannot act on must never carry an action flag.
    if (!r.actionable) assert.equal(r.brightnessActionApplicable, false, expected);
    seen.add(r.cause);
  }
  assert.equal(seen.size, 7, "all seven causes must be covered by a fixture");
});

test("INVARIANT: evidence is never empty except where we truly hold nothing", () => {
  const nothing = blankCause(
    facts({
      currentBrightnessRaw: null,
      displayOn: null,
      screen: { isBlackScreen: null, showingLogo: null, isScreenOn: null },
    }),
    IN_WINDOW,
  );
  assert.deepEqual(nothing.evidence, [], "no readings means no evidence claims");
  for (const f of [facts(), dark(), litButBlack()]) {
    assert.ok(blankCause(f, IN_WINDOW).evidence.length > 0);
  }
});
