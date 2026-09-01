/**
 * Trend intelligence — change over TIME. Pure, no I/O (Epic 7).
 *
 * Every other engine in this system answers "what is true NOW": down, dark,
 * drifted, uncorrelated. None of them answer "what is getting WORSE". We have
 * been storing the history all along and never reading it. This module reads it.
 *
 * "This site fell from 82% to 61% availability week-over-week" is a more useful
 * sentence than "this device is offline", and it needs no platform access we do
 * not already have.
 *
 * THE ONE WAY THIS FEATURE COULD LIE
 * ----------------------------------
 * A trend is a comparison, and a comparison is only as honest as its denominator.
 * The collector on this deployment is itself intermittent — measured over the
 * last eight days it produced anywhere from 2 to 228 five-minute buckets per day
 * out of a possible 288. So a naive "samples last week vs samples this week"
 * detector would mostly be measuring OUR OWN uptime and reporting it as fleet
 * degradation. Three rules exist to stop that:
 *
 *   1. **Availability is computed over OBSERVED time only.** A bucket in which we
 *      have no reading for a device is not counted against that device — it is
 *      not counted at all. This is the same rule `src/sla/coverage.ts` enforces
 *      for SLA claims, for the same reason.
 *
 *   2. **Windows must be comparable before they are compared.** If the collector
 *      saw far less of one window than the other, the two are not comparable and
 *      NOTHING is emitted for that pair — see `windowsComparable()`. Likewise
 *      per entity: a device observed 400 times last week and 25 times this week
 *      produces an `observation-imbalance` suppression, never a regression. "We
 *      stopped looking" and "it got worse" must never collapse into one claim.
 *
 *   3. **Minimum sample gates, stated and enforced in both directions.** Telemetry
 *      coverage is ~43% of the fleet and the slow lane sweeps over hours, so many
 *      devices simply do not have enough points for a trend. Below the gate we
 *      emit nothing — not a low-confidence trend, nothing — and count the
 *      suppression so a reader can see how much of the fleet we declined to
 *      judge. A trend from two points is not a trend.
 *
 * WHY IMPROVEMENTS ARE REPORTED TOO
 * ---------------------------------
 * `direction` is `regression` or `recovery`, and recoveries are emitted. Two
 * reasons: an operator who fixed a site needs the confirmation, and — more
 * importantly — a detector that can only ever find declines is indistinguishable
 * from a detector that is broken in the pessimistic direction. If every finding
 * on a stable fleet is a regression and nothing ever recovers, that asymmetry is
 * the bug report.
 *
 * CLOCK TRUST
 * -----------
 * `data_usage_days.date` comes from the platform, not from us. A single row dated
 * next year would otherwise become the reference "today" for silence detection
 * and make the entire fleet look silent for months. `sanitizeUsageDates()` throws
 * such rows out before anything else looks at them, and reports how many it
 * discarded rather than silently dropping them.
 *
 * Everything in this file is a pure function: rows in, findings out. No pool, no
 * clock of its own (the observation time is always passed in), no network. The
 * orchestration lives in `src/api/routes/trends.ts`.
 */

import type { SiteRef } from "../videri/services/group-hierarchy.js";

// ── shared vocabulary ────────────────────────────────────────────────────────

/** Which way a trend points. Both are reported; see the header. */
export type TrendDirection = "regression" | "recovery";

/** Scope a trend is asserted at. Sites come from the group hierarchy, never city. */
export type TrendScope = "fleet" | "site" | "device";

/**
 * Why we said nothing about an entity. Codes, not prose, so the caller can count
 * them — "we declined to judge 180 of 249 devices" is itself a finding.
 */
export type SuppressionReason =
  | "insufficient-recent-samples"
  | "insufficient-prior-samples"
  | "observation-imbalance"
  | "insufficient-devices"
  | "insufficient-points"
  | "insufficient-span"
  | "observation-gap"
  | "no-baseline-habit"
  | "feed-gap";

export interface Suppression {
  scope: TrendScope;
  key: string;
  label: string;
  reason: SuppressionReason;
  /** Plain-language version of the code, for a UI that has no code table. */
  detail: string;
}

/**
 * A suppression list over a 249-device fleet is noise in a payload, so the
 * report carries counts for everything and a bounded sample of examples.
 */
export interface SuppressionSummary {
  total: number;
  byReason: Partial<Record<SuppressionReason, number>>;
  examples: Suppression[];
}

const EXAMPLE_CAP = 8;

export function summarizeSuppressions(items: readonly Suppression[]): SuppressionSummary {
  const byReason: Partial<Record<SuppressionReason, number>> = {};
  for (const item of items) byReason[item.reason] = (byReason[item.reason] ?? 0) + 1;
  return { total: items.length, byReason, examples: items.slice(0, EXAMPLE_CAP) };
}

/** One side of a comparison, described well enough to be quoted back. */
export interface WindowRef {
  label: string;
  from: string;
  to: string;
  days: number;
  bucketSeconds: number;
  /**
   * Distinct buckets in which ANY device reported. This is the collector's own
   * uptime for the window and the denominator every coverage figure uses — see
   * rule 1 in the header.
   */
  fleetObservedBuckets: number;
  /** fleetObservedBuckets / (window / bucket). How much of the window we watched. */
  collectorCoverage: number;
}

/** The fleet metadata a trend needs to label itself. Site is pre-resolved. */
export interface TrendDevice {
  id: string;
  name: string | null;
  /** Depth-1 group ancestor, resolved by the caller from the group hierarchy. */
  site: SiteRef | null;
}

const pct = (fraction: number): string => `${Math.round(fraction * 100)}%`;

const labelFor = (device: TrendDevice | undefined, id: string): string =>
  device?.name?.trim() ? device.name.trim() : id;

// ── 1. AVAILABILITY REGRESSION ───────────────────────────────────────────────

/**
 * Per-device bucket counts for one window, as computed in SQL.
 *
 * `observedBuckets` counts buckets holding at least one presence reading for this
 * device; `onlineBuckets` counts those in which it reported `online` at least
 * once. Absent buckets appear in neither: unobserved is not offline.
 */
export interface DeviceBucketCounts {
  deviceId: string;
  observedBuckets: number;
  onlineBuckets: number;
}

export interface WindowBuckets {
  window: WindowRef;
  devices: readonly DeviceBucketCounts[];
}

export interface AvailabilityInput {
  recent: WindowBuckets;
  prior: WindowBuckets;
  devices: readonly TrendDevice[];
}

/** Observed availability for one side of a comparison, with its sample counts. */
export interface AvailabilitySide {
  /** 0-1 over OBSERVED buckets. Null when nothing was observed. */
  availability: number | null;
  observedBuckets: number;
  onlineBuckets: number;
  /** Devices contributing (1 for a device-scoped trend). */
  devices: number;
}

export interface AvailabilityTrend {
  scope: TrendScope;
  key: string;
  label: string;
  direction: TrendDirection;
  recent: AvailabilitySide;
  prior: AvailabilitySide;
  /** Signed change in percentage POINTS. Negative = got worse. */
  deltaPoints: number;
  /** Direction and magnitude with the window attached, per the honesty rules. */
  statement: string;
}

/**
 * GATES — availability.
 *
 * Bucket counts, not sample counts, because the status poller can write a dozen
 * rows for one device inside one bucket when it catches up after a stall, and
 * twelve rows from one minute is not twelve observations of a week.
 */
export const AVAILABILITY_GATES = {
  /** Buckets a DEVICE needs in EACH window. At 300s buckets, 2h of observation. */
  minDeviceBuckets: 24,
  /** Buckets the FLEET needs in EACH window before the trend type runs at all. */
  minFleetBuckets: 48,
  /** Devices a SITE needs before it is judged as a site rather than as devices. */
  minSiteDevices: 3,
  /**
   * Thinner window's observation must be at least this share of the fatter one's,
   * both fleet-wide and per entity. Below it, the windows measure different
   * amounts of looking and the comparison is refused.
   */
  minObservationBalance: 0.25,
  /** Percentage POINTS of change below which we call it steady, not a trend. */
  minDeltaPoints: 10,
} as const;

/** Ratio of the smaller observation count to the larger. 1 = identical effort. */
export function observationBalance(a: number, b: number): number {
  const hi = Math.max(a, b);
  if (hi === 0) return 0;
  return Math.min(a, b) / hi;
}

/**
 * Are two windows comparable at all?
 *
 * This is the data-gap guard at window level. If the collector watched 500
 * buckets of one window and 6 of the other, then every "decline" the comparison
 * produces is an artefact of when we happened to be running. Refusing the whole
 * comparison is the only honest answer — a per-entity gate cannot rescue a
 * baseline that does not exist.
 */
export function windowsComparable(
  recent: WindowRef,
  prior: WindowRef,
  gates: { minFleetBuckets: number; minObservationBalance: number } = AVAILABILITY_GATES,
): { comparable: boolean; reason: string | null } {
  if (recent.fleetObservedBuckets < gates.minFleetBuckets) {
    return {
      comparable: false,
      reason:
        `The recent window (${recent.label}) holds only ${recent.fleetObservedBuckets} observed ` +
        `bucket(s) of collection; ${gates.minFleetBuckets} are required. There is not enough ` +
        `history yet to compare windows.`,
    };
  }
  if (prior.fleetObservedBuckets < gates.minFleetBuckets) {
    return {
      comparable: false,
      reason:
        `The prior window (${prior.label}) holds only ${prior.fleetObservedBuckets} observed ` +
        `bucket(s) of collection; ${gates.minFleetBuckets} are required. Nothing is reported ` +
        `rather than treating a period we barely watched as a baseline.`,
    };
  }
  const balance = observationBalance(recent.fleetObservedBuckets, prior.fleetObservedBuckets);
  if (balance < gates.minObservationBalance) {
    return {
      comparable: false,
      reason:
        `Collection differed too much between the windows to compare them ` +
        `(${recent.fleetObservedBuckets} observed buckets recently vs ` +
        `${prior.fleetObservedBuckets} before, balance ${balance.toFixed(2)} < ` +
        `${gates.minObservationBalance}). That is a change in how much we were looking, ` +
        `not evidence of a change in the fleet.`,
    };
  }
  return { comparable: true, reason: null };
}

const side = (observed: number, online: number, devices: number): AvailabilitySide => ({
  availability: observed === 0 ? null : online / observed,
  observedBuckets: observed,
  onlineBuckets: online,
  devices,
});

/**
 * Compare one entity across two windows.
 *
 * Returns a trend, a `steady` verdict, or a suppression — never a guess. Exported
 * because it is where every gate actually bites and it deserves direct tests.
 */
export function compareAvailability(
  scope: TrendScope,
  key: string,
  label: string,
  recent: { observed: number; online: number; devices: number },
  prior: { observed: number; online: number; devices: number },
  windows: { recent: WindowRef; prior: WindowRef },
  gates: typeof AVAILABILITY_GATES = AVAILABILITY_GATES,
): { trend: AvailabilityTrend } | { steady: true } | { suppressed: Suppression } {
  // Sites need enough members to be a site; one device behind a site name is a
  // device finding wearing a venue's clothes.
  if (scope === "site" && Math.min(recent.devices, prior.devices) < gates.minSiteDevices) {
    return {
      suppressed: {
        scope,
        key,
        label,
        reason: "insufficient-devices",
        detail:
          `Only ${Math.min(recent.devices, prior.devices)} device(s) observed at this site in ` +
          `both windows; ${gates.minSiteDevices} are required before a site-level claim.`,
      },
    };
  }

  // A site aggregates many devices, so its bucket floor scales with membership —
  // otherwise a 30-device site clears the same bar as a single device.
  const floor =
    scope === "site"
      ? gates.minDeviceBuckets * Math.min(recent.devices, prior.devices)
      : gates.minDeviceBuckets;

  if (recent.observed < floor) {
    return {
      suppressed: {
        scope,
        key,
        label,
        reason: "insufficient-recent-samples",
        detail:
          `${recent.observed} observed bucket(s) in ${windows.recent.label}; ${floor} required. ` +
          `Too few observations to state a trend.`,
      },
    };
  }
  if (prior.observed < floor) {
    return {
      suppressed: {
        scope,
        key,
        label,
        reason: "insufficient-prior-samples",
        detail:
          `${prior.observed} observed bucket(s) in ${windows.prior.label}; ${floor} required. ` +
          `No usable baseline, so nothing is claimed.`,
      },
    };
  }

  // The per-entity data-gap guard. A device we saw far less of this week may have
  // been unreachable, retired mid-window, or simply missed by a partial sweep —
  // all of which are "we stopped looking", not "it got worse".
  const balance = observationBalance(recent.observed, prior.observed);
  if (balance < gates.minObservationBalance) {
    return {
      suppressed: {
        scope,
        key,
        label,
        reason: "observation-imbalance",
        detail:
          `Observed ${recent.observed} bucket(s) in ${windows.recent.label} vs ${prior.observed} ` +
          `in ${windows.prior.label} (balance ${balance.toFixed(2)}). We looked a different ` +
          `amount in each window, so a change here would be ours, not the fleet's.`,
      },
    };
  }

  const recentSide = side(recent.observed, recent.online, recent.devices);
  const priorSide = side(prior.observed, prior.online, prior.devices);
  // Unreachable given the floors above, but the types say null is possible and
  // an honest-null system does not assert non-null on a hunch.
  if (recentSide.availability === null || priorSide.availability === null) {
    return {
      suppressed: {
        scope,
        key,
        label,
        reason: "insufficient-recent-samples",
        detail: "Availability could not be computed for one of the windows.",
      },
    };
  }

  // Rounded BEFORE the threshold test, deliberately. 0.80 - 0.90 in IEEE754 is
  // -9.999999999999998, which would silently suppress an exactly-10-point drop —
  // and a payload reporting "-10.0 points" must never have been judged as 9.99.
  // The gate and the published number have to be the same number.
  const deltaPoints = Math.round((recentSide.availability - priorSide.availability) * 1000) / 10;
  if (Math.abs(deltaPoints) < gates.minDeltaPoints) return { steady: true };

  const direction: TrendDirection = deltaPoints < 0 ? "regression" : "recovery";
  const verb = direction === "regression" ? "fell" : "rose";
  return {
    trend: {
      scope,
      key,
      label,
      direction,
      recent: recentSide,
      prior: priorSide,
      deltaPoints,
      statement:
        `Availability ${verb} from ${pct(priorSide.availability)} to ` +
        `${pct(recentSide.availability)} comparing ${windows.recent.label} against ` +
        `${windows.prior.label} — ${Math.abs(Math.round(deltaPoints))} points, measured over ` +
        `${recent.observed} observed bucket(s) recently and ${prior.observed} before` +
        (scope === "site" ? ` across ${recent.devices} device(s)` : "") +
        `. Computed over observed time only; unobserved buckets are excluded, not counted as down.`,
    },
  };
}

export interface AvailabilityReport {
  /** False when the windows were not comparable — `reason` says why. */
  available: boolean;
  reason: string | null;
  windows: { recent: WindowRef; prior: WindowRef };
  trends: AvailabilityTrend[];
  /** Entities that cleared every gate and simply did not move much. */
  steady: { sites: number; devices: number };
  suppressed: SuppressionSummary;
  gates: typeof AVAILABILITY_GATES;
}

const sumBuckets = (
  rows: readonly (DeviceBucketCounts | undefined)[],
): { observed: number; online: number; devices: number } => {
  let observed = 0;
  let online = 0;
  let devices = 0;
  for (const row of rows) {
    if (!row) continue;
    observed += row.observedBuckets;
    online += row.onlineBuckets;
    devices += 1;
  }
  return { observed, online, devices };
};

/**
 * Availability regression / recovery at fleet, site and device scope.
 *
 * Site membership comes from the pre-resolved `site` on each `TrendDevice` (the
 * depth-1 group ancestor — joined on group_id, never group_name, for the reasons
 * in group-hierarchy.ts). Devices with no resolvable site contribute to the fleet
 * and device scopes but to no site, which keeps "site with no devices we could
 * place" distinct from "site that is fine".
 */
export function analyzeAvailability(
  input: AvailabilityInput,
  gates: typeof AVAILABILITY_GATES = AVAILABILITY_GATES,
): AvailabilityReport {
  const windows = { recent: input.recent.window, prior: input.prior.window };
  const comparable = windowsComparable(windows.recent, windows.prior, gates);
  if (!comparable.comparable) {
    return {
      available: false,
      reason: comparable.reason,
      windows,
      trends: [],
      steady: { sites: 0, devices: 0 },
      suppressed: summarizeSuppressions([]),
      gates,
    };
  }

  const recentById = new Map(input.recent.devices.map((r) => [r.deviceId, r]));
  const priorById = new Map(input.prior.devices.map((r) => [r.deviceId, r]));

  const trends: AvailabilityTrend[] = [];
  const suppressed: Suppression[] = [];
  const steady = { sites: 0, devices: 0 };

  // ── fleet scope ──
  // Deliberately first and unconditional: if the whole fleet moved, that is the
  // headline, and it is also the sanity check on every finding below it.
  const fleetVerdict = compareAvailability(
    "fleet",
    "fleet",
    "Whole fleet",
    sumBuckets(input.recent.devices),
    sumBuckets(input.prior.devices),
    windows,
    gates,
  );
  if ("trend" in fleetVerdict) trends.push(fleetVerdict.trend);
  else if ("suppressed" in fleetVerdict) suppressed.push(fleetVerdict.suppressed);

  // ── site scope ──
  const sites = new Map<string, { label: string; members: string[] }>();
  for (const device of input.devices) {
    if (!device.site) continue;
    const entry = sites.get(device.site.uuid) ?? {
      label: device.site.name ?? device.site.uuid,
      members: [],
    };
    entry.members.push(device.id);
    sites.set(device.site.uuid, entry);
  }
  for (const [uuid, site] of sites) {
    const verdict = compareAvailability(
      "site",
      uuid,
      site.label,
      sumBuckets(site.members.map((id) => recentById.get(id))),
      sumBuckets(site.members.map((id) => priorById.get(id))),
      windows,
      gates,
    );
    if ("trend" in verdict) trends.push(verdict.trend);
    else if ("suppressed" in verdict) suppressed.push(verdict.suppressed);
    else steady.sites += 1;
  }

  // ── device scope ──
  for (const device of input.devices) {
    const r = recentById.get(device.id);
    const p = priorById.get(device.id);
    const verdict = compareAvailability(
      "device",
      device.id,
      labelFor(device, device.id),
      { observed: r?.observedBuckets ?? 0, online: r?.onlineBuckets ?? 0, devices: 1 },
      { observed: p?.observedBuckets ?? 0, online: p?.onlineBuckets ?? 0, devices: 1 },
      windows,
      gates,
    );
    if ("trend" in verdict) trends.push(verdict.trend);
    else if ("suppressed" in verdict) suppressed.push(verdict.suppressed);
    else steady.devices += 1;
  }

  // Fleet, then sites, then devices; worst first inside each. The site claim is
  // the valuable one, so it must not be buried under 200 device rows.
  const scopeRank = { fleet: 0, site: 1, device: 2 } as const;
  trends.sort((a, b) => scopeRank[a.scope] - scopeRank[b.scope] || a.deltaPoints - b.deltaPoints);

  return {
    available: true,
    reason: null,
    windows,
    trends,
    steady,
    suppressed: summarizeSuppressions(suppressed),
    gates,
  };
}

// ── 2. STORAGE FILL TREND ────────────────────────────────────────────────────

/** One telemetry reading. `percent` is null when the field was unreadable. */
export interface StoragePoint {
  observedAt: string;
  percent: number | null;
}

export interface StorageSeries {
  deviceId: string;
  points: readonly StoragePoint[];
}

/**
 * GATES — storage.
 *
 * The slow lane sweeps the online estate roughly every two hours and reaches
 * ~43% of the fleet, so most devices will not clear these. That is the intended
 * outcome: a fill rate fitted to four points inside one afternoon would put a
 * "disk full in 3 days" claim in front of an operator on the strength of integer
 * rounding.
 */
export const STORAGE_GATES = {
  /** Readable points required. */
  minPoints: 6,
  /** First to last reading must span at least this long. */
  minSpanHours: 48,
  /** Points must fall on at least this many distinct calendar days (UTC). */
  minDistinctDays: 3,
  /**
   * A gap this long inside the series voids the fit. We refuse to draw a line
   * across a period we were not watching: the device could have been reimaged,
   * and a step change is not a fill rate.
   */
  maxGapHours: 36,
  /** Percent-per-day below which we call it flat. Storage is an integer percent. */
  minSlopePctPerDay: 0.5,
  /**
   * Beyond this horizon a projection is arithmetic, not a forecast. A quarter is
   * the furthest a rate fitted to whole-percent readings can honestly reach: at
   * the 0.5 pt/day floor, a device at 55% used is already 90 days out.
   */
  projectionHorizonDays: 90,
  /** Only devices already this full get a "days to full" projection at all. */
  projectionFloorPercent: 50,
} as const;

export type StorageDirection = "filling" | "draining";

export interface StorageTrend {
  deviceId: string;
  label: string;
  direction: StorageDirection;
  /** Signed least-squares slope in percentage points per day. */
  slopePctPerDay: number;
  firstPercent: number;
  latestPercent: number;
  firstObservedAt: string;
  latestObservedAt: string;
  points: number;
  spanHours: number;
  distinctDays: number;
  largestGapHours: number;
  /**
   * Days until 100% at the fitted rate. Null when draining, when beyond the
   * projection horizon, or when the device is not full enough for a projection
   * to mean anything — with `projectionNote` saying which.
   */
  daysToFull: number | null;
  projectionNote: string | null;
  statement: string;
}

/** Least-squares slope of y over x. Null when x has no spread. Pure. */
export function leastSquaresSlope(xs: readonly number[], ys: readonly number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += xs[i]!;
    sy += ys[i]!;
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i]! - mx;
    num += dx * (ys[i]! - my);
    den += dx * dx;
  }
  if (den === 0) return null;
  return num / den;
}

/**
 * A reading whose timestamp we cannot trust is dropped, not clamped.
 *
 * The metrics path has had to defend against absurd platform timestamps before.
 * Clamping a bad date to `now` would fabricate a data point at a time we never
 * observed — which inside a slope fit is worse than having one fewer point.
 */
const USABLE_FUTURE_MS = 60 * 60 * 1000;
const USABLE_PAST_DAYS = 400;

export function sanitizeStoragePoints(
  points: readonly StoragePoint[],
  observedNow: Date,
): { points: Array<{ atMs: number; percent: number }>; discarded: number } {
  const out: Array<{ atMs: number; percent: number }> = [];
  let discarded = 0;
  const nowMs = observedNow.getTime();
  for (const point of points) {
    // An unreadable metric is absent, not suspect — it is not counted as discarded.
    if (point.percent === null || !Number.isFinite(point.percent)) continue;
    // A percentage outside 0-100 is not a reading, it is a parse failure.
    if (point.percent < 0 || point.percent > 100) {
      discarded += 1;
      continue;
    }
    const atMs = Date.parse(point.observedAt);
    if (!Number.isFinite(atMs)) {
      discarded += 1;
      continue;
    }
    if (atMs > nowMs + USABLE_FUTURE_MS || atMs < nowMs - USABLE_PAST_DAYS * 86_400_000) {
      discarded += 1;
      continue;
    }
    out.push({ atMs, percent: point.percent });
  }
  out.sort((a, b) => a.atMs - b.atMs);
  return { points: out, discarded };
}

export interface StorageReport {
  available: boolean;
  reason: string | null;
  windowDays: number;
  trends: StorageTrend[];
  /** Devices that cleared the gates and are not moving. The healthy majority. */
  flat: number;
  suppressed: SuppressionSummary;
  /** Readings thrown out as unusable (bad clock, out-of-range percent). */
  discardedReadings: number;
  gates: typeof STORAGE_GATES;
}

/**
 * Devices trending toward full.
 *
 * The only PREVENTIVE claim in the product — everything else reports a fault that
 * has already happened. Which is exactly why the gates are strict: a preventive
 * claim that turns out to be noise costs more credibility than a missed one.
 */
export function analyzeStorage(
  series: readonly StorageSeries[],
  devices: readonly TrendDevice[],
  windowDays: number,
  observedNow: Date,
  gates: typeof STORAGE_GATES = STORAGE_GATES,
): StorageReport {
  const byId = new Map(devices.map((d) => [d.id, d]));
  const trends: StorageTrend[] = [];
  const suppressed: Suppression[] = [];
  let flat = 0;
  let discardedReadings = 0;

  for (const entry of series) {
    const label = labelFor(byId.get(entry.deviceId), entry.deviceId);
    const clean = sanitizeStoragePoints(entry.points, observedNow);
    discardedReadings += clean.discarded;
    const points = clean.points;

    if (points.length < gates.minPoints) {
      suppressed.push({
        scope: "device",
        key: entry.deviceId,
        label,
        reason: "insufficient-points",
        detail:
          `${points.length} usable storage reading(s); ${gates.minPoints} required. ` +
          `The telemetry slow lane has not reached this device often enough yet.`,
      });
      continue;
    }

    const first = points[0]!;
    const last = points[points.length - 1]!;
    const spanHours = (last.atMs - first.atMs) / 3_600_000;
    if (spanHours < gates.minSpanHours) {
      suppressed.push({
        scope: "device",
        key: entry.deviceId,
        label,
        reason: "insufficient-span",
        detail:
          `Readings span ${spanHours.toFixed(1)}h; ${gates.minSpanHours}h required. ` +
          `A fill rate from a few hours of readings is noise, not a trend.`,
      });
      continue;
    }

    const distinctDays = new Set(points.map((p) => new Date(p.atMs).toISOString().slice(0, 10)))
      .size;
    if (distinctDays < gates.minDistinctDays) {
      suppressed.push({
        scope: "device",
        key: entry.deviceId,
        label,
        reason: "insufficient-span",
        detail:
          `Readings fall on ${distinctDays} distinct day(s); ${gates.minDistinctDays} required.`,
      });
      continue;
    }

    // The data-gap guard: never fit across a period we were not watching.
    let largestGapHours = 0;
    for (let i = 1; i < points.length; i += 1) {
      largestGapHours = Math.max(
        largestGapHours,
        (points[i]!.atMs - points[i - 1]!.atMs) / 3_600_000,
      );
    }
    if (largestGapHours > gates.maxGapHours) {
      suppressed.push({
        scope: "device",
        key: entry.deviceId,
        label,
        reason: "observation-gap",
        detail:
          `A ${largestGapHours.toFixed(1)}h gap sits inside the readings (limit ` +
          `${gates.maxGapHours}h). We stopped looking for part of this window, so any ` +
          `change across the gap could be a step, not a fill rate.`,
      });
      continue;
    }

    const slope = leastSquaresSlope(
      points.map((p) => (p.atMs - first.atMs) / 86_400_000),
      points.map((p) => p.percent),
    );
    if (slope === null || Math.abs(slope) < gates.minSlopePctPerDay) {
      flat += 1;
      continue;
    }

    const direction: StorageDirection = slope > 0 ? "filling" : "draining";
    let daysToFull: number | null = null;
    let projectionNote: string | null = null;
    if (direction === "draining") {
      projectionNote = "Storage is being freed, so there is nothing to project.";
    } else if (last.percent < gates.projectionFloorPercent) {
      projectionNote =
        `At ${last.percent}% used, this device is too far from full for a date to be ` +
        `meaningful; the rate is reported instead.`;
    } else {
      const projected = (100 - last.percent) / slope;
      if (projected > gates.projectionHorizonDays) {
        projectionNote =
          `Full in about ${Math.round(projected)} days at this rate — beyond the ` +
          `${gates.projectionHorizonDays}-day horizon, so no date is asserted.`;
      } else {
        daysToFull = Math.round(projected * 10) / 10;
      }
    }

    const rounded = Math.round(slope * 100) / 100;
    trends.push({
      deviceId: entry.deviceId,
      label,
      direction,
      slopePctPerDay: rounded,
      firstPercent: first.percent,
      latestPercent: last.percent,
      firstObservedAt: new Date(first.atMs).toISOString(),
      latestObservedAt: new Date(last.atMs).toISOString(),
      points: points.length,
      spanHours: Math.round(spanHours * 10) / 10,
      distinctDays,
      largestGapHours: Math.round(largestGapHours * 10) / 10,
      daysToFull,
      projectionNote,
      statement:
        `Storage used ${direction === "filling" ? "rose" : "fell"} from ${first.percent}% to ` +
        `${last.percent}% over ${(spanHours / 24).toFixed(1)} days (${points.length} readings ` +
        `on ${distinctDays} days), a rate of ${rounded > 0 ? "+" : ""}${rounded.toFixed(2)} ` +
        `points/day` +
        (daysToFull !== null ? `, reaching 100% in about ${daysToFull} days` : "") +
        `. Storage is reported as a whole percent, so slow rates sit near the resolution of ` +
        `the measurement.`,
    });
  }

  trends.sort((a, b) => {
    const aKey = a.daysToFull ?? Number.POSITIVE_INFINITY;
    const bKey = b.daysToFull ?? Number.POSITIVE_INFINITY;
    return aKey - bKey || b.slopePctPerDay - a.slopePctPerDay;
  });

  return {
    available: series.length > 0,
    reason:
      series.length === 0
        ? "No storage telemetry has been collected yet, so no fill trend can be computed."
        : null,
    windowDays,
    trends,
    flat,
    suppressed: summarizeSuppressions(suppressed),
    discardedReadings,
    gates,
  };
}

// ── 3. TRANSMISSION SILENCE ──────────────────────────────────────────────────

/**
 * One day of usage as the platform reports it. `date` is a platform-supplied
 * `YYYY-MM-DD` and is NOT trusted until `sanitizeUsageDates` has seen it.
 */
export interface UsageDay {
  deviceId: string;
  date: string;
  bytes: number;
}

/**
 * GATES — transmission silence.
 *
 * This signal is valuable precisely because it comes from a DIFFERENT feed than
 * presence: `data_usage_days` is the platform's own daily accounting, so it can
 * corroborate or contradict the status flags — which we have already proven can
 * be wrong. That independence is worth nothing if the detector fires on feed
 * outages, hence the quorum rule below.
 */
export const SILENCE_GATES = {
  /** Days of history examined for the habit baseline. */
  baselineDays: 14,
  /** Trailing days examined for silence, ending at the FEED's newest date. */
  recentDays: 3,
  /**
   * A date counts as observed only if this share of the feed's typical daily
   * device count has a row on it. Below quorum the platform did not report that
   * day and it is excluded from both windows — the whole fleet going quiet at
   * once is a feed outage, never 249 simultaneous device faults.
   */
  feedQuorumFraction: 0.5,
  /** Healthy baseline days required before a device can be said to have a habit. */
  minBaselineDays: 7,
  /** Share of healthy baseline days the device must have transmitted on. */
  minBaselineActiveFraction: 0.6,
  /** Healthy days required in the recent window before silence can be asserted. */
  minRecentDays: 2,
} as const;

export interface SilenceTrend {
  deviceId: string;
  label: string;
  /** Healthy recent days on which the device sent nothing. */
  silentDays: number;
  /** Healthy baseline days it transmitted on, over healthy baseline days examined. */
  baselineActiveDays: number;
  baselineDaysExamined: number;
  lastTransmissionDate: string | null;
  /** Bytes on the last day it did transmit, for scale. Null when never seen. */
  lastTransmissionBytes: number | null;
  statement: string;
}

export interface SilenceReport {
  available: boolean;
  reason: string | null;
  /**
   * The feed's own newest usable date. Every claim is relative to THIS, not to
   * wall-clock today — see `feedLagDays`.
   */
  feedThroughDate: string | null;
  /** Wall-clock days between the feed's newest date and now. */
  feedLagDays: number | null;
  /** Dates in the examined range that failed quorum — feed outages, not silence. */
  feedGapDates: string[];
  recentDaysExamined: string[];
  baselineDaysExamined: string[];
  trends: SilenceTrend[];
  /** Devices with a habit that are still transmitting. */
  transmitting: number;
  suppressed: SuppressionSummary;
  /** Rows thrown out for an unusable date. */
  discardedRows: number;
  gates: typeof SILENCE_GATES;
}

const MAX_USAGE_FUTURE_DAYS = 1;

/**
 * Throw out rows whose platform date we cannot trust, BEFORE anything derives a
 * reference date from them.
 *
 * This is the single most dangerous input in the module: the reference "today"
 * for silence is the feed's own maximum date, so one row stamped next year would
 * move the reference forward and render the entire fleet "silent" — a
 * catastrophic, confident, entirely fabricated finding. Tolerance is one day
 * ahead of the observation clock, for timezone rounding at the platform's end.
 */
export function sanitizeUsageDates(
  rows: readonly UsageDay[],
  observedNow: Date,
): { rows: UsageDay[]; discarded: number } {
  const nowMs = observedNow.getTime();
  const kept: UsageDay[] = [];
  let discarded = 0;
  for (const row of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
      discarded += 1;
      continue;
    }
    const atMs = Date.parse(`${row.date}T00:00:00Z`);
    if (!Number.isFinite(atMs)) {
      discarded += 1;
      continue;
    }
    if (
      atMs > nowMs + MAX_USAGE_FUTURE_DAYS * 86_400_000 ||
      atMs < nowMs - USABLE_PAST_DAYS * 86_400_000
    ) {
      discarded += 1;
      continue;
    }
    // A negative or non-finite byte count is a parse failure, not a reading. The
    // ROW still counts as the feed having reported this device on this date —
    // that is what keeps the quorum check honest — but the bytes read as zero.
    kept.push({ ...row, bytes: Number.isFinite(row.bytes) && row.bytes > 0 ? row.bytes : 0 });
  }
  return { rows: kept, discarded };
}

/** The `days` calendar days ending at (and including) `throughDate`, ascending. */
const dateRange = (throughDate: string, days: number): string[] => {
  const end = Date.parse(`${throughDate}T00:00:00Z`);
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    out.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
};

/**
 * Devices that transmitted every day and then stopped.
 *
 * Independent of presence by construction, which is the point: when the status
 * flag says a device is fine and its own traffic accounting says it has sent
 * nothing for three days, the disagreement is the finding.
 */
export function analyzeTransmissionSilence(
  rows: readonly UsageDay[],
  devices: readonly TrendDevice[],
  observedNow: Date,
  gates: typeof SILENCE_GATES = SILENCE_GATES,
): SilenceReport {
  const byId = new Map(devices.map((d) => [d.id, d]));
  const clean = sanitizeUsageDates(rows, observedNow);

  const base = (reason: string | null): SilenceReport => ({
    available: false,
    reason,
    feedThroughDate: null,
    feedLagDays: null,
    feedGapDates: [],
    recentDaysExamined: [],
    baselineDaysExamined: [],
    trends: [],
    transmitting: 0,
    suppressed: summarizeSuppressions([]),
    discardedRows: clean.discarded,
    gates,
  });

  if (clean.rows.length === 0) {
    return base(
      "No usable daily usage rows. The data-usage poller has not produced trustworthy history yet.",
    );
  }

  // Reference date = the feed's newest USABLE date. Never wall-clock today: the
  // usage poller runs daily and lags, so measuring silence against `now` would
  // brand the whole fleet silent for exactly the length of that lag.
  let feedThroughDate = clean.rows[0]!.date;
  for (const row of clean.rows) if (row.date > feedThroughDate) feedThroughDate = row.date;

  // Calendar days, not a rounded duration: with `now` at midday, rounding turns a
  // three-day-old feed into "4 day(s) behind" and the number stops matching the
  // dates either side of it in the same sentence.
  const feedLagDays = Math.max(
    0,
    Math.round(
      (Date.parse(`${observedNow.toISOString().slice(0, 10)}T00:00:00Z`) -
        Date.parse(`${feedThroughDate}T00:00:00Z`)) /
        86_400_000,
    ),
  );

  // Which devices the feed reported on each date, and per-device bytes per date.
  const devicesPerDate = new Map<string, Set<string>>();
  const bytesByDeviceDate = new Map<string, number>();
  for (const row of clean.rows) {
    const set = devicesPerDate.get(row.date) ?? new Set<string>();
    set.add(row.deviceId);
    devicesPerDate.set(row.date, set);
    const key = `${row.deviceId} ${row.date}`;
    bytesByDeviceDate.set(key, (bytesByDeviceDate.get(key) ?? 0) + row.bytes);
  }

  // Quorum is measured against the MEDIAN daily device count, not the maximum:
  // one unusually complete day must not disqualify every ordinary one.
  const counts = [...devicesPerDate.values()].map((s) => s.size).sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)] ?? 0;
  const quorum = Math.max(1, Math.ceil(median * gates.feedQuorumFraction));
  const healthy = (date: string): boolean => (devicesPerDate.get(date)?.size ?? 0) >= quorum;

  const window = dateRange(feedThroughDate, gates.baselineDays + gates.recentDays);
  const feedGapDates = window.filter((d) => !healthy(d));
  const healthyDates = window.filter(healthy);

  // Windows are built from HEALTHY dates only, so a feed outage in the middle
  // shifts the boundary rather than manufacturing silence.
  const recentDates = healthyDates.slice(-gates.recentDays);
  const baselineDates = healthyDates.slice(0, Math.max(0, healthyDates.length - recentDates.length));

  if (recentDates.length < gates.minRecentDays) {
    return {
      ...base(
        `Only ${recentDates.length} of the last ${gates.recentDays} day(s) were reported by the ` +
          `feed with enough of the fleet present (quorum ${quorum} device(s)); ` +
          `${gates.minRecentDays} are required. Absence of usage rows here is the feed not ` +
          `reporting, not devices going quiet.`,
      ),
      feedThroughDate,
      feedLagDays,
      feedGapDates,
      baselineDaysExamined: baselineDates,
      recentDaysExamined: recentDates,
    };
  }

  const trends: SilenceTrend[] = [];
  const suppressed: Suppression[] = [];
  let transmitting = 0;

  // Only devices the feed has ever mentioned can be judged. A device with no
  // usage rows at all is not silent — the platform accounts for ~130 of 249
  // devices, and absence from that accounting is a coverage fact, not a fault.
  const seenDevices = [...new Set(clean.rows.map((r) => r.deviceId))].sort();

  for (const deviceId of seenDevices) {
    const label = labelFor(byId.get(deviceId), deviceId);
    const bytesOn = (date: string): number => bytesByDeviceDate.get(`${deviceId} ${date}`) ?? 0;

    if (baselineDates.length < gates.minBaselineDays) {
      suppressed.push({
        scope: "device",
        key: deviceId,
        label,
        reason: "feed-gap",
        detail:
          `Only ${baselineDates.length} healthy baseline day(s) in the feed; ` +
          `${gates.minBaselineDays} required to establish a transmission habit.`,
      });
      continue;
    }

    const activeBaselineDays = baselineDates.filter((d) => bytesOn(d) > 0).length;
    const activeFraction = activeBaselineDays / baselineDates.length;
    if (activeFraction < gates.minBaselineActiveFraction) {
      suppressed.push({
        scope: "device",
        key: deviceId,
        label,
        reason: "no-baseline-habit",
        detail:
          `Transmitted on ${activeBaselineDays} of ${baselineDates.length} healthy baseline ` +
          `day(s) (${pct(activeFraction)}); a habit needs ` +
          `${pct(gates.minBaselineActiveFraction)}. An intermittent device going quiet is ` +
          `not a change.`,
      });
      continue;
    }

    const silentDays = recentDates.filter((d) => bytesOn(d) === 0).length;
    if (silentDays < recentDates.length) {
      transmitting += 1;
      continue;
    }

    // Last day it did transmit, searched back over the whole examined window.
    let lastTransmissionDate: string | null = null;
    let lastTransmissionBytes: number | null = null;
    for (const date of [...baselineDates, ...recentDates].reverse()) {
      const bytes = bytesOn(date);
      if (bytes > 0) {
        lastTransmissionDate = date;
        lastTransmissionBytes = bytes;
        break;
      }
    }

    trends.push({
      deviceId,
      label,
      silentDays,
      baselineActiveDays: activeBaselineDays,
      baselineDaysExamined: baselineDates.length,
      lastTransmissionDate,
      lastTransmissionBytes,
      statement:
        `Transmitted on ${activeBaselineDays} of ${baselineDates.length} baseline day(s), then ` +
        `nothing on all ${silentDays} of the feed's most recent reported day(s) ` +
        `(${recentDates[0]} to ${recentDates[recentDates.length - 1]})` +
        (lastTransmissionDate
          ? `; last traffic ${lastTransmissionDate}` +
            (lastTransmissionBytes !== null
              ? ` (${(lastTransmissionBytes / 1_000_000).toFixed(1)} MB)`
              : "")
          : "") +
        `. From the platform's daily traffic accounting, which is independent of the presence ` +
        `flags` +
        (feedLagDays > 0
          ? ` and currently runs ${feedLagDays} day(s) behind (through ${feedThroughDate})`
          : "") +
        `.`,
    });
  }

  trends.sort((a, b) => b.silentDays - a.silentDays || a.label.localeCompare(b.label));

  return {
    available: true,
    reason: null,
    feedThroughDate,
    feedLagDays,
    feedGapDates,
    recentDaysExamined: recentDates,
    baselineDaysExamined: baselineDates,
    trends,
    transmitting,
    suppressed: summarizeSuppressions(suppressed),
    discardedRows: clean.discarded,
    gates,
  };
}

// ── report assembly ──────────────────────────────────────────────────────────

/**
 * The one caveat that governs every number in the report. Carried in the payload
 * so a trend is never read as a live claim about this instant.
 */
export const TREND_BASIS =
  "Trends compare stored windows, not live state. Every figure is computed over time we " +
  "actually observed: buckets, days and readings we have no data for are excluded from the " +
  "denominator rather than counted as failures, and any window pair where collection differed " +
  "too much to compare is refused outright. Sample counts travel with every trend so a reader " +
  "can judge it, and a device or site below the stated minimum for a trend type produces " +
  "nothing at all rather than a low-confidence claim.";

export interface TrendReport {
  basis: string;
  observedAt: string;
  availability: AvailabilityReport;
  storage: StorageReport;
  transmissionSilence: SilenceReport;
  /** Headline sentences, worst first, across all three engines. */
  headlines: string[];
  /** What we could not do and why. Never empty when something was skipped. */
  notes: string[];
}

/** Cap on headlines — a list nobody reads is not a summary. */
const HEADLINE_CAP = 10;

export function buildTrendReport(
  observedNow: Date,
  availability: AvailabilityReport,
  storage: StorageReport,
  silence: SilenceReport,
): TrendReport {
  const headlines: string[] = [];
  const notes: string[] = [];

  for (const trend of availability.trends) {
    if (trend.direction !== "regression") continue;
    headlines.push(`${trend.label} (${trend.scope}): ${trend.statement}`);
  }
  for (const trend of silence.trends) headlines.push(`${trend.label}: ${trend.statement}`);
  for (const trend of storage.trends) {
    if (trend.direction !== "filling") continue;
    headlines.push(`${trend.label}: ${trend.statement}`);
  }

  if (!availability.available && availability.reason) {
    notes.push(`Availability regression: ${availability.reason}`);
  }
  if (!storage.available && storage.reason) notes.push(`Storage fill: ${storage.reason}`);
  if (!silence.available && silence.reason) notes.push(`Transmission silence: ${silence.reason}`);

  if (availability.available && availability.suppressed.total > 0) {
    notes.push(
      `Availability: ${availability.suppressed.total} entity(ies) were below the sample gates ` +
        `and deliberately not judged.`,
    );
  }
  if (storage.available && storage.trends.length === 0) {
    notes.push(
      `Storage fill: no device cleared the gates (${storage.gates.minPoints}+ readings across ` +
        `${storage.gates.minDistinctDays}+ days spanning ${storage.gates.minSpanHours}h+ with no ` +
        `gap over ${storage.gates.maxGapHours}h). ${storage.suppressed.total} device(s) had ` +
        `history but not enough of it; ${storage.flat} were measurable and flat.`,
    );
  }
  if (silence.available && silence.feedGapDates.length > 0) {
    notes.push(
      `Transmission silence: ${silence.feedGapDates.length} day(s) in the examined range were ` +
        `excluded because the usage feed did not report enough of the fleet on them ` +
        `(${silence.feedGapDates.join(", ")}). Those are our blind days, not silent devices.`,
    );
  }
  if (silence.available && (silence.feedLagDays ?? 0) > 0) {
    notes.push(
      `Transmission silence is measured against the usage feed's own newest day ` +
        `(${silence.feedThroughDate}), which is ${silence.feedLagDays} day(s) behind now. ` +
        `Measuring against today would report the feed's lag as fleet-wide silence.`,
    );
  }
  if (headlines.length === 0 && notes.length === 0) {
    notes.push("Every trend type ran and found no material change.");
  }

  return {
    basis: TREND_BASIS,
    observedAt: observedNow.toISOString(),
    availability,
    storage,
    transmissionSilence: silence,
    headlines: headlines.slice(0, HEADLINE_CAP),
    notes,
  };
}
