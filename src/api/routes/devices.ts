import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { envelope } from "../freshness.js";
import {
  NO_HIERARCHY_REASON,
  groupIdsForSites,
  sitesMatchingName,
  type SiteResolution,
} from "../queries.js";
import { GroupSiteCache } from "../../videri/services/group-hierarchy.js";
import type { ApiContext } from "../server.js";

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  // Capped: this endpoint joins two laterals per row, and an uncapped limit is
  // how a dashboard bug turns into a database incident.
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.enum(["online", "warning", "alert", "offline", "unknown"]).optional(),
  deviceClass: z.string().min(1).max(50).optional(),
  groupId: z.string().min(1).max(100).optional(),
  /**
   * Comma-separated SITE ids (the uuid of the depth-1 group ancestor, as served
   * in `site.id` on every row).
   *
   * The whole product question for an MSP is "which customer, which site", and
   * until now the answer was not filterable at all. Comma-separated rather than
   * repeated so one query string can carry a multi-select; capped so a caller
   * cannot smuggle an unbounded id list into a `= ANY` array.
   *
   * An explicitly supplied filter that resolves to no groups matches NOTHING —
   * see the fail-closed note in queries.devices().
   */
  siteIds: z
    .string()
    .min(1)
    .max(4000)
    .optional()
    .transform((v) =>
      v === undefined
        ? undefined
        : Array.from(new Set(v.split(",").map((x) => x.trim()).filter(Boolean))).slice(0, 200),
    ),
  search: z.string().min(1).max(200).optional(),
  sort: z.enum(["name", "last_seen", "alerts"]).default("last_seen"),
  direction: z.enum(["asc", "desc"]).default("desc"),
});

const HealthQuery = z.object({
  windowHours: z.coerce.number().int().min(1).max(2160).default(24),
  bucketMinutes: z.coerce.number().int().min(1).max(1440).default(15),
});

export async function registerDeviceRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  /**
   * The group tree, cached in memory for 30 minutes (GroupSiteCache).
   *
   * The site axis is not in Postgres — it is the depth-1 ancestor of a device's
   * group in the `rpm /v1/groups` hierarchy — so the list has to read the tree to
   * project it. Resolving per request would walk ~94 groups on every keystroke of
   * a device search, so it is cached; the cache's age rides in
   * `meta.sites.hierarchyAgeSeconds` exactly as /api/correlation reports it, so a
   * mapping resolved 20 minutes ago is never presented as live.
   *
   * A separate instance from the one in routes/correlation.ts: sharing it would
   * mean widening ApiContext in server.ts, which this change does not own. The
   * cost is one extra group listing per 30 minutes per consumer, and both report
   * their own age honestly, so neither can claim the other's freshness.
   *
   * Null when the server has no credentials — every row is then site-unresolved
   * WITH A REASON, and the endpoint still serves 200.
   */
  const siteCache = ctx.videri ? new GroupSiteCache(ctx.videri) : null;

  app.get("/api/devices", async (request, reply) => {
    const parsed = ListQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "bad_request",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }
    const filters = parsed.data;

    // A hierarchy we could not read must not 500 this endpoint and must not
    // silently blank the site column: `index` comes back null, every row carries
    // site.resolved=false with the reason, and meta says so once for the page.
    const [freshness, hierarchy] = await Promise.all([
      ctx.freshness(),
      siteCache?.get() ?? Promise.resolve(null),
    ]);
    const resolution: SiteResolution = {
      index: hierarchy?.index ?? null,
      reason: hierarchy === null ? NO_HIERARCHY_REASON : hierarchy.reason,
    };

    // Site → group ids, using the SAME resolveSite the row projection uses, so a
    // filter can never select a device whose site cell disagrees with it.
    // Fail closed: `siteIds` supplied but unresolvable (no hierarchy, or an id
    // that is not a site) yields [], which matches nothing.
    const siteGroupIds =
      filters.siteIds === undefined
        ? undefined
        : resolution.index === null
          ? []
          : groupIdsForSites(resolution.index, filters.siteIds);

    // Search is a WIDENING, not a narrowing, so it does not fail closed: with no
    // hierarchy the term still matches the text columns and simply cannot match
    // a site name.
    const searchSiteGroupIds =
      filters.search && resolution.index !== null
        ? groupIdsForSites(resolution.index, sitesMatchingName(resolution.index, filters.search))
        : undefined;

    const result = await ctx.queries.devices(
      { ...filters, siteGroupIds, searchSiteGroupIds },
      resolution,
    );

    const base = envelope(result.items, freshness, {
      page: filters.page,
      limit: filters.limit,
      totalItems: result.totalItems,
      totalPages: Math.max(1, Math.ceil(result.totalItems / filters.limit)),
    });
    // Extra meta block rather than a new field on `envelope()`, which is shared
    // by every endpoint. Same shape and same key as /api/correlation's `sites`,
    // so a consumer learns one contract for the site dimension.
    return {
      ...base,
      meta: {
        ...base.meta,
        sites: {
          /** False = the site column is unavailable, not empty. */
          available: resolution.index !== null,
          hierarchyAgeSeconds: hierarchy?.ageSeconds ?? null,
          groupsRead: hierarchy?.groupsRead ?? 0,
          groupsTotal: hierarchy?.groupsTotal ?? null,
          truncated: hierarchy?.truncated ?? false,
          reason: resolution.reason,
          // How the requested filter was translated. `groupsMatched: 0` on a
          // non-empty request is the visible form of failing closed.
          filter:
            filters.siteIds === undefined
              ? null
              : { siteIds: filters.siteIds, groupsMatched: siteGroupIds?.length ?? 0 },
          // Honest denominators for THIS page, so "no site" is countable rather
          // than an impression left by blank cells.
          onPage: {
            devices: result.items.length,
            resolved: result.items.filter((d) => d.site.resolved).length,
            unresolved: result.items.filter((d) => !d.site.resolved).length,
          },
        },
      },
    };
  });

  app.get<{ Params: { id: string } }>("/api/devices/:id", async (request, reply) => {
    // One call returns everything the drawer shows — identity, components,
    // cached settings and the compliance verdict — so the UI has one loading
    // state instead of five.
    const hierarchy = await (siteCache?.get() ?? Promise.resolve(null));
    const [device, context, freshness] = await Promise.all([
      // The drawer gets the same `site` the row does — it was printing
      // "Location not reported" while the payload already carried a groupName.
      ctx.queries.device(request.params.id, {
        index: hierarchy?.index ?? null,
        reason: hierarchy === null ? NO_HIERARCHY_REASON : hierarchy.reason,
      }),
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
