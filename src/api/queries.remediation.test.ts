/**
 * `remediationDevices()` row-shaping tests — `node --test dist/api/queries.remediation.test.js`
 *
 * A separate file from queries.test.ts because this one method is where a
 * shipped false positive was born: the engine was handed
 * `settings->>'brightness'` (the SCHEDULED base value) and nothing else, so it
 * could not tell a dark panel from a lit one and recommended a write on 21
 * working screens.
 *
 * What is pinned here is therefore the CONTRACT of the projection — that the live
 * fields and the schedule fields are all selected and shaped honestly — plus the
 * jsonb-text-to-boolean coercion, the other place a null can quietly become a
 * confident `false`. Stub pool, no network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { ReadQueries } from "./queries.js";

/** Answers every statement with `rows` and captures the SQL. */
function stubPool(rows: Array<Record<string, unknown>>): { pool: Pool; sql: string[] } {
  const sql: string[] = [];
  const pool = {
    async query(text: string) {
      sql.push(text);
      return { rows, rowCount: rows.length };
    },
  } as unknown as Pool;
  return { pool, sql };
}

/** A row exactly as pg returns it: jsonb `->>` gives text, numerics give strings. */
const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "1000015",
  name: "Lobby North",
  city: "New York",
  group_id: "g-1",
  firmware_current: "3.4.1",
  firmware_latest: "3.4.1",
  status: "online",
  last_online_time: new Date("2026-08-31T12:00:00Z"),
  timezone: "America/New_York",
  is_black_screen: false,
  showing_logo: false,
  is_screen_on: true,
  telemetry_observed_at: null,
  cpu_percent: null,
  ram_used_percent: null,
  storage_used_percent: null,
  rssi_dbm: null,
  ntp_offset_ms: null,
  brightness_raw: "0",
  current_brightness_raw: "204",
  display_on: "true",
  brightness_schedule_enabled: "true",
  auto_brightness_enabled: "false",
  turn_on_time: "0900",
  turn_off_time: "0500",
  drift: [],
  ...over,
});

test("the projection selects the live panel fields, the schedule and the device zone", async () => {
  const { pool, sql } = stubPool([]);
  await new ReadQueries(pool).remediationDevices();
  const text = sql.join("\n");
  // Each of these is load-bearing: drop one and the display rules go blind, and
  // historically that meant judging darkness from the scheduled base value.
  for (const needle of [
    "'current_brightness'",
    "'display_on'",
    "'brightness_schedule_enabled'",
    "'auto_brightness_enabled'",
    "'turn_on_time'",
    "'turn_off_time'",
    "d.timezone",
    // The status feed's own view of panel power. Without it we cannot see the 5
    // devices whose `is_screen_on` contradicts `display_on`, and they silently
    // become "panel off → restore brightness" off ONE of two disagreeing sources.
    "hs.is_screen_on",
  ]) {
    assert.ok(text.includes(needle), `remediation projection must select ${needle}`);
  }
});

test("the status feed's is_screen_on rides along, and an unread sample is null not false", async () => {
  const { pool } = stubPool([row({ is_screen_on: true })]);
  const [d] = await new ReadQueries(pool).remediationDevices();
  assert.equal(d!.screen.isScreenOn, true);

  const { pool: p2 } = stubPool([row({ is_screen_on: null })]);
  const [d2] = await new ReadQueries(p2).remediationDevices();
  assert.equal(d2!.screen.isScreenOn, null, "no sample means no second opinion, not 'off'");
});

test("the live contradiction shape survives the projection intact", async () => {
  // 5 reachable devices read display_on=false while is_screen_on=true. Both
  // values must arrive as themselves, or the classifier cannot see the conflict.
  const { pool } = stubPool([
    row({ display_on: "false", current_brightness_raw: "0", is_screen_on: true }),
  ]);
  const [d] = await new ReadQueries(pool).remediationDevices();
  assert.equal(d!.displayOn, false);
  assert.equal(d!.screen.isScreenOn, true);
});

test("the real fleet shape — base brightness 0 on a LIT panel — is shaped faithfully", async () => {
  const { pool } = stubPool([row()]);
  const [d] = await new ReadQueries(pool).remediationDevices();
  assert.ok(d);
  assert.equal(d!.brightnessRaw, 0, "the scheduled base value, kept as-is");
  assert.equal(d!.currentBrightnessRaw, 204, "the live panel output, coerced from text");
  assert.equal(d!.displayOn, true);
  assert.equal(d!.brightnessScheduleEnabled, true);
  assert.equal(d!.autoBrightnessEnabled, false);
  assert.equal(d!.turnOnTime, "0900");
  assert.equal(d!.turnOffTime, "0500");
  assert.equal(d!.timezone, "America/New_York");
});

test("absent settings arrive as nulls, never as 0 or false", async () => {
  const { pool } = stubPool([
    row({
      brightness_raw: null,
      current_brightness_raw: null,
      display_on: null,
      brightness_schedule_enabled: null,
      auto_brightness_enabled: null,
      turn_on_time: null,
      turn_off_time: null,
      timezone: null,
    }),
  ]);
  const [d] = await new ReadQueries(pool).remediationDevices();
  assert.equal(d!.brightnessRaw, null);
  assert.equal(d!.currentBrightnessRaw, null);
  assert.equal(d!.displayOn, null);
  assert.equal(d!.brightnessScheduleEnabled, null);
  assert.equal(d!.autoBrightnessEnabled, null);
  assert.equal(d!.turnOnTime, null);
  assert.equal(d!.turnOffTime, null);
  assert.equal(d!.timezone, null);
});

test("boolean settings coerce from text, and unrecognised text is null (not false)", async () => {
  const cases: Array<[unknown, boolean | null]> = [
    ["true", true],
    ["TRUE", true],
    ["1", true],
    ["false", false],
    ["0", false],
    [true, true],
    ["", null],
    ["  ", null],
    ["maybe", null],
    [42, null],
  ];
  for (const [raw, expected] of cases) {
    const { pool } = stubPool([row({ display_on: raw })]);
    const [d] = await new ReadQueries(pool).remediationDevices();
    assert.equal(d!.displayOn, expected, `display_on=${JSON.stringify(raw)}`);
  }
});

test("blank schedule strings are absent, not empty values", async () => {
  const { pool } = stubPool([row({ turn_on_time: "", turn_off_time: "   ", timezone: "" })]);
  const [d] = await new ReadQueries(pool).remediationDevices();
  assert.equal(d!.turnOnTime, null);
  assert.equal(d!.turnOffTime, null);
  assert.equal(d!.timezone, null);
});

test("a genuinely dark row shapes to dark evidence", async () => {
  const { pool } = stubPool([
    row({ brightness_raw: "0", current_brightness_raw: "0", display_on: "false" }),
  ]);
  const [d] = await new ReadQueries(pool).remediationDevices();
  assert.equal(d!.currentBrightnessRaw, 0);
  assert.equal(d!.displayOn, false);
});
