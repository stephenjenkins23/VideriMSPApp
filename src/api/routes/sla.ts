import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { envelope } from "../freshness.js";
import { buildSlaReport } from "../../sla/report.js";
import { UNMEASURABLE } from "../../sla/coverage.js";
import type { ApiContext } from "../server.js";

const Query = z.object({
  windowHours: z.coerce.number().int().min(1).max(2160).default(24),
  /** Bucket granularity. Smaller = stricter coverage measurement. */
  bucketSeconds: z.coerce.number().int().min(60).max(3600).default(300),
});

export async function registerSlaRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  /**
   * SLA coverage and measurement confidence.
   *
   * Reports observed uptime and collection coverage as SEPARATE figures, plus
   * which devices have enough coverage to support an external claim. The fleet
   * uptime figure is computed over claimable devices only — averaging in devices
   * we barely observed would produce a number nobody could defend to a customer.
   */
  app.get("/api/sla/coverage", async (request, reply) => {
    const parsed = Query.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "bad_request",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }
    const [report, freshness] = await Promise.all([
      buildSlaReport(ctx.repo, parsed.data.windowHours, parsed.data.bucketSeconds),
      ctx.freshness(),
    ]);
    return envelope(report, freshness);
  });

  /**
   * Dimensions this platform cannot measure at all.
   *
   * Deliberately its own endpoint rather than a footnote: an MSP needs this
   * list BEFORE agreeing SLA language, and it should be as easy to find as the
   * uptime number.
   */
  app.get("/api/sla/unmeasurable", async (_request, reply) => {
    const freshness = await ctx.freshness();
    return reply.send(
      envelope(
        {
          dimensions: UNMEASURABLE,
          summary:
            `${UNMEASURABLE.length} dimensions cannot be evidenced on this platform. ` +
            `Confirmed across all devices: the Videri telemetry payload contains ` +
            `package versions and hardware identity only — no runtime metrics.`,
        },
        freshness,
      ),
    );
  });

  /** Per-device compliance, with the age of the settings it was computed from. */
  app.get("/api/compliance", async (request, reply) => {
    const P = z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      band: z.enum(["compliant", "minor-drift", "non-compliant"]).optional(),
    });
    const parsed = P.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request", message: parsed.error.message });
    }
    const [result, freshness] = await Promise.all([
      ctx.queries.compliance(parsed.data),
      ctx.freshness(),
    ]);
    return envelope(result.items, freshness, {
      page: parsed.data.page,
      limit: parsed.data.limit,
      totalItems: result.totalItems,
      totalPages: Math.max(1, Math.ceil(result.totalItems / parsed.data.limit)),
    });
  });
}
