/**
 * Generate a fleet brief and persist it — the manual entrypoint.
 *
 *   npm run brief          # last 24 hours
 *   npm run brief -- 72    # a wider window
 *
 * All the work lives in `runBriefJob` (src/ai/jobs.ts), which the scheduled
 * `ai-brief` lane in the poller daemon calls too. This file is argv, printing and
 * the pool lifecycle — nothing that could diverge from the scheduled path.
 */

import { Pool } from "pg";
import { config } from "../config.js";
import { renderBrief } from "./brief.js";
import { runBriefJob } from "./jobs.js";

const pool = new Pool({ connectionString: config.DATABASE_URL });
const windowHours = Number(process.argv[2] ?? 24);

try {
  const { artifact: brief, usage } = await runBriefJob(pool, { windowHours });

  console.log(renderBrief(brief));
  console.error(
    `\n[usage] in=${usage.input_tokens} out=${usage.output_tokens} ` +
      `cache_read=${usage.cache_read_input_tokens ?? 0} ` +
      `cache_write=${usage.cache_creation_input_tokens ?? 0}`,
  );
  console.error("[persisted] brief stored — GET /api/fleet/brief will now serve it");
} finally {
  await pool.end();
}
