/**
 * What we can measure well enough to put in a contract — decided from live
 * capability, not from a list.
 *
 * THE BUG THIS REPLACES
 * `UNMEASURABLE` used to be a hardcoded array of six dimensions. It was correct
 * when it was written and then quietly went false: storage, Wi-Fi signal, CPU,
 * memory and screenshots all became readable, and the SLA page went on telling a
 * customer we could not measure things the same product measures on the next tab.
 * Under-claiming on the page an exec reads in a contract conversation is a
 * commercial error, not a cosmetic one — so the classification is now derived
 * from what the fleet actually returned in the last window.
 *
 * THE DISTINCTION THE OLD MODEL LACKED
 * "Readable" and "measurable for SLA purposes" are not the same claim, and
 * collapsing them would be the same mistake in the opposite direction:
 *
 *   sla-grade    Measured continuously and fleet-wide. Defensible in a contract
 *                because the evidence is stored and covers nearly every device.
 *   readable     We can obtain it per device, on a rotation, at partial
 *                coverage. Genuinely useful for diagnosis; NOT something to
 *                promise a customer. Coverage and cadence are always stated so
 *                the reader can judge for themselves.
 *   unmeasurable No source at all — or a source that returned nothing at all in
 *                the last window. `permanent` separates those two.
 *
 * WHERE THE SLA-GRADE LINE SITS, AND WHY  (§`SLA_GRADE_BARS`)
 * Three bars, and a dimension must clear all of them. Each failure is reported
 * as a sentence, so "not SLA-grade" is never a bare verdict.
 *
 * THE ONE THING STILL HARDCODED
 * `sourceless` on a catalog entry. No live probe can prove the absence of a verb
 * across every model, so that judgement is asserted — in this one place, with
 * its evidence next to it, and it is never upgraded by a live reading.
 */

import type { PollerRunRow, LaneCadence } from "../alerting/pipeline-health.js";
import { measureCadence } from "../alerting/pipeline-health.js";

export type MeasurementGrade = "sla-grade" | "readable" | "unmeasurable";

/**
 * Coverage below which we make no external claim.
 *
 * Deliberately ONE number shared with per-device uptime claimability
 * (`CLAIMABLE_FLOOR` in coverage.ts is this constant): "can we claim this
 * device's uptime" and "can we claim we measure this dimension" are the same
 * question asked of a window and of a fleet. Two constants here would drift, and
 * an SLA page showing two different claimability bars is indefensible.
 */
export const CLAIMABLE_COVERAGE_FLOOR = 0.95;

export const SLA_GRADE_BARS = {
  /** Share of the ACTIVE fleet that must return a value. */
  minCoverage: CLAIMABLE_COVERAGE_FLOOR,
  /**
   * How often the feed must come back to a given device.
   *
   * One hour is already 3x coarser than the platform's own 15–22 min push floor,
   * and it is the coarsest sampling from which a daily figure is observation
   * rather than interpolation. The rotating slow lanes return to a device every
   * few HOURS, so they sit outside this bar by arithmetic, not by opinion.
   */
  maxCadenceSeconds: 3600,
} as const;

/** Shared with coverage.ts so the SLA page words a duration exactly one way. */
export const humanDuration = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${Math.round(s / 86400)} days`;
};

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** Where a live reading for a dimension comes from. */
export interface DimensionSource {
  /** Plain-language feed name, shown to the reader. */
  feed: string;
  /**
   * `telemetryAvailability()` keys backing this dimension. A dimension needing
   * two fields is only as measurable as its WEAKER one, so coverage is the min.
   */
  fields: readonly string[];
  /** `poller_runs.poller` that fills it, when a standing lane does. */
  lane: string | null;
  /**
   * False when the value only exists at the moment we fetch it. An SLA figure
   * must be reproducible from stored evidence months later (see report.ts), so
   * an unstored reading can never be SLA-grade however good its coverage is.
   */
  persisted: boolean;
}

export interface DimensionDefinition {
  id: string;
  dimension: string;
  /** SLA language this dimension would be needed to evidence. */
  slaImpact: string;
  /**
   * Set ONLY where no source exists anywhere on the platform. Asserted, not
   * measured — so the evidence travels with the assertion, and a live reading
   * never overrides it.
   */
  sourceless?: { reason: string };
  source?: DimensionSource;
}

/**
 * The dimension catalog.
 *
 * Only two entries assert unmeasurability, and both are re-verified claims
 * rather than inherited ones:
 *   - temperature has no verb on ANY model (docs/14 §C);
 *   - per-slot confirmed playback has no readable render log — an EXTERNAL
 *     blocker sitting with Videri (docs/22 Ask 5).
 *
 * "Network quality" used to be one entry conflating signal with packet loss and
 * jitter, which made a readable field share a false verdict with two sourceless
 * ones. It is split here, because a customer conversation turns on exactly that
 * distinction: we can show a weak radio, we cannot show a congested venue.
 */
export const DIMENSION_CATALOG: readonly DimensionDefinition[] = [
  {
    id: "thermal",
    dimension: "Thermal state",
    sourceless: {
      reason:
        "No verb returns a thermal reading on any model — the one hardware metric " +
        "with no source anywhere (docs/14 §C). Asserted, not measured: absence of " +
        "a verb cannot be probed for.",
    },
    slaImpact:
      "Cannot evidence thermal shutdown, overheating, or environmental cause. " +
      "Do not sign a clause referencing device temperature.",
  },
  {
    id: "cpu-memory",
    dimension: "CPU / memory load",
    source: {
      feed: "demo_command per-device read, stored in device_telemetry",
      fields: ["cpu_percent", "ram_percent"],
      lane: "telemetry-slowlane",
      persisted: true,
    },
    slaImpact:
      "Enough to attribute one content failure to resource exhaustion after the " +
      "fact. Not enough to underwrite a clause about it fleet-wide.",
  },
  {
    id: "network-signal",
    dimension: "Network signal strength (Wi-Fi RSSI)",
    source: {
      feed: "demo_command rssi_dbm, stored in device_telemetry",
      fields: ["wifi_signal_dbm"],
      lane: "telemetry-slowlane",
      persisted: true,
    },
    slaImpact:
      "Supports 'this screen has a weak radio' as diagnosis. Does not support a " +
      "contractual network-quality commitment across the estate.",
  },
  {
    id: "network-loss-jitter",
    dimension: "Packet loss / jitter",
    sourceless: {
      reason:
        "No packet-loss or jitter value is reported by any service. RSSI and " +
        "ping_ms are readable; the two fields that would isolate venue congestion " +
        "from a device fault are not.",
    },
    slaImpact:
      "Cannot fully distinguish a venue network fault from a device fault. " +
      "Materially affects who bears responsibility for an outage.",
  },
  {
    id: "storage",
    dimension: "Storage capacity",
    source: {
      feed: "demo_command storage_used_percent, stored in device_telemetry",
      fields: ["storage_percent"],
      lane: "telemetry-slowlane",
      persisted: true,
    },
    slaImpact:
      "Supports a fill-rate forecast for the devices we have swept (Trends fits " +
      "slopes from it). Does not support a fleet-wide disk-capacity clause.",
  },
  {
    id: "playback-slot",
    dimension: "Playback verification (per-slot)",
    sourceless: {
      reason:
        "No readable render log exists at any scope: proof-of-play is a per-device " +
        "asynchronous file export with an undocumented schema and no aggregation. " +
        "Asked of Videri and still open (docs/22 Ask 5) — an EXTERNAL blocker.",
    },
    slaImpact:
      "Per-slot delivery cannot be evidenced. An 'every scheduled slot played' " +
      "clause is not currently instrumentable; the scheduled half is.",
  },
  {
    id: "visual-confirmation",
    dimension: "Visual confirmation (screenshot)",
    source: {
      // Corrects the worst wrong finding in the project: the images ARE readable,
      // from a CloudFront mirror keyed by hardware serial. What is missing is not
      // the read path but a standing sweep and any stored history.
      feed: "serial-keyed CDN mirror, read through GET /api/devices/:id/screenshot",
      fields: [],
      lane: "evidence",
      persisted: false,
    },
    slaImpact:
      "Produces visual proof for one device, now, on request. Cannot evidence " +
      "'every screen showed the right thing' over a past window — we keep no frames.",
  },
];

export interface DimensionCoverage {
  /** Devices we hold a value for in the sampling window. Null = not probed. */
  readableDevices: number | null;
  fleetSize: number;
  /** 0–1, or null when unprobed. */
  share: number | null;
}

export interface ClassifiedDimension {
  id: string;
  dimension: string;
  grade: MeasurementGrade;
  /** Why it landed in that grade, in words fit for a customer conversation. */
  reason: string;
  slaImpact: string;
  coverage: DimensionCoverage;
  /** How often the feed returns to a given device. Null when unknown. */
  cadenceSeconds: number | null;
  /** Every SLA-grade bar this dimension misses. Empty for an sla-grade one. */
  shortfalls: string[];
  /** True only for an asserted absence of source — never for a quiet feed. */
  permanent: boolean;
  /** False when the value exists only at the moment we fetch it. */
  persisted: boolean;
  /** How the coverage and cadence figures above were obtained. */
  basis: string;
}

/**
 * How long a rotating lane takes to come back to a given device.
 *
 * The lane's own interval is NOT this number: a lane running every 15 min in
 * batches of 10 across 248 devices returns to one device every ~6 h, and it is
 * that 6 h — not the 15 min — that decides whether a claim is continuous.
 * Reporting the lane interval as the cadence is precisely how a rotation gets
 * mistaken for a fleet-wide feed.
 */
export function sweepPeriodSeconds(
  cadence: LaneCadence,
  medianDevicesTargeted: number | null,
  fleetSize: number,
): { seconds: number | null; basis: string } {
  if (cadence.seconds === null) {
    return { seconds: null, basis: `lane cadence unknown — ${cadence.basis}` };
  }
  if (medianDevicesTargeted === null || medianDevicesTargeted <= 0) {
    return { seconds: null, basis: "lane runs recorded no device count, so the sweep period is unknown" };
  }
  if (medianDevicesTargeted >= fleetSize) {
    return {
      seconds: cadence.seconds,
      basis:
        `every run covers the whole fleet (${medianDevicesTargeted} of ${fleetSize}), ` +
        `so the sweep period is the lane interval — ${cadence.basis}`,
    };
  }
  const passes = fleetSize / medianDevicesTargeted;
  return {
    seconds: cadence.seconds * passes,
    basis:
      `${humanDuration(cadence.seconds)} lane interval x ${passes.toFixed(1)} passes ` +
      `(${medianDevicesTargeted} devices per run, ${fleetSize} active) — ${cadence.basis}`,
  };
}

/** The live capability facts a classification needs, per dimension. */
export interface CapabilitySignal {
  coverage: DimensionCoverage;
  cadenceSeconds: number | null;
  persisted: boolean;
  basis: string;
}

/**
 * Grade one dimension against live capability.
 *
 * Fail-closed in both directions: an unprobed dimension is never promoted to
 * sla-grade, and a sourceless one is never promoted at all.
 */
export function classifyDimension(
  def: DimensionDefinition,
  signal: CapabilitySignal,
  bars: typeof SLA_GRADE_BARS = SLA_GRADE_BARS,
): ClassifiedDimension {
  const base = {
    id: def.id,
    dimension: def.dimension,
    slaImpact: def.slaImpact,
    coverage: signal.coverage,
    cadenceSeconds: signal.cadenceSeconds,
    persisted: signal.persisted,
    basis: signal.basis,
  };

  if (def.sourceless) {
    return {
      ...base,
      grade: "unmeasurable",
      reason: def.sourceless.reason,
      shortfalls: ["no source exists, so there is nothing to grade"],
      permanent: true,
      coverage: { readableDevices: 0, fleetSize: signal.coverage.fleetSize, share: 0 },
      cadenceSeconds: null,
    };
  }

  const { readableDevices, fleetSize, share } = signal.coverage;

  // A source that returned NOTHING is reported as unmeasurable right now, but
  // never as permanent: this is the direction the old constant could not travel.
  // If the slow lane stops, the claim must degrade on its own.
  if (share === 0) {
    return {
      ...base,
      grade: "unmeasurable",
      reason:
        `A source exists (${def.source?.feed ?? "unknown feed"}) but no device returned a ` +
        `value in the last window — 0 of ${fleetSize}. Nothing to claim and nothing to ` +
        `diagnose with until the feed resumes.`,
      shortfalls: ["the feed returned no values at all in the last window"],
      permanent: false,
    };
  }

  const shortfalls: string[] = [];
  if (!signal.persisted) {
    shortfalls.push(
      "readings are not stored, so a claim about a past window could not be reproduced from evidence",
    );
  }
  if (share === null || readableDevices === null) {
    shortfalls.push("no live capability sample was available, so coverage is unknown");
  } else if (share < bars.minCoverage) {
    shortfalls.push(
      `readable on ${readableDevices} of ${fleetSize} devices (${pct(share)}) — ` +
        `an SLA claim needs ${pct(bars.minCoverage)}`,
    );
  }
  if (signal.cadenceSeconds === null) {
    shortfalls.push("no standing sweep, so there is no cadence to state");
  } else if (signal.cadenceSeconds > bars.maxCadenceSeconds) {
    shortfalls.push(
      `the feed returns to a given device about every ${humanDuration(signal.cadenceSeconds)}, ` +
        `slower than the ${humanDuration(bars.maxCadenceSeconds)} a continuous claim needs`,
    );
  }

  if (shortfalls.length === 0) {
    return {
      ...base,
      grade: "sla-grade",
      reason:
        `Measured continuously and fleet-wide: ${readableDevices} of ${fleetSize} devices ` +
        `(${pct(share!)}), every ${humanDuration(signal.cadenceSeconds!)}, stored.`,
      shortfalls,
      permanent: false,
    };
  }

  // Coverage and cadence lead the sentence on purpose. "Readable but not
  // SLA-grade" is only useful to a reader who can see HOW partial it is.
  const coverageClause =
    share === null
      ? "coverage unknown"
      : `${readableDevices} of ${fleetSize} devices (${pct(share)})`;
  const cadenceClause =
    signal.cadenceSeconds === null
      ? "on demand, with no standing sweep"
      : `on a ~${humanDuration(signal.cadenceSeconds)} rotation`;

  return {
    ...base,
    grade: "readable",
    reason:
      `Readable per device, not SLA-grade: ${coverageClause}, ${cadenceClause}. ` +
      `Useful for diagnosis; not something to promise a customer. ` +
      `Shortfall: ${shortfalls.join("; ")}.`,
    shortfalls,
    permanent: false,
  };
}

/** Back-compat shape for the existing SLA payload and console renderer. */
export interface UnmeasurableDimension {
  dimension: string;
  reason: string;
  /** SLA language this dimension would be needed to evidence. */
  slaImpact: string;
}

export const asUnmeasurableDimension = (c: ClassifiedDimension): UnmeasurableDimension => ({
  dimension: c.dimension,
  reason: c.reason,
  slaImpact: c.slaImpact,
});

export interface MeasurabilityAssessment {
  fleetSize: number;
  /** Catalog order, every dimension, whatever its grade. */
  dimensions: ClassifiedDimension[];
  slaGrade: ClassifiedDimension[];
  readable: ClassifiedDimension[];
  unmeasurable: ClassifiedDimension[];
  bars: { minCoverageShare: number; maxCadenceSeconds: number };
  /** True when no live probe backed this assessment — everything failed closed. */
  fromLiveCapability: boolean;
  summary: string;
}

/** Raw inputs for a live assessment. All optional — absence fails closed. */
export interface MeasurabilityInputs {
  fleetSize: number;
  /**
   * Devices with a readable value per telemetry field, from
   * `telemetryAvailability()`. Null when the probe was not run.
   */
  fieldReadable: Record<string, number> | null;
  /** `poller_runs` rows, any order and any lane set. */
  laneRuns: readonly PollerRunRow[];
  /** Screenshot addressability: devices keyed on the CDN by hardware serial. */
  screenshot: { addressable: number; capturedWithin24h: number } | null;
}

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/**
 * Assess every catalog dimension from live inputs. Pure — takes rows, returns a
 * verdict, so the SLA-grade boundary is unit-testable in both directions.
 */
export function buildMeasurability(inputs: MeasurabilityInputs): MeasurabilityAssessment {
  const fleetSize = Math.max(0, inputs.fleetSize);

  // Group lane runs once: cadence needs them newest-first per lane.
  const byLane = new Map<string, PollerRunRow[]>();
  for (const run of inputs.laneRuns) {
    const list = byLane.get(run.poller) ?? [];
    list.push(run);
    byLane.set(run.poller, list);
  }
  for (const list of byLane.values()) {
    list.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }

  const laneSweep = (lane: string | null): { seconds: number | null; basis: string } => {
    if (lane === null) return { seconds: null, basis: "no standing lane fills this dimension" };
    const runs = byLane.get(lane) ?? [];
    if (runs.length === 0) {
      return {
        seconds: null,
        basis: `no run of the '${lane}' lane is on record, so it is operator-driven or stopped`,
      };
    }
    return sweepPeriodSeconds(
      measureCadence(runs),
      median(runs.map((r) => r.devicesTargeted)),
      fleetSize,
    );
  };

  const dimensions = DIMENSION_CATALOG.map((def) => {
    if (def.sourceless) {
      return classifyDimension(def, {
        coverage: { readableDevices: 0, fleetSize, share: 0 },
        cadenceSeconds: null,
        persisted: false,
        basis: "asserted absence of a source; no live probe can confirm or deny it",
      });
    }

    const source = def.source!;
    const sweep = laneSweep(source.lane);

    // Screenshots have no telemetry field: addressability IS the coverage, since
    // every device with a serial has an image on the CDN.
    if (source.fields.length === 0) {
      const shot = inputs.screenshot;
      const readableDevices = shot?.addressable ?? null;
      return classifyDimension(def, {
        coverage: {
          readableDevices,
          fleetSize,
          share: readableDevices === null || fleetSize === 0 ? null : Math.min(1, readableDevices / fleetSize),
        },
        cadenceSeconds: sweep.seconds,
        persisted: source.persisted,
        basis:
          shot === null
            ? "screenshot addressability was not probed"
            : `${shot.addressable} of ${fleetSize} devices are addressable on the CDN by ` +
              `hardware serial; ${shot.capturedWithin24h} were asked for a fresh capture in ` +
              `the last 24 h. ${sweep.basis}.`,
      });
    }

    // The dimension is only as measurable as its weakest field.
    const perField = source.fields.map((f) => inputs.fieldReadable?.[f] ?? null);
    const readableDevices = perField.some((v) => v === null)
      ? null
      : Math.min(...(perField as number[]));

    return classifyDimension(def, {
      coverage: {
        readableDevices,
        fleetSize,
        share: readableDevices === null || fleetSize === 0 ? null : Math.min(1, readableDevices / fleetSize),
      },
      cadenceSeconds: sweep.seconds,
      persisted: source.persisted,
      basis:
        (readableDevices === null
          ? `no live sample for ${source.fields.join(" / ")}`
          : `weakest of ${source.fields
              .map((f, i) => `${f} ${perField[i]}`)
              .join(", ")} across ${fleetSize} active devices`) + `. ${sweep.basis}.`,
    });
  });

  const slaGrade = dimensions.filter((d) => d.grade === "sla-grade");
  const readable = dimensions.filter((d) => d.grade === "readable");
  const unmeasurable = dimensions.filter((d) => d.grade === "unmeasurable");
  const fromLiveCapability = inputs.fieldReadable !== null || inputs.screenshot !== null;

  return {
    fleetSize,
    dimensions,
    slaGrade,
    readable,
    unmeasurable,
    bars: {
      minCoverageShare: SLA_GRADE_BARS.minCoverage,
      maxCadenceSeconds: SLA_GRADE_BARS.maxCadenceSeconds,
    },
    fromLiveCapability,
    summary:
      `${slaGrade.length} of ${dimensions.length} dimensions are measured well enough to ` +
      `defend in a contract; ${readable.length} are readable per device but not SLA-grade ` +
      `(coverage and cadence stated per dimension); ${unmeasurable.length} have no usable ` +
      `source. Graded from ${fromLiveCapability ? "live capability" : "NO live capability sample, so nothing was promoted"}.`,
  };
}

/**
 * The assessment with no live evidence at all.
 *
 * Used as the fallback wherever a caller has not probed capability. It promotes
 * nothing: a page that cannot see the fleet must not claim SLA grade for
 * anything, which is the conservative direction for a customer-facing number.
 */
export const MEASURABILITY_WITHOUT_LIVE_SIGNAL: MeasurabilityAssessment = buildMeasurability({
  fleetSize: 0,
  fieldReadable: null,
  laneRuns: [],
  screenshot: null,
});

// ─────────────────────────────────────────────────────────────────────────────
// The knock-on: the fleet health score's exclusion list.
//
// `healthScore()` in the console excludes a dimension from the weighted maths
// when it has no data source, and it excluded three on the strength of the same
// stale constant this file replaces. An exclusion list that disagrees with the
// capability page is how a headline number ends up computed on an out-of-date
// basis, so both now come from one assessment.
//
// The rule is deliberately strict: only SLA-GRADE dimensions may be weighted.
// A dimension readable on 42% of the fleet on a multi-hour rotation would make
// the headline number a partial sample dressed as a fleet figure — the same
// class of error as scoring a dark fleet green. It stays excluded, but the
// stated reason is now the live coverage and cadence instead of "no source".
// ─────────────────────────────────────────────────────────────────────────────

export interface HealthScoreBasis {
  /** Dimensions measured well enough to carry weight in a headline score. */
  scorable: string[];
  /** Dimensions the score must exclude, each with its live reason. */
  excluded: Array<{ dimension: string; why: string }>;
  /** One sentence an operator can read next to the number. */
  note: string;
}

export function healthScoreBasis(assessment: MeasurabilityAssessment): HealthScoreBasis {
  const scorable = assessment.slaGrade.map((d) => d.dimension);
  const excluded = [...assessment.readable, ...assessment.unmeasurable].map((d) => ({
    dimension: d.dimension,
    // Worded from what the dimension actually misses. Calling a 248-of-248
    // screenshot read "too partial" would be its own small lie: its shortfall is
    // that we store nothing, not that we cannot see it.
    why:
      d.grade === "readable" && d.coverage.share !== null
        ? `readable on ${d.coverage.readableDevices} of ${d.coverage.fleetSize} devices` +
          (d.cadenceSeconds === null
            ? " on demand only"
            : ` on a ~${humanDuration(d.cadenceSeconds)} rotation`) +
          (d.persisted ? "" : ", and no reading is stored") +
          " — not a continuous fleet-wide measurement, so it cannot weight a fleet score"
        : d.reason,
  }));

  return {
    scorable,
    excluded,
    note:
      `${scorable.length} dimension(s) are measured well enough to weight; ${excluded.length} ` +
      `are excluded and each says why. A score of 100 means "everything we can see is fine", ` +
      `never "everything is fine".`,
  };
}
