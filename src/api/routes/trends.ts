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
}
