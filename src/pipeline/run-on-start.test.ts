/**
 * `runOnStart` contract tests — `node --test dist/pipeline/run-on-start.test.js`
 *
 * WHY THIS FILE EXISTS, AND WHAT IT DOES NOT COVER
 *
 * The data-usage lane was recently changed from `runOnStart: false` to `true`
 * with a 20-hour last-run gate inside the handler, because a 24h interval plus
 * no start-up run meant the lane never fired at all on a daemon that restarts
 * more often than daily (pipeline-health measured 48.8h since the last run
 * against a 24.3h cadence).
 *
 * That fix has two halves. The GATE half lives inline in `src/pipeline/run-poller.ts`,
 * which exports nothing and, at import time, opens a real pool, seeds the rules
 * and template tables and starts the scheduler — so it cannot be imported by a
 * test at all, and nothing here covers the skip/run decision. See the report
 * accompanying this file for the smallest refactor that would make it testable.
 *
 * The half that IS testable is the one the fix rests on: that `start()` really
 * does invoke a `runOnStart` task immediately, exactly ONCE, and still honours
 * `false` for the lanes that must not fire on a restart (every paid or expensive
 * lane depends on that). None of it was pinned. `pipeline.test.ts` covers
 * `runOnce`, overlap, teardown and event-loop retention, but never whether the
 * start-up invocation happens.
 *
 * Pure timers and counters. No pollers, no database, no device.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Scheduler, type Task } from "./scheduler.js";

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A far-future interval, so anything that fires can only be the start-up run. */
const NEVER_AGAIN = 50_000;

interface Counted {
  tasks: Task[];
  counts: Record<string, number>;
}

/** Tasks that only count their invocations. Index order is preserved (jitter). */
function counted(specs: Array<{ name: string; runOnStart?: boolean }>): Counted {
  const counts: Record<string, number> = {};
  const tasks = specs.map((spec) => {
    counts[spec.name] = 0;
    const task: Task = {
      name: spec.name,
      intervalMs: NEVER_AGAIN,
      handler: async () => { counts[spec.name] = (counts[spec.name] ?? 0) + 1; },
      ...(spec.runOnStart === undefined ? {} : { runOnStart: spec.runOnStart }),
    };
    return task;
  });
  return { tasks, counts };
}

test("runOnStart:true fires the lane immediately, which is the whole point of the data-usage fix", async () => {
  // Without this, a lane on a 24h interval simply never runs on a daemon that
  // restarts more often than once a day.
  const { tasks, counts } = counted([{ name: "data-usage", runOnStart: true }]);
  const scheduler = new Scheduler(tasks, silent, false);

  scheduler.start();
  await sleep(40);
  assert.equal(counts["data-usage"], 1, "a runOnStart lane must fire at startup");
  await scheduler.stop();
});

test("start-up fires the lane exactly ONCE, not once per timer registered", async () => {
  // `start()` registers both an immediate timer and the repeating one. If the
  // repeating path also fired straight away, every restart would double the work
  // — 249 devices re-polled twice, which is what the in-handler gate exists to
  // prevent in the first place.
  const { tasks, counts } = counted([{ name: "data-usage", runOnStart: true }]);
  const scheduler = new Scheduler(tasks, silent, false);

  scheduler.start();
  await sleep(60);
  assert.equal(counts["data-usage"], 1);
  await scheduler.stop();
});

test("an omitted runOnStart fires too — `false` is a deliberate opt-out, not the default", async () => {
  // Most collection lanes omit the flag and are expected to fire on start; the
  // expensive and paid ones set it false explicitly.
  const { tasks, counts } = counted([{ name: "devices" }]);
  const scheduler = new Scheduler(tasks, silent, false);

  scheduler.start();
  await sleep(40);
  assert.equal(counts["devices"], 1, "the default must be to collect on start");
  await scheduler.stop();
});

test("runOnStart:false is honoured: a restart must not fire an expensive or paid lane", async () => {
  const { tasks, counts } = counted([{ name: "ai-brief", runOnStart: false }]);
  const scheduler = new Scheduler(tasks, silent, false);

  scheduler.start();
  await sleep(40);
  assert.equal(counts["ai-brief"], 0, "a restart loop must not spend money or re-poll the fleet");
  await scheduler.stop();
});

test("start-up runs are per-task, so one gated lane cannot drag another in with it", async () => {
  const { tasks, counts } = counted([
    { name: "data-usage", runOnStart: true },
    { name: "ai-brief", runOnStart: false },
    { name: "alerting", runOnStart: false },
  ]);
  const scheduler = new Scheduler(tasks, silent, false);

  scheduler.start();
  await sleep(80);
  assert.deepEqual(counts, { "data-usage": 1, "ai-brief": 0, alerting: 0 });
  await scheduler.stop();
});

test("`--once` mode ignores runOnStart, so a cron pass runs every lane", async () => {
  // `npm run poll -- --once` is the container/cron mode. If it honoured
  // runOnStart:false, a cron deployment would silently never evaluate alerts.
  const { tasks, counts } = counted([
    { name: "data-usage", runOnStart: true },
    { name: "alerting", runOnStart: false },
  ]);
  const scheduler = new Scheduler(tasks, silent, false);

  await scheduler.runOnce();
  assert.deepEqual(counts, { "data-usage": 1, alerting: 1 });
});
