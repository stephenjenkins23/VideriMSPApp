import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../server.js";

export async function registerSystemRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  /** Liveness. Unauthenticated by design so probes can reach it. */
  app.get("/health", async () => ({ status: "ok" }));

  /**
   * Readiness — is the API able to serve meaningful data?
   *
   * Deliberately distinct from liveness. The process can be perfectly healthy
   * while the pipeline has collected nothing, and a load balancer keeping traffic
   * off an instance with no data is the correct behaviour.
   *
   * Unauthenticated, because probes do not carry credentials — so the body is
   * kept to the minimum a probe needs. Staleness figures, poller names and
   * failure counts are operational detail and belong on the authenticated
   * /api/pipeline/status endpoint, not on a public URL.
   */
  app.get("/health/ready", async (_request, reply) => {
    try {
      await ctx.pool.query("SELECT 1");
    } catch {
      // The underlying error may name hosts, databases or roles — log it, do
      // not return it.
      app.log.error("readiness check failed: database unreachable");
      return reply.code(503).send({ status: "unavailable", reason: "database_unreachable" });
    }
    const freshness = await ctx.freshness();
    const ready = freshness.state !== "unknown";
    return reply
      .code(ready ? 200 : 503)
      .send({ status: ready ? "ok" : "no_data", hasData: ready });
  });

  /**
   * Pipeline status — the operational view of our own collectors.
   *
   * Surfaced through the API because "why is this dashboard empty" is a question
   * the dashboard itself should be able to answer.
   */
  app.get("/api/pipeline/status", async () => {
    const [freshness, availability] = await Promise.all([
      ctx.freshness(),
      ctx.queries.telemetryAvailability(),
    ]);
    return {
      data: { freshness, telemetryAvailability: availability },
      meta: { freshness },
    };
  });
}
