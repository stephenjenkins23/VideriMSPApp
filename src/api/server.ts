/**
 * The read API.
 *
 * Built as a factory returning a Fastify instance rather than a module that binds
 * a port, so tests drive it through `app.inject()` — no sockets, no port
 * conflicts, no flaky async teardown.
 *
 * Every response goes out in an envelope carrying data freshness. That is not
 * decoration: we poll, so the client must be able to tell how old what it is
 * looking at actually is (see freshness.ts).
 */

import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { Pool } from "pg";
import { ReadQueries } from "./queries.js";
import { getFreshness } from "./freshness.js";
import { extractBearer, tokenMatches, type AuthConfig } from "./auth.js";
import { registerFleetRoutes } from "./routes/fleet.js";
import { registerDeviceRoutes } from "./routes/devices.js";
import { registerAlertRoutes } from "./routes/alerts.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerSlaRoutes } from "./routes/sla.js";
import type { Repository } from "../db/repository.js";
import type { VideriHttp } from "../videri/http.js";
import { registerCommandRoutes } from "./routes/commands.js";
import { registerScreenshotRoutes } from "./routes/screenshots.js";
import { registerRemediationRoutes } from "./routes/remediation.js";
import { registerCorrelationRoutes } from "./routes/correlation.js";
import { registerProofOfPlayRoutes } from "./routes/proof-of-play.js";
import { registerRollupRoutes } from "./routes/rollups.js";
import { registerActionPlanRoutes } from "./routes/action-plan.js";

export interface BuildServerOptions {
  pool: Pool;
  repo: Repository;
  auth: AuthConfig;
  /**
   * Present only when the server has Videri credentials. Absent in tests and in
   * any read-only deployment — the command endpoint then returns 503 rather than
   * pretending a control plane exists.
   */
  videri?: VideriHttp;
  corsOrigins?: string[];
  logger?: boolean;
}

export interface ApiContext {
  pool: Pool;
  repo: Repository;
  queries: ReadQueries;
  freshness: () => ReturnType<typeof getFreshness>;
  /** undefined when this server cannot reach devices. */
  videri?: VideriHttp | undefined;
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    // The dashboard sends no large bodies; the only write is an acknowledgement.
    bodyLimit: 64 * 1024,
  });

  const ctx: ApiContext = {
    pool: options.pool,
    repo: options.repo,
    queries: new ReadQueries(options.pool),
    freshness: () => getFreshness(options.pool),
    videri: options.videri,
  };

  await app.register(cors, {
    origin: options.corsOrigins && options.corsOrigins.length > 0 ? options.corsOrigins : false,
    methods: ["GET", "POST"],
  });

  // ── auth ──
  app.addHook("onRequest", async (request, reply) => {
    // Health endpoints must stay reachable for load balancers and container
    // probes, which do not carry credentials. Readiness therefore discloses only
    // whether we can serve — never fleet detail. See routes/system.ts.
    if (request.url.split("?")[0]?.startsWith("/health")) return;
    // The console shell itself carries no fleet data — it is an empty page that
    // then calls the API with a token like any other client. Gating the HTML
    // would only mean the browser cannot render a login prompt.
    const path = request.url.split("?")[0];
    if (path === "/" || path === "/console.html") return;
    if (options.auth.allowAnonymous) return;

    const provided = extractBearer(request.headers.authorization);
    if (!provided || !tokenMatches(provided, options.auth.token!)) {
      return reply.code(401).send({
        error: "unauthorized",
        message: "A valid bearer token is required.",
      });
    }
  });

  // ── error handling ──
  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Validation failures are the client's problem and safe to describe.
    if (error.validation) {
      return reply.code(400).send({
        error: "bad_request",
        message: error.message,
      });
    }
    // Everything else is ours. Log it in full, return nothing internal — a SQL
    // error message can disclose schema details.
    request.log.error({ err: error }, "unhandled API error");
    return reply.code(500).send({
      error: "internal_error",
      message: "The request could not be completed.",
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: "not_found", message: "No such endpoint." });
  });

  // ── routes ──
  // ── the console ──
  // Served from the API's own origin so the browser needs no CORS grant and no
  // second process. The HTML holds no data and no token.
  const consoleHtml = async (): Promise<string> => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    // dist/api/server.js -> ../../public/console.html
    const here = dirname(fileURLToPath(import.meta.url));
    return readFile(join(here, "..", "..", "public", "console.html"), "utf8");
  };
  for (const route of ["/", "/console.html"]) {
    app.get(route, async (_request, reply) => {
      try {
        return reply.type("text/html; charset=utf-8").send(await consoleHtml());
      } catch {
        return reply.code(404).type("text/plain").send("console.html not found");
      }
    });
  }

  await registerSystemRoutes(app, ctx);
  await registerFleetRoutes(app, ctx);
  await registerDeviceRoutes(app, ctx);
  await registerAlertRoutes(app, ctx);
  await registerSlaRoutes(app, ctx);
  await registerCommandRoutes(app, ctx);
  await registerScreenshotRoutes(app, ctx);
  await registerRemediationRoutes(app, ctx);
  await registerCorrelationRoutes(app, ctx);
  await registerProofOfPlayRoutes(app, ctx);
  await registerRollupRoutes(app, ctx);
  await registerActionPlanRoutes(app, ctx);

  return app;
}
