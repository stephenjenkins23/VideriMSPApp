/**
 * Proof-of-play engine tests — `node --test dist/intelligence/proof-of-play.test.js`
 *
 * Two invariants carry the whole surface and are tested hardest:
 *
 *   1. The window evaluator is correct against REAL dayparts (bounded windows,
 *      midnight wrap, absolute timestamps) as well as the degenerate always-on
 *      windows the demo tenant actually has — because "scheduled now" must be a
 *      real evaluation of a window against a time, not a shortcut that trusts the
 *      demo data.
 *
 *   2. A gap is NEVER asserted from a missing reading. An unread panel is
 *      "screen-state unknown", not a black one — the honest-null rule. There is a
 *      dedicated test proving an all-null screen with an active schedule yields no
 *      gap.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assemblePersistedProofOfPlay,
  detectGaps,
  scheduledNow,
  windowCoversAt,
  type PersistedScheduleRow,
  type PopDevice,
  type ScheduledEvent,
  type ScreenState,
} from "./proof-of-play.js";

const ev = (over: Partial<ScheduledEvent> = {}): ScheduledEvent => ({
  assetUuid: "asset-1",
  assetType: "image",
  durationMs: 10_000,
  startTime: null,
  endTime: null,
  priority: 1,
  frequency: "loop",
  ...over,
});

const at = (iso: string) => new Date(iso);

// ─── window evaluation ────────────────────────────────────────────────────────

test("always-on window (no bounds) covers any instant — the degenerate demo case", () => {
  assert.equal(windowCoversAt(ev(), at("2026-08-31T03:00:00Z")), true);
  assert.equal(windowCoversAt(ev(), at("2026-08-31T23:59:00Z")), true);
});

test("empty-string bounds are treated as open, not as a real window", () => {
  assert.equal(windowCoversAt(ev({ startTime: "", endTime: "" }), at("2026-08-31T12:00:00Z")), true);
});

test("zero-width time-of-day window (start === end) is read as always-on", () => {
  // How the demo encodes 24/7: 00:00 → 00:00.
  const e = ev({ startTime: "00:00", endTime: "00:00" });
  assert.equal(windowCoversAt(e, at("2026-08-31T09:00:00Z")), true);
  assert.equal(windowCoversAt(e, at("2026-08-31T21:00:00Z")), true);
});

test("a real daypart covers times inside and excludes times outside", () => {
  const e = ev({ startTime: "08:00", endTime: "18:00" });
  assert.equal(windowCoversAt(e, at("2026-08-31T12:00:00Z")), true);
  assert.equal(windowCoversAt(e, at("2026-08-31T07:59:00Z")), false);
  assert.equal(windowCoversAt(e, at("2026-08-31T18:30:00Z")), false);
});

test("a daypart that wraps past midnight is covered on both sides of the seam", () => {
  const e = ev({ startTime: "22:00", endTime: "02:00" });
  assert.equal(windowCoversAt(e, at("2026-08-31T23:30:00Z")), true);
  assert.equal(windowCoversAt(e, at("2026-08-31T01:00:00Z")), true);
  assert.equal(windowCoversAt(e, at("2026-08-31T12:00:00Z")), false);
});

test("an open-ended daypart (start only) runs to end of day", () => {
  const e = ev({ startTime: "20:00", endTime: null });
  assert.equal(windowCoversAt(e, at("2026-08-31T21:00:00Z")), true);
  assert.equal(windowCoversAt(e, at("2026-08-31T10:00:00Z")), false);
});

test("absolute ISO-timestamp bounds compare on absolute time", () => {
  const e = ev({ startTime: "2026-08-31T08:00:00Z", endTime: "2026-08-31T18:00:00Z" });
  assert.equal(windowCoversAt(e, at("2026-08-31T12:00:00Z")), true);
  assert.equal(windowCoversAt(e, at("2026-09-01T12:00:00Z")), false);
  assert.equal(windowCoversAt(e, at("2026-08-30T12:00:00Z")), false);
});

test('"24:00" end is accepted as end-of-day', () => {
  const e = ev({ startTime: "06:00", endTime: "24:00" });
  assert.equal(windowCoversAt(e, at("2026-08-31T23:59:00Z")), true);
});

test("scheduledNow filters a mixed set to only the active windows", () => {
  const events = [
    ev({ assetUuid: "on", startTime: "08:00", endTime: "18:00" }),
    ev({ assetUuid: "off", startTime: "19:00", endTime: "22:00" }),
    ev({ assetUuid: "always", startTime: null, endTime: null }),
  ];
  const active = scheduledNow(events, at("2026-08-31T12:00:00Z")).map((e) => e.assetUuid);
  assert.deepEqual(active.sort(), ["always", "on"]);
});

// ─── gap detection ────────────────────────────────────────────────────────────

const screen = (over: Partial<ScreenState> = {}): ScreenState => ({
  isScreenOn: true,
  isBlackScreen: false,
  showingLogo: false,
  ...over,
});

const dev = (over: Partial<PopDevice> = {}): PopDevice => ({
  deviceId: "d1",
  deviceLabel: "Lobby North",
  scheduled: [ev()],
  screen: screen(),
  ...over,
});

test("scheduled + healthy screen is not a gap (scheduled, not confirmed)", () => {
  const report = detectGaps([dev()]);
  assert.equal(report.summary.devicesWithSchedule, 1);
  assert.equal(report.summary.gaps, 0);
  assert.equal(report.devices[0]!.gap, false);
});

test("scheduled + screen off is a gap, reason 'screen off'", () => {
  const report = detectGaps([dev({ screen: screen({ isScreenOn: false }) })]);
  assert.equal(report.devices[0]!.gap, true);
  assert.equal(report.devices[0]!.reason, "screen off");
  assert.equal(report.summary.gaps, 1);
  assert.equal(report.summary.byReason["screen off"], 1);
});

test("scheduled + black screen is a gap, reason 'screen black'", () => {
  const report = detectGaps([dev({ screen: screen({ isBlackScreen: true }) })]);
  assert.equal(report.devices[0]!.reason, "screen black");
  assert.equal(report.summary.byReason["screen black"], 1);
});

test("scheduled + logo fallback is a gap, reason 'screen logo'", () => {
  const report = detectGaps([dev({ screen: screen({ showingLogo: true }) })]);
  assert.equal(report.devices[0]!.reason, "screen logo");
  assert.equal(report.summary.byReason["screen logo"], 1);
});

test("the most fundamental fault wins: off is reported over black over logo", () => {
  const report = detectGaps([
    dev({ screen: screen({ isScreenOn: false, isBlackScreen: true, showingLogo: true }) }),
  ]);
  assert.equal(report.devices[0]!.reason, "screen off");
});

test("HONEST NULL: scheduled + all-null screen asserts NO gap, reports unknown", () => {
  const report = detectGaps([
    dev({ screen: { isScreenOn: null, isBlackScreen: null, showingLogo: null } }),
  ]);
  assert.equal(report.devices[0]!.gap, false, "an unread panel is never a gap");
  assert.equal(report.devices[0]!.screenStateKnown, false);
  assert.equal(report.summary.gaps, 0);
  assert.equal(report.summary.screenStateUnknown, 1);
  assert.equal(report.summary.devicesWithSchedule, 1);
});

test("a partial reading (black null but logo true) still fires on the known signal", () => {
  const report = detectGaps([
    dev({ screen: { isScreenOn: null, isBlackScreen: null, showingLogo: true } }),
  ]);
  assert.equal(report.devices[0]!.gap, true);
  assert.equal(report.devices[0]!.reason, "screen logo");
});

test("no active schedule → not counted as with-schedule and never a gap", () => {
  const report = detectGaps([
    dev({ scheduled: [], screen: screen({ isBlackScreen: true }) }),
  ]);
  assert.equal(report.summary.devicesWithSchedule, 0);
  assert.equal(report.summary.gaps, 0);
  assert.equal(report.devices[0]!.gap, false);
});

test("summary aggregates across a mixed fleet", () => {
  const report = detectGaps([
    dev({ deviceId: "a", screen: screen() }), // healthy, scheduled
    dev({ deviceId: "b", screen: screen({ isBlackScreen: true }) }), // gap: black
    dev({ deviceId: "c", screen: screen({ showingLogo: true }) }), // gap: logo
    dev({ deviceId: "d", screen: { isScreenOn: null, isBlackScreen: null, showingLogo: null } }), // unknown
    dev({ deviceId: "e", scheduled: [] }), // no schedule
  ]);
  assert.equal(report.summary.devicesWithSchedule, 4);
  assert.equal(report.summary.gaps, 2);
  assert.equal(report.summary.byReason["screen black"], 1);
  assert.equal(report.summary.byReason["screen logo"], 1);
  assert.equal(report.summary.screenStateUnknown, 1);
});

test("an empty fleet is an empty report, not an error", () => {
  const report = detectGaps([]);
  assert.deepEqual(report.devices, []);
  assert.equal(report.summary.devicesWithSchedule, 0);
  assert.equal(report.summary.gaps, 0);
});

// ── assemblePersistedProofOfPlay (US-4.5 fleet-wide persisted path) ───────────

const persistedRow = (over: Partial<PersistedScheduleRow> = {}): PersistedScheduleRow => ({
  id: "canvas-1",
  name: "Lobby North",
  scheduledItems: [ev()],
  fetchedAt: "2026-08-31T12:00:00.000Z",
  isScreenOn: true,
  isBlackScreen: false,
  showingLogo: false,
  ...over,
});

test("assemblePersistedProofOfPlay maps rows into gap-detector inputs verbatim", () => {
  const { devices } = assemblePersistedProofOfPlay(
    [persistedRow({ id: "a", name: null, scheduledItems: [ev(), ev()] })],
    10,
  );
  assert.equal(devices.length, 1);
  assert.equal(devices[0]!.deviceId, "a");
  assert.equal(devices[0]!.deviceLabel, "a"); // name null → falls back to id
  // scheduledItems pass straight through — the slow lane already filtered to now.
  assert.equal(devices[0]!.scheduled.length, 2);
  // Feeding the result to detectGaps produces a real report.
  const report = detectGaps(devices);
  assert.equal(report.summary.devicesWithSchedule, 1);
});

test("assemblePersistedProofOfPlay reports honest coverage against the fleet", () => {
  const { coverage } = assemblePersistedProofOfPlay(
    [persistedRow({ id: "a" }), persistedRow({ id: "b" })],
    8,
  );
  assert.equal(coverage.fleetDevices, 8);
  assert.equal(coverage.withPersistedSchedule, 2);
  assert.equal(coverage.coveragePct, 0.25);
});

test("assemblePersistedProofOfPlay never fabricates a 0/0 coverage ratio", () => {
  const { coverage } = assemblePersistedProofOfPlay([], 0);
  assert.equal(coverage.withPersistedSchedule, 0);
  assert.equal(coverage.coveragePct, null); // honest null, never 0 dressed as data
});

test("assemblePersistedProofOfPlay carries the snapshot age envelope", () => {
  const { staleness } = assemblePersistedProofOfPlay(
    [
      persistedRow({ id: "old", fetchedAt: "2026-08-31T09:00:00.000Z" }),
      persistedRow({ id: "new", fetchedAt: "2026-08-31T15:00:00.000Z" }),
      persistedRow({ id: "mid", fetchedAt: "2026-08-31T12:00:00.000Z" }),
    ],
    3,
  );
  assert.equal(staleness.oldestFetchedAt, "2026-08-31T09:00:00.000Z");
  assert.equal(staleness.newestFetchedAt, "2026-08-31T15:00:00.000Z");
});
