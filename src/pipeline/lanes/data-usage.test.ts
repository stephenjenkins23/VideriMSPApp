/**
 * Regression tests for the two data-usage bugs.
 *
 * Both were found by the test agent and reported rather than patched, which is
 * the right order: a test that fails because the code is wrong is worth more
 * than a test bent to pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DATA_USAGE_MIN_GAP_MS,
  dataUsageTask,
  shouldSkipDataUsage,
} from "./data-usage.js";
import type { PollerRunHistoryRow } from "../../db/repository.js";

const NOW = Date.parse("2026-09-02T12:00:00.000Z");
const run = (o: Partial<PollerRunHistoryRow> & { startedAt: Date }): PollerRunHistoryRow => ({
  poller: "data-usage", durationMs: 1, devicesTargeted: 249,
  rowsWritten: 3080, batchesOk: 249, batchesFailed: 0, telemetryYield: null, ...o,
});
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000);

test("no run on record at all: the lane must run", () => {
  const d = shouldSkipDataUsage([], NOW);
  assert.equal(d.skip, false);
  assert.match(d.reason, /no successful run/i);
});

test("a successful run an hour ago suppresses another", () => {
  const d = shouldSkipDataUsage([run({ startedAt: hoursAgo(1) })], NOW);
  assert.equal(d.skip, true);
  assert.match(d.reason, /per-day/);
});

test("a successful run older than the gap does not suppress", () => {
  assert.equal(shouldSkipDataUsage([run({ startedAt: hoursAgo(21) })], NOW).skip, false);
});

test("the boundary is exclusive on both sides", () => {
  const justInside = new Date(NOW - DATA_USAGE_MIN_GAP_MS + 1000);
  const justOutside = new Date(NOW - DATA_USAGE_MIN_GAP_MS - 1000);
  assert.equal(shouldSkipDataUsage([run({ startedAt: justInside })], NOW).skip, true);
  assert.equal(shouldSkipDataUsage([run({ startedAt: justOutside })], NOW).skip, false);
});

test("REGRESSION (bug 2): a recent run where every batch FAILED must not suppress", () => {
  // record() writes a poller_runs row even when nothing was collected, so keying
  // on recency alone let a total failure block retries for 20 hours while
  // claiming "a second run cannot produce a new row".
  const failed = run({ startedAt: hoursAgo(1), batchesOk: 0, batchesFailed: 249, rowsWritten: 0 });
  assert.equal(shouldSkipDataUsage([failed], NOW).skip, false);
});

test("REGRESSION (bug 2): a recent run that wrote zero rows must not suppress", () => {
  const empty = run({ startedAt: hoursAgo(2), rowsWritten: 0 });
  assert.equal(shouldSkipDataUsage([empty], NOW).skip, false);
});

test("a successful run is still honoured when a later failure exists", () => {
  const rows = [
    run({ startedAt: hoursAgo(1), batchesOk: 0, batchesFailed: 249, rowsWritten: 0 }),
    run({ startedAt: hoursAgo(3) }),
  ];
  assert.equal(shouldSkipDataUsage(rows, NOW).skip, true);
});

test("other lanes' runs are ignored", () => {
  const other = run({ poller: "metrics", startedAt: hoursAgo(1) });
  assert.equal(shouldSkipDataUsage([other], NOW).skip, false);
});

test("a future timestamp is refused rather than trusted", () => {
  const d = shouldSkipDataUsage([run({ startedAt: new Date(NOW + 3_600_000) })], NOW);
  assert.equal(d.skip, false);
  assert.match(d.reason, /unusable timestamp/);
});

test("the task fires on start, and polls only when it should", async () => {
  let polled = 0, recorded = 0;
  const mk = (history: PollerRunHistoryRow[]) =>
    dataUsageTask({
      history: async () => history,
      poll: async () => { polled++; return { poller: "data-usage" } as never; },
      record: async () => { recorded++; },
      now: () => NOW,
      log: () => {},
    });
  const t = mk([]);
  assert.equal(t.runOnStart, true, "must fire on start — false is how the lane starved");
  assert.equal(t.name, "data-usage");
  await t.handler();
  assert.deepEqual([polled, recorded], [1, 1]);
  polled = recorded = 0;
  await mk([run({ startedAt: hoursAgo(1) })]).handler();
  assert.deepEqual([polled, recorded], [0, 0], "a skip must not poll or record");
});
