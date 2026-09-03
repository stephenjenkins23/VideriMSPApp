/**
 * The two parts of the action-plan input that need the Videri control plane.
 *
 * Split out of jobs.ts on purpose: both reach for the credentialed HTTP client,
 * which validates the whole environment at import time. jobs.ts loads this module
 * ON DEMAND so the jobs and the scheduled lane that wraps them stay unit-testable
 * with a stubbed client and no .env — see the lazy defaults in jobs.ts.
 *
 * Read-only throughout: no device write happens here, and every failure mode
 * degrades to `available:false` WITH a reason rather than to zeros.
 */

import { config } from "../config.js";
import { VideriAuth } from "../videri/auth.js";
import { VideriHttp } from "../videri/http.js";
import { AggregatorService } from "../videri/services/aggregator.js";
import { GroupSiteCache, withSites } from "../videri/services/group-hierarchy.js";
import { summarizeRollupsForPlan } from "./action-plan.js";
import type { PlanRollupFold } from "./jobs.js";
import type { DeviceView } from "../intelligence/remediation.js";

/**
 * The aggregator rollups are the one part of the input that needs the control
 * plane: ~94 read-only group-metrics calls. Worth it for a batch job, and a
 * failed or credential-less read leaves the plan reporting the blind spot
 * instead of inferring a fleet with no offline canvases.
 */
export async function readPlanRollups(skipRollups = false): Promise<PlanRollupFold> {
  if (skipRollups) {
    return unavailable("Rollups were skipped for this run (--no-rollups).");
  }
  if (!config.VIDERI_PASSWORD) {
    return unavailable(
      "No Videri credentials are configured, so the aggregator group-metrics could " +
        "not be read. Fleet count-rollups are unknown for this plan, not zero.",
    );
  }
  try {
    const service = new AggregatorService(new VideriHttp(new VideriAuth()));
    const collectedAt = new Date().toISOString();
    return summarizeRollupsForPlan(await service.fleetRollups(), collectedAt);
  } catch (error) {
    // Never log the error object wholesale — request context can carry credentials.
    return unavailable(
      `The aggregator group-metrics fan-out failed (${
        error instanceof Error ? error.message : "unknown error"
      }), so fleet count-rollups are unknown for this plan, not zero.`,
    );
  }
}

/** No rollup read, so no citable group refs either — an honest empty catalog. */
const unavailable = (reason: string): PlanRollupFold => ({
  rollups: { available: false, reason },
  signals: [],
});

/**
 * Resolve each device's site (depth-1 group ancestor) so the plan's venue
 * correlation says the same thing `GET /api/correlation` does.
 *
 * One read-only `rpm /v1/groups` walk. Degrades the same way the rollups do: no
 * credentials or a failed read leaves every `site` null, and the correlation
 * engine then emits its honest "no site resolved" note instead of a fabricated
 * cluster.
 */
export async function withResolvedSites(devices: DeviceView[]): Promise<DeviceView[]> {
  if (!config.VIDERI_PASSWORD) return devices;
  try {
    const hierarchy = await new GroupSiteCache(new VideriHttp(new VideriAuth())).get();
    return hierarchy.index ? withSites(devices, hierarchy.index).devices : devices;
  } catch {
    return devices;
  }
}
