import type { FastifyInstance } from "fastify";
import { envelope } from "../freshness.js";
import { recommendationsFor, summarize } from "../../intelligence/remediation.js";
import type { ApiContext } from "../server.js";

export async function registerRemediationRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  /**
   * Self-heal recommendations (Epic 1, docs/19).
   *
   * Assembles the per-device facts and runs the pure remediation engine over
   * them. READ-ONLY: this endpoint never fires a device action. An `auto-safe`
   * item means the UI *could* route it through the existing verified brightness
   * write (with its confirm/verify/rollback) — the write happens there, driven by
   * a human, not here.
   *
   * Carries the standard freshness envelope: a recommendation computed from
   * 40-minute-old telemetry is a different claim from a live one, and the client
   * must be able to tell which.
   */
  app.get("/api/remediation", async (_request, reply) => {
    const [devices, freshness] = await Promise.all([
      ctx.queries.remediationDevices(),
      ctx.freshness(),
    ]);

    const recommendations = recommendationsFor(devices);
    return reply.send(
      envelope(
        {
          recommendations,
          summary: summarize(recommendations),
          // How many devices were considered, so an empty list reads as
          // "nothing to do" rather than "we saw nothing".
          devicesConsidered: devices.length,
        },
        freshness,
      ),
    );
  });
}
