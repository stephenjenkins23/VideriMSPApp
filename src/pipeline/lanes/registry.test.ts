/**
 * Lane registry tests — `node --test dist/pipeline/lanes/registry.test.js`
 *
 * The registry exists because a hand-written mirror of the scheduler drifted and
 * hid two real failures. So these tests are about the mechanism that makes drift
 * impossible rather than about any single lane: importing `run-poller.ts` builds
 * a real pool and starts a daemon, so the drift check is the only part of that
 * wiring a test can reach, and it has to be reachable.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LANE_NAMES,
  LANE_REGISTRY,
  assertSchedulerMatchesRegistry,
  laneDecl,
  laneIntervalMs,
  laneIntervalSeconds,
  laneOptInState,
  laneRegistryDrift,
  laneTableSources,
} from "./registry.js";

/** The real task list's shape, as `run-poller.ts` hands it over. */
const task = (name: string, intervalMs: number) => ({ name, intervalMs });

test("every declared lane has a name, an interval and a way to be observed", () => {
  assert.equal(LANE_REGISTRY.length, LANE_NAMES.length);
  for (const decl of LANE_REGISTRY) {
    assert.ok(LANE_NAMES.includes(decl.lane), `${decl.lane} must be in LANE_NAMES`);
    assert.ok(laneIntervalMs(decl, {}) > 0, `${decl.lane} needs a positive interval`);
    assert.ok(decl.feeds.length > 0, `${decl.lane} must say what goes stale without it`);
    // The field that closes the hole: a lane with no declared observability
    // could silently be assessed as if it recorded runs when it does not.
    assert.ok(decl.observability.kind, `${decl.lane} must declare its observability`);
    if (decl.observability.kind !== "poller-runs") {
      assert.ok(
        decl.observability.why.length > 0,
        `${decl.lane} must explain why it is not in poller_runs`,
      );
    }
  }
});

test("the four lanes that drifted out of the old roster are declared, with how to see them", () => {
  // `snapshot` writes no run row but one fleet_snapshots row per cycle, so it is
  // measurable from its own output. The other three leave no trace at all and
  // must say so rather than be assessed as if they did.
  assert.deepEqual(laneDecl("snapshot")?.observability, {
    kind: "table",
    table: "fleet_snapshots",
    timeColumn: "computed_at",
    why: "it writes one row per successful cycle, so its own output dates every run",
  });
  // These three were `none` until they were given a record() call. The point of
  // pinning them now is the opposite of before: a regression that removed the
  // recording would make them unobservable again, and the last time that was
  // true their silence got read as "never ran".
  for (const lane of ["alert-cross-check", "retention", "prune-raw"]) {
    assert.equal(
      laneDecl(lane)?.observability.kind, "poller-runs",
      `${lane} records a poller_runs row, so its silence is measurable`,
    );
    assert.equal(
      laneDecl(lane)?.zeroRowsIsNormal, true,
      `${lane} writes no rows by design, so 0 rows_written must not read as a stall`,
    );
  }
});

test("no lane is declared twice, which would make the health roster ambiguous", () => {
  assert.equal(new Set(LANE_NAMES).size, LANE_NAMES.length);
});

test("a matching task list produces no drift", () => {
  const tasks = LANE_REGISTRY.map((d) => task(d.lane, laneIntervalMs(d, {})));
  assert.deepEqual(laneRegistryDrift(tasks, {}), []);
  assertSchedulerMatchesRegistry(tasks, {});
});

test("an undeclared lane is drift, and the daemon refuses to start", () => {
  assert.throws(
    () => assertSchedulerMatchesRegistry([task("mystery-lane", 60_000)], {}),
    /mystery-lane.*not declared in the lane registry/s,
  );
});

test("a tuned interval that was not declared is drift, with the factor named", () => {
  // Why this must throw rather than warn: coverage thresholds are multiples of
  // the DECLARED interval, so silent divergence misreports the lane by exactly
  // this factor — and the previous failure mode was silence for weeks.
  const drift = laneRegistryDrift([task("snapshot", 10 * 60_000)], {});
  assert.equal(drift.length, 1);
  assert.match(drift[0]!.problem, /factor of 2\.00/);
});

test("factory-built lanes are covered by the boot check, since the type check cannot see them", () => {
  // `dataUsageTask` and `aiJobTasks` build their own tasks in other modules, so
  // `laneTask`'s LaneName parameter never sees them.
  for (const [lane, intervalMs] of [
    ["data-usage", 24 * 60 * 60_000],
    ["ai-brief", 24 * 60 * 60_000],
    ["ai-action-plan", 8 * 60 * 60_000],
  ] as const) {
    assert.deepEqual(laneRegistryDrift([task(lane, intervalMs)], {}), [], `${lane} must agree`);
  }
});

test("env-driven intervals are resolved from the environment given, not the process", () => {
  const status = laneDecl("status")!;
  assert.equal(laneIntervalSeconds(status, {}), 120, "config.ts's documented default");
  assert.equal(laneIntervalSeconds(status, { POLL_STATUS_INTERVAL_MS: "30000" }), 30);
  // A junk value falls back to the default rather than throwing: config.ts
  // validates the env and would already have refused to start, and a bad
  // interval must never be able to take the health report down with it.
  assert.equal(laneIntervalSeconds(status, { POLL_STATUS_INTERVAL_MS: "nonsense" }), 120);
  assert.equal(laneIntervalSeconds(status, { POLL_STATUS_INTERVAL_MS: "-5" }), 120);
});

test("opt-in polarity: the one default-ON flag is read as on when unset", () => {
  // Getting this backwards once made the self-check go quiet about the exact
  // starvation it exists to catch.
  const dataUsage = laneDecl("data-usage")!;
  assert.equal(laneOptInState(dataUsage, {}), true, "unset means ENABLED for this flag");
  assert.equal(laneOptInState(dataUsage, { ENABLE_DATA_USAGE_POLL: "false" }), false);
  assert.equal(laneOptInState(dataUsage, { ENABLE_DATA_USAGE_POLL: "true" }), true);
});

test("opt-in polarity: an off-by-default flag left unset is UNKNOWABLE, not off", () => {
  // The asymmetry is the point: the flag may be unset in the process asking and
  // set for the poller, so "off by choice" is a guess we refuse to make.
  const verify = laneDecl("screen-verify-slowlane")!;
  assert.equal(laneOptInState(verify, {}), undefined);
  assert.equal(laneOptInState(verify, { ENABLE_SCREEN_VERIFY: "true" }), true);
  assert.equal(laneOptInState(verify, { ENABLE_SCREEN_VERIFY: "false" }), false);
});

test("a lane with no flag has no opt-in state to report", () => {
  assert.equal(laneOptInState(laneDecl("devices")!, { ENABLE_SCREEN_VERIFY: "true" }), undefined);
});

test("table sources are enumerable, so the coverage read needs no hardcoded table list", () => {
  assert.deepEqual(laneTableSources(), [
    { lane: "snapshot", table: "fleet_snapshots", timeColumn: "computed_at" },
  ]);
});
