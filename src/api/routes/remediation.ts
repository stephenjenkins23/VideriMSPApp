import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { envelope } from "../freshness.js";
import {
  byCauseFromChurn,
  byCauseUnavailable,
  recommendationsFor,
  summarize,
  type DeviceView,
  type Recommendation,
  type RemediationByCause,
} from "../../intelligence/remediation.js";
import {
  analyzeChurn,
  judgeObservation,
  judgeWatermark,
  observationFrom,
  type PriorItem,
} from "../../intelligence/churn.js";
import { recordedIntentByDevice } from "../../alerting/suppression.js";
import type { ApiContext } from "../server.js";

/**
 * Caps on the baseline, and why they are so much lower than the churn
 * endpoint's 3,000.
 *
 * This one travels in a request LINE, which Node counts against its 16 KB header
 * ceiling — a baseline the size of the full manual set (259 items × ~39 chars of
 * id on this fleet today) would be rejected by the transport with a 431 and no
 * explanation an operator could act on. So the ceiling is ours, it is stated,
 * and it is a REFUSAL rather than a truncation: silently dropping ids would
 * shrink the caller's baseline and flatter us with departures that never
 * happened. 120 ids comfortably covers the `auto-safe` queue this story is about
 * (5 items today, 20 at the collapse GAP-7 recorded); anything larger belongs in
 * POST /api/trends/churn, which the reason says.
 */
const MAX_PREVIOUS_IDS = 120;
const MAX_PREVIOUS_CHARS = 6000;

/**
 * The optional baseline that turns `summary.byCause` from a null into a tally
 * (US-8.6.3).
 *
 * None of these parameters filter the returned list, and that is deliberate:
 * `recommendations` stays the FULL set whatever is asked about churn, because a
 * diff that doubled as the queue would be a filter and a filter is how items
 * disappear (US-6.2.3).
 */
const Query = z.object({
  /**
   * The watermark: an absolute ISO instant — the moment the read you are
   * diffing against was taken. Judged by `judgeWatermark`, never defaulted: a
   * defaulted watermark reports the whole queue as new.
   */
  since: z.string().min(1).optional(),
  /**
   * Comma-separated recommendation ids you held at `since`. Deliberately NOT
   * `.min(1)`: an explicitly EMPTY `previous=` is a legitimate baseline ("I
   * looked and the queue was empty"), so presence of the parameter, not its
   * length, is what says a prior set exists — the same rule the churn endpoint's
   * body follows.
   */
  previous: z.string().max(MAX_PREVIOUS_CHARS).optional(),
  /**
   * Which set the baseline describes. Named `churnKind` rather than `kind` so it
   * cannot be misread as filtering the list: it scopes the DIFF only.
   */
  churnKind: z.enum(["auto-safe", "manual"]).default("auto-safe"),
  /** Bucket size for the collector-coverage check. Same bounds as /api/trends/churn. */
  bucketSeconds: z.coerce.number().int().min(60).max(3600).default(300),
});

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
   *
   * `summary.byCause` (US-8.6.3) answers "why is this set different from the one
   * I was looking at" in THIS response rather than in a second call — but only
   * when the caller attests to what it was looking at, because no recommendation
   * snapshot exists to compare against. Without that it is an explained null.
   * Two rules hold at this boundary:
   *
   *   1. The QUEUE IS NEVER WITHHELD over a baseline problem. A malformed
   *      `since`, an over-long `previous`, a query we could not parse, even a
   *      failure to read our own collection — none of them 400 this endpoint or
   *      empty it. They are reported inside `summary.byCause` as a null with the
   *      reason, because the operator's work list is the payload and an optional
   *      annotation is not allowed to take it away.
   *   2. The diff is computed from the SAME `recommendations` array and the SAME
   *      devices this response returns — one engine run, not a second query path
   *      — so the breakdown cannot describe a set the caller never saw.
   */
  app.get("/api/remediation", async (request, reply) => {
    const now = new Date();
    const [devices, suppressions, freshness] = await Promise.all([
      ctx.queries.remediationDevices(),
      // US-8.2.7. The operator's RECORDED intent per device, which always
      // outranks the name heuristic in the engine — including the `none` value,
      // which is how someone tells us a device called `Repairs Desk Menu Board`
      // is a production screen and we should stop demoting it. Loaded here rather
      // than joined in `remediationDevices` so the precedence rule exists in
      // exactly one place (`resolveIntent`) and cannot be half-implemented in SQL.
      ctx.repo.listSuppressions(),
      ctx.freshness(),
    ]);

    const recommendations = recommendationsFor(devices, now, {
      recordedIntent: recordedIntentByDevice(suppressions, now),
    });

    const byCause = await resolveByCause(request, ctx, devices, recommendations, now);

    return reply.send(
      envelope(
        {
          recommendations,
          summary: summarize(recommendations, byCause),
          // How many devices were considered, so an empty list reads as
          // "nothing to do" rather than "we saw nothing".
          devicesConsidered: devices.length,
        },
        freshness,
      ),
    );
  });

  /**
   * Build `summary.byCause`, or the explained null that stands in for it.
   *
   * Separated from the handler because every branch here is a refusal with a
   * reason, and they are easier to read — and to keep honest — in one ladder
   * than interleaved with the happy path. Returns `undefined` for "nobody asked",
   * which `summarize` renders as the `no-baseline` null.
   */
  async function resolveByCause(
    request: FastifyRequest,
    context: ApiContext,
    devices: DeviceView[],
    recommendations: Recommendation[],
    now: Date,
  ): Promise<RemediationByCause | undefined> {
    // Presence in the RAW query, before parsing: a caller who asked for no diff
    // must get `no-baseline`, not a complaint about a parameter they never sent.
    const raw = (request.query ?? {}) as Record<string, unknown>;
    if (raw.since === undefined && raw.previous === undefined) return undefined;

    const parsed = Query.safeParse(raw);
    if (!parsed.success) {
      return byCauseUnavailable(
        "unusable-baseline",
        `The baseline on the query string could not be used — ` +
          `${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. ` +
          `The recommendation list in this response is unaffected; only this breakdown is.`,
      );
    }
    const { since, previous, churnKind, bucketSeconds } = parsed.data;

    if (previous === undefined) {
      // judgeWatermark reports this as `no-prior-set` with the reason we want,
      // so let it say so rather than paraphrasing the same fact twice.
      const verdict = judgeWatermark(since, now, false);
      return byCauseUnavailable(
        "unusable-baseline",
        verdict.message ??
          "A `since` was supplied without a `previous`, and there is no stored snapshot of your " +
            "last read to substitute for it.",
      );
    }
    if (since === undefined) {
      return byCauseUnavailable(
        "unusable-baseline",
        "`previous` was supplied without `since`. A diff needs the INSTANT your read was taken " +
          "as well as its contents: every schedule cause is judged by comparing your device's " +
          "own on/off window at that instant against the same window now, and the collector's " +
          "coverage of the span between them is what decides whether `applied` may be claimed " +
          "at all. Without the instant there is no span, and a guessed one would invent both.",
      );
    }

    const ids = Array.from(new Set(previous.split(",").map((part) => part.trim()).filter(Boolean)));
    if (ids.length > MAX_PREVIOUS_IDS) {
      return byCauseUnavailable(
        "unusable-baseline",
        `The baseline carries ${ids.length} ids, past the ${MAX_PREVIOUS_IDS} this endpoint ` +
          `accepts on a query string (a request line has a hard transport ceiling, and a ` +
          `truncated baseline would report departures that never happened). Refused rather ` +
          `than trimmed — POST the full baseline to /api/trends/churn, which takes 3,000.`,
      );
    }

    const watermark = judgeWatermark(since, now, true);
    if (!watermark.ok || watermark.at === null) {
      return byCauseUnavailable(
        "unusable-baseline",
        watermark.message ?? "The watermark could not be used, and no reason was given.",
      );
    }

    const windowFrom = watermark.at.toISOString();
    const windowTo = now.toISOString();
    let bucketStarts: number[];
    try {
      bucketStarts = await context.queries.observedBucketStarts(windowFrom, windowTo, bucketSeconds);
    } catch (error) {
      // Our own collection is what the gates are judged from. If we cannot read
      // it we do not know whether we were watching, and every cause below would
      // rest on that unknown — so this is a null with the reason, never a
      // breakdown computed as though coverage were perfect.
      request.log.error({ err: error }, "byCause: observed-bucket read failed");
      return byCauseUnavailable(
        "window-unreadable",
        `We could not read our own collection coverage for the window ${windowFrom} → ` +
          `${windowTo} (${(error as Error).message}). Whether the collector was watching is ` +
          `what decides which causes are claimable, so with that unknown nothing is ` +
          `attributed. This is a fault on our side, not a fact about your fleet.`,
      );
    }

    const report = analyzeChurn({
      previous: {
        observedAt: windowFrom,
        // Ids only: a query string carries no severities, so `changed` is
        // unknowable and the churn engine says so rather than reporting zero
        // changes. This block publishes departures, which need no severity.
        items: ids.map((id) => ({ id })) as PriorItem[],
      },
      current: { observedAt: windowTo, recommendations },
      devices,
      kind: churnKind,
      verdict: judgeObservation(
        observationFrom(windowFrom, windowTo, bucketSeconds, bucketStarts),
      ),
    });
    return byCauseFromChurn(report);
  }
}
