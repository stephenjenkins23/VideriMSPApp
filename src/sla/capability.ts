/**
 * Live capability probe — the IO half of the measurability model.
 *
 * Everything that decides a grade lives in `measurability.ts` as pure functions.
 * This file only fetches, and it fetches from sources that ALREADY exist for
 * other surfaces, deliberately: the whole point of BUG-3 was three surfaces
 * giving three answers about the same capability, so the SLA page reads the same
 * availability probe the Overview tile and the Trends engine read.
 *
 * Structurally typed against the repository and query classes rather than
 * importing them, so `src/sla` stays independent of the API and DB layers and
 * the probe is trivially fakeable in a test.
 */

import type { PollerRunRow } from "../alerting/pipeline-health.js";
import {
  buildMeasurability,
  MEASURABILITY_WITHOUT_LIVE_SIGNAL,
  type MeasurabilityAssessment,
} from "./measurability.js";

/** Only the reads this probe needs, so a caller can pass anything that has them. */
export interface CapabilitySources {
  /** Devices with a readable value per telemetry field, plus the active fleet size. */
  telemetryAvailability(): Promise<Record<string, { readable: number; total: number }>>;
  /** Lane run history, for measuring sweep cadence rather than assuming it. */
  pollerRunHistory(opts?: { lookbackHours?: number; runsPerLane?: number }): Promise<PollerRunRow[]>;
  /** Devices addressable on the screenshot CDN (they have a hardware serial). */
  screenshotTargets(
    onlineOnly: boolean,
    limit: number,
  ): Promise<Array<{ serialNo: string | null; requestedAt: string | null }>>;
}

/** Generous: this is a whole-fleet count, and a truncated one would understate coverage. */
const SCREENSHOT_PROBE_LIMIT = 10_000;
/** Long enough to measure a slow lane's cadence, short enough to reflect today. */
const LANE_LOOKBACK_HOURS = 72;

/**
 * Probe live capability and grade every dimension.
 *
 * Fails SOFT: if a probe throws we grade with no live signal, which promotes
 * nothing. A capability page that cannot see the fleet must under-claim, never
 * over-claim — and the assessment says which of the two happened
 * (`fromLiveCapability`).
 */
export async function loadMeasurability(
  sources: CapabilitySources,
  now = new Date(),
): Promise<MeasurabilityAssessment> {
  const [availability, laneRuns, shots] = await Promise.all([
    sources.telemetryAvailability().catch(() => null),
    sources.pollerRunHistory({ lookbackHours: LANE_LOOKBACK_HOURS }).catch(() => [] as PollerRunRow[]),
    sources.screenshotTargets(false, SCREENSHOT_PROBE_LIMIT).catch(() => null),
  ]);

  if (availability === null && shots === null) return MEASURABILITY_WITHOUT_LIVE_SIGNAL;

  const fieldReadable =
    availability === null
      ? null
      : Object.fromEntries(Object.entries(availability).map(([k, v]) => [k, v.readable]));

  // `total` is the ACTIVE fleet, not the number of rows we happened to get — a
  // thin sweep must read as low coverage, not as full coverage of a small sample.
  const fleetSize = availability
    ? (Object.values(availability)[0]?.total ?? 0)
    : (shots?.length ?? 0);

  const dayAgo = now.getTime() - 86_400_000;

  return buildMeasurability({
    fleetSize,
    fieldReadable,
    laneRuns,
    screenshot:
      shots === null
        ? null
        : {
            addressable: shots.filter((s) => s.serialNo !== null).length,
            capturedWithin24h: shots.filter(
              (s) => s.requestedAt !== null && new Date(s.requestedAt).getTime() >= dayAgo,
            ).length,
          },
  });
}
