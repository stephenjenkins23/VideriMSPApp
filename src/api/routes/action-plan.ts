import type { FastifyInstance } from "fastify";
import { envelope } from "../freshness.js";
import type { ApiContext } from "../server.js";

/**
 * The prioritized AI action plan (US-5.2).
 *
 * Read-only and never generated on request: generation is one Claude call over
 * the day's structured intelligence, so it runs out-of-band (`npm run plan`) and
 * every viewer works the same plan. Mirrors `GET /api/fleet/brief` exactly,
 * including the 404-with-guidance when nothing has been generated yet — an empty
 * plan body would read as "nothing to do", which is the opposite of the truth.
 *
 * The plan carries its OWN age alongside the envelope's poller freshness: a plan
 * generated this morning is a snapshot of this morning's fleet, and an operator
 * working an 11-hour-old plan needs to know that.
 */
export async function registerActionPlanRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  app.get("/api/action-plan", async (_request, reply) => {
    const [plan, freshness] = await Promise.all([
      ctx.queries.latestActionPlan(),
      ctx.freshness(),
    ]);

    if (!plan) {
      return reply.code(404).send({
        error: "no_action_plan",
        message: "No action plan has been generated yet. Run `npm run plan`.",
        meta: { freshness },
      });
    }

    const generatedAt = Date.parse(plan["generatedAt"] as string);
    return envelope(
      {
        ...plan,
        ageSeconds: Number.isFinite(generatedAt)
          ? Math.round((Date.now() - generatedAt) / 1000)
          : null,
      },
      freshness,
    );
  });
}
