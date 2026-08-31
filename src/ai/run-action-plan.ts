/**
 * Generate a prioritized action plan (US-5.2) and PERSIST it.
 *
 *   npm run plan            # last 24 hours
 *   npm run plan -- 72      # a wider window
 *   npm run plan -- 24 --no-rollups
 *
 * Mirrors run-brief.ts: assemble the structured intelligence, make ONE Claude
 * call, store the plan next to the input it was generated from, print it. The
 * persist step is load-bearing — `GET /api/action-plan` serves the most recent
 * `action_plans` row, so a plan that is only printed leaves that endpoint
 * permanently empty.
 */

import { Pool } from "pg";
import { config } from "../config.js";
import { ReadQueries } from "../api/queries.js";
import { FleetContext } from "./context.js";
import { summarizeIntelligence } from "./bundle.js";
import {
  generateActionPlan,
  renderActionPlan,
  summarizePersistedPop,
  summarizeRollupsForPlan,
  type PlanInput,
  type PlanRollups,
} from "./action-plan.js";
import { VideriAuth } from "../videri/auth.js";
import { VideriHttp } from "../videri/http.js";
import { AggregatorService } from "../videri/services/aggregator.js";

const pool = new Pool({ connectionString: config.DATABASE_URL });
const args = process.argv.slice(2);
const windowHours = Number(args.find((a) => !a.startsWith("--")) ?? 24);
const skipRollups = args.includes("--no-rollups");

/**
 * The aggregator rollups are the one part of the input that needs the control
 * plane: ~94 read-only group-metrics calls. Worth it for a once-a-day batch job,
 * and every failure mode degrades to `available:false` WITH a reason rather than
 * to zeros — the plan then reports the blind spot instead of inferring a fleet
 * with no offline canvases. Read-only throughout: no device write happens here.
 */
async function readRollups(): Promise<PlanRollups> {
  if (skipRollups) {
    return { available: false, reason: "Rollups were skipped for this run (--no-rollups)." };
  }
  if (!config.VIDERI_PASSWORD) {
    return {
      available: false,
      reason:
        "No Videri credentials are configured, so the aggregator group-metrics could " +
        "not be read. Fleet count-rollups are unknown for this plan, not zero.",
    };
  }
  try {
    const service = new AggregatorService(new VideriHttp(new VideriAuth()));
    const collectedAt = new Date().toISOString();
    return summarizeRollupsForPlan(await service.fleetRollups(), collectedAt);
  } catch (error) {
    // Never log the error object wholesale — request context can carry credentials.
    return {
      available: false,
      reason: `The aggregator group-metrics fan-out failed (${
        error instanceof Error ? error.message : "unknown error"
      }), so fleet count-rollups are unknown for this plan, not zero.`,
    };
  }
}

try {
  const queries = new ReadQueries(pool);
  const fleet = new FleetContext(pool);

  const [overview, devices, persistedPop, rollups] = await Promise.all([
    fleet.overview(),
    queries.remediationDevices(),
    queries.popPersistedSchedules(),
    readRollups(),
  ]);

  // Reuse the brief's fold verbatim so the two AI surfaces can never disagree
  // about what the engines said. Its own POP block is the batch-brief caveat
  // ("not measured"); the plan replaces it with the persisted fleet-wide gap
  // summary, which is one query and therefore cheap enough to carry here.
  const { remediation, correlation } = summarizeIntelligence(devices);

  const input: PlanInput = {
    windowHours,
    overview,
    remediation,
    correlation,
    proofOfPlay: summarizePersistedPop(persistedPop.devices, persistedPop.fleetDevices),
    rollups,
  };

  const { plan, usage } = await generateActionPlan(input);

  await pool.query(
    `INSERT INTO action_plans (window_hours, plan, input, model, input_tokens, output_tokens)
     VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6)`,
    [
      windowHours,
      JSON.stringify(plan),
      JSON.stringify(input),
      "claude-opus-5",
      usage.input_tokens,
      usage.output_tokens,
    ],
  );

  console.log(renderActionPlan(plan));
  console.error(
    `\n[usage] in=${usage.input_tokens} out=${usage.output_tokens} ` +
      `cache_read=${usage.cache_read_input_tokens ?? 0} ` +
      `cache_write=${usage.cache_creation_input_tokens ?? 0}`,
  );
  console.error("[persisted] action plan stored — GET /api/action-plan will now serve it");
} finally {
  await pool.end();
}
