/**
 * OUR OWN health, not the fleet's.
 *
 *   GET /api/alerts/hygiene  — how the incident list was made readable, and
 *                              exactly what was moved out of it
 *   GET /api/pipeline/health — whether our own collector is still collecting
 *
 * The second exists because a poller that is up but polling nothing looks
 * identical to a healthy one from outside. Every finding carries
 * scope "vfi-pipeline", so no consumer can render "our collector stalled" as
 * "the screen is broken".
 */

import type { FastifyInstance } from "fastify";
import { envelope } from "../freshness.js";
import { loadAlertHygiene } from "../../alerting/hygiene.js";
import { loadPipelineHealth } from "../../alerting/pipeline-health.js";
import type { ApiContext } from "../server.js";

export async function registerHealthRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  /**
   * Reports BOTH totals on purpose: the incident list an operator should read,
   * and the dormant band taken out of it. A suppression you cannot count is
   * indistinguishable from a bug.
   */
  app.get("/api/alerts/hygiene", async (_request, reply) => {
    const [view, freshness] = await Promise.all([loadAlertHygiene(ctx.repo), ctx.freshness()]);
    return reply.send(envelope(view, freshness));
  });

  app.get("/api/pipeline/health", async (_request, reply) => {
    const [report, freshness] = await Promise.all([loadPipelineHealth(ctx.repo), ctx.freshness()]);
    return reply.send(envelope(report, freshness));
  });
}
