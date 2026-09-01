/**
 * Screen-state tests — `node --test dist/intelligence/screen-state.test.js`
 *
 * This module is the guard on a false positive that reached operators: 21 lit
 * screens recommended for a brightness write. So the tests are weighted toward
 * the ways it could go wrong again:
 *
 *   - a lit panel must never come back dark, whatever the stored base value says;
 *   - the ON window must be evaluated in the DEVICE's timezone (there are
 *     explicit non-UTC cases where the zone flips the answer, plus a half-hour
 *     offset zone and a DST case);
 *   - the overnight wrap ("0900"→"0500" is ~20h ON, not 4h) must not invert;
 *   - anything unreadable is `null`/"unknown" — never a confident verdict.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  darknessVerdict,
  describeDarkEvidence,
  describeOnWindow,
  formatHHmm,
  isDark,
  localMinutes,
  parseHHmm,
  withinOnWindow,
  type ScreenStateFacts,
} from "./screen-state.js";

const NY = "America/New_York";

/** A lit panel on the fleet's most common schedule shape. */
const facts = (over: Partial<ScreenStateFacts> = {}): ScreenStateFacts => ({
  currentBrightnessRaw: 200,
  displayOn: true,
  brightnessScheduleEnabled: true,
  turnOnTime: "0900",
  turnOffTime: "0500",
  timezone: NY,
  ...over,
});

/**
 * A UTC instant for a wall-clock time on 2026-08-31 in New York, which is EDT
 * (UTC-4) that day. Hour overflow rolls the date, so edt(23) is 2026-09-01T03:00Z.
 */
const edt = (hour: number, minute = 0): Date =>
  new Date(Date.UTC(2026, 7, 31, hour + 4, minute));

// ── parseHHmm / formatHHmm ───────────────────────────────────────────────────

test("parseHHmm reads HHmm to minutes-since-midnight", () => {
  assert.equal(parseHHmm("0000"), 0);
  assert.equal(parseHHmm("0900"), 540);
  assert.equal(parseHHmm("0500"), 300);
  assert.equal(parseHHmm("1730"), 1050);
  assert.equal(parseHHmm("2359"), 1439);
  assert.equal(parseHHmm(" 0800 "), 480, "surrounding whitespace is tolerated");
});

test("parseHHmm returns null for anything it cannot trust", () => {
  for (const bad of [null, undefined, "", "   ", "900", "09:00", "9", "abcd", "2400", "0960", "-100", "09000"]) {
    assert.equal(parseHHmm(bad as string | null), null, JSON.stringify(bad));
  }
});

test("formatHHmm renders operator-facing times, null through", () => {
  assert.equal(formatHHmm("0900"), "09:00");
  assert.equal(formatHHmm("0005"), "00:05");
  assert.equal(formatHHmm("1700"), "17:00");
  assert.equal(formatHHmm("nope"), null);
  assert.equal(formatHHmm(null), null);
});

// ── localMinutes — the zone actually applies ─────────────────────────────────

test("localMinutes evaluates in the requested zone, not UTC", () => {
  const at = new Date("2026-08-31T16:00:00Z");
  assert.equal(localMinutes(at, "UTC"), 16 * 60);
  assert.equal(localMinutes(at, NY), 12 * 60, "EDT is UTC-4 on this date");
  assert.equal(localMinutes(at, "Asia/Kolkata"), 21 * 60 + 30, "half-hour offset zone");
  assert.equal(localMinutes(at, "Asia/Tokyo"), 1 * 60, "next day in Tokyo");
});

test("localMinutes follows DST rather than a fixed offset", () => {
  // Same clock time in January: New York is EST (UTC-5), so one hour earlier.
  assert.equal(localMinutes(new Date("2026-01-15T16:00:00Z"), NY), 11 * 60);
  assert.equal(localMinutes(new Date("2026-08-31T16:00:00Z"), NY), 12 * 60);
});

test("localMinutes handles midnight as 00:xx, never 24:xx", () => {
  assert.equal(localMinutes(new Date("2026-08-31T04:00:00Z"), NY), 0, "00:00 EDT");
  assert.equal(localMinutes(new Date("2026-08-31T04:07:00Z"), NY), 7);
});

test("localMinutes returns null for an unknown zone or an invalid date", () => {
  assert.equal(localMinutes(new Date("2026-08-31T16:00:00Z"), "Not/AZone"), null);
  assert.equal(localMinutes(new Date("2026-08-31T16:00:00Z"), ""), null);
  assert.equal(localMinutes(new Date("nonsense"), NY), null);
});

// ── withinOnWindow — normal window ──────────────────────────────────────────

test("normal window: inside is true, outside is false", () => {
  assert.equal(withinOnWindow("0900", "1700", NY, edt(12)), true);
  assert.equal(withinOnWindow("0900", "1700", NY, edt(8)), false);
  assert.equal(withinOnWindow("0900", "1700", NY, edt(19)), false);
  assert.equal(withinOnWindow("0800", "1700", NY, edt(8, 1)), true);
  assert.equal(withinOnWindow("0700", "1800", NY, edt(17, 59)), true);
});

test("normal window boundaries are half-open: turn-on in, turn-off out", () => {
  assert.equal(withinOnWindow("0900", "1700", NY, edt(9)), true, "exactly turn_on is ON");
  assert.equal(withinOnWindow("0900", "1700", NY, edt(8, 59)), false);
  assert.equal(withinOnWindow("0900", "1700", NY, edt(16, 59)), true);
  assert.equal(withinOnWindow("0900", "1700", NY, edt(17)), false, "exactly turn_off is OFF");
});

// ── withinOnWindow — the overnight wrap ─────────────────────────────────────

test("overnight wrap 0900→0500 is ON across midnight", () => {
  assert.equal(withinOnWindow("0900", "0500", NY, edt(12)), true);
  assert.equal(withinOnWindow("0900", "0500", NY, edt(23)), true);
  assert.equal(withinOnWindow("0900", "0500", NY, edt(26)), true, "02:00 the next day");
  assert.equal(withinOnWindow("0900", "0500", NY, edt(28, 59)), true, "04:59 the next day");
});

test("overnight wrap 0900→0500 is OFF only in the 05:00–09:00 gap", () => {
  assert.equal(withinOnWindow("0900", "0500", NY, edt(29)), false, "exactly 05:00 is OFF");
  assert.equal(withinOnWindow("0900", "0500", NY, edt(30)), false, "06:00");
  assert.equal(withinOnWindow("0900", "0500", NY, edt(32, 59)), false, "08:59");
  assert.equal(withinOnWindow("0900", "0500", NY, edt(33)), true, "09:00 turns it back on");
});

test("overnight wrap covers ~20 of 24 hours (never read backwards as 4)", () => {
  const onHours = Array.from({ length: 24 }, (_, h) =>
    withinOnWindow("0900", "0500", NY, edt(h)),
  ).filter((v) => v === true).length;
  assert.equal(onHours, 20);
});

// ── withinOnWindow — the zone is load-bearing ───────────────────────────────

test("the same instant lands inside or outside depending on the DEVICE zone", () => {
  // 02:00Z: still the small hours in UTC, mid-morning in Tokyo.
  const at = new Date("2026-08-31T02:00:00Z");
  assert.equal(withinOnWindow("0900", "1700", "UTC", at), false);
  assert.equal(withinOnWindow("0900", "1700", "Asia/Tokyo", at), true, "11:00 JST");
  assert.equal(withinOnWindow("0900", "1700", NY, at), false, "22:00 previous day EDT");
});

test("assuming UTC would misjudge a New York schedule", () => {
  // 06:30Z = 02:30 EDT — inside a 0900→0500 window locally, outside it in UTC.
  const at = new Date("2026-08-31T06:30:00Z");
  assert.equal(withinOnWindow("0900", "0500", NY, at), true);
  assert.equal(withinOnWindow("0900", "0500", "UTC", at), false);
});

// ── withinOnWindow — honest nulls ───────────────────────────────────────────

test("withinOnWindow returns null for missing or unparseable inputs", () => {
  const at = edt(12);
  assert.equal(withinOnWindow(null, "0500", NY, at), null);
  assert.equal(withinOnWindow("0900", null, NY, at), null);
  assert.equal(withinOnWindow("0900", "0500", null, at), null);
  assert.equal(withinOnWindow("garbage", "0500", NY, at), null);
  assert.equal(withinOnWindow("0900", "25:00", NY, at), null);
  assert.equal(withinOnWindow("0900", "0500", "Mars/Olympus", at), null);
  assert.equal(withinOnWindow("0900", "0500", NY, new Date("bad")), null);
});

test("a degenerate window (turn_on === turn_off) is null, not a guess", () => {
  assert.equal(withinOnWindow("0900", "0900", NY, edt(12)), null);
  assert.equal(withinOnWindow("0000", "0000", NY, edt(12)), null);
});

// ── isDark ──────────────────────────────────────────────────────────────────

test("isDark is true on either live dark signal", () => {
  assert.equal(isDark(facts({ currentBrightnessRaw: 0, displayOn: false })), true);
  assert.equal(isDark(facts({ currentBrightnessRaw: 0, displayOn: true })), true);
  assert.equal(isDark(facts({ currentBrightnessRaw: 200, displayOn: false })), true);
  assert.equal(isDark(facts({ currentBrightnessRaw: 0, displayOn: null })), true);
  assert.equal(isDark(facts({ currentBrightnessRaw: null, displayOn: false })), true);
});

test("isDark is false when the live evidence says the panel is producing light", () => {
  assert.equal(isDark(facts({ currentBrightnessRaw: 255, displayOn: true })), false);
  assert.equal(isDark(facts({ currentBrightnessRaw: 179, displayOn: null })), false);
  assert.equal(isDark(facts({ currentBrightnessRaw: null, displayOn: true })), false);
  assert.equal(isDark(facts({ currentBrightnessRaw: 1, displayOn: true })), false);
});

test("isDark is null when neither live field was read (never a convenient false)", () => {
  assert.equal(isDark(facts({ currentBrightnessRaw: null, displayOn: null })), null);
});

// ── darknessVerdict — the four outcomes ─────────────────────────────────────

test("verdict lit — including the false-positive shape (base brightness 0, panel at 255)", () => {
  assert.equal(darknessVerdict(facts(), edt(12)), "lit");
  assert.equal(
    darknessVerdict(facts({ currentBrightnessRaw: 255, displayOn: true }), edt(3)),
    "lit",
    "a lit panel is lit even outside its ON window — we report what we measured",
  );
});

test("verdict dark-unexpected — dark inside the ON window", () => {
  const dark = facts({ currentBrightnessRaw: 0, displayOn: false });
  assert.equal(darknessVerdict(dark, edt(12)), "dark-unexpected");
  assert.equal(darknessVerdict(dark, edt(26)), "dark-unexpected", "02:00, still inside the wrap");
});

test("verdict dark-unexpected — dark with no schedule enabled to explain it", () => {
  const dark = facts({
    currentBrightnessRaw: 0,
    displayOn: false,
    brightnessScheduleEnabled: false,
  });
  assert.equal(darknessVerdict(dark, edt(12)), "dark-unexpected");
  assert.equal(darknessVerdict(dark, edt(7)), "dark-unexpected", "no schedule ⇒ no exemption");
});

test("verdict dark-unexpected — dark with the schedule flag unread", () => {
  const dark = facts({
    currentBrightnessRaw: 0,
    displayOn: false,
    brightnessScheduleEnabled: null,
  });
  // We measured the darkness; we simply found nothing that excuses it.
  assert.equal(darknessVerdict(dark, edt(7)), "dark-unexpected");
});

test("verdict dark-expected — dark outside its own ON window", () => {
  const dark = facts({ currentBrightnessRaw: 0, displayOn: false });
  assert.equal(darknessVerdict(dark, edt(7)), "dark-expected", "07:00, in the 05:00–09:00 gap");
  assert.equal(darknessVerdict(dark, edt(29)), "dark-expected", "exactly 05:00, just turned off");
});

test("verdict dark-expected respects the device zone, not the server's", () => {
  const at = new Date("2026-08-31T11:00:00Z"); // 07:00 EDT, inside the OFF gap
  const dark = facts({ currentBrightnessRaw: 0, displayOn: false });
  assert.equal(darknessVerdict(dark, at), "dark-expected");
  // The same instant in UTC (11:00) is inside the window, which is exactly the
  // wrong answer we would give if we ignored `timezone`.
  assert.equal(darknessVerdict({ ...dark, timezone: "UTC" }, at), "dark-unexpected");
});

test("verdict unknown — no live reading, or a schedule we cannot evaluate", () => {
  assert.equal(
    darknessVerdict(facts({ currentBrightnessRaw: null, displayOn: null }), edt(12)),
    "unknown",
  );
  const dark = { currentBrightnessRaw: 0, displayOn: false };
  assert.equal(darknessVerdict(facts({ ...dark, turnOnTime: "??" }), edt(12)), "unknown");
  assert.equal(darknessVerdict(facts({ ...dark, turnOffTime: null }), edt(12)), "unknown");
  assert.equal(darknessVerdict(facts({ ...dark, timezone: null }), edt(12)), "unknown");
  assert.equal(darknessVerdict(facts({ ...dark, timezone: "Not/AZone" }), edt(12)), "unknown");
});

// ── operator-facing text ────────────────────────────────────────────────────

test("describeOnWindow names the window and the zone, or nothing at all", () => {
  assert.equal(describeOnWindow(facts()), "09:00–05:00 local (America/New_York)");
  assert.equal(describeOnWindow(facts({ timezone: null })), "09:00–05:00 local");
  assert.equal(describeOnWindow(facts({ turnOnTime: "x" })), null);
  assert.equal(describeOnWindow(facts({ turnOffTime: null })), null);
});

test("describeDarkEvidence only claims readings we hold", () => {
  assert.equal(
    describeDarkEvidence(facts({ currentBrightnessRaw: 0, displayOn: false })),
    "the panel reports current brightness 0 and display_on is false",
  );
  assert.equal(
    describeDarkEvidence(facts({ currentBrightnessRaw: null, displayOn: false })),
    "display_on is false",
  );
  assert.equal(
    describeDarkEvidence(facts({ currentBrightnessRaw: 0, displayOn: true })),
    "the panel reports current brightness 0",
  );
  assert.equal(describeDarkEvidence(facts()), null, "nothing says dark");
});
