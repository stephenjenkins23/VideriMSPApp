/**
 * Scheduled AI job tests — NO network and NO real Anthropic call anywhere here.
 *
 * The bug these guard against is not a wrong number, it is a MISSING run: the
 * brief and the plan drifted for days because nothing scheduled them, and a plan
 * that outlived a fix kept recommending work that no longer existed (docs/20
 * §D-2). So what is asserted is the wiring, not the prose:
 *
 *   1. The gate. Off (the default) means the lane is completely inert — no pool
 *      query, no Anthropic client constructed, no recorded run — and it SAYS so.
 *      Every tick costs money, so "inert while off" has to be provable.
 *   2. The failure containment. A throwing generator must not escape the tick,
 *      must be recorded as a FAILED poller run carrying the reason, and must
 *      leave the previously cached artifact alone. A stale artifact discloses its
 *      age; a clobbered one cannot.
 *   3. That the scheduled lane and the npm scripts run the SAME core. Two copies
 *      of the prompt assembly is how the two surfaces start disagreeing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import type { Pool } from "pg";
import type { PollerResult } from "../pipeline/pollers/types.js";
import {
  ACTION_PLAN_INTERVAL_MS,
  AI_JOBS_FLAG,
  BRIEF_INTERVAL_MS,
  aiJobTasks,
  runGatedAiJob,
} from "./scheduled.js";
import {
  assertPublishableBrief,
  assertPublishablePlan,
  runActionPlanJob,
  runBriefJob,
} from "./jobs.js";
import type { FleetBrief } from "./brief.js";
import type { ActionPlan } from "./action-plan.js";

/** Collects recorded runs and log lines the way the poller would. */
function harness(env: Record<string, string | undefined>) {
  const recorded: PollerResult[] = [];
  const logs: string[] = [];
  return {
    recorded,
    logs,
    deps: {
      record: async (r: PollerResult) => void recorded.push(r),
      log: (m: string) => void logs.push(m),
      env,
    },
  };
}

/** A pool that fails the test if anything queries it. Proves inertness. */
const forbiddenPool = {
  query: () => {
    throw new Error("the gated lane queried the database while the flag was off");
  },
} as unknown as Pool;

/** Records every SQL statement; answers everything with no rows. */
function recordingPool(): Pool & { sql: string[] } {
  const sql: string[] = [];
  const pool = {
    sql,
    query: async (text: string) => {
      sql.push(text);
      return { rows: [], rowCount: 0 };
    },
  };
  return pool as unknown as Pool & { sql: string[] };
}

/** A stub Anthropic client. `parsed` null ⇒ the generator throws, as in real life. */
function stubClient(parsed: unknown, opts: { throws?: string } = {}): Anthropic {
  return {
    messages: {
      parse: async () => {
        if (opts.throws) throw new Error(opts.throws);
        return {
          stop_reason: "end_turn",
          parsed_output: parsed,
          usage: { input_tokens: 10, output_tokens: 20 },
        };
      },
    },
  } as unknown as Anthropic;
}

const emptyBrief: FleetBrief = {
  headline: "",
  fleetState: "",
  needsAttention: [],
  changes: [],
  dataGaps: [],
};

// ─── the gate ───────────────────────────────────────────────────────────────

test("with the flag absent the AI lane is inert and says why", async () => {
  const { deps, recorded, logs } = harness({});
  let invoked = 0;

  const disposition = await runGatedAiJob(
    "ai-brief",
    async () => {
      invoked += 1;
      return { devicesCovered: 1, usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage };
    },
    deps,
  );

  assert.equal(disposition, "skipped");
  assert.equal(invoked, 0, "no Claude call may be assembled while the flag is off");
  assert.equal(recorded.length, 0, "a skipped tick is not a run");
  assert.match(logs[0]!, /\[ai-brief\] skipped/);
  assert.match(logs[0]!, new RegExp(`${AI_JOBS_FLAG}=true`), "the log must name the flag to set");
});

test("the flag must be exactly true — a truthy-looking value does not spend money", async () => {
  for (const value of ["1", "yes", "TRUE", ""]) {
    const { deps, recorded } = harness({ [AI_JOBS_FLAG]: value });
    let invoked = 0;
    const disposition = await runGatedAiJob("ai-brief", async () => {
      invoked += 1;
      return { devicesCovered: 0, usage: { input_tokens: 0, output_tokens: 0 } as Anthropic.Usage };
    }, deps);
    assert.equal(disposition, "skipped", `${value} must not enable the lane`);
    assert.equal(invoked, 0);
    assert.equal(recorded.length, 0);
  }
});

test("with the flag on the lane attempts the job and records a successful run", async () => {
  const { deps, recorded } = harness({ [AI_JOBS_FLAG]: "true" });
  let invoked = 0;

  const disposition = await runGatedAiJob(
    "ai-action-plan",
    async () => {
      invoked += 1;
      return {
        devicesCovered: 242,
        usage: { input_tokens: 1200, output_tokens: 900 } as Anthropic.Usage,
      };
    },
    deps,
  );

  assert.equal(disposition, "ok");
  assert.equal(invoked, 1, "exactly ONE call per run");
  assert.equal(recorded.length, 1);
  const run = recorded[0]!;
  assert.equal(run.poller, "ai-action-plan");
  assert.equal(run.devicesTargeted, 242, "the run row says how much of the fleet it covered");
  assert.equal(run.rowsWritten, 1, "one artifact row per successful run");
  assert.equal(run.batchesOk, 1);
  assert.equal(run.batchesFailed, 0);
  assert.deepEqual(run.errors, []);
});

// ─── failure containment ────────────────────────────────────────────────────

test("a failing LLM call is a recorded failed run, not a thrown tick", async () => {
  const { deps, recorded } = harness({ [AI_JOBS_FLAG]: "true" });

  const disposition = await runGatedAiJob(
    "ai-brief",
    async () => {
      throw new Error("rate_limit_error: too many requests");
    },
    deps,
  );

  assert.equal(disposition, "failed", "the failure is reported, not swallowed silently");
  assert.equal(recorded.length, 1, "a failed generation is still a run");
  const run = recorded[0]!;
  assert.equal(run.batchesFailed, 1);
  assert.equal(run.batchesOk, 0);
  assert.equal(run.rowsWritten, 0, "nothing was written, so the run must not claim a row");
  assert.match(run.errors[0]!, /rate_limit_error/, "the freshness surface needs the reason");
});

test("the task handlers never throw, so a failed AI call cannot take down the tick", async () => {
  const { deps, recorded } = harness({ [AI_JOBS_FLAG]: "true" });
  // A pool whose first query rejects stands in for any failure inside the job.
  const brokenPool = {
    query: async () => {
      throw new Error("connection terminated");
    },
  } as unknown as Pool;

  for (const task of aiJobTasks(brokenPool, deps)) {
    await assert.doesNotReject(task.handler());
  }
  assert.equal(recorded.length, 2, "both failures are recorded");
  assert.ok(recorded.every((r) => r.batchesFailed === 1 && r.rowsWritten === 0));
});

test("a failed brief generation does not overwrite the cached brief", async () => {
  const pool = recordingPool();
  await assert.rejects(
    runBriefJob(pool, { client: stubClient(null, { throws: "overloaded_error" }) }),
    /overloaded_error/,
  );
  assert.equal(
    pool.sql.filter((s) => s.includes("INSERT INTO briefs")).length,
    0,
    "the previous brief must survive a failed call",
  );
});

test("a failed plan generation does not overwrite the cached plan", async () => {
  const pool = recordingPool();
  await assert.rejects(
    runActionPlanJob(pool, {
      client: stubClient(null, { throws: "overloaded_error" }),
      // Keep the control plane out of the test: rollups degrade honestly anyway.
      rollups: async () => ({ available: false, reason: "not read in this test" }),
      resolveSites: async (devices) => devices,
    }),
    /overloaded_error/,
  );
  assert.equal(
    pool.sql.filter((s) => s.includes("INSERT INTO action_plans")).length,
    0,
    "the previous plan must survive a failed call",
  );
});

test("an unparseable response is never persisted as an empty artifact", async () => {
  const pool = recordingPool();
  // stop_reason end_turn but no parsed_output — the generator's own guard fires.
  await assert.rejects(runBriefJob(pool, { client: stubClient(null) }), /no parseable output/);
  assert.equal(pool.sql.filter((s) => s.includes("INSERT INTO briefs")).length, 0);
});

test("an EMPTY brief is refused rather than published over a real one", async () => {
  assert.throws(() => assertPublishableBrief(emptyBrief), /refusing to persist/);
  // A brief with no attention items is legitimate — only the narrative is required.
  assert.doesNotThrow(() =>
    assertPublishableBrief({ ...emptyBrief, headline: "All quiet.", fleetState: "Nothing to report." }),
  );

  const pool = recordingPool();
  await assert.rejects(
    runBriefJob(pool, { client: stubClient(emptyBrief) }),
    /refusing to persist/,
  );
  assert.equal(pool.sql.filter((s) => s.includes("INSERT INTO briefs")).length, 0);
});

test("an EMPTY plan is refused rather than published over a real one", async () => {
  const empty: ActionPlan = { focus: "  ", items: [], notCovered: [] };
  assert.throws(() => assertPublishablePlan(empty), /refusing to persist/);
  // No items is a legitimate answer when the data supported none.
  assert.doesNotThrow(() =>
    assertPublishablePlan({ ...empty, focus: "The supplied data supported no actions." }),
  );
});

// ─── cadence + one shared core ──────────────────────────────────────────────

test("both lanes are opt-in, off by default, and cheap by cadence", () => {
  const { deps } = harness({});
  const tasks = aiJobTasks(forbiddenPool, deps);

  assert.deepEqual(tasks.map((t) => t.name), ["ai-brief", "ai-action-plan"]);
  for (const task of tasks) {
    assert.equal(task.runOnStart, false, "a daemon restart must not fire a paid call");
  }
  // Daily brief, per-shift plan: 4 Claude calls a day in the worst case.
  assert.equal(BRIEF_INTERVAL_MS, 24 * 60 * 60_000);
  assert.equal(ACTION_PLAN_INTERVAL_MS, 8 * 60 * 60_000);
  assert.ok(tasks.every((t) => t.intervalMs >= 8 * 60 * 60_000), "no AI lane may run hourly or faster");
});

test("the gated task handlers touch nothing at all while the flag is off", async () => {
  const { deps, recorded, logs } = harness({});
  // forbiddenPool throws on any query, so reaching the DB fails the test.
  for (const task of aiJobTasks(forbiddenPool, deps)) await task.handler();
  assert.equal(recorded.length, 0);
  assert.deepEqual(
    logs.map((l) => l.split(" ")[0]),
    ["[ai-brief]", "[ai-action-plan]"],
    "one skip line per lane and nothing else",
  );
});

/**
 * Static check, deliberately over the COMPILED artifacts the npm scripts
 * actually execute: both entrypoints must delegate to src/ai/jobs.ts and must
 * not carry a prompt assembly or an INSERT of their own. A duplicated persist
 * path is how `npm run plan` and the scheduled lane would begin to differ.
 */
test("both npm entrypoints run the same shared core as the scheduled lane", () => {
  for (const [file, core, table] of [
    ["run-brief.js", "runBriefJob", "briefs"],
    ["run-action-plan.js", "runActionPlanJob", "action_plans"],
  ] as const) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.match(source, new RegExp(`${core}\\(`), `${file} must call the shared core`);
    assert.match(source, /from "\.\/jobs\.js"/, `${file} must import the shared core`);
    assert.doesNotMatch(source, new RegExp(`INSERT INTO ${table}`), `${file} must not persist its own copy`);
    assert.doesNotMatch(source, /messages\.parse/, `${file} must not assemble its own call`);
  }

  const scheduled = readFileSync(new URL("./scheduled.js", import.meta.url), "utf8");
  assert.match(scheduled, /runBriefJob\(/);
  assert.match(scheduled, /runActionPlanJob\(/);
});
