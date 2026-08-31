import { Pool } from "pg";
import { config } from "../config.js";
import { FleetContext } from "./context.js";
import { ReadQueries } from "../api/queries.js";
import { assembleBundle } from "./bundle.js";
import { generateFleetBrief, renderBrief } from "./brief.js";

/**
 * Generate a fleet brief and PERSIST it.
 *
 * The persist step matters: `GET /api/fleet/brief` serves the most recent row
 * from `briefs`, so a brief that is only printed to stdout leaves that endpoint
 * permanently empty. The bundle is stored alongside the output so any claim in a
 * brief can be traced back to the data it was generated from.
 */

const pool = new Pool({ connectionString: config.DATABASE_URL });
const windowHours = Number(process.argv[2] ?? 24);

try {
  const bundle = await assembleBundle(new FleetContext(pool), new ReadQueries(pool), windowHours);
  const { brief, usage } = await generateFleetBrief(bundle, { windowHours });

  await pool.query(
    `INSERT INTO briefs (window_hours, brief, bundle, model, input_tokens, output_tokens)
     VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6)`,
    [
      windowHours,
      JSON.stringify(brief),
      JSON.stringify(bundle),
      "claude-opus-5",
      usage.input_tokens,
      usage.output_tokens,
    ],
  );

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
