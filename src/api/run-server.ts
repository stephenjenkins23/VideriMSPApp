/**
 * Read API entry point.
 *
 *   npm run serve
 *   npm run serve -- --allow-anonymous   # local development only
 */

import { config } from "../config.js";
import { pool, closePool } from "../db/pool.js";
import { Repository } from "../db/repository.js";
import { buildServer } from "./server.js";
import { resolveAuth } from "./auth.js";
import { VideriAuth } from "../videri/auth.js";
import { VideriHttp } from "../videri/http.js";

const allowAnonymous = process.argv.includes("--allow-anonymous");
const auth = resolveAuth(config.VFI_API_TOKEN, allowAnonymous);

const corsOrigins = config.VFI_API_CORS_ORIGINS.split(",")
  .map((o) => o.trim())
  .filter(Boolean);

/**
 * The control plane is only wired when credentials exist. Without them the
 * server still serves every read endpoint; the command endpoint returns 503 and
 * the console disables its controls with that reason, rather than showing
 * buttons that quietly do nothing.
 */
const videri = config.VIDERI_PASSWORD
  ? new VideriHttp(new VideriAuth())
  : undefined;

const app = await buildServer({
  pool,
  repo: new Repository(pool),
  auth,
  corsOrigins,
  logger: true,
  ...(videri ? { videri } : {}),
});

const shutdown = async (signal: string) => {
  app.log.info(`received ${signal}, closing`);
  await app.close();
  await closePool();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port: config.VFI_API_PORT, host: config.VFI_API_HOST });
  if (allowAnonymous) {
    app.log.warn(
      "Running with --allow-anonymous: the whole fleet's operational data is " +
        "readable without authentication. Never use this outside local development.",
    );
  }
  if (corsOrigins.length === 0) {
    app.log.warn(
      "No VFI_API_CORS_ORIGINS set — browser requests from a dashboard origin will " +
        "be blocked. Set it to the dashboard's origin.",
    );
  }
} catch (error) {
  app.log.error(error);
  await closePool();
  process.exit(1);
}
