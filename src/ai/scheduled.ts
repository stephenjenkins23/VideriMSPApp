/**
 * The two AI artifacts as SCHEDULED poller lanes.
 *
 * Why this exists: the brief and the plan were out-of-band jobs run by hand, so
 * they drifted. `/api/action-plan` served "Restore brightness on 34 dark but
 * online screens" for days after the brightness verdict fix took the real number
 * to 11 (docs/20 §D-2). The age was stamped and shown, so it was disclosed — but
 * it was still WRONG, and an operator reading the lead card was misled. A stale
 * artifact is a scheduling bug, not an honesty bug, and this is the fix.
 *
 * Three properties this wrapper is responsible for:
 *
 *   1. GATED. Unlike every other lane, a tick here spends money at Anthropic, so
 *      it does nothing at all unless ENABLE_AI_JOBS=true. Off is the default and
 *      the flag is deliberately absent from .env — enabling it is a human's call.
 *   2. CONTAINED. An LLM call can fail for reasons that have nothing to do with
 *      the fleet (rate limit, refusal, transport). That must never take down the
 *      poller tick, and it must never leave a half-written artifact: the job
 *      generates before it persists, and a throw here is recorded as a FAILED
 *      poller run whose reason surfaces in the freshness envelope for 24h.
 *   3. VISIBLE. Every run — success or failure — is `record()`ed like any other
 *      poller, so "when did the plan last regenerate" is answerable from
 *      poller_runs instead of from someone's shell history.
 */

import type { Pool } from "pg";
import type { Task } from "../pipeline/scheduler.js";
import { emptyResult, type PollerResult } from "../pipeline/pollers/types.js";
import { runActionPlanJob, runBriefJob, type AiJobOutcome } from "./jobs.js";

/**
 * ONE flag for both jobs, not one each.
 *
 * They are the same decision — "spend Anthropic tokens on a schedule" — taken by
 * the same person for the same reason, and the cost of the pair is still a
 * handful of calls a day. Two flags would let the fleet run with a fresh plan and
 * a month-old brief, which is exactly the drift this lane exists to remove.
 */
export const AI_JOBS_FLAG = "ENABLE_AI_JOBS";

/**
 * Cadence. These are LLM calls over our own aggregates, not device reads, so
 * cost control outranks freshness — and neither artifact changes meaningfully on
 * a five-minute timescale.
 *
 *   brief:  daily. It is a narrative over a 24h window; regenerating it more
 *           often than its own window mostly re-describes the same day.
 *   plan:   every 8 hours, i.e. once a shift. The plan is the artifact an
 *           operator ACTS on, and it is the one that misled us, so it gets the
 *           tighter cadence — but a shift boundary is the natural granularity for
 *           "what do I do first", and 3 calls a day is still cheap.
 *
 * Worst case with the flag on: 4 Claude calls per day.
 */
export const BRIEF_INTERVAL_MS = 24 * 60 * 60_000;
export const ACTION_PLAN_INTERVAL_MS = 8 * 60 * 60_000;

export interface ScheduledAiJobDeps {
  /** The poller's own recorder, so these runs land in poller_runs like any other. */
  record: (result: PollerResult) => Promise<void>;
  log?: (message: string) => void;
  /** Injected so a test can drive the gate without mutating process.env. */
  env?: Record<string, string | undefined>;
}

/** Whatever the underlying job returns, we only need its coverage and its cost. */
type AiJob = () => Promise<Pick<AiJobOutcome<unknown>, "devicesCovered" | "usage">>;

export type AiJobDisposition = "skipped" | "ok" | "failed";

/**
 * Run one gated AI job and record the outcome. Never throws.
 *
 * The return value is for tests and callers that care; the scheduler ignores it.
 */
export async function runGatedAiJob(
  poller: string,
  job: AiJob,
  { record, log = (m) => console.log(m), env = process.env }: ScheduledAiJobDeps,
): Promise<AiJobDisposition> {
  if (env[AI_JOBS_FLAG] !== "true") {
    log(`[${poller}] skipped — set ${AI_JOBS_FLAG}=true to enable (each run is a paid Claude call)`);
    return "skipped";
  }

  const startedAt = new Date();
  const result = emptyResult(poller, startedAt);
  try {
    const { devicesCovered, usage } = await job();
    result.durationMs = Date.now() - startedAt.getTime();
    result.devicesTargeted = devicesCovered;
    // One artifact row per successful run. Zero is never written on success.
    result.rowsWritten = 1;
    result.batchesOk = 1;
    log(
      `[${poller}] generated over ${devicesCovered} device(s) · ` +
        `tokens in=${usage.input_tokens} out=${usage.output_tokens}`,
    );
  } catch (error) {
    // Message only — an SDK error can carry request context, and the API key
    // lives in that context. Nothing here ever prints a credential.
    const reason = error instanceof Error ? error.message : "unknown error";
    result.durationMs = Date.now() - startedAt.getTime();
    result.batchesFailed = 1;
    result.errors.push(`${poller} generation failed: ${reason}`);
    await record(result);
    return "failed";
  }

  await record(result);
  return "ok";
}

export interface AiJobTaskOptions {
  windowHours?: number;
}

/**
 * The two scheduled lanes, ready to push into the poller's task list.
 *
 * `runOnStart: false` like every other opt-in lane: a daemon restart must not
 * fire a paid call, and a restart loop must not fire several.
 */
export function aiJobTasks(
  pool: Pool,
  deps: ScheduledAiJobDeps,
  { windowHours = 24 }: AiJobTaskOptions = {},
): Task[] {
  return [
    {
      name: "ai-brief",
      intervalMs: BRIEF_INTERVAL_MS,
      runOnStart: false,
      handler: async () => {
        await runGatedAiJob("ai-brief", () => runBriefJob(pool, { windowHours }), deps);
      },
    },
    {
      name: "ai-action-plan",
      intervalMs: ACTION_PLAN_INTERVAL_MS,
      runOnStart: false,
      handler: async () => {
        await runGatedAiJob("ai-action-plan", () => runActionPlanJob(pool, { windowHours }), deps);
      },
    },
  ];
}
