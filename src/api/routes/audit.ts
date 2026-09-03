/**
 * The audit trail — what VFI did, not what the platform told us.
 *
 * Twenty-one tables recorded the fleet's state; none recorded our own writes.
 * VFI fires real device commands — a brightness write with a
 * preflight → verify → rollback cycle — and until now the only trace was a
 * transient banner in the console drawer, lost on the next render. "What did we
 * change on this screen last week, and who asked for it?" had no answer, and
 * `GET /api/commands` is a capability CATALOGUE, not a log.
 *
 * For an MSP acting on a customer's estate that is a trust and dispute problem.
 * It is built BEFORE the bulk-write work on purpose, so the write surface never
 * grows unlogged.
 *
 * This endpoint is READ-ONLY and answers the four questions that actually get
 * asked — everything we did to device X, everything in this window, everything
 * that failed, everything a given actor did — each backed by its own index (see
 * migrations/009-device-action-log.sql).
 *
 * The pure helpers below (`resolveActor`, `auditOutcomeForBrightness`) live here
 * rather than in the routes that use them so that the outcome vocabulary and the
 * writers of it sit in one file: the CHECK constraint on the table is only as
 * good as the single mapper the app funnels through.
 */

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../server.js";
import { envelope } from "../freshness.js";
import {
  AUDIT_RETAIN_DAYS,
  DEVICE_ACTION_OUTCOMES,
  type DeviceActionOutcome,
  type DeviceActionRow,
} from "../../db/repository.js";
import type { BrightnessState } from "../../videri/brightness.js";

/**
 * Map a brightness cycle's internal state onto the audit vocabulary.
 *
 * Pure and exhaustive on purpose: `outcome` is CHECKed in the database and
 * filtered on by this endpoint, so a state the mapper does not know must be a
 * compile error here rather than a rejected INSERT at write time (which the
 * write path would swallow, per "a logging failure never breaks the operation" —
 * leaving a silent hole in the audit exactly when a write misbehaved).
 *
 * `preflight_blocked` is `refused`, not `failed`: we declined to write because
 * the original value was unreadable, and the panel was never touched.
 * `write_rejected` is `failed`: we did write, and the device said no.
 */
export function auditOutcomeForBrightness(state: BrightnessState): DeviceActionOutcome {
  switch (state) {
    case "verified": return "verified";
    case "no_change": return "no_change";
    case "preflight_blocked": return "refused";
    case "write_rejected": return "failed";
    case "unconfirmed_rolled_back": return "rolled_back";
    case "unconfirmed_rollback_failed": return "rollback_failed";
  }
}

/**
 * Who or what initiated an action.
 *
 * There is NO user model: auth is a single shared bearer token (api/auth.ts), so
 * inventing a user id here would be fabricating provenance in the one table
 * whose entire value is that it does not. So this reports exactly what we know:
 *
 *   api:<name>     — the caller identified itself via `X-VFI-Actor`. Trusted no
 *                    further than the token is: it is a claim, and it is
 *                    recorded as a claim, which is still better provenance than
 *                    none while it is the only identity the console can offer.
 *   api:token      — a caller holding the shared token, unnamed.
 *   api:anonymous  — the server was started with --allow-anonymous (local dev).
 *
 * Pollers pass their own `poller:<lane>` string and never go through this.
 *
 * The header is trimmed and length-capped: an actor is an index key and a log
 * line, not a place to store a kilobyte.
 */
export function resolveActor(input: {
  actorHeader?: string | undefined;
  authorization?: string | undefined;
  allowAnonymous: boolean;
}): string {
  const named = input.actorHeader?.trim().slice(0, 120);
  if (named) return `api:${named}`;
  if (input.authorization) return "api:token";
  return input.allowAnonymous ? "api:anonymous" : "api:token";
}

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  deviceId: z.string().min(1).max(100).optional(),
  actor: z.string().min(1).max(200).optional(),
  /**
   * Comma-separated, so "everything that failed" is one call:
   * `outcome=failed,rolled_back,rollback_failed`. Validated against the closed
   * vocabulary rather than passed through — a typo that silently matches zero
   * rows would read as "we did nothing", which is the worst possible wrong
   * answer from an audit log.
   */
  outcome: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      const parts = Array.from(new Set(v.split(",").map((x) => x.trim()).filter(Boolean)));
      const bad = parts.filter((p) => !DEVICE_ACTION_OUTCOMES.includes(p as DeviceActionOutcome));
      if (bad.length > 0) {
        ctx.addIssue({
          code: "custom",
          message:
            `unknown outcome(s) ${bad.join(", ")}. Valid: ${DEVICE_ACTION_OUTCOMES.join(", ")}.`,
        });
        return z.NEVER;
      }
      return parts as DeviceActionOutcome[];
    }),
  action: z.string().min(1).max(64).optional(),
  /** Half-open window [since, until) on when the action STARTED. */
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
});

/** Dates out as ISO strings; `null` stays `null` and never becomes an epoch. */
const serialise = (row: DeviceActionRow) => ({
  ...row,
  startedAt: row.startedAt.toISOString(),
  finishedAt: row.finishedAt.toISOString(),
});

export async function registerAuditRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  app.get("/api/audit", async (request, reply) => {
    const parsed = ListQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "bad_request",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }
    const f = parsed.data;
    if (f.since && f.until && f.since >= f.until) {
      return reply.code(400).send({
        error: "bad_request",
        message: "`since` must be earlier than `until`; the window is half-open [since, until).",
      });
    }

    const [result, freshness] = await Promise.all([
      ctx.repo.listDeviceActions({
        deviceId: f.deviceId,
        actor: f.actor,
        outcome: f.outcome,
        action: f.action,
        since: f.since,
        until: f.until,
        page: f.page,
        limit: f.limit,
      }),
      ctx.freshness(),
    ]);

    /**
     * An empty log must say WHICH empty it is. "We have never logged an action"
     * and "your filter matched nothing" are different facts, and reporting the
     * first as the second (or either as a bare `[]`) is how someone concludes a
     * write went unrecorded when it did not. The extra count runs only when the
     * page came back empty.
     */
    let emptyReason: string | null = null;
    if (result.items.length === 0) {
      const total = await ctx.repo.deviceActionLogSize();
      emptyReason =
        total === 0
          ? "No device action has been logged yet. This log starts empty and is only " +
            "written when VFI actually writes to a device; nothing here is inferred " +
            "or backfilled, so an empty log means no write has happened under this build."
          : result.totalItems === 0
            ? "No logged action matches these filters."
            : `Page ${f.page} is past the end of ${result.totalItems} matching action(s).`;
    }

    return envelope(
      {
        actions: result.items.map(serialise),
        /**
         * Span of the MATCHED set, not of the page — a caller on page 1 of 40
         * still needs to know how far back the match reaches.
         */
        oldestActionAt: result.oldestAt?.toISOString() ?? null,
        newestActionAt: result.newestAt?.toISOString() ?? null,
        emptyReason,
        /**
         * Stated in the response because a reader of an audit log has to know
         * whether absence of a row means "it did not happen" or "it aged out".
         */
        retention: {
          retainDays: AUDIT_RETAIN_DAYS,
          /**
           * False today: nothing calls `pruneDeviceActionLog`. The bound is a
           * declared ceiling, not an active deletion — the same honest status as
           * the `fleet_snapshots` bound, which has never yet deleted a live row.
           */
          enforced: false,
          note:
            `The audit log is bounded at ${AUDIT_RETAIN_DAYS} days as a ceiling, ` +
            `deliberately far longer than the 14-90 day windows used for ` +
            `measurement history, and it is kept out of the nightly retention ` +
            `sweep. No pruning is wired up, so nothing has aged out: absence of a ` +
            `row means the action was not logged, not that it expired.`,
        },
      },
      freshness,
      {
        page: f.page,
        limit: f.limit,
        totalItems: result.totalItems,
        totalPages: Math.max(1, Math.ceil(result.totalItems / f.limit)),
      },
    );
  });
}
