import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { envelope } from "../freshness.js";
import {
  analyzeAvailability,
  analyzeStorage,
  analyzeTransmissionSilence,
  buildTrendReport,
  SILENCE_GATES,
  type TrendDevice,
  type WindowRef,
} from "../../intelligence/trends.js";
import {
  analyzeChurn,
  buildFirstLook,
  judgeObservation,
  judgeWatermark,
  observationFrom,
  WATERMARK_BASIS,
  WATERMARK_MAX_AGE_DAYS,
  type PriorItem,
} from "../../intelligence/churn.js";
import { recommendationsFor } from "../../intelligence/remediation.js";
import { recordedIntentByDevice } from "../../alerting/suppression.js";
import { GroupSiteCache, resolveSite } from "../../videri/services/group-hierarchy.js";
import type { ApiContext } from "../server.js";

const Query = z.object({
  /**
   * Length of EACH availability window. The recent window is the last N days and
   * the prior window is the N days before it, so `7` is week-over-week — the
   * headline comparison. Capped at 90 because nothing older than that is dense
   * enough on this deployment to be a baseline.
   */
  windowDays: z.coerce.number().int().min(1).max(90).default(7),
  /**
   * Bucket size for presence. Smaller buckets measure availability more strictly
   * and are harder to clear the sample gates with; 300s matches the SLA module.
   */
  bucketSeconds: z.coerce.number().int().min(60).max(3600).default(300),
  /** Lookback for the storage fill fit. */
  storageDays: z.coerce.number().int().min(2).max(90).default(14),
});

/** Human window label. Every trend statement quotes one, so it must read well. */
const labelWindow = (days: number, offset: number): string =>
  offset === 0
    ? days === 1
      ? "the last day"
      : `the last ${days} days`
    : days === 1
      ? "the day before"
      : `the previous ${days} days`;

const windowRef = (
  label: string,
  from: Date,
  to: Date,
  days: number,
  bucketSeconds: number,
  fleetObservedBuckets: number,
): WindowRef => {
  const possible = Math.max(1, Math.round(((to.getTime() - from.getTime()) / 1000) / bucketSeconds));
  return {
    label,
    from: from.toISOString(),
    to: to.toISOString(),
    days,
    bucketSeconds,
    fleetObservedBuckets,
    // How much of the window we were actually collecting. Reported, never used to
    // scale a number: it explains a refusal, it does not repair a comparison.
    collectorCoverage: Math.min(1, Math.round((fleetObservedBuckets / possible) * 1000) / 1000),
  };
};

// ── churn: the set you are looking at vs the set you looked at ───────────────

/**
 * The body of `POST /api/trends/churn`.
 *
 * `previous` is the caller's OWN prior read. It has to be, and the shape is the
 * honest consequence of a fact worth stating in the schema: no recommendation
 * snapshot is persisted anywhere (21 tables in `src/db/schema.sql`, none of them
 * a recommendation log), so the only baseline that exists is the one the client
 * still holds in memory. Reconstructing it from stored device facts would mean
 * reconstructing the device facts as they were at the watermark, which we do not
 * keep either.
 */
const ChurnBody = z.object({
  /**
   * The watermark: an absolute ISO instant, normally the `computedAt` of the
   * `/api/remediation` envelope the caller last rendered. Optional, and its
   * absence is answered as a labelled first look — never as "everything is new".
   */
  since: z.string().min(1).optional(),
  /** Which set to track. `auto-safe` is the queue GAP-7 observed collapsing. */
  kind: z.enum(["auto-safe", "manual"]).default("auto-safe"),
  /**
   * Bucket size for the collector-coverage check on the window between the two
   * reads. 300s matches the SLA module and `availabilityBuckets`.
   */
  bucketSeconds: z.coerce.number().int().min(60).max(3600).default(300),
  /**
   * What the caller held at `since`. `severity` is optional and its absence is
   * reported as "we cannot tell whether anything changed", not as "nothing did".
   * Capped at 3,000: the engine holds at most ten rules per device and this
   * fleet is 251 devices, so ~2,510 is the ceiling for the ENTIRE list, let
   * alone one filtered set. A body claiming more than that is a bug or an
   * attack, not a triage session, and it is refused rather than truncated —
   * truncating would silently shrink the caller's baseline and flatter us.
   */
  previous: z
    .array(
      z.object({
        id: z.string().min(1),
        deviceId: z.string().min(1).optional(),
        severity: z.enum(["critical", "high", "medium", "low"]).optional(),
        kind: z.enum(["auto-safe", "manual"]).optional(),
      }),
    )
    .max(3000)
    .optional(),
});

export async function registerTrendRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  /**
   * The group tree, cached with a 30-minute TTL — same instance rationale as the
   * correlation route: sites come from `rpm /v1/groups`, and resolving 94 groups
   * on every dashboard poll would be control-plane traffic for a tree that
   * changes when someone provisions a group. Null when there are no credentials,
   * in which case site-scoped trends are simply absent and the payload says so
   * rather than silently reporting device trends as the whole story.
   */
  const siteCache = ctx.videri ? new GroupSiteCache(ctx.videri) : null;

  /**
   * Trend intelligence — what is getting WORSE (Epic 7).
   *
   * The first endpoint in this product that looks at change over time. Three
   * independent engines, one per feed we already store:
   *
   *   - **Availability regression** from `health_samples` presence, at fleet,
   *     site and device scope, comparing the last N days against the previous N.
   *     The site claim ("this venue fell from 82% to 61% week-over-week") is the
   *     valuable one; site membership is the depth-1 group ancestor.
   *   - **Storage fill** from `device_telemetry` — the only PREVENTIVE claim we
   *     make, so it carries the strictest gates in the module.
   *   - **Transmission silence** from `data_usage_days`, the platform's own daily
   *     traffic accounting. Independent of presence by construction, which is why
   *     it is worth having: it can contradict the status flags, and we have
   *     already proven those can be wrong.
   *
   * READ-ONLY. Nothing here touches a device; it only reads tables we filled.
   *
   * The honesty rules are in the engine, not here — this route does IO and
   * labelling only. What matters at this layer: the two availability windows are
   * queried SEPARATELY with their own fleet-bucket counts, so the engine can see
   * that collection differed between them and refuse the comparison. Handing it
   * one blended aggregate would make that impossible to detect.
   *
   * Carries the standard freshness envelope. A trend computed from stored windows
   * is never live, and `data.basis` says so in the payload itself.
   */
  app.get("/api/trends", async (request, reply) => {
    const parsed = Query.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "bad_request",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }
    const { windowDays, bucketSeconds, storageDays } = parsed.data;

    // One observation instant for the whole request. Reading the clock more than
    // once would let the two windows overlap or leave a sliver between them.
    const observedNow = new Date();
    const dayMs = 86_400_000;
    const recentFrom = new Date(observedNow.getTime() - windowDays * dayMs);
    const priorFrom = new Date(observedNow.getTime() - 2 * windowDays * dayMs);
    const storageFrom = new Date(observedNow.getTime() - storageDays * dayMs);

    const [recent, prior, storage, usage, fleet, freshness, hierarchy] = await Promise.all([
      ctx.queries.availabilityBuckets(recentFrom.toISOString(), observedNow.toISOString(), bucketSeconds),
      ctx.queries.availabilityBuckets(priorFrom.toISOString(), recentFrom.toISOString(), bucketSeconds),
      ctx.queries.storageSeries(storageFrom.toISOString(), observedNow.toISOString()),
      ctx.queries.usageDays(SILENCE_GATES.baselineDays + SILENCE_GATES.recentDays),
      ctx.queries.trendDevices(),
      ctx.freshness(),
      siteCache?.get() ?? Promise.resolve(null),
    ]);

    // Site resolution happens here so the engine stays pure. A tree we could not
    // read leaves every site null, which suppresses site-scoped trends entirely
    // rather than inventing a bucket — see `sites.reason` below.
    const index = hierarchy?.index ?? null;
    const devices: TrendDevice[] = fleet.map((device) => ({
      id: device.id,
      name: device.name,
      site: index ? resolveSite(index, device.groupId) : null,
    }));

    const availability = analyzeAvailability({
      recent: {
        window: windowRef(
          labelWindow(windowDays, 0),
          recentFrom,
          observedNow,
          windowDays,
          bucketSeconds,
          recent.fleetObservedBuckets,
        ),
        devices: recent.devices,
      },
      prior: {
        window: windowRef(
          labelWindow(windowDays, 1),
          priorFrom,
          recentFrom,
          windowDays,
          bucketSeconds,
          prior.fleetObservedBuckets,
        ),
        devices: prior.devices,
      },
      devices,
    });

    const report = buildTrendReport(
      observedNow,
      availability,
      analyzeStorage(storage, devices, storageDays, observedNow),
      analyzeTransmissionSilence(usage, devices, observedNow),
    );

    return reply.send(
      envelope(
        {
          ...report,
          // Without this block, "no site trends" is ambiguous between "no site is
          // degrading" and "we could not place any device at a site".
          sites: {
            available: index !== null,
            resolved: devices.filter((d) => d.site !== null).length,
            devices: devices.length,
            groupsRead: hierarchy?.groupsRead ?? 0,
            hierarchyAgeSeconds: hierarchy?.ageSeconds ?? null,
            reason:
              hierarchy === null
                ? "No Videri credentials are configured, so the group hierarchy could not be " +
                  "read and no site-scoped trend is reported."
                : hierarchy.reason,
          },
        },
        freshness,
      ),
    );
  });

  /**
   * Recommendation churn and new-since-you-looked (Epic 8.6, US-8.6.3/8.6.4).
   *
   * Answers the question docs/25 GAP-7 recorded and nothing in this product could
   * answer: the auto-safe set was seen moving **20 → 2**, and the payload said
   * only "2". Here it reads "18 left because their schedule closed, not because
   * they were fixed", with a count per cause, an absolute "last looked" stamp, and
   * the collector's own coverage of the window between the two reads attached to
   * every figure.
   *
   * POST rather than GET, and it still writes nothing to a device or to Postgres.
   * The body carries the caller's PRIOR READ, which is the only baseline that
   * exists: there is no recommendation-snapshot table, so a server-side "what did
   * you see at 09:00" would have to be invented. Sending it makes the baseline
   * explicit and the payload labels it `attestedBy: "caller"` — we cannot verify
   * it and we do not pretend to.
   *
   * Three honesty rules live at this boundary rather than in the engine:
   *
   *   1. A MISSING watermark is answered as a labelled FIRST LOOK with a null
   *      new-count. An INVALID one (unparseable, in the future, past the 30-day
   *      ceiling, or a watermark with no prior set) is a 400. Neither is ever
   *      defaulted, because a defaulted watermark reports the whole queue as new.
   *
   *   2. The window between the two reads is measured for the collector's own
   *      coverage BEFORE any cause is attributed, and the bucket STARTS are
   *      fetched — not just their count — so the longest blind run is known. The
   *      collector here managed 77% of the measured week; a churn figure that
   *      straddles one of those holes must say so, and `applied` is withheld.
   *
   *   3. The current set is recomputed the same way `/api/remediation` computes
   *      it — same `remediationDevices()`, same recorded intent, same engine — so
   *      the diff is against the set the caller will actually render, not a
   *      lookalike assembled from a second query path.
   *
   * This endpoint returns the DIFF, not the queue. `/api/remediation` remains the
   * full set and nothing is hidden there for not being new (US-6.2.3); the client
   * joins these ids onto it.
   */
  app.post("/api/trends/churn", async (request, reply) => {
    const parsed = ChurnBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "bad_request",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        watermarkBasis: WATERMARK_BASIS,
      });
    }
    const { since, kind, bucketSeconds, previous } = parsed.data;

    // One observation instant for the whole request: it is the far end of the
    // watermark window AND the instant every schedule is evaluated at, and two
    // clock reads would let those disagree.
    const observedNow = new Date();
    // An explicitly EMPTY `previous` is a legitimate baseline — "I looked at
    // 09:00 and the queue was empty" — so presence of the field, not its length,
    // is what decides whether we have a prior set to diff against.
    const watermark = judgeWatermark(since, observedNow, previous !== undefined);

    const [devices, suppressions, freshness] = await Promise.all([
      ctx.queries.remediationDevices(),
      ctx.repo.listSuppressions(),
      ctx.freshness(),
    ]);
    const recommendations = recommendationsFor(devices, observedNow, {
      recordedIntent: recordedIntentByDevice(suppressions, observedNow),
    });

    if (!watermark.ok || watermark.at === null) {
      // An absent watermark is a first look, not an error: the caller has simply
      // never looked, and the honest answer is the whole set with the new-count
      // reported as null. Everything else is malformed input and is refused.
      if (watermark.problem === "missing") {
        return reply.send(
          envelope(
            buildFirstLook(kind, observedNow.toISOString(), recommendations, watermark, null),
            freshness,
          ),
        );
      }
      return reply.code(400).send({
        error: "bad_request",
        problem: watermark.problem,
        message: watermark.message,
        watermarkBasis: watermark.basis,
        maxAgeDays: WATERMARK_MAX_AGE_DAYS,
      });
    }

    // How much of the window between the two reads were we actually collecting?
    // Fetched before attribution because it decides which causes are claimable.
    const windowFrom = watermark.at.toISOString();
    const windowTo = observedNow.toISOString();
    const bucketStarts = await ctx.queries.observedBucketStarts(windowFrom, windowTo, bucketSeconds);
    const verdict = judgeObservation(
      observationFrom(windowFrom, windowTo, bucketSeconds, bucketStarts),
    );

    const report = analyzeChurn({
      previous: { observedAt: windowFrom, items: (previous ?? []) as PriorItem[] },
      current: { observedAt: windowTo, recommendations },
      devices,
      kind,
      verdict,
    });

    return reply.send(
      envelope(
        {
          ...report,
          watermark: { supplied: since ?? null, resolved: windowFrom, basis: watermark.basis },
          // So an empty diff reads as "nothing moved" rather than "we saw nothing".
          devicesConsidered: devices.length,
        },
        freshness,
      ),
    );
  });
}
