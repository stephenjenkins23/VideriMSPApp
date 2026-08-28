import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { envelope } from "../freshness.js";
import type { ApiContext } from "../server.js";

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  // Capped: this endpoint joins two laterals per row, and an uncapped limit is
  // how a dashboard bug turns into a database incident.
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.enum(["online", "warning", "alert", "offline", "unknown"]).optional(),
  deviceClass: z.string().min(1).max(50).optional(),
  groupId: z.string().min(1).max(100).optional(),
  search: z.string().min(1).max(200).optional(),
  sort: z.enum(["name", "last_seen", "alerts"]).default("last_seen"),
  direction: z.enum(["asc", "desc"]).default("desc"),
});

const HealthQuery = z.object({
  windowHours: z.coerce.number().int().min(1).max(2160).default(24),
  bucketMinutes: z.coerce.number().int().min(1).max(1440).default(15),
});

export async function registerDeviceRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  app.get("/api/devices", async (request, reply) => {
    const parsed = ListQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "bad_request",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }
    const filters = parsed.data;
    const [result, freshness] = await Promise.all([
      ctx.queries.devices(filters),
      ctx.freshness(),
    ]);

    return envelope(result.items, freshness, {
      page: filters.page,
      limit: filters.limit,
      totalItems: result.totalItems,
      totalPages: Math.max(1, Math.ceil(result.totalItems / filters.limit)),
    });
  });

  app.get<{ Params: { id: string } }>("/api/devices/:id", async (request, reply) => {
    // One call returns everything the drawer shows — identity, components,
    // cached settings and the compliance verdict — so the UI has one loading
    // state instead of five.
    const [device, context, freshness] = await Promise.all([
      ctx.queries.device(request.params.id),
      ctx.queries.deviceContext(request.params.id),
      ctx.freshness(),
    ]);
    if (!device) {
      return reply.code(404).send({ error: "not_found", message: "No such device." });
    }
    return envelope({ ...device, ...context }, freshness);
  });

  /**
   * Device health history.
   *
   * `availability` reports, per metric, whether any reading exists in the window.
   * The UI needs that to distinguish an unreadable metric from a metric reading
   * zero — a chart drawing a flat line at zero for unavailable telemetry is the
   * exact failure this whole data model is built to prevent.
   */
  app.get<{ Params: { id: string } }>("/api/devices/:id/health", async (request, reply) => {
    const parsed = HealthQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "bad_request",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }
    const device = await ctx.queries.device(request.params.id);
    if (!device) {
      return reply.code(404).send({ error: "not_found", message: "No such device." });
    }

    const [health, freshness] = await Promise.all([
      ctx.queries.deviceHealth(
        request.params.id,
        parsed.data.windowHours,
        parsed.data.bucketMinutes,
      ),
      ctx.freshness(),
    ]);
    return envelope(health, freshness);
  });

  app.get<{ Params: { id: string } }>("/api/devices/:id/alerts", async (request, reply) => {
    const [result, freshness] = await Promise.all([
      ctx.queries.alerts({ page: 1, limit: 100, state: "all", deviceId: request.params.id }),
      ctx.freshness(),
    ]);
    return reply.send(
      envelope(result.items, freshness, {
        page: 1, limit: 100, totalItems: result.totalItems,
        totalPages: Math.max(1, Math.ceil(result.totalItems / 100)),
      }),
    );
  });
}
