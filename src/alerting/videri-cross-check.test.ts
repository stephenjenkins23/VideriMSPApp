/**
 * Cross-check observability tests — `node --test dist/alerting/videri-cross-check.test.js`
 *
 * WHAT THIS PINS, AND WHY IT IS NOT A TEST OF THE COMPARISON
 *
 * This lane used to log its verdict and persist nothing: no poller_runs row, no
 * table of its own. `poller_runs` therefore held ZERO rows for it — and a claim
 * was once made from that zero that the lane "has never run once". It is not
 * evidence of that. With no `record()` call, zero rows is evidence WE CANNOT
 * TELL. So the properties worth pinning are the ones that keep the new run row
 * from lying in the same direction:
 *
 *   - it records under its OWN name, `alert-cross-check`, never a sibling's;
 *   - a zero that means "we compared and nothing disagreed" is distinguishable
 *     from a zero that means "we could not look" — in the run row AND in the log
 *     line, which previously printed "0 agreement(s)" over a failed read;
 *   - the two counts that are zero BY NATURE (no device is contacted, no row is
 *     written) say so, so nobody reads them as a collapse;
 *   - `telemetryYield` is null, not 0.0.
 *
 * Fake http and a fake pool. No credential, no platform, no database.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { VideriHttp } from "../videri/http.js";
import {
  crossCheckVideriAlerts,
  renderCrossCheck,
  toPollerRun,
  CROSS_CHECK_POLLER,
} from "./videri-cross-check.js";

interface TheirAlert {
  canvasId?: string;
  alertType?: string;
  canvasName?: string;
  isResolved?: boolean;
}

/** An http client that returns one page of Videri alerts, or throws. */
function fakeHttp(alerts: TheirAlert[] | Error): VideriHttp {
  return {
    async request() {
      if (alerts instanceof Error) throw alerts;
      return { data: alerts };
    },
  } as unknown as VideriHttp;
}

/** A pool that returns our open alerts, or throws. */
function fakePool(ours: Array<{ device_id: string; rule_id: string }> | Error): Pool {
  return {
    async query() {
      if (ours instanceof Error) throw ours;
      return { rows: ours, rowCount: ours.length };
    },
  } as unknown as Pool;
}

/** A monotonic clock, so durationMs is asserted rather than hoped for. */
function clock(stepMs: number): () => number {
  let t = 1_000;
  return () => {
    const now = t;
    t += stepMs;
    return now;
  };
}

// ─── it records under its own name ───────────────────────────────────────────

test("the run is recorded under the lane's own name", async () => {
  // The name exists once, as a constant shared with the scheduler task, because
  // a lane recording under a sibling's name is silent: the SQL works, the row
  // lands, and the counts belong to the wrong lane.
  assert.equal(CROSS_CHECK_POLLER, "alert-cross-check");

  const result = await crossCheckVideriAlerts(fakeHttp([]), fakePool([]));
  assert.equal(toPollerRun(result).poller, "alert-cross-check");
});

test("the recorded name is not any other lane's", () => {
  // Guards the specific swap this project has already had: a retention change
  // that handed one label another's statement.
  const run = toPollerRun({
    ranAt: new Date(), durationMs: 1, completed: true, videriOpenAlerts: 0,
    devicesCompared: 0, theyFlagWeDoNot: [], weFlagTheyDoNot: [], agreements: 0,
    unknownAlertTypes: [], errors: [],
  });
  for (const other of ["retention", "prune-raw", "alerting", "status", "metrics"]) {
    assert.notEqual(run.poller, other);
  }
});

// ─── zero-by-nature vs zero-because-we-could-not-look ────────────────────────

test("a completed comparison with nothing to disagree about is a MEASURED zero", async () => {
  const result = await crossCheckVideriAlerts(fakeHttp([]), fakePool([]), clock(40));
  const run = toPollerRun(result);

  assert.equal(result.completed, true);
  // The distinguishing field: one comparison pass succeeded.
  assert.equal(run.batchesOk, 1, "a completed comparison must show a successful batch");
  assert.equal(run.batchesFailed, 0);
  assert.equal(run.durationMs, 40, "a run must be timed");
  assert.ok(
    run.errors.some((e) => /0 agreement\(s\)/.test(e)),
    `the verdict must be findable in the run row: ${JSON.stringify(run.errors)}`,
  );
});

test("a failed read is UNKNOWN, not a clean bill of health", async () => {
  const result = await crossCheckVideriAlerts(
    fakeHttp(new Error("503 from alerting service")),
    fakePool([]),
    clock(70),
  );
  const run = toPollerRun(result);

  assert.equal(result.completed, false);
  // Same shape as a clean run in every count — which is exactly why batchesOk
  // has to carry the difference.
  assert.equal(run.batchesOk, 0, "nothing was compared, so no batch succeeded");
  assert.equal(run.batchesFailed, 1);
  assert.equal(run.durationMs, 70, "a failed run is still a run and is still timed");
  assert.ok(run.errors.some((e) => /503 from alerting service/.test(e)));
  assert.ok(
    run.errors.some((e) => /UNKNOWN rather than zero/.test(e)),
    `the run row must say the counts are unknown: ${JSON.stringify(run.errors)}`,
  );
  // And it must NOT claim agreement.
  assert.ok(!run.errors.some((e) => /agreement\(s\)/.test(e)));
});

test("the two zeros differ in the run row, not merely in prose", async () => {
  const clean = toPollerRun(await crossCheckVideriAlerts(fakeHttp([]), fakePool([])));
  const blind = toPollerRun(
    await crossCheckVideriAlerts(fakeHttp(new Error("timeout")), fakePool([])),
  );

  // Identical where they must be…
  assert.equal(clean.rowsWritten, blind.rowsWritten);
  assert.equal(clean.devicesTargeted, blind.devicesTargeted);
  // …and different where it counts.
  assert.notDeepEqual(
    [clean.batchesOk, clean.batchesFailed],
    [blind.batchesOk, blind.batchesFailed],
    "a measured zero and an unknown must not produce the same run row",
  );
});

test("our own alerts failing to read is recorded, not thrown", async () => {
  // A thrown lane records nothing, which is indistinguishable from a lane that
  // never ran — the exact fault this change closes.
  const result = await crossCheckVideriAlerts(
    fakeHttp([{ canvasId: "d1", alertType: "offline" }]),
    fakePool(new Error("connection terminated")),
  );
  const run = toPollerRun(result);

  assert.equal(result.completed, false);
  assert.equal(run.batchesOk, 0);
  assert.ok(run.errors.some((e) => /could not read our own alerts/.test(e)));
});

// ─── honest counts ───────────────────────────────────────────────────────────

test("devicesTargeted and rowsWritten are 0 BY NATURE, and the row says so", async () => {
  const result = await crossCheckVideriAlerts(
    fakeHttp([
      { canvasId: "d1", alertType: "offline" },
      { canvasId: "d2", alertType: "showingLogo" },
    ]),
    fakePool([{ device_id: "d1", rule_id: "offline-4h" }]),
  );
  const run = toPollerRun(result);

  // It contacts no device and persists nothing; both columns are NOT NULL
  // integers, so the meaning of the zero has to be carried as a note.
  assert.equal(run.devicesTargeted, 0);
  assert.equal(run.rowsWritten, 0);
  assert.ok(
    run.errors.some((e) => /0 by nature, not by failure/.test(e)),
    `the zeros must be explained: ${JSON.stringify(run.errors)}`,
  );
  // The real coverage figure is reported as what it is, never as devicesTargeted.
  assert.equal(result.devicesCompared, 2);
  assert.ok(run.errors.some((e) => /compared 2 device\(s\)/.test(e)));
});

test("telemetryYield is null, never 0.0", async () => {
  // 0.0 would read as "collected nothing"; this lane collects no telemetry at
  // all, which is a different claim.
  const run = toPollerRun(await crossCheckVideriAlerts(fakeHttp([]), fakePool([])));
  assert.equal(run.telemetryYield, null);
});

test("a disagreement is findable in the run row afterwards", async () => {
  // Until now the verdict existed only in stdout, so the next morning it was
  // gone. poller_runs is the only per-cycle record we keep.
  const result = await crossCheckVideriAlerts(
    fakeHttp([{ canvasId: "d9", alertType: "offline", canvasName: "Lobby" }]),
    fakePool([{ device_id: "d7", rule_id: "showing-logo" }]),
  );
  const run = toPollerRun(result);

  assert.equal(result.theyFlagWeDoNot.length, 1);
  assert.equal(result.weFlagTheyDoNot.length, 1);
  assert.ok(run.errors.some((e) => /Videri flags and we do not/.test(e)));
  assert.ok(run.errors.some((e) => /we flag and Videri does not/.test(e)));
});

test("an alert type we do not model is recorded, not just printed", async () => {
  const result = await crossCheckVideriAlerts(
    fakeHttp([{ canvasId: "d1", alertType: "someNewCondition" }]),
    fakePool([]),
  );
  const run = toPollerRun(result);
  assert.deepEqual(result.unknownAlertTypes, ["someNewCondition"]);
  assert.ok(run.errors.some((e) => /alert type\(s\) we do not model: someNewCondition/.test(e)));
});

// ─── the log line must not lie either ────────────────────────────────────────

test("the log line for an incomplete run does not print zeros as findings", async () => {
  // It used to render "0 open Videri alert(s) · 0 agreement(s) · 0 they-only ·
  // 0 we-only" with the error underneath — a clean bill of health over a read
  // that never happened.
  const blind = await crossCheckVideriAlerts(fakeHttp(new Error("timeout")), fakePool([]));
  const rendered = renderCrossCheck(blind);

  assert.ok(/DID NOT COMPLETE/.test(rendered), rendered);
  assert.ok(!/agreement\(s\)/.test(rendered), rendered);
  assert.ok(/timeout/.test(rendered), "the reason must still be printed");
});

test("the log line for a completed run still reports the verdict", async () => {
  const clean = await crossCheckVideriAlerts(
    fakeHttp([{ canvasId: "d1", alertType: "offline" }]),
    fakePool([{ device_id: "d1", rule_id: "offline-30m" }]),
  );
  const rendered = renderCrossCheck(clean);
  assert.ok(/1 agreement\(s\)/.test(rendered), rendered);
  assert.ok(!/DID NOT COMPLETE/.test(rendered), rendered);
});
