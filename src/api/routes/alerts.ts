import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { envelope } from "../freshness.js";
import type { ApiContext } from "../server.js";
import { previewRule } from "../../alerting/preview.js";
import type { AlertRule } from "../../alerting/rules.js";
import { resolveActor } from "./audit.js";
import {
  DEFAULT_EXPIRY_DAYS,
  MAX_EXPIRY_DAYS,
  MIN_REASON_LENGTH,
  loadSuppressionView,
} from "../../alerting/suppression.js";
import type { DeviceIntentKind } from "../../intelligence/device-intent.js";

/** Uuid shape check, so a malformed id is a 400 rather than a database 500. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  severity: z.enum(["critical", "high", "medium", "info"]).optional(),
  state: z.enum(["open", "resolved", "all"]).default("open"),
  deviceId: z.string().min(1).max(100).optional(),
  /**
   * Comma-separated device ids. The dormant rollup in /api/alerts/hygiene hands
   * back 104 ids as its drilldown; `deviceId` takes exactly one, so without
   * this the rollup can say "104 devices" and then not list them — a count you
   * cannot open is barely better than a count you cannot see.
   * Capped so a caller cannot smuggle an unbounded IN list through.
   */
  deviceIds: z
    .string()
    .min(1)
    .max(4000)
    .optional()
    .transform((v) =>
      v === undefined
        ? undefined
        : Array.from(new Set(v.split(",").map((x) => x.trim()).filter(Boolean))).slice(0, 500),
    ),
  /**
   * Comma-separated ALERT ids — the drilldown the dormant band wishes it had.
   *
   * `hygiene`'s own comment records the lesson: a client that reproduced a band
   * from `deviceIds` got it wrong, because critical/high alerts stay in the
   * incident list even on a banded device. Publishing and accepting alert ids
   * means the client never has to know the banding rule, so the rule cannot
   * drift out from under it. Capped like `deviceIds` so no caller can smuggle an
   * unbounded IN list through.
   */
  alertIds: z
    .string()
    .min(1)
    .max(20_000)
    .optional()
    .transform((v) =>
      v === undefined
        ? undefined
        : Array.from(new Set(v.split(",").map((x) => x.trim())))
            // Non-uuid entries are DROPPED rather than rejected, because the
            // column is cast to `uuid[]` and one malformed id would 500 the
            // whole request. Dropping is safe here only because this filter
            // fails CLOSED: a list that filters down to nothing matches nothing,
            // so a garbled parameter returns an empty page rather than the
            // entire queue.
            .filter((x) => UUID.test(x))
            .slice(0, 500),
    ),
  /**
   * Which BAND to list — Epic 8.2's suppression band, the dormant band's pattern.
   *
   * Defaults to `all`, which is NOT an oversight. `/api/alerts` is the drilldown
   * surface and it already behaves this way for dormancy: it returns dormant
   * alerts too, and `/api/alerts/hygiene` is what does the banding. The parallel
   * surface here is `/api/alerts/suppressions`. Changing this default would make
   * 69 alerts vanish from any client that had not been updated, which is the
   * silent suppression this whole feature exists to avoid.
   *
   * Membership is resolved by the pure classifier and never re-derived in SQL —
   * see `queries.alerts`'s `excludeAlertIds`.
   */
  band: z.enum(["incident", "suppressed", "all"]).default("all"),
  /**
   * Acknowledged in, out, or both. `all` by default, per docs/23 US-6.2.3:
   * acknowledged alerts are filterable and NEVER hidden by default. A tech who
   * claims an alert has not fixed it.
   */
  acknowledged: z.enum(["yes", "no", "all"]).default("all"),
});

/**
 * ── the technician's work surface (Epic 8.2, GAP-2 + GAP-3) ─────────────────
 *
 * Everything below exists because VFI decided a great deal about what is by
 * design and gave the operator nowhere to record a conclusion of their own.
 * `acknowledge` was built and never called; 22% of the queue was permanent noise
 * that every shift re-triaged from scratch.
 *
 * Design rules these routes hold to, all of them learned from the dormant band:
 *   - nothing is ever deleted. Un-suppression revokes; un-acknowledgement clears
 *     two columns and APPENDS an event, so the release is as visible as the claim;
 *   - a suppressed alert is still open, still counted and still one call away;
 *   - a reason and an expiry are mandatory, and the schema enforces both;
 *   - the alert lifecycle log is append-only. An editable note destroys the audit
 *     value of the thing it records.
 */

/**
 * Who did this.
 *
 * There is no user model (auth is one shared bearer token), so this reports what
 * we actually know and nothing more. An explicit `by` in the body wins because
 * that is the mechanism the console already uses on `acknowledge` and it is the
 * most specific claim available; otherwise we fall back to the audit trail's own
 * resolver (`X-VFI-Actor`, then the token, then anonymous). Either way the result
 * is a CLAIM recorded as a claim — which is still better provenance than none.
 */
function actorFor(ctx: ApiContext, request: FastifyRequest, by?: string | undefined): string {
  const named = by?.trim().slice(0, 120);
  if (named) return `api:${named}`;
  const header = request.headers["x-vfi-actor"];
  return resolveActor({
    actorHeader: Array.isArray(header) ? header[0] : header,
    authorization: request.headers.authorization,
    allowAnonymous: ctx.allowAnonymous,
  });
}

const ByField = z.string().min(1).max(200).optional();

/**
 * Intent vocabulary, as a zod tuple.
 *
 * Written out rather than spread from `RECORDABLE_INTENT_KINDS` so that adding a
 * kind is a deliberate three-place edit — here, the type union, and the schema's
 * CHECK constraint. A vocabulary that can widen in one place and not the others
 * is how a value the database accepts becomes one the API cannot express.
 */
const INTENT_VALUES = [
  "eol", "not-product", "repair", "prototype", "lab", "test", "demo-unit",
  "internal-account", "none",
] as const;

const CreateSuppressionBody = z
  .object({
    deviceId: z.string().min(1).max(100),
    /**
     * Absent/null = the WHOLE DEVICE ("this unit lives in the lab"). A rule id =
     * that rule on that device only ("the brightness drift on the lobby screen is
     * deliberate"). Both scopes exist because both statements get made; see
     * alerting/suppression.ts for why neither alone is sufficient.
     */
    ruleId: z.string().min(1).max(100).nullish(),
    /**
     * Mandatory, and the minimum length is the point. A suppression with no
     * reason is indistinguishable from a bug six weeks later, and the person who
     * has to tell them apart is not the person who created it.
     */
    reason: z.string().trim().min(MIN_REASON_LENGTH).max(2000),
    /** The operator's recorded purpose for the ASSET. `none` = "the name lies". */
    intent: z.enum(INTENT_VALUES).nullish(),
    /**
     * Only meaningful on a rule-scoped record; the database CHECK rejects it on a
     * whole-device one, and we reject it here first so the caller gets a sentence
     * rather than a constraint name.
     */
    includeCriticalHigh: z.boolean().default(false),
    /** Finite expiry in days. Omitted = DEFAULT_EXPIRY_DAYS. */
    expiresInDays: z.number().int().min(1).max(MAX_EXPIRY_DAYS).optional(),
    /**
     * A deliberate permanent suppression, for a genuinely retired asset. Must be
     * asked for in as many words — this is never the default, and it cannot be
     * reached by simply omitting an expiry.
     */
    neverExpires: z.boolean().default(false),
    by: ByField,
  })
  .refine((b) => !(b.neverExpires && b.expiresInDays !== undefined), {
    message:
      "neverExpires and expiresInDays contradict each other. Pick one: a finite " +
      "expiry in days, or an explicit permanent suppression.",
  })
  .refine((b) => !(b.includeCriticalHigh && !b.ruleId), {
    message:
      "includeCriticalHigh requires a ruleId. A whole-device suppression may never " +
      "absorb a critical or high alert: if a critical rule fires on a device we " +
      "believe is by-design, the device spoke, and that is news. Suppress the " +
      "specific rule instead.",
  });

const RevokeSuppressionBody = z.object({
  /** Optional, but strongly wanted: why the mute came off is half the audit. */
  reason: z.string().trim().min(1).max(2000).optional(),
  by: ByField,
});

const NoteBody = z.object({
  body: z.string().trim().min(1).max(4000),
  by: ByField,
});

const UnacknowledgeBody = z.object({
  /** Why it was released. Free text; recorded on the event. */
  reason: z.string().trim().min(1).max(2000).optional(),
  by: ByField,
});

const AcknowledgeBody = z.object({
  /**
   * Who is acknowledging. Supplied by the caller for now; it becomes the
   * authenticated identity once JWT auth replaces the shared token (auth.ts).
   */
  by: z.string().min(1).max(200),
  /**
   * An optional note to file with the claim — "on site Thursday", "waiting on
   * the customer". Optional because forcing a note onto every claim makes
   * claiming slow enough that people stop doing it, and an unclaimed queue is
   * the failure we are actually fixing. Recorded as a normal append-only note,
   * so it appears in the history alongside the acknowledgement.
   */
  note: z.string().trim().min(1).max(4000).optional(),
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

    // The suppression band is resolved by the PURE classifier and handed to the
    // query as ids, rather than re-encoded as a second SQL predicate. That is
    // deliberate: the critical/high safety valve means the suppressed DEVICE set
    // is a superset of the suppressed ALERT set, and two implementations of that
    // rule would eventually disagree — at which point the queue and the chip stop
    // summing and the surface loses its credibility. Costs two aggregate reads,
    // the same two `/api/alerts/hygiene` already pays.
    const view = await loadSuppressionView(ctx.repo);
    const suppressedIds = new Set(view.suppressed.alertIds);
    const heldBackIds = new Set(view.suppressed.heldBackAlertIds);

    const [result, freshness] = await Promise.all([
      ctx.queries.alerts({
        ...filters,
        alertIds:
          filters.band === "suppressed"
            ? // Intersect rather than replace, so `band=suppressed&deviceId=X`
              // narrows instead of one filter quietly winning.
              view.suppressed.alertIds
            : filters.alertIds,
        excludeAlertIds: filters.band === "incident" ? view.suppressed.alertIds : undefined,
      }),
      ctx.freshness(),
    ]);

    return envelope(
      result.items.map((item) => ({
        ...item,
        /**
         * Is this alert OUT of the incident queue? The authoritative answer, from
         * the classifier. Distinct from `suppression` (which the query supplies
         * and which only says a record covers this alert) precisely so the UI can
         * render the useful tension: a covering suppression plus
         * `suppressed: false` is the safety valve doing its job.
         */
        suppressed: suppressedIds.has(item["id"] as string),
        /**
         * True when a suppression covers this alert and it was KEPT in the queue
         * anyway — critical/high on a whole-device mute. Worth a badge: it is the
         * one case where "I muted this, why am I still seeing it" has a good
         * answer.
         */
        suppressionHeldBack: heldBackIds.has(item["id"] as string),
      })),
      freshness,
      // The band reconciliation (`incidents + suppressed === totalOpen`) lives on
      // `/api/alerts/suppressions`, not here — the standard envelope's `page`
      // block is a closed shape shared by every paginated endpoint, and this
      // endpoint's contract stays exactly as it was. Same division of labour as
      // dormancy: `/api/alerts` lists, `/api/alerts/hygiene` bands.
      {
        page: filters.page,
        limit: filters.limit,
        totalItems: result.totalItems,
        totalPages: Math.max(1, Math.ceil(result.totalItems / filters.limit)),
      },
    );
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
    if (!UUID.test(request.params.id)) {
      return reply.code(400).send({ error: "bad_request", message: "Malformed alert id." });
    }

    // Read the scope BEFORE the write, so the lifecycle event can be attributed
    // to a device even if the alert is resolved out from under us in between.
    const scope = await ctx.repo.alertScope(request.params.id);

    const acknowledged = await ctx.repo.acknowledgeAlert(request.params.id, parsed.data.by);
    if (!acknowledged) {
      // Idempotent from the client's perspective: already acknowledged, already
      // resolved, or gone all produce the same "nothing to do" answer. Now with
      // a hint at the release path, which is what a tech who clicked the wrong
      // row actually needs to hear.
      return reply.code(409).send({
        error: "not_acknowledgeable",
        message:
          "That alert is already acknowledged, already resolved, or does not exist. " +
          "To hand back an alert you claimed, POST /api/alerts/:id/unacknowledge.",
      });
    }

    // Epic 8.2: the claim is now recorded in the append-only lifecycle log too,
    // not just as two columns on `alerts`. The columns hold the CURRENT owner and
    // are overwritten by the next claim; the log holds every claim and release
    // there has ever been, which is what "there is a record that someone looked
    // at this" actually requires.
    const actor = actorFor(ctx, request, parsed.data.by);
    let events = 0;
    if (scope) {
      await ctx.repo.appendAlertEvent({
        alertId: request.params.id,
        deviceId: scope.deviceId,
        kind: "acknowledge",
        actor,
        actorIp: request.ip ?? null,
      });
      events += 1;
      if (parsed.data.note) {
        await ctx.repo.appendAlertEvent({
          alertId: request.params.id,
          deviceId: scope.deviceId,
          kind: "note",
          body: parsed.data.note,
          actor,
          actorIp: request.ip ?? null,
        });
        events += 1;
      }
    }

    return reply.code(200).send({
      data: {
        id: request.params.id,
        acknowledgedBy: parsed.data.by,
        actor,
        /** Absolute, so the console can render "claimed 12 min ago" from a clock. */
        acknowledgedAt: new Date().toISOString(),
        eventsAppended: events,
      },
    });
  });

  // ── suppressions ───────────────────────────────────────────────────────────

  /**
   * The suppression band and every record behind it.
   *
   * The parallel of `/api/alerts/hygiene` for the dormant band, and deliberately
   * the same shape: a counted band, a chip that sums with the incident chip to
   * the grand total, the ALERT ids so the drilldown cannot drift, plain-language
   * notes, and the held-back criticals published so the safety valve is auditable
   * rather than merely described.
   *
   * It also reports what most surfaces like this omit: records in force that are
   * suppressing NOTHING (candidates for revocation, and the answer to "I muted
   * this, why am I seeing it") and records that have LAPSED with the count of
   * alerts that came back because of it. Re-escalation you cannot count is
   * re-escalation you have to take on trust.
   */
  app.get("/api/alerts/suppressions", async (_request, reply) => {
    const [view, freshness] = await Promise.all([loadSuppressionView(ctx.repo), ctx.freshness()]);
    return reply.send(
      envelope(
        {
          ...view,
          policy: {
            defaultExpiryDays: DEFAULT_EXPIRY_DAYS,
            maxExpiryDays: MAX_EXPIRY_DAYS,
            minReasonLength: MIN_REASON_LENGTH,
            intentKinds: INTENT_VALUES,
            /** Stated in the payload so a client renders the rule rather than guessing it. */
            neverAbsorbedSeverities: ["critical", "high"],
          },
        },
        freshness,
      ),
    );
  });

  /**
   * Record a suppression — "this is meant to be like this, stop telling me".
   *
   * Creating one for a scope that already has one SUPERSEDES the incumbent: the
   * old record is revoked (never deleted) with an attributed reason, so the
   * history reads as a sequence of decisions rather than as one mutable row.
   *
   * Writes an `alert_events` row against every open alert the new record covers,
   * so the suppression appears in each alert's own lifecycle. A tech reading one
   * alert should not have to know that a fleet-level record exists to understand
   * why it went quiet.
   */
  app.post("/api/alerts/suppressions", async (request, reply) => {
    const parsed = CreateSuppressionBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "bad_request",
        message: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      });
    }
    const body = parsed.data;

    // Refuse against a device we do not have. A suppression on an unknown id is
    // a mute that will never lapse and never match anything — the exact orphan
    // this feature must not accumulate.
    const device = await ctx.queries.deviceExists(body.deviceId);
    if (!device) {
      return reply.code(404).send({
        error: "not_found",
        message: `No device "${body.deviceId}". Suppressions are scoped to a device we hold.`,
      });
    }

    const now = new Date();
    const expiresAt = body.neverExpires
      ? null
      : new Date(now.getTime() + (body.expiresInDays ?? DEFAULT_EXPIRY_DAYS) * 86_400_000);

    const actor = actorFor(ctx, request, body.by);
    const created = await ctx.repo.createSuppression({
      deviceId: body.deviceId,
      ruleId: body.ruleId ?? null,
      reason: body.reason,
      intent: (body.intent ?? null) as DeviceIntentKind | null,
      includeCriticalHigh: body.includeCriticalHigh,
      createdBy: actor,
      expiresAt,
      neverExpires: body.neverExpires,
    });

    // Recompute so the answer states the ACTUAL effect rather than the intended
    // one. "You suppressed 4 alerts and 1 critical stayed in the queue" is the
    // sentence that stops the operator believing they silenced something they
    // did not.
    const view = await loadSuppressionView(ctx.repo, { now });
    const record = view.suppressed.byRecord.find((r) => r.suppressionId === created.id);
    const covered = await ctx.repo.openAlertIdsForScope(body.deviceId, body.ruleId ?? null);
    for (const alertId of covered) {
      await ctx.repo.appendAlertEvent({
        alertId,
        deviceId: body.deviceId,
        kind: "suppress",
        body: body.reason,
        suppressionId: created.id,
        actor,
        actorIp: request.ip ?? null,
      });
    }

    return reply.code(201).send({
      data: {
        id: created.id,
        supersededId: created.supersededId,
        deviceId: body.deviceId,
        ruleId: body.ruleId ?? null,
        scope: body.ruleId ? "rule" : "device",
        intent: body.intent ?? null,
        createdBy: actor,
        expiresAt: expiresAt?.toISOString() ?? null,
        neverExpires: body.neverExpires,
        /** Open alerts this record is suppressing right now. May be 0. */
        alertsSuppressed: record?.alertCount ?? 0,
        /**
         * Open alerts on this scope that were NOT suppressed. On a whole-device
         * record these are the criticals and highs the safety valve held back,
         * and the count is stated here so the operator learns it at the moment
         * they act rather than by noticing later.
         */
        alertsHeldBack: covered.length - (record?.alertCount ?? 0),
        bands: {
          totalOpen: view.totalOpen,
          incidents: view.incidents.total,
          suppressed: view.suppressed.total,
        },
      },
    });
  });

  /**
   * Un-suppress. An UPDATE of three columns, never a DELETE.
   *
   * The alerts return to the incident list at their normal rank on the next read
   * — no re-open, no re-fire, because they were never closed. That is the whole
   * argument for banding over muting.
   */
  app.post<{ Params: { id: string } }>("/api/alerts/suppressions/:id/revoke", async (request, reply) => {
    if (!UUID.test(request.params.id)) {
      return reply.code(400).send({ error: "bad_request", message: "Malformed suppression id." });
    }
    const parsed = RevokeSuppressionBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "bad_request",
        message: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      });
    }

    const existing = (await ctx.repo.listSuppressions({ includeLapsed: true })).find(
      (r) => r.id === request.params.id,
    );
    if (!existing) {
      return reply.code(404).send({ error: "not_found", message: "No such suppression." });
    }

    const actor = actorFor(ctx, request, parsed.data.by);
    const revoked = await ctx.repo.revokeSuppression(
      request.params.id, actor, parsed.data.reason ?? null,
    );
    if (!revoked) {
      // Already revoked. Reported as a conflict rather than a success so a
      // second click cannot overwrite the first revoker — who un-muted it, and
      // why, is the fact this record exists to keep.
      return reply.code(409).send({
        error: "already_revoked",
        message:
          `That suppression was already revoked by ${existing.revokedBy} at ` +
          `${existing.revokedAt?.toISOString()}. The original revocation is kept as-is.`,
      });
    }

    const returned = await ctx.repo.openAlertIdsForScope(existing.deviceId, existing.ruleId);
    for (const alertId of returned) {
      await ctx.repo.appendAlertEvent({
        alertId,
        deviceId: existing.deviceId,
        kind: "unsuppress",
        body: parsed.data.reason ?? null,
        suppressionId: existing.id,
        actor,
        actorIp: request.ip ?? null,
      });
    }

    return reply.code(200).send({
      data: {
        id: existing.id,
        revokedBy: actor,
        /** Alerts back in the incident list at their normal rank, right now. */
        alertsReturned: returned.length,
      },
    });
  });

  // ── one alert, in full ─────────────────────────────────────────────────────

  /**
   * Everything a technician needs about one alert: its state, who claimed it,
   * the suppression covering it, and the whole append-only note history.
   *
   * The list endpoint carries a note COUNT; this carries the notes. That split is
   * on purpose — the count is what a 110-row queue can afford to render, and the
   * history is what the drawer needs, and fetching every note for every row to
   * satisfy the drawer is how a triage list becomes slow.
   */
  app.get<{ Params: { id: string } }>("/api/alerts/:id", async (request, reply) => {
    if (!UUID.test(request.params.id)) {
      return reply.code(400).send({ error: "bad_request", message: "Malformed alert id." });
    }
    const [detail, freshness] = await Promise.all([
      ctx.queries.alert(request.params.id),
      ctx.freshness(),
    ]);
    if (!detail) return reply.code(404).send({ error: "not_found", message: "No such alert." });

    const events = await ctx.repo.alertEvents(request.params.id);
    const view = await loadSuppressionView(ctx.repo);
    return reply.send(
      envelope(
        {
          ...detail,
          suppressed: view.suppressed.alertIds.includes(request.params.id),
          suppressionHeldBack: view.suppressed.heldBackAlertIds.includes(request.params.id),
          /**
           * The whole lifecycle, oldest first — claimed, noted, released, muted.
           * Append-only: no event here has ever been edited, which is what makes
           * "what did the last shift actually conclude" answerable.
           */
          events: events.map((e) => ({
            id: e.id,
            kind: e.kind,
            body: e.body,
            suppressionId: e.suppressionId,
            actor: e.actor,
            createdAt: e.createdAt.toISOString(),
          })),
          noteCount: events.filter((e) => e.kind === "note").length,
        },
        freshness,
      ),
    );
  });

  /**
   * Release an alert claimed by mistake.
   *
   * A tech who claims the wrong row must be able to hand it back — without this,
   * the first accidental click makes an alert look permanently owned and the
   * queue silently loses an item to a colleague who never worked it.
   *
   * Deliberately does NOT check that the releaser is the acknowledger. With one
   * shared bearer token, `acknowledged_by` is an unverified claim, and enforcing
   * ownership against an unverified name is security theatre that would also
   * strand every alert claimed by someone now off shift. The event log records
   * who released it, which is the honest version of the same protection.
   */
  app.post<{ Params: { id: string } }>("/api/alerts/:id/unacknowledge", async (request, reply) => {
    if (!UUID.test(request.params.id)) {
      return reply.code(400).send({ error: "bad_request", message: "Malformed alert id." });
    }
    const parsed = UnacknowledgeBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "bad_request",
        message: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      });
    }
    const scope = await ctx.repo.alertScope(request.params.id);
    if (!scope) return reply.code(404).send({ error: "not_found", message: "No such alert." });

    const released = await ctx.repo.unacknowledgeAlert(request.params.id);
    if (!released) {
      return reply.code(409).send({
        error: "not_releasable",
        message: "That alert is not acknowledged, or is already resolved.",
      });
    }
    const actor = actorFor(ctx, request, parsed.data.by);
    // Appended AFTER the release succeeds, so the log never claims an event that
    // did not happen. The release is as visible as the claim was — an alert that
    // quietly became unowned is how a queue loses work.
    await ctx.repo.appendAlertEvent({
      alertId: request.params.id,
      deviceId: scope.deviceId,
      kind: "unacknowledge",
      body: parsed.data.reason ?? null,
      actor,
      actorIp: request.ip ?? null,
    });
    return reply.code(200).send({ data: { id: request.params.id, acknowledgedBy: null, releasedBy: actor } });
  });

  /**
   * Append a note. Append-ONLY: there is no edit and no delete.
   *
   * An editable note destroys the audit value of the thing it records — the next
   * shift needs what the last shift ACTUALLY wrote, not the tidied version, and
   * "I found the PSU unplugged" being silently replaced by "resolved" is the
   * failure mode. A correction is a second note.
   */
  app.post<{ Params: { id: string } }>("/api/alerts/:id/notes", async (request, reply) => {
    if (!UUID.test(request.params.id)) {
      return reply.code(400).send({ error: "bad_request", message: "Malformed alert id." });
    }
    const parsed = NoteBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "bad_request",
        message: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      });
    }
    const scope = await ctx.repo.alertScope(request.params.id);
    if (!scope) return reply.code(404).send({ error: "not_found", message: "No such alert." });

    // A note is allowed on a RESOLVED alert on purpose: "this came back twice, it
    // is the switch not the panel" is written after the fact, and refusing it
    // would push the one durable piece of knowledge into a chat message.
    const actor = actorFor(ctx, request, parsed.data.by);
    const id = await ctx.repo.appendAlertEvent({
      alertId: request.params.id,
      deviceId: scope.deviceId,
      kind: "note",
      body: parsed.data.body,
      actor,
      actorIp: request.ip ?? null,
    });
    return reply.code(201).send({
      data: { id, alertId: request.params.id, actor, body: parsed.data.body },
    });
  });
}
