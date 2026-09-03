/**
 * SLA measurement confidence.
 *
 * Written for an operator who has contractual uptime commitments and may have to
 * defend a number in front of a customer. That changes the requirement: it is not
 * enough to report uptime, we must report **how much of the window we were
 * actually watching**, and be unable to accidentally conflate the two.
 *
 * THE CENTRAL RULE
 * `observedUptime` and `collectionCoverage` are separate numbers and are never
 * multiplied, blended, or presented as one figure.
 *
 *   "Online for 99.2% of the 94% of the window we observed"   ← defensible
 *   "99.2% uptime"                                            ← unsupportable
 *
 * The second sentence is how an MSP loses an SLA dispute: the customer asks what
 * happened during the missing 6% and there is no answer. So a claim is only
 * marked `claimable` when coverage is high enough to support it, and the gap is
 * always stated.
 *
 * THE SECOND RULE — whose fault is the silence?
 * If ONE device stops reporting, that is a device problem and counts against its
 * uptime. If EVERY device stops reporting simultaneously, that is OUR collector
 * failing, and it must never be recorded as a fleet-wide outage. Those two look
 * identical in a naive uptime query and are opposite in meaning. §`blindWindows`
 * separates them.
 */

import {
  CLAIMABLE_COVERAGE_FLOOR,
  MEASURABILITY_WITHOUT_LIVE_SIGNAL,
  asUnmeasurableDimension,
  humanDuration,
  type MeasurabilityAssessment,
  type UnmeasurableDimension,
} from "./measurability.js";

export type { UnmeasurableDimension };

export type Confidence = "high" | "medium" | "low" | "none";

/** Per-device aggregates for one SLA window, as computed in SQL. */
export interface DeviceWindowAggregate {
  deviceId: string;
  name: string | null;
  /** Distinct time buckets in which we have at least one reading. */
  observedBuckets: number;
  /** Buckets where the device reported `online`. */
  onlineBuckets: number;
  /** Total buckets in the window (window / bucket size). */
  expectedBuckets: number;
  /** Longest run of consecutive buckets with no reading at all, in seconds. */
  longestGapSeconds: number;
  /** Seconds since the most recent reading. */
  stalenessSeconds: number | null;
}

export interface DeviceSlaWindow {
  deviceId: string;
  name: string | null;
  /** 0–1. Share of the window we have any reading for. */
  collectionCoverage: number;
  /** 0–1. Share of OBSERVED time the device was online. Null when unobserved. */
  observedUptime: number | null;
  /** Seconds of the window we have no reading for. */
  blindSeconds: number;
  longestGapSeconds: number;
  stalenessSeconds: number | null;
  confidence: Confidence;
  /** True only when coverage supports an external uptime claim. */
  claimable: boolean;
  /** Plain-language statement fit to put in front of a customer. */
  statement: string;
}

/** Coverage thresholds for confidence banding. Deliberately conservative. */
const HIGH = 0.98;
const MEDIUM = 0.9;
const LOW = 0.5;
/**
 * Below this, we do not make an external claim at all. Shared with the
 * measurability grader so the page has ONE claimability bar, not two.
 */
const CLAIMABLE_FLOOR = CLAIMABLE_COVERAGE_FLOOR;

export function confidenceFor(coverage: number): Confidence {
  if (coverage >= HIGH) return "high";
  if (coverage >= MEDIUM) return "medium";
  if (coverage >= LOW) return "low";
  return "none";
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export function assessDevice(
  agg: DeviceWindowAggregate,
  bucketSeconds: number,
): DeviceSlaWindow {
  const expected = Math.max(1, agg.expectedBuckets);
  const coverage = Math.min(1, agg.observedBuckets / expected);
  const blindSeconds = Math.max(0, (expected - agg.observedBuckets) * bucketSeconds);

  // Uptime is computed over OBSERVED buckets only. Dividing by expectedBuckets
  // would silently charge the device for our own collection gaps.
  const observedUptime =
    agg.observedBuckets === 0 ? null : agg.onlineBuckets / agg.observedBuckets;

  const confidence = confidenceFor(coverage);
  const claimable = coverage >= CLAIMABLE_FLOOR && observedUptime !== null;

  let statement: string;
  if (observedUptime === null) {
    statement =
      `No readings in this window — uptime cannot be asserted. ` +
      `${humanDuration(blindSeconds)} unobserved.`;
  } else if (claimable) {
    statement =
      `Online for ${pct(observedUptime)} of the window. ` +
      `Coverage ${pct(coverage)}; ${humanDuration(blindSeconds)} unobserved.`;
  } else {
    statement =
      `Online for ${pct(observedUptime)} of the ${pct(coverage)} of the window we observed. ` +
      `NOT CLAIMABLE — ${humanDuration(blindSeconds)} unobserved` +
      (agg.longestGapSeconds > 0
        ? `, longest single gap ${humanDuration(agg.longestGapSeconds)}.`
        : ".");
  }

  return {
    deviceId: agg.deviceId,
    name: agg.name,
    collectionCoverage: Number(coverage.toFixed(4)),
    observedUptime: observedUptime === null ? null : Number(observedUptime.toFixed(4)),
    blindSeconds,
    longestGapSeconds: agg.longestGapSeconds,
    stalenessSeconds: agg.stalenessSeconds,
    confidence,
    claimable,
    statement,
  };
}

/** A period in which the WHOLE fleet went quiet — our collector, not their screens. */
export interface BlindWindow {
  from: string;
  to: string;
  durationSeconds: number;
  /** Devices reporting during the window. Zero means the collector was down. */
  devicesReporting: number;
}

/**
 * Dimensions we cannot measure to SLA grade, stated once and prominently.
 *
 * This used to be a hardcoded array of six, and three of its entries went false
 * without anyone noticing: storage, Wi-Fi signal and screenshots all became
 * readable, and this page kept telling customers otherwise. It is now DERIVED —
 * see `measurability.ts` for the grades and where the SLA-grade line sits.
 *
 * This export is the no-live-signal fallback, kept under its original name for
 * callers that have no capability probe to hand. It promotes nothing, so it is
 * the union of "no source" and "readable but not SLA-grade": exactly the set an
 * MSP must read BEFORE signing. A caller holding a live probe should pass a
 * `MeasurabilityAssessment` into `buildFleetReport` instead and get the three
 * grades separated.
 */
export const UNMEASURABLE: UnmeasurableDimension[] = [
  ...MEASURABILITY_WITHOUT_LIVE_SIGNAL.unmeasurable,
  ...MEASURABILITY_WITHOUT_LIVE_SIGNAL.readable,
].map(asUnmeasurableDimension);

export interface FleetSlaReport {
  windowHours: number;
  bucketSeconds: number;
  generatedAt: string;
  devicesAssessed: number;
  /** Devices with no reading at all in the window. */
  devicesUnobserved: number;
  /** Devices whose coverage supports an external claim. */
  devicesClaimable: number;
  fleetCollectionCoverage: number;
  /** Uptime across claimable devices only — the only defensible fleet figure. */
  fleetObservedUptimeClaimable: number | null;
  confidenceBreakdown: Record<Confidence, number>;
  reportingLag: { p50: number | null; p95: number | null; max: number | null };
  /** Fleet-wide silence = our collector failed. Never a fleet outage. */
  blindWindows: BlindWindow[];
  /**
   * Dimensions with NO usable source — the genuinely unmeasurable ones only.
   * Readable-but-not-SLA-grade dimensions are in `measurability.readable`,
   * because presenting the two as one list is what BUG-3 was.
   */
  unmeasurable: UnmeasurableDimension[];
  /** The full three-grade assessment, with coverage and cadence per dimension. */
  measurability: MeasurabilityAssessment;
  /** Worst devices by coverage — where measurement, not uptime, is the problem. */
  leastObserved: DeviceSlaWindow[];
  warnings: string[];
}

export function buildFleetReport(
  windowHours: number,
  bucketSeconds: number,
  devices: DeviceSlaWindow[],
  blindWindows: BlindWindow[],
  /**
   * Live capability grades. Omitted means "not probed", and the fallback
   * promotes nothing — an unprobed page under-claims rather than over-claims.
   */
  measurability: MeasurabilityAssessment = MEASURABILITY_WITHOUT_LIVE_SIGNAL,
): FleetSlaReport {
  const observed = devices.filter((d) => d.observedUptime !== null);
  const claimable = devices.filter((d) => d.claimable);

  const confidenceBreakdown: Record<Confidence, number> = { high: 0, medium: 0, low: 0, none: 0 };
  for (const d of devices) confidenceBreakdown[d.confidence] += 1;

  const lags = devices
    .map((d) => d.stalenessSeconds)
    .filter((s): s is number => s !== null)
    .sort((a, b) => a - b);
  const at = (q: number) => (lags.length === 0 ? null : lags[Math.min(lags.length - 1, Math.floor(lags.length * q))]!);

  const fleetCoverage =
    devices.length === 0
      ? 0
      : devices.reduce((s, d) => s + d.collectionCoverage, 0) / devices.length;

  const warnings: string[] = [];
  if (claimable.length < devices.length) {
    warnings.push(
      `${devices.length - claimable.length} of ${devices.length} devices do not have ` +
        `sufficient collection coverage to support an external uptime claim.`,
    );
  }
  if (blindWindows.length > 0) {
    const total = blindWindows.reduce((s, w) => s + w.durationSeconds, 0);
    warnings.push(
      `${blindWindows.length} fleet-wide blind window(s) totalling ${humanDuration(total)} — ` +
        `NO device reported during these periods, which indicates our own collector ` +
        `stopped, not a fleet outage. Uptime is not assertable across them.`,
    );
  }
  if (observed.length < devices.length) {
    warnings.push(
      `${devices.length - observed.length} device(s) produced no readings at all in this window.`,
    );
  }
  // Two separate sentences on purpose. "Cannot be measured at all" and "readable
  // but not to SLA grade" lead to different contract decisions, and the old
  // single count blurred them into one over-broad refusal.
  if (measurability.unmeasurable.length > 0) {
    warnings.push(
      `${measurability.unmeasurable.length} dimensions cannot be measured at all on this ` +
        `platform (${measurability.unmeasurable.map((d) => d.dimension).join(", ")}) — ` +
        `do not agree SLA language referencing them.`,
    );
  }
  if (measurability.readable.length > 0) {
    warnings.push(
      `${measurability.readable.length} dimensions are READABLE per device but not to SLA ` +
        `grade (${measurability.readable.map((d) => d.dimension).join(", ")}) — useful for ` +
        `diagnosis, and each states its live coverage and cadence. Do not promise them.`,
    );
  }
  if (!measurability.fromLiveCapability) {
    warnings.push(
      `Measurability was graded with NO live capability sample, so nothing was promoted to ` +
        `SLA grade. This list under-claims until the capability probe runs.`,
    );
  }

  return {
    windowHours,
    bucketSeconds,
    generatedAt: new Date().toISOString(),
    devicesAssessed: devices.length,
    devicesUnobserved: devices.length - observed.length,
    devicesClaimable: claimable.length,
    fleetCollectionCoverage: Number(fleetCoverage.toFixed(4)),
    // Deliberately computed over claimable devices only. Averaging in devices we
    // barely observed would produce a fleet number nobody could defend.
    fleetObservedUptimeClaimable:
      claimable.length === 0
        ? null
        : Number(
            (claimable.reduce((s, d) => s + (d.observedUptime ?? 0), 0) / claimable.length).toFixed(4),
          ),
    confidenceBreakdown,
    reportingLag: { p50: at(0.5), p95: at(0.95), max: lags.length === 0 ? null : lags[lags.length - 1]! },
    blindWindows,
    unmeasurable: measurability.unmeasurable.map(asUnmeasurableDimension),
    measurability,
    leastObserved: [...devices]
      .sort((a, b) => a.collectionCoverage - b.collectionCoverage)
      .slice(0, 15),
    warnings,
  };
}
