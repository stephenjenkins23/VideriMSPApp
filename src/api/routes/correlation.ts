import type { FastifyInstance } from "fastify";
import { envelope } from "../freshness.js";
import { correlate } from "../../intelligence/correlation.js";
import type { ApiContext } from "../server.js";

export async function registerCorrelationRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  /**
   * Cross-fleet correlation findings (Epic 2, docs/19 US-2.1..2.4).
   *
   * Reuses the SAME per-device assembly as the remediation engine
   * (`remediationDevices()`), then runs the pure correlation engine over it to
   * surface patterns a single root cause leaves across many devices — a venue
   * outage, a bad firmware build, a resource-linked symptom, a correlated drop.
   *
   * READ-ONLY: like remediation, this endpoint never touches a device. It only
   * reports what the data already shows. Degenerate or missing data yields an
   * honest `note`, never a fabricated finding, so an empty `findings` list with a
   * note reads as "we could not correlate", not "all clear".
   *
   * Carries the standard freshness envelope: a correlation computed from
   * 40-minute-old telemetry is a different claim from a live one, and the client
   * must be able to tell which.
   */
  app.get("/api/correlation", async (_request, reply) => {
    const [devices, freshness] = await Promise.all([
      ctx.queries.remediationDevices(),
      ctx.freshness(),
    ]);

    const report = correlate(devices);
    return reply.send(
      envelope(
        {
          findings: report.findings,
          notes: report.notes,
          devicesConsidered: report.devicesConsidered,
        },
        freshness,
      ),
    );
  });
}
