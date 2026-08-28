/**
 * Brightness preflight/verify/rollback — pure-logic tests.
 * `node --test dist/videri/brightness.test.js`
 *
 * The IO orchestrator is driven by a fake CommandRunner so every path — including
 * a failed rollback, the worst outcome — is exercised without a device.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyBrightness, applyBrightnessLive, parseBrightnessRaw, rawFromPercent, percentFromRaw,
  brightnessMatches, MIN_RAW, MAX_RAW,
} from "./brightness.js";

test("percent<->raw round-trips and clamps 0 to display-safe MIN_RAW", () => {
  assert.equal(rawFromPercent(100), MAX_RAW);
  assert.equal(rawFromPercent(50), 128);
  // 0% must never reach raw 0 (display off).
  assert.equal(rawFromPercent(0), MIN_RAW);
  assert.equal(percentFromRaw(255), 100);
});

test("parseBrightnessRaw reads the SET value, not the backlight PWM", () => {
  // "Current brightness" is the set value; "Current backlight" is the physical PWM.
  const msg = "Current brightness is: 102 Default brightness is: 102 Current backlight is: 40";
  assert.equal(parseBrightnessRaw(msg), 102);
  assert.equal(parseBrightnessRaw("Backlight: 40"), null);
  assert.equal(parseBrightnessRaw("garbage"), null);
});

test("verify tolerance absorbs device rounding but not a real miss", () => {
  assert.equal(brightnessMatches(128, 127), true);
  assert.equal(brightnessMatches(128, 126), true);
  assert.equal(brightnessMatches(128, 125), false);
});

/** A scripted runner: responds to get_brightness with a state it holds, and to
 *  set_brightness by mutating that state (unless told to ignore writes). */
function fakeDevice(opts: { start: number; ignoreWrites?: boolean; unreadable?: boolean; rejectWrite?: boolean }) {
  let current = opts.start;
  const calls: string[] = [];
  const run = async (arg: string) => {
    calls.push(arg);
    if (arg === "get_brightness") {
      if (opts.unreadable) return { code: "ERROR", message: "no" };
      return { code: "SUCCESS", message: `Current brightness is: ${current} Default brightness is: ${current} Current backlight is: 40` };
    }
    const m = /set_brightness:=(\d+)/.exec(arg);
    if (m) {
      if (opts.rejectWrite) return { code: "TIME_OUT", message: "" };
      if (!opts.ignoreWrites) current = Number(m[1]);
      return { code: "SUCCESS", message: "ok" };
    }
    return { code: "ERROR", message: "unknown" };
  };
  return { run, calls, get current() { return current; } };
}

test("verified: a device that accepts the write reports verified", async () => {
  const dev = fakeDevice({ start: 50 });
  const r = await applyBrightness("d1", 80, dev.run);
  assert.equal(r.state, "verified");
  assert.equal(r.applied, true);
  assert.equal(dev.current, rawFromPercent(80));
});

test("preflight_blocked: unreadable current means NOTHING is written", async () => {
  const dev = fakeDevice({ start: 50, unreadable: true });
  const r = await applyBrightness("d1", 80, dev.run);
  assert.equal(r.state, "preflight_blocked");
  assert.equal(r.applied, false);
  assert.ok(!dev.calls.some((c) => c.startsWith("set_brightness")), "must not write without a readable original");
});

test("no_change: already at target, nothing written", async () => {
  const dev = fakeDevice({ start: rawFromPercent(80) });
  const r = await applyBrightness("d1", 80, dev.run);
  assert.equal(r.state, "no_change");
  assert.ok(!dev.calls.some((c) => c.startsWith("set_brightness")));
});

test("write_rejected: device refuses the write, brightness unchanged", async () => {
  const dev = fakeDevice({ start: 50, rejectWrite: true });
  const r = await applyBrightness("d1", 80, dev.run);
  assert.equal(r.state, "write_rejected");
  assert.equal(dev.current, 50);
});

test("rollback: a device that ignores the write is restored to its original", async () => {
  // Accepts the set command (SUCCESS) but does not actually change — the SJ
  // Office V4 failure mode. Verify catches it; rollback restores the original.
  const dev = fakeDevice({ start: 50, ignoreWrites: true });
  const r = await applyBrightness("d1", 80, dev.run);
  assert.equal(r.state, "unconfirmed_rolled_back");
  assert.equal(r.applied, false);
  // The restore write is to the original value (a no-op here, but attempted).
  assert.ok(dev.calls.filter((c) => c.startsWith("set_brightness")).length >= 2);
});

test("rollback_failed is reported distinctly — the page-me outcome", async () => {
  // Writes ignored AND reads go unreadable after the first: verify fails and the
  // restore cannot be confirmed either.
  let phase = 0;
  const run = async (arg: string) => {
    if (arg === "get_brightness") {
      phase += 1;
      if (phase === 1) return { code: "SUCCESS", message: "Current brightness is: 50" };
      return { code: "ERROR", message: "unreadable" }; // can't verify or confirm restore
    }
    return { code: "SUCCESS", message: "ok" }; // accepts writes but nothing verifies
  };
  const r = await applyBrightness("d1", 80, run);
  assert.equal(r.state, "unconfirmed_rollback_failed");
  assert.match(r.message, /unknown brightness/);
});


test("live mode: sets and returns the observed value, no rollback", async () => {
  const dev = fakeDevice({ start: 50 });
  const r = await applyBrightnessLive("d1", 80, dev.run);
  assert.equal(r.applied, true);
  assert.equal(r.observedRaw, rawFromPercent(80));
  assert.equal(dev.current, rawFromPercent(80));
  // exactly two commands: set, then read-back. No preflight, no rollback.
  assert.equal(dev.calls.length, 2);
  assert.equal(dev.calls[0]?.startsWith("set_brightness"), true);
  assert.equal(dev.calls[1], "get_brightness");
});

test("live mode: a device that ignores the write reports applied:false, no restore", async () => {
  const dev = fakeDevice({ start: 50, ignoreWrites: true });
  const r = await applyBrightnessLive("d1", 80, dev.run);
  assert.equal(r.applied, false);
  assert.equal(r.observedRaw, 50);
  // still just set + read — live never rolls back.
  assert.equal(dev.calls.length, 2);
});
