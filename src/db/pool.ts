import { Pool } from "pg";
import { config } from "../config.js";

/**
 * Shared connection pool. The poller is long-lived and its tasks overlap, so a
 * pool (rather than per-task clients) keeps connection churn off the hot path.
 */
export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  // A poll tick that cannot reach the database should fail fast and be retried
  // on the next tick rather than pile up connections.
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (error) => {
  // An idle client erroring is not fatal — pg replaces it. Log and continue,
  // because throwing here would take down the whole poller process.
  console.error(`[db] idle client error: ${error.message}`);
});

export async function closePool(): Promise<void> {
  await pool.end();
}
