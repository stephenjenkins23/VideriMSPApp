import type { FastifyInstance } from "fastify";
import { envelope } from "../freshness.js";
import { correlate } from "../../intelligence/correlation.js";
import { GroupSiteCache, withSites, type SiteCoverage } from "../../videri/services/group-hierarchy.js";
import type { ApiContext } from "../server.js";

export async function registerCorrelationRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  /**
   * The group tree, cached for the life of the process (30-minute TTL).
   *
   * Venue correlation needs a device → site mapping, and site comes from the
   * `rpm /v1/groups` hierarchy. Resolving it per request would walk 94 groups on
   * every dashboard poll, so the tree is cached in memory here rather than
   * persisted: it is derived data with one consumer, and a table would need its
   * own freshness plumbing to be trustworthy. The cache's age travels in the
   * response instead (`sites.hierarchyAgeSeconds`), so a mapping resolved 20
   * minutes ago is never presented as live.
   *
   * Null when there is no control plane — correlation then falls back to the city
   * dimension and says so, rather than reasoning over a tree it never read.
   */
  const siteCache = ctx.videri ? new GroupSiteCache(ctx.videri) : null;

  /**
   * Cross-fleet correlation findings (Epic 2, docs/19 US-2.1..2.4).
   *
   * Reuses the SAME per-device assembly as the remediation engine
   * (`remediationDevices()`), enriches each device with its site (the depth-1
   * ancestor of its group, joined on group_id — NEVER group_name), then runs the
   * pure correlation engine over it to surface patterns a single root cause leaves
   * across many devices — a venue outage, a bad firmware build, a resource-linked
   * symptom, a correlated drop.
   *
   * READ-ONLY: like remediation, this endpoint never touches a device. It only
   * reports what the data already shows. Degenerate or missing data yields an
   * honest `note`, never a fabricated finding, so an empty `findings` list with a
   * note reads as "we could not correlate", not "all clear".
   *
   * Carries the standard freshness envelope: a correlation computed from
   * 40-minute-old telemetry is a different claim from a live one, and the client
   * must be able to tell which.
   */
  app.get("/api/correlation", async (_request, reply) => {
    const [devices, freshness, hierarchy] = await Promise.all([
      ctx.queries.remediationDevices(),
      ctx.freshness(),
      siteCache?.get() ?? Promise.resolve(null),
    ]);

    // A tree we could not read leaves every `site` null, which the engine reports
    // as an honest note and falls back to city for — never a silent empty result.
    const resolved =
      hierarchy?.index != null
        ? withSites(devices, hierarchy.index)
        : { devices, coverage: null as SiteCoverage | null };

    const report = correlate(resolved.devices);
    return reply.send(
      envelope(
        {
          findings: report.findings,
          notes: report.notes,
          devicesConsidered: report.devicesConsidered,
          // How well the venue dimension covers the fleet, and how old the
          // mapping is. Without this, "no venue findings" is ambiguous between
          // "no site is failing" and "we could not place any device at a site".
          sites: {
            available: resolved.coverage !== null,
            coverage: resolved.coverage,
            groupsRead: hierarchy?.groupsRead ?? 0,
            groupsTotal: hierarchy?.groupsTotal ?? null,
            truncated: hierarchy?.truncated ?? false,
            hierarchyAgeSeconds: hierarchy?.ageSeconds ?? null,
            reason:
              hierarchy === null
                ? "No Videri credentials are configured, so the group hierarchy could not be read."
                : hierarchy.reason,
          },
        },
        freshness,
      ),
    );
  });
}
