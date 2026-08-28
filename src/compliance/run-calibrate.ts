/**
 * Propose compliance templates from observed fleet configuration.
 *
 *   npm run compliance:calibrate
 *
 * Read-only. Prints what the fleet actually does, what check it would suggest,
 * and how much of the fleet would pass — so a human can decide what to enforce
 * rather than inheriting a guess.
 */

import { pool, closePool } from "../db/pool.js";
import { calibrate } from "./calibrate.js";

const { rows } = await pool.query<{ settings: Record<string, unknown> }>(
  `SELECT DISTINCT ON (device_id) settings
     FROM device_settings ORDER BY device_id, observed_at DESC`,
);

if (rows.length === 0) {
  console.log("No cached settings. Run the settings poller first (ENABLE_SETTINGS_POLL=true).");
  await closePool();
  process.exit(0);
}

console.log(`Calibrating against ${rows.length} device settings snapshot(s)\n`);
const proposals = calibrate(rows.map((r) => r.settings));

const label = { strong: "STRONG", weak: "weak  ", none: "none  " } as const;
for (const p of proposals) {
  const d = p.distribution;
  if (d.observed === 0) continue;
  console.log(
    `${label[p.consensus]}  ${p.field.padEnd(30)} n=${String(d.observed).padStart(3)} ` +
      `distinct=${String(d.distinct).padStart(3)}  pass=${(p.wouldPass * 100).toFixed(0)}%`,
  );
  console.log(`         top: ${d.values.slice(0, 4).map((v) => `${v.value}×${v.count}`).join("  ")}`);
  console.log(`         ${p.recommendation}`);
  console.log("");
}

const strong = proposals.filter((p) => p.consensus === "strong").length;
const unusable = proposals.filter((p) => p.consensus === "none" || p.distribution.observed === 0).length;
console.log(
  `${strong} field(s) have strong consensus and make good checks; ` +
    `${unusable} vary too much (or are unreported) to enforce.`,
);
await closePool();
