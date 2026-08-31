import type { FastifyInstance } from "fastify";
import { envelope } from "../freshness.js";
import { AggregatorService, type RollupResult } from "../../videri/services/aggregator.js";
import type { ApiContext } from "../server.js";

/**
 * Fleet-health count-rollups (US-4.6).
 *
 * A read-only view over the aggregator's per-group counts, summed into a fleet
 * total with a worst-offline-first drill-down. Computing it fans out ~94 group
 * calls, so a short-lived in-memory cache keeps a burst of dashboard loads from
 * re-firing the whole fan-out each time. The cache age is surfaced in the payload
 * — a 25-minute-old rollup is never presented as live.
 */
const CACHE_TTL_MS = 30 * 60 * 1000;

export async function registerRollupRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  let cache: { collectedAt: number; result: RollupResult } | null = null;

  app.get("/api/fleet/rollups", async (_request, reply) => {
    // No control plane → we cannot read the aggregator at all. Say so rather than
    // returning an empty rollup that would read as a fleet of zero canvases.
    if (!ctx.videri) {
      return reply.code(503).send({
        error: "no_control_plane",
        message:
          "No Videri credentials are configured, so the aggregator group-metrics " +
          "cannot be read. This rollup requires a live control plane.",
      });
    }

    const now = Date.now();
    let servedFromCache = true;
    if (!cache || now - cache.collectedAt > CACHE_TTL_MS) {
      const service = new AggregatorService(ctx.videri);
      cache = { collectedAt: now, result: await service.fleetRollups() };
      servedFromCache = false;
    }

    const freshness = await ctx.freshness();
    const ageSeconds = Math.round((Date.now() - cache.collectedAt) / 1000);
    return envelope(
      {
        ...cache.result,
        // The rollup's own freshness, independent of the poller freshness in the
        // envelope: this data came from a live fan-out, not health_samples.
        collectedAt: new Date(cache.collectedAt).toISOString(),
        ageSeconds,
        cached: servedFromCache,
      },
      freshness,
    );
  });
}
