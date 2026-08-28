import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { envelope } from "../freshness.js";
import type { ApiContext } from "../server.js";
import { previewRule } from "../../alerting/preview.js";
import type { AlertRule } from "../../alerting/rules.js";

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  severity: z.enum(["critical", "high", "medium", "info"]).optional(),
  state: z.enum(["open", "resolved", "all"]).default("open"),
  deviceId: z.string().min(1).max(100).optional(),
});

const AcknowledgeBody = z.object({
  /**
   * Who is acknowledging. Supplied by the caller for now; it becomes the
   * authenticated identity once JWT auth replaces the shared token (auth.ts).
   */
  by: z.string().min(1).max(200),
});

export async function registerAlertRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  app.get("/api/alerts", async (request, reply) => {
    const parsed = ListQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "bad_request",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }
    const filters = parsed.data;
    const [result, freshness] = await Promise.all([
      ctx.queries.alerts(filters),
      ctx.freshness(),
    ]);
    return envelope(result.items, freshness, {
      page: filters.page,
      limit: filters.limit,
      totalItems: result.totalItems,
      totalPages: Math.max(1, Math.ceil(result.totalItems / filters.limit)),
    });
  });

  /**
   * Rule definitions as the engine will actually use them — read from the
   * database, not from DEFAULT_RULES, so what the UI shows is what runs even
   * after an operator has tuned a threshold.
   */
  app.get("/api/alerts/rules", async () => {
    const [rules, freshness] = await Promise.all([ctx.queries.alertRules(), ctx.freshness()]);
    return envelope(rules, freshness);
  });

  /**
   * Preview a candidate rule against the live fleet without saving it.
   *
   * The point of a configurable alerting engine is not the editor — it is knowing
   * the blast radius before you commit. This evaluates in memory and persists
   * nothing, and it will tell you plainly when a threshold matches so much of the
   * fleet that it is a definition rather than a detector.
   */
  app.post("/api/alerts/rules/preview", async (request, reply) => {
    const rule = request.body as AlertRule | undefined;
    if (!rule || typeof rule !== "object" || !rule.id) {
      return reply.code(400).send({
        error: "bad_request",
        message: "Body must be a rule object with at least an id and kind.",
      });
    }
    const [preview, freshness] = await Promise.all([
      previewRule(ctx.repo, rule),
      ctx.freshness(),
    ]);
    return envelope(preview, freshness);
  });

  /** Update a rule. The engine reads from the database, so this takes effect. */
  app.patch<{ Params: { id: string } }>("/api/alerts/rules/:id", async (request, reply) => {
    const body = request.body as { definition?: AlertRule; enabled?: boolean } | undefined;
    if (!body || (body.definition === undefined && body.enabled === undefined)) {
      return reply.code(400).send({
        error: "bad_request",
        message: "Provide `definition`, `enabled`, or both.",
      });
    }

    if (body.definition) {
      // The definition's embedded id must match the row being updated. The
      // engine unions rules by the id INSIDE the stored JSON, so a mismatch
      // corrupts two rules at once: the definition lands in row A but loads as
      // rule B (overwriting the real B), while A silently reverts to its
      // compiled-in default. Nothing errors; both rules are just wrong.
      if (body.definition.id !== request.params.id) {
        return reply.code(400).send({
          error: "id_mismatch",
          message:
            `definition.id ("${body.definition.id}") must match the rule being ` +
            `updated ("${request.params.id}").`,
        });
      }
      // Refuse to store a rule that cannot be evaluated — a broken rule in the
      // table means the engine silently drops it every cycle.
      const preview = await previewRule(ctx.repo, body.definition);
      if (!preview.valid) {
        return reply.code(400).send({
          error: "invalid_rule", message: preview.problems.join("; "), problems: preview.problems,
        });
      }
      const ok = await ctx.repo.updateRuleDefinition(
        request.params.id, body.definition, body.enabled,
      );
      if (!ok) return reply.code(404).send({ error: "not_found", message: "No such rule." });
      return reply.send({ data: { id: request.params.id, updated: true, preview } });
    }

    const ok = await ctx.repo.setRuleEnabled(request.params.id, body.enabled!);
    if (!ok) return reply.code(404).send({ error: "not_found", message: "No such rule." });
    return reply.send({ data: { id: request.params.id, enabled: body.enabled } });
  });

  /**
   * Acknowledge an alert — the one write on this API.
   *
   * Acknowledging is deliberately not resolving. The condition is still true; a
   * human has just taken ownership. Resolution stays with the engine, which
   * clears an alert when the underlying condition actually goes away. Letting a
   * human close an alert whose cause persists is how a fleet ends up looking
   * healthy while screens stay dark.
   */
  app.post<{ Params: { id: string } }>("/api/alerts/:id/acknowledge", async (request, reply) => {
    const parsed = AcknowledgeBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "bad_request",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }

    // A malformed uuid would raise a database error; reject it here so the
    // client gets a 400 rather than a 500.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.params.id)) {
      return reply.code(400).send({ error: "bad_request", message: "Malformed alert id." });
    }

    const acknowledged = await ctx.repo.acknowledgeAlert(request.params.id, parsed.data.by);
    if (!acknowledged) {
      // Idempotent from the client's perspective: already acknowledged, already
      // resolved, or gone all produce the same "nothing to do" answer.
      return reply.code(409).send({
        error: "not_acknowledgeable",
        message: "That alert is already acknowledged, already resolved, or does not exist.",
      });
    }
    return reply.code(200).send({ data: { id: request.params.id, acknowledgedBy: parsed.data.by } });
  });
}
