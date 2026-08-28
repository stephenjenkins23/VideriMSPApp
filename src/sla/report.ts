import type { Repository } from "../db/repository.js";
import { assessDevice, buildFleetReport, type FleetSlaReport } from "./coverage.js";

/**
 * Builds the SLA report from cached samples. No live API calls — an SLA figure
 * must be reproducible from stored evidence, not dependent on whether the
 * platform is reachable at the moment someone asks.
 */
export async function buildSlaReport(
  repo: Repository,
  windowHours = 24,
  bucketSeconds = 300,
): Promise<FleetSlaReport> {
  const [aggregates, blind] = await Promise.all([
    repo.loadSlaAggregates(windowHours, bucketSeconds),
    repo.loadFleetBlindWindows(windowHours, bucketSeconds),
  ]);

  const devices = aggregates.map((a) => assessDevice(a, bucketSeconds));

  return buildFleetReport(
    windowHours,
    bucketSeconds,
    devices,
    blind.map((w) => ({
      from: w.from.toISOString(),
      to: w.to.toISOString(),
      durationSeconds: w.durationSeconds,
      devicesReporting: w.devicesReporting,
    })),
  );
}
