/**
 * Generate a prioritized action plan (US-5.2) and persist it — the manual entrypoint.
 *
 *   npm run plan            # last 24 hours
 *   npm run plan -- 72      # a wider window
 *   npm run plan -- 24 --no-rollups
 *
 * All the work lives in `runActionPlanJob` (src/ai/jobs.ts), which the scheduled
 * `ai-action-plan` lane in the poller daemon calls too. This file is argv,
 * printing and the pool lifecycle — nothing that could diverge from the
 * scheduled path, because a plan generated two different ways is a plan nobody
 * can trust.
 */

import { Pool } from "pg";
import { config } from "../config.js";
import { renderActionPlan } from "./action-plan.js";
import { runActionPlanJob } from "./jobs.js";

const pool = new Pool({ connectionString: config.DATABASE_URL });
const args = process.argv.slice(2);
const windowHours = Number(args.find((a) => !a.startsWith("--")) ?? 24);
const skipRollups = args.includes("--no-rollups");

try {
  const { artifact: plan, usage } = await runActionPlanJob(pool, { windowHours, skipRollups });

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
