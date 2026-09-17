/**
 * Lane wiring tests — `node --test dist/pipeline/run-poller.test.js`
 *
 * WHY STATIC, AND WHAT THAT BUYS
 *
 * `run-poller.ts` exports nothing and, at import time, opens a real pool, builds
 * an auth client and starts a scheduler — importing it from a test starts a
 * daemon, so the handler logic lives in modules that CAN be imported
 * (`db/retention.ts`, `alerting/videri-cross-check.ts`, `lanes/data-usage.ts`)
 * and is unit-tested there. What cannot be tested that way is the one thing left
 * in the entrypoint: which recorder each lane's handler calls.
 *
 * That is worth pinning by text, over the COMPILED artifact the daemon actually
 * runs, following the precedent in `ai/scheduled.test.ts`. The failure it
 * catches is specific and has happened here before: a previous retention change
 * swapped two labels so a `run("poller_runs", …)` call executed the
 * `fleet_snapshots` DELETE. The SQL worked, nothing errored, and the counts
 * lied. `laneTask("prune-raw", { handler: … runRetentionLane … })` would be
 * exactly as quiet — every lane still runs, every row still lands, and one lane
 * reports the other's work.
 *
 * This asserts nothing about behaviour. No pool, no scheduler, no database.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** The compiled entrypoint, read as text — never imported. */
const source = (): string =>
  readFileSync(new URL("./run-poller.js", import.meta.url), "utf8");

/**
 * The slice of the task list between one lane's declaration and the next.
 *
 * Fails loudly if a marker is missing rather than passing on an empty string: a
 * harness that quietly stops testing is the failure mode this file exists to
 * prevent.
 */
function laneBlock(src: string, lane: string, until: string | null): string {
  const start = src.indexOf(`laneTask("${lane}"`);
  assert.notEqual(start, -1, `run-poller.js no longer declares laneTask("${lane}") — update this test`);
  if (until === null) return src.slice(start);
  const end = src.indexOf(`laneTask("${until}"`, start);
  assert.notEqual(end, -1, `expected laneTask("${until}") after ${lane} — update this test`);
  return src.slice(start, end);
}

/** lane → [the recorder it must call, the recorders it must NOT call]. */
const WIRING: Array<[lane: string, until: string | null, own: string, foreign: string[]]> = [
  ["alert-cross-check", "device-settings", "crossCheckRun", ["runRetentionLane", "runPruneRawLane"]],
  ["retention", "prune-raw", "runRetentionLane", ["runPruneRawLane", "crossCheckRun"]],
  ["prune-raw", null, "runPruneRawLane", ["runRetentionLane", "crossCheckRun"]],
];

test("each of the three lanes is wired to its OWN recorder, not a sibling's", () => {
  const src = source();
  for (const [lane, until, own, foreign] of WIRING) {
    const block = laneBlock(src, lane, until);
    assert.match(block, new RegExp(`\\b${own}\\b`), `the ${lane} lane must call ${own}`);
    for (const other of foreign) {
      assert.doesNotMatch(
        block, new RegExp(`\\b${other}\\b`),
        `the ${lane} lane must not call ${other} — that is the label swap this guards`,
      );
    }
  }
});

test("all three lanes record a run; none of them is record-free any more", () => {
  // The fault being closed: these three called no `record()` and wrote no table,
  // so poller_runs held zero rows for them. Zero rows for a lane that never
  // records is evidence WE CANNOT TELL whether it ran — not evidence it never
  // ran, which is a claim this project has already had to retract once.
  const src = source();

  // The cross-check records inline, through the shared `record()` helper.
  assert.match(laneBlock(src, "alert-cross-check", "device-settings"), /record\(crossCheckRun\(/);
  // The prune lanes record inside their own module, which is handed `record`.
  for (const [lane, until] of [["retention", "prune-raw"], ["prune-raw", null]] as const) {
    assert.match(laneBlock(src, lane, until), /\brecord\b/, `${lane} must be handed the recorder`);
  }
});

test("the stale comments claiming these lanes record nothing are gone", () => {
  // They were accurate and are now the opposite of true. A comment that lies
  // about observability is worse than none: the last one was cited as evidence.
  const src = readFileSync(new URL("../../src/pipeline/run-poller.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /this lane records NOTHING/);
  assert.doesNotMatch(src, /both prune lanes record nothing/);
});

test("the prune lanes still prune exactly what they always did", () => {
  // Observability only. `pruneTimeSeries({})` keeps its defaults and prune-raw
  // keeps its 14-day window — the retention semantics are not this change's to
  // move, and a widened window here would silently destroy history.
  const src = source();
  assert.match(laneBlock(src, "retention", "prune-raw"), /repo\.pruneTimeSeries\(\{\}\)/);
  assert.match(laneBlock(src, "prune-raw", null), /repo\.pruneRawPayloads\(PRUNE_RAW_RETAIN_DAYS\)/);
});
