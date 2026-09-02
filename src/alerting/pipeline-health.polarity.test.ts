/**
 * REGRESSION (bug 1): the self-check went quiet about the fault it exists to catch.
 *
 * ENABLE_DATA_USAGE_POLL is the one DEFAULT-ON flag: run-poller schedules the
 * lane when it is unset, and it ships commented out in .env.example. The old code
 * skipped on `raw === undefined` BEFORE applying that polarity, so on a default
 * deployment a lane that had NEVER RUN reported `unknown`/"possibly off by
 * choice" instead of a fault, and was excluded from deviceDataAtRisk.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPipelineHealth } from "./pipeline-health.js";

const repo = { pollerRunHistory: async () => [] } as never;
const laneOf = async (env: Record<string, string>) => {
  const r = await loadPipelineHealth(repo, { env });
  return (r.lanes ?? []).find((l: { lane: string }) => l.lane === "data-usage");
};

test("default-on flag UNSET + never ran => a fault, not 'unknown'", async () => {
  const lane = await laneOf({});
  assert.equal(lane?.status, "never-ran");
});

test("default-on flag explicitly false => disabled, and never a fault", async () => {
  const lane = await laneOf({ ENABLE_DATA_USAGE_POLL: "false" });
  assert.equal(lane?.status, "disabled");
});

test("default-on flag explicitly true + never ran => still a fault", async () => {
  const lane = await laneOf({ ENABLE_DATA_USAGE_POLL: "true" });
  assert.equal(lane?.status, "never-ran");
});

test("an off-by-default flag left unset stays UNKNOWN, not a fault", async () => {
  // The asymmetry is the point: absence is unknowable for opt-in lanes, because
  // the flag may be set for the poller and not for this process.
  const r = await loadPipelineHealth(repo, { env: {} });
  const optIn = (r.lanes ?? []).find((l: { lane: string }) => l.lane === "screen-verify-slowlane");
  assert.equal(optIn?.status, "unknown");
});
