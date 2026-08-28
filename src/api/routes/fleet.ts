import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { envelope } from "../freshness.js";
import { FleetContext } from "../../ai/context.js";
import type { ApiContext } from "../server.js";

const TrendQuery = z.object({
  metric: z.enum([
    "cpu_percent", "ram_percent", "temperature_c", "wifi_signal_dbm",
    "ntp_sync_percent", "playback_quality", "ping_quality",
  ]),
  windowHours: z.coerce.number().int().min(1).max(2160).default(168),
  bucketHours: z.coerce.number().int().min(1).max(168).default(6),
});

export async function registerFleetRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  const fleet = new FleetContext(ctx.pool);

  /**
   * The Overview tab.
   *
   * Served from the pre-computed `fleet_snapshots` row, not a live aggregate.
   * The platform has no aggregation endpoint above device level, so pre-computing
   * is exactly where our speed advantage over a direct-to-API client comes from.
   */
  app.get("/api/fleet/summary", async (_request, reply) => {
    const [snapshot, freshness] = await Promise.all([
      ctx.queries.fleetSummary(),
      ctx.freshness(),
    ]);

    if (!snapshot) {
      // No snapshot yet is a real state, not an error — the poller may simply
      // not have completed a cycle. Say so rather than returning empty numbers
      // that would read as a fleet of zero devices.
      return reply.code(503).send({
        error: "no_snapshot",
        message:
          "No fleet snapshot has been computed yet. The poller has not completed a " +
          "cycle, so there is nothing to summarise.",
        meta: { freshness },
      });
    }

    return envelope(snapshot, freshness);
  });

  app.get("/api/fleet/firmware", async () => {
    const [distribution, freshness] = await Promise.all([
      fleet.firmwareDistribution(),
      ctx.freshness(),
    ]);
    return envelope(distribution, freshness);
  });

  /**
   * Metric trend across the fleet.
   *
   * Returns `available: false` with a reason when the metric is unreadable, so a
   * chart can render "not measured" rather than a flat line at zero.
   */
  app.get("/api/fleet/trends", async (request, reply) => {
    const parsed = TrendQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "bad_request",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }
    const { metric, windowHours, bucketHours } = parsed.data;
    const [trend, freshness] = await Promise.all([
      fleet.metricTrend(metric, windowHours, bucketHours),
      ctx.freshness(),
    ]);
    return envelope(trend, freshness);
  });

  /** The latest generated AI brief. Never generated on request — see queries.ts. */
  app.get("/api/fleet/brief", async (_request, reply) => {
    const [brief, freshness] = await Promise.all([
      ctx.queries.latestBrief(),
      ctx.freshness(),
    ]);
    if (!brief) {
      return reply.code(404).send({
        error: "no_brief",
        message: "No brief has been generated yet. Run `npm run brief`.",
        meta: { freshness },
      });
    }
    return envelope(brief, freshness);
  });
}
