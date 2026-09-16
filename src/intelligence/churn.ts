/**
 * Recommendation churn — why the queue is a different queue than it was when you
 * last looked. Pure, no I/O (Epic 8.6, US-8.6.3 + US-8.6.4).
 *
 * THE OBSERVATION THIS EXISTS FOR
 * -------------------------------
 * docs/25 GAP-7: the auto-safe recommendation set was observed moving **20 → 2**.
 * That collapse was CORRECT — eighteen panels crossed a scheduled-OFF boundary in
 * their own timezone, so there was nothing left to one-click — but the payload
 * said only "2". An operator reading "2" has no way to tell "eighteen were fixed"
 * from "eighteen went dark on schedule" from "eighteen devices fell off the
 * network", and those three readings demand three different days of work. This
 * module turns the number into a sentence with a cause on it.
 *
 * WHAT A CHURN REPORT IS AND IS NOT
 * ---------------------------------
 * It is a diff between TWO READS: one the caller attests to (`previous`, taken at
 * the watermark) and one we just computed (`current`). It is NOT a history — we
 * persist no recommendation snapshots, there is no table for them, and inventing
 * one from stored device facts would mean inventing the device facts as they were
 * at the watermark. So the caller's prior read is the only honest baseline
 * available, it is labelled `attestedBy: "caller"` in the payload, and we never
 * pretend to have verified it.
 *
 * A churn report is also NOT the queue. `entered` / `left` / `changed` are
 * annotations to be joined by id onto the full set from `/api/remediation`;
 * nothing is ever hidden because it is not new (US-6.2.3). A diff that doubled as
 * the queue would be a filter, and a filter is how items disappear.
 *
 * THE TWO WAYS THIS FEATURE COULD LIE
 * -----------------------------------
 *  1. **"It is gone" read as "it was fixed".** Every departure needs a cause
 *     derived from something we can actually check, and where we cannot check it
 *     the item says so by name. There is deliberately no `other` bucket: an
 *     unattributable departure carries `undetermined` PLUS the list of readings
 *     that were null, because "we could not tell, and here is which fact we were
 *     missing" is a finding and "other: 18" is a shrug.
 *
 *  2. **A gap in collection read as a quiet period.** The collector on this
 *     deployment is itself intermittent — 1,561 of 2,016 five-minute buckets in
 *     the measured week (77%; ~38 h in which NO device reported). A churn window
 *     that straddles one of those holes cannot distinguish "the symptom cleared"
 *     from "we stopped looking", so `applied` — the only cause that asserts the
 *     world got better — is gated on the window's own observation and degrades to
 *     the named cause `unobserved-window` when the gate fails. The gate is per
 *     cause rather than a blanket refusal on purpose: `schedule-window-closed` is
 *     derived from the device's schedule and two clock readings, not from
 *     collection, so a collector hole does not make it unknowable and refusing it
 *     would throw away the exact answer this epic was written to surface. What is
 *     never allowed is emitting `applied` across a hole, or emitting any figure
 *     without the coverage it was measured under.
 *
 *     One hard floor sits above that: if we observed NOTHING at all between the
 *     two reads, then our "current" read adds no observation to the caller's and
 *     the whole attribution is refused — `byCause` is `null` with a reason, never
 *     a set of zeros.
 *
 * Everything here is a pure function: two reads plus device facts in, a diff out.
 * No clock of its own (both instants are passed in), no pool, no network. The
 * orchestration lives in `src/api/routes/trends.ts`.
 */

import {
  blankCause,
  darknessVerdict,
  describeOnWindow,
  isReachableStatus,
  withinOnWindow,
} from "./screen-state.js";
import type { DeviceView, RecommendationKind, Severity } from "./remediation.js";
import type { Recommendation } from "./remediation.js";
import { makeFigureOf, type Figure } from "./figure.js";

// ── figures: a number is never served on its own ─────────────────────────────

/**
 * What a churn figure was measured over — this engine's vocabulary for the
 * shared `Figure<T>` wrapper in `./figure.js`.
 *
 * The wrapper used to be redeclared here field-for-field as `ChurnFigure<T>`,
 * because `src/intelligence/` is engine land and must not depend on the route
 * module the original lived in. It is now lifted into `./figure.js`, which both
 * sides import downwards, so there is one definition of how a number states its
 * basis. Only the vocabulary stayed local: `time-buckets` here means the window
 * between the two reads, which is not the report's window, so the two labels are
 * legitimately different sentences.
 */
export type ChurnFigureUnit = "recommendations" | "time-buckets" | "screens";

const UNIT_LABEL: Record<ChurnFigureUnit, string> = {
  recommendations: "recommendation(s)",
  "time-buckets": "time bucket(s) of the window between the two reads",
  screens: "screen(s)",
};

export const churnFigure = makeFigureOf(UNIT_LABEL);

// ── the cause vocabulary ─────────────────────────────────────────────────────

/**
 * Why an item LEFT the set. Codes, not prose, because the caller counts them.
 *
 * The first five are the vocabulary US-8.6.3 names. `device-retired` and
 * `unobserved-window` are additions, and both are additions for the same reason:
 * they are real, distinguishable answers that would otherwise have been forced
 * into one of the five and misread there.
 *
 *  - `applied`                — the symptom no longer holds: the device is
 *                               reachable, inside its own ON window, and its
 *                               panel reads lit. This says the CONDITION cleared;
 *                               it does not claim VFI's write cleared it. Who
 *                               changed what is answerable from
 *                               `device_action_log`, not from a diff, and the
 *                               `detail` on the item says exactly that.
 *  - `schedule-window-closed` — the device's own schedule turned the panel off
 *                               between the two reads. This is the 20 → 2 cause.
 *  - `schedule-window-opened`  — the mirror, and a departure cause in its own
 *                               right: the informational "off per its own
 *                               schedule" item stops applying the moment the
 *                               window opens. Without this rung that departure
 *                               lands on `superseded`, which states a true fact
 *                               (the device is still in the set under something
 *                               else) while naming the wrong mechanism.
 *  - `device-unreachable`     — we can no longer reach the device, so the engine
 *                               has nothing to recommend for it. An absent
 *                               recommendation here is our reach failing, not a
 *                               screen recovering.
 *  - `superseded`             — the device is still in the set under a DIFFERENT
 *                               recommendation. The work did not go away; it
 *                               changed shape.
 *  - `intent-excluded`        — the item still exists but intent (US-8.2.5) took
 *                               it out of the one-click set. Demoted, not fixed,
 *                               and not gone.
 *  - `device-retired`         — the device is no longer in the active fleet we
 *                               query at all. Distinct from `device-unreachable`:
 *                               one is a screen we cannot talk to, the other is a
 *                               screen that is no longer ours to talk to.
 *  - `unobserved-window`      — the item would have read as `applied`, but the
 *                               collector did not watch enough of the window
 *                               between the two reads for "the symptom cleared"
 *                               to be separable from "we stopped looking". The
 *                               invariant made visible rather than a silent
 *                               upgrade to good news.
 *  - `undetermined`           — we could not name a cause, AND the item lists the
 *                               readings that were null. Never a catch-all: an
 *                               `undetermined` item without an `unreadable` entry
 *                               or a stated obstacle is a bug, and a test asserts
 *                               it.
 */
export type ChurnDepartureCause =
  | "applied"
  | "schedule-window-closed"
  | "schedule-window-opened"
  | "device-unreachable"
  | "superseded"
  | "intent-excluded"
  | "device-retired"
  | "unobserved-window"
  | "undetermined";

/**
 * Why an item ENTERED the set.
 *
 * Deliberately shorter than the departure vocabulary, and the asymmetry is
 * honest rather than lazy: a departure can be explained against the device facts
 * we hold NOW, but an arrival would need the device facts as they were at the
 * watermark, and we do not store those. So only three arrival causes are
 * derivable:
 *   - `schedule-window-opened` — the panel should now be lit and is not, so the
 *     finding became actionable. It did not newly break.
 *   - `schedule-window-closed` — the mirror: the informational "off per its own
 *     schedule" item only exists while the window is shut, so a closing window
 *     is what put it in the set. Both are computed from the schedule config and
 *     the two clock instants, which is why neither needs collection history.
 *   - `symptom-first-observed` — the reading the item rests on was itself taken
 *     inside the window, so the symptom is new to US rather than newly shown.
 *
 * Everything else is `undetermined` with that limitation named on the item.
 * Inventing `device-returned` or `intent-cleared` from a single snapshot would be
 * guessing at a baseline we never had.
 */
export type ChurnArrivalCause =
  | "schedule-window-opened"
  | "schedule-window-closed"
  | "symptom-first-observed"
  | "unobserved-window"
  | "undetermined";

/** What the two reads were, stated well enough to be quoted back. */
export interface ChurnRead {
  /** Absolute instant the set was read. The "last looked" stamp US-8.6.4 wants. */
  observedAt: string;
  /** How we know. `caller` is attested and unverifiable; `self` we computed. */
  attestedBy: "caller" | "self";
  /** Items in the tracked set at that instant. */
  count: number;
}

/** One item the caller held at the watermark. Severity is optional — see `changed`. */
export interface PriorItem {
  id: string;
  /**
   * Which device it was about. Optional: recommendation ids are
   * `${deviceId}::${rule}` so it is recoverable, but a caller that knows should
   * say so rather than make us parse.
   */
  deviceId?: string | undefined;
  /** Needed for `changed`. Absent means "changed" is unknowable, not "unchanged". */
  severity?: Severity | undefined;
  kind?: RecommendationKind | undefined;
}

// ── window observation: how much we were looking, between the two reads ──────

/**
 * The collector's own coverage of the churn window.
 *
 * `bucketStarts` are epoch milliseconds of the START of every bucket in which
 * ANY device reported — the same "fleet observed bucket" definition
 * `trends.ts WindowRef.fleetObservedBuckets` uses, for the same reason: a bucket
 * with no reading is time we were not looking, and it must never be counted as
 * time in which nothing happened.
 */
export interface ChurnWindowObservation {
  from: string;
  to: string;
  bucketSeconds: number;
  /** Buckets the window contains — the denominator. */
  expectedBuckets: number;
  /** Buckets in which any device reported — the numerator. */
  observedBuckets: number;
  /** observedBuckets / expectedBuckets, or null for a zero-length window. */
  collectorCoverage: number | null;
  /**
   * Longest unbroken run with no reading from ANY device, in seconds, counting
   * the run from the window's own edges as well as between buckets. `null` when
   * it could not be established.
   */
  longestGapSeconds: number | null;
}

export const CHURN_GATES = {
  /**
   * Share of the churn window the collector must have watched before we will
   * say a symptom was fixed. 0.8 rather than something laxer because the
   * measured baseline is 77% over a week: a threshold below the long-run average
   * would wave through exactly the windows that need stopping.
   */
  minCollectorCoverage: 0.8,
  /**
   * ...and no single blind run longer than this, because coverage alone hides
   * shape. Over a 7-day window a one-hour hole is 0.6% of the buckets and
   * invisible to a ratio, yet it is long enough to contain a scheduled off/on
   * transition AND a device dropping and returning. One hour is the resolution
   * at which the schedule causes below become guesses.
   */
  maxGapSeconds: 3600,
} as const;

export interface ChurnObservationVerdict {
  /** True when `applied` may be claimed. */
  clearsGates: boolean;
  /**
   * True when we observed nothing at all between the reads, in which case no
   * cause is attributable and `byCause` is null rather than zeroed.
   */
  blind: boolean;
  /** Why, always populated when `clearsGates` is false. Null when it is true. */
  reason: string | null;
  observation: ChurnWindowObservation;
  gates: typeof CHURN_GATES;
}

const pct = (fraction: number): string => `${Math.round(fraction * 100)}%`;

/**
 * Build the window observation from the raw observed-bucket starts.
 *
 * Pure so the gap arithmetic — the part that decides whether we are allowed to
 * say "fixed" — is unit-testable without a database. The caller does the SQL.
 */
export function observationFrom(
  fromIso: string,
  toIso: string,
  bucketSeconds: number,
  bucketStartsMs: readonly number[],
): ChurnWindowObservation {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  const spanSeconds = Number.isFinite(from) && Number.isFinite(to) ? (to - from) / 1000 : 0;
  const expectedBuckets = spanSeconds > 0 ? Math.max(1, Math.round(spanSeconds / bucketSeconds)) : 0;

  // Only buckets inside the window count. A caller handing us a wider query than
  // it asked about must not inflate its own coverage.
  const inside = bucketStartsMs
    .filter((ms) => Number.isFinite(ms) && ms >= from && ms < to)
    .sort((a, b) => a - b);

  // The gap is measured from the window's edges too. A window whose first
  // reading lands three hours in was blind for three hours, and a gap detector
  // that only looks between readings would score that as perfect continuity.
  let longestGapSeconds: number | null = null;
  if (spanSeconds > 0) {
    let gapMs = 0;
    let cursor = from;
    for (const start of inside) {
      gapMs = Math.max(gapMs, start - cursor);
      cursor = start + bucketSeconds * 1000;
    }
    gapMs = Math.max(gapMs, to - cursor);
    longestGapSeconds = Math.max(0, Math.round(gapMs / 1000));
  }

  return {
    from: fromIso,
    to: toIso,
    bucketSeconds,
    expectedBuckets,
    observedBuckets: inside.length,
    collectorCoverage:
      expectedBuckets === 0
        ? null
        : Math.min(1, Math.round((inside.length / expectedBuckets) * 1000) / 1000),
    longestGapSeconds,
  };
}

/** Does the window support the one cause that asserts the world improved? */
export function judgeObservation(
  observation: ChurnWindowObservation,
  gates: typeof CHURN_GATES = CHURN_GATES,
): ChurnObservationVerdict {
  const humanGap = (seconds: number): string =>
    seconds >= 3600 ? `${(seconds / 3600).toFixed(1)}h` : `${Math.round(seconds / 60)}m`;

  if (observation.expectedBuckets === 0) {
    return {
      clearsGates: false,
      blind: true,
      reason:
        `The two reads carry the same instant (${observation.from}), so there is no window ` +
        `between them to have observed. Nothing is attributed.`,
      observation,
      gates,
    };
  }
  if (observation.observedBuckets === 0) {
    return {
      clearsGates: false,
      blind: true,
      reason:
        `No device reported at all between the two reads (0 of ${observation.expectedBuckets} ` +
        `five-minute-equivalent buckets from ${observation.from} to ${observation.to}). Our ` +
        `"current" read therefore rests on no observation the caller's read did not already ` +
        `have, so no cause is attributed and the breakdown is null rather than zeroed. This is ` +
        `a gap in OUR collection, not a quiet fleet.`,
      observation,
      gates,
    };
  }
  const coverage = observation.collectorCoverage ?? 0;
  if (coverage < gates.minCollectorCoverage) {
    return {
      clearsGates: false,
      blind: false,
      reason:
        `The collector watched ${observation.observedBuckets} of ${observation.expectedBuckets} ` +
        `buckets between the two reads (${pct(coverage)}); ${pct(gates.minCollectorCoverage)} is ` +
        `required before a departure may be reported as fixed. Causes that do not depend on ` +
        `continuous observation are still reported; departures that would have read as ` +
        `"applied" are reported as "unobserved-window" instead, because across a hole in our ` +
        `own collection "the symptom cleared" and "we stopped looking" are the same evidence.`,
      observation,
      gates,
    };
  }
  if (observation.longestGapSeconds !== null && observation.longestGapSeconds > gates.maxGapSeconds) {
    return {
      clearsGates: false,
      blind: false,
      reason:
        `Collection between the two reads holds an unbroken ` +
        `${humanGap(observation.longestGapSeconds)} run in which no device reported, longer ` +
        `than the ${humanGap(gates.maxGapSeconds)} ceiling, even though overall coverage was ` +
        `${pct(coverage)}. A blind run that long can contain a scheduled off/on transition and ` +
        `a device dropping and returning, so a departure inside it is not reported as fixed.`,
      observation,
      gates,
    };
  }
  return { clearsGates: true, blind: false, reason: null, observation, gates };
}

// ── departures ───────────────────────────────────────────────────────────────

export interface DepartedItem {
  id: string;
  deviceId: string | null;
  deviceLabel: string | null;
  /** Null ONLY when the whole attribution was refused; then `blockedBy` says why. */
  cause: ChurnDepartureCause | null;
  /** Plain language, naming the evidence. Never empty. */
  detail: string;
  /**
   * Readings we needed and did not have. Populated for `undetermined`, and
   * empty for every cause we could name. A null reading is reported as a null
   * reading — never defaulted so a cause can be guessed off it.
   */
  unreadable: string[];
  /** When `cause` is null, the window reason that stopped us attributing. */
  blockedBy: string | null;
}

export interface ArrivedItem {
  id: string;
  deviceId: string | null;
  deviceLabel: string | null;
  cause: ChurnArrivalCause | null;
  detail: string;
  unreadable: string[];
  blockedBy: string | null;
}

/** An item in both reads whose shape moved. */
export interface ChangedItem {
  id: string;
  deviceId: string | null;
  deviceLabel: string | null;
  severityFrom: Severity;
  severityTo: Severity;
  detail: string;
}

/** `${deviceId}::${rule}` — recover the device without trusting the caller. */
const deviceIdOf = (item: { id: string; deviceId?: string | undefined }): string | null => {
  if (item.deviceId) return item.deviceId;
  const cut = item.id.indexOf("::");
  return cut > 0 ? item.id.slice(0, cut) : null;
};

const ruleOf = (id: string): string => {
  const cut = id.indexOf("::");
  return cut > 0 ? id.slice(cut + 2) : id;
};

/** Which reading a departed display item rested on, for the `applied` check. */
const isDisplayRule = (id: string): boolean => {
  const rule = ruleOf(id);
  return rule === "display-off" || rule === "black-screen" || rule === "logo-fallback";
};

/**
 * Is this rule's existence decided by the device's own on/off schedule?
 *
 * Only these rules may be attributed to a schedule boundary. Without the gate,
 * a `compliance::volume_percent` item that happened to vanish while a schedule
 * closed would be blamed on the schedule — a true coincidence stated as a cause.
 * `compliance::brightness` is on the list because the engine stands that rule
 * down whenever darkness is schedule-explained (remediation.ts: the
 * `darknessExplained` guard), so its lifetime really does follow the window.
 */
const isScheduleSensitiveRule = (id: string): boolean => {
  const rule = ruleOf(id);
  return (
    rule === "display-off" ||
    rule === "display-off-scheduled" ||
    rule === "black-screen" ||
    rule === "logo-fallback" ||
    rule === "compliance::brightness"
  );
};

/**
 * Which readings a rule's existence depends on, and whether we still hold them.
 *
 * This is the honest-nulls guard on `applied`, and it is the reason `applied`
 * cannot be inferred from an item's mere absence. A `storage-full` item vanishes
 * for two completely different reasons — the disk was cleared, or the telemetry
 * read failed and `storage_used_percent` is now null — and only one of them is
 * good news. So before we will call anything fixed, the readings that rule fires
 * on must be PRESENT now. A null reading names itself here and the departure is
 * reported as `undetermined`, never as a clearance.
 *
 * Deliberately a map of which FIELDS each rule reads, not of its thresholds: the
 * thresholds live in remediation.ts and duplicating them here would give us two
 * copies to drift apart. What the engine decided with them is already visible in
 * whether it still emits the recommendation.
 */
const RULE_READINGS: Record<string, (device: DeviceView) => string[]> = {
  "storage-full": (d) =>
    d.telemetry?.storageUsedPercent == null ? ["telemetry storage_used_percent"] : [],
  "weak-wifi": (d) => (d.telemetry?.rssiDbm == null ? ["telemetry rssi_dbm"] : []),
  "resource-pressure": (d) => {
    const missing: string[] = [];
    if (d.telemetry?.cpuPercent == null) missing.push("telemetry cpu_percent");
    if (d.telemetry?.ramUsedPercent == null) missing.push("telemetry ram_used_percent");
    // The rule fires on EITHER metric, so one readable metric is enough to say
    // that metric is no longer over the line.
    return missing.length === 2 ? missing : [];
  },
  "clock-drift": (d) => (d.telemetry?.ntpOffsetMs == null ? ["telemetry ntp_offset_ms"] : []),
  "screen-signals-disagree": (d) => {
    const missing: string[] = [];
    if (d.displayOn === null) missing.push("display_on");
    if (d.screen.isScreenOn === null || d.screen.isScreenOn === undefined) {
      missing.push("is_screen_on (the second opinion on panel power)");
    }
    return missing;
  },
};

/**
 * Can we show the symptom behind a departed item has cleared?
 *
 *   `{ missing: [...] }`   — a reading we need is null. Reported as
 *                            `undetermined` naming it, never as a clearance.
 *   `{ cleared: false }`   — we hold the readings and the symptom is STILL
 *                            there, which means the item's absence is not
 *                            explained by the world improving.
 *   `{ cleared: true }`    — positive evidence, subject to the window gates.
 */
const judgeClearance = (
  id: string,
  device: DeviceView,
  now: Date,
): { cleared: boolean; missing: string[] } => {
  const rule = ruleOf(id);

  // Display and content rules: the panel itself is the evidence.
  if (isDisplayRule(id) || rule === "display-off-scheduled") {
    const verdict = darknessVerdict(device, now);
    if (verdict === "unknown") return { cleared: false, missing: unreadableFacts(device) };
    return { cleared: verdict === "lit" && blankCause(device, now).cause === "not-blank", missing: [] };
  }

  // Compliance drift: the current drift list is the evidence, but ONLY when we
  // actually hold one. An empty list cannot distinguish "nothing drifts" from
  // "compliance has never been evaluated for this device", so it is a missing
  // reading rather than a clearance.
  if (rule.startsWith("compliance::")) {
    const field = rule.slice("compliance::".length);
    if (device.drift.length === 0) {
      return {
        cleared: false,
        missing: [
          `a compliance result for this device (the drift list is empty, which we cannot tell ` +
            `apart from "never evaluated")`,
        ],
      };
    }
    return { cleared: !device.drift.some((d) => d.field === field), missing: [] };
  }

  const readings = RULE_READINGS[rule];
  if (!readings) {
    return {
      cleared: false,
      missing: [`a clearance check for rule \`${rule}\` (this module holds none)`],
    };
  }
  const missing = readings(device);
  if (missing.length > 0) return { cleared: false, missing };
  return { cleared: true, missing: [] };
};

/**
 * Which live readings we were missing for this device. The `undetermined` cause
 * is only ever published alongside this list, which is what keeps it from being
 * an `other` bucket.
 */
const unreadableFacts = (device: DeviceView): string[] => {
  const missing: string[] = [];
  if (device.currentBrightnessRaw === null) missing.push("current_brightness (panel output)");
  if (device.displayOn === null) missing.push("display_on (backlight)");
  if (device.brightnessScheduleEnabled === null) {
    missing.push("brightness_schedule_enabled (is a schedule in force)");
  }
  if (device.timezone === null) missing.push("timezone (the schedule is only evaluable in it)");
  if (device.turnOnTime === null) missing.push("turn_on_time");
  if (device.turnOffTime === null) missing.push("turn_off_time");
  return missing;
};

export interface ChurnInput {
  /** What the caller held, at the watermark. Unverifiable, and labelled so. */
  previous: { observedAt: string; items: readonly PriorItem[] };
  /** What we just computed. `recommendations` is the FULL list, not the filtered set. */
  current: { observedAt: string; recommendations: readonly Recommendation[] };
  /** Device facts as of the current read. Absence here means "not in the fleet". */
  devices: readonly DeviceView[];
  /** The set being tracked. `auto-safe` is the queue GAP-7 is about. */
  kind: RecommendationKind;
  verdict: ChurnObservationVerdict;
}

/**
 * Attribute ONE departure. Exported because the cause ladder is the product and
 * every rung deserves a direct test.
 *
 * The ladder is ordered, first match wins, and the order is the claim: a device
 * we cannot reach is reported as unreachable even if its schedule also closed,
 * because "we cannot see it" outranks every inference we would draw from facts
 * we cannot refresh. `applied` sits LAST of the determinate rungs on purpose —
 * it is the only cause that asserts the world got better, so everything that
 * could explain the departure more cheaply is tried first.
 */
export function attributeDeparture(
  item: PriorItem,
  input: Omit<ChurnInput, "previous">,
  deviceById: ReadonlyMap<string, DeviceView>,
  currentById: ReadonlyMap<string, Recommendation>,
  trackedByDevice: ReadonlyMap<string, Recommendation[]>,
  previousIds: ReadonlySet<string>,
  watermark: Date,
  now: Date,
): DepartedItem {
  const deviceId = deviceIdOf(item);
  const base = { id: item.id, deviceId, unreadable: [] as string[], blockedBy: null };

  // Refusal tier: we observed nothing between the reads, so we hold no fact
  // about this window that the caller did not already hold.
  if (input.verdict.blind) {
    return {
      ...base,
      deviceLabel: deviceId ? (deviceById.get(deviceId)?.name ?? null) : null,
      cause: null,
      detail:
        "This item is in your read and not in ours, but no cause is attributed: " +
        input.verdict.reason,
      blockedBy: input.verdict.reason,
    };
  }

  if (deviceId === null) {
    return {
      ...base,
      deviceLabel: null,
      cause: "undetermined",
      detail:
        `The id \`${item.id}\` does not carry a device (recommendation ids are ` +
        `\`deviceId::rule\`), so we could not look the device up to explain its departure.`,
      unreadable: ["deviceId (not recoverable from the id, and none was supplied)"],
    };
  }

  const device = deviceById.get(deviceId);
  const label = device?.name ?? deviceId;

  // 1. Not in the fleet at all. Checked first because every rung below reads
  //    device facts, and there are none.
  if (!device) {
    return {
      ...base,
      deviceLabel: null,
      cause: "device-retired",
      detail:
        `Device ${deviceId} is no longer returned by the active-fleet query — deactivated, ` +
        `retired or removed — so it has no recommendations of any kind. The screen did not get ` +
        `better; it stopped being ours to look at.`,
    };
  }

  // 2. Unreachable. The engine emits nothing for a device it cannot reach, so the
  //    item's absence is our reach failing.
  if (!isReachableStatus(device.status)) {
    return {
      ...base,
      deviceLabel: label,
      cause: "device-unreachable",
      detail:
        `${label} now reads status \`${device.status}\`, which we do not treat as reachable, so ` +
        `no action is recommended for it. Nothing was fixed — we cannot currently see or act on ` +
        `this screen` +
        (device.lastOnlineTime ? `; it was last online at ${device.lastOnlineTime}.` : "."),
    };
  }

  // 3. Still present, demoted out of the tracked set by intent (US-8.2.5).
  const stillThere = currentById.get(item.id);
  if (stillThere && stillThere.kind !== input.kind) {
    if (stillThere.demotedByIntent === true && stillThere.intent) {
      return {
        ...base,
        deviceLabel: label,
        cause: "intent-excluded",
        detail:
          `The finding still stands and is still listed — it left the \`${input.kind}\` set ` +
          `because this device carries intent (${stillThere.intent.kind}, from ` +
          `${stillThere.intent.source}), so it is no longer offered as a one-click. Demoted, ` +
          `not resolved.`,
      };
    }
    return {
      ...base,
      deviceLabel: label,
      cause: "undetermined",
      detail:
        `The item is still present but is now \`${stillThere.kind}\` rather than ` +
        `\`${input.kind}\`, and nothing on it says intent demoted it. We cannot name the reason.`,
      unreadable: ["demotedByIntent / intent on the current recommendation"],
    };
  }

  // 4. The device's own schedule closed under it. Derived from the schedule
  //    config and the two clock instants, which is why it survives a collector
  //    gap: no continuous observation is involved. It DOES assume the schedule
  //    config did not itself change inside the window, which we cannot verify —
  //    the detail says so.
  if (device.brightnessScheduleEnabled === true && isScheduleSensitiveRule(item.id)) {
    const wasInWindow = withinOnWindow(
      device.turnOnTime,
      device.turnOffTime,
      device.timezone,
      watermark,
    );
    const isInWindow = withinOnWindow(device.turnOnTime, device.turnOffTime, device.timezone, now);
    const window = describeOnWindow(device);
    const assumption =
      `Judged from the schedule we hold now, which we assume did not itself change between the ` +
      `two reads — we store no history of the schedule config, so that assumption is stated ` +
      `rather than verified.`;
    if (wasInWindow === true && isInWindow === false) {
      return {
        ...base,
        deviceLabel: label,
        cause: "schedule-window-closed",
        detail:
          `${label} was inside its scheduled ON window when you looked and is outside it now` +
          (window ? ` (on ${window})` : "") +
          `. The panel is dark because it was told to be, so there is nothing to one-click. ` +
          `This was not fixed. ${assumption}`,
      };
    }
    if (wasInWindow === false && isInWindow === true) {
      return {
        ...base,
        deviceLabel: label,
        cause: "schedule-window-opened",
        detail:
          `${label} was outside its scheduled ON window when you looked and is inside it now` +
          (window ? ` (on ${window})` : "") +
          `, so this item stopped applying — a screen that is off on purpose is a different ` +
          `finding from a screen that should be lit. Nothing was fixed; the window moved. ` +
          `${assumption}`,
      };
    }
  }

  // 5. Superseded — the device is still in the tracked set, under something else.
  const others = (trackedByDevice.get(deviceId) ?? []).filter((r) => r.id !== item.id);
  if (others.length > 0) {
    const arrivals = others.filter((r) => !previousIds.has(r.id));
    const replacement = arrivals[0] ?? others[0];
    return {
      ...base,
      deviceLabel: label,
      cause: "superseded",
      detail:
        `${label} is still in the \`${input.kind}\` set, under \`${replacement?.id}\` ` +
        `(${replacement?.action}). The work did not go away; the symptom changed shape, so the ` +
        `recommendation did too.`,
    };
  }

  // 6. `applied` — the symptom cleared. Two gates on this rung and only this
  //    rung: the readings the rule fires on must still be readable (otherwise
  //    "the disk was cleared" and "the telemetry read failed" are the same
  //    evidence), and the window must have been watched.
  const clearance = judgeClearance(item.id, device, now);
  if (clearance.missing.length > 0) {
    return {
      ...base,
      deviceLabel: label,
      cause: "undetermined",
      unreadable: clearance.missing,
      detail:
        `${label} no longer carries this item, but we cannot say the symptom cleared: the ` +
        `reading(s) it rests on are not readable now (${clearance.missing.join("; ")}). An item ` +
        `that vanished because we stopped being able to measure it is not an item that was ` +
        `fixed.`,
    };
  }

  if (clearance.cleared) {
    if (!input.verdict.clearsGates) {
      return {
        ...base,
        deviceLabel: label,
        cause: "unobserved-window",
        detail:
          `${label} no longer shows the symptom, but we are not reporting it as fixed: ` +
          `${input.verdict.reason} Read this as "we cannot say", not as good news.`,
      };
    }
    return {
      ...base,
      deviceLabel: label,
      cause: "applied",
      detail:
        `${label} no longer shows the symptom — it is reachable, its panel reads lit and no ` +
        `recommendation of any kind remains for it. This says the CONDITION cleared, not that ` +
        `VFI's write cleared it: what was changed, by whom, is answerable from the action log ` +
        `(\`/api/audit\`), never from a diff.`,
    };
  }

  // 7. We hold every reading the rule needs AND the symptom is still there, so
  //    the item's absence is not explained by anything above. Say exactly that:
  //    an `undetermined` with an empty obstacle list means the ladder has a hole
  //    rather than the data, which `analyzeChurn` raises as a note about US.
  return {
    ...base,
    deviceLabel: label,
    cause: "undetermined",
    unreadable: [],
    detail:
      `${label} is reachable, every reading rule \`${ruleOf(item.id)}\` rests on is present, ` +
      `and the symptom still reads as present — yet the item is not in the \`${input.kind}\` ` +
      `set. Panel verdict reads \`${darknessVerdict(device, now)}\` and blank cause reads ` +
      `\`${blankCause(device, now).cause}\`. Nothing above explains the departure, which makes ` +
      `this a gap in our cause ladder rather than a gap in the data, and worth a bug report.`,
  };
}

/** Attribute ONE arrival. See `ChurnArrivalCause` for why this list is shorter. */
export function attributeArrival(
  rec: Recommendation,
  input: Omit<ChurnInput, "previous">,
  deviceById: ReadonlyMap<string, DeviceView>,
  watermark: Date,
  now: Date,
): ArrivedItem {
  const deviceId = rec.deviceIds[0] ?? deviceIdOf(rec);
  const device = deviceId ? deviceById.get(deviceId) : undefined;
  const label = rec.deviceLabel || device?.name || deviceId;
  const base = {
    id: rec.id,
    deviceId: deviceId ?? null,
    deviceLabel: label ?? null,
    unreadable: [] as string[],
    blockedBy: null,
  };

  if (input.verdict.blind) {
    return {
      ...base,
      cause: null,
      detail:
        "This item is in our read and not in yours, but no cause is attributed: " +
        input.verdict.reason,
      blockedBy: input.verdict.reason,
    };
  }

  // The schedule rungs, mirroring the departure side, and gated on the same rule
  // list: only a rule whose existence the window decides may be attributed to the
  // window moving.
  if (device && device.brightnessScheduleEnabled === true && isScheduleSensitiveRule(rec.id)) {
    const wasInWindow = withinOnWindow(
      device.turnOnTime,
      device.turnOffTime,
      device.timezone,
      watermark,
    );
    const isInWindow = withinOnWindow(device.turnOnTime, device.turnOffTime, device.timezone, now);
    const window = describeOnWindow(device);
    if (wasInWindow === false && isInWindow === true) {
      return {
        ...base,
        cause: "schedule-window-opened",
        detail:
          `${label} was outside its scheduled ON window when you looked and is inside it now` +
          (window ? ` (on ${window})` : "") +
          `. It should be lit and it is not, so the finding is newly actionable — it did not ` +
          `newly break.`,
      };
    }
    if (wasInWindow === true && isInWindow === false) {
      return {
        ...base,
        cause: "schedule-window-closed",
        detail:
          `${label} was inside its scheduled ON window when you looked and is outside it now` +
          (window ? ` (on ${window})` : "") +
          `. This item exists only while the window is shut — it is here to explain a dark ` +
          `screen, not to report a fault, and nothing about the device changed.`,
      };
    }
  }

  // The reading the item rests on was itself taken inside the window, so the
  // symptom is genuinely new to us. Only telemetry carries its own observation
  // stamp on this projection, so only telemetry items can claim this.
  const observedAt = device?.telemetry?.observedAt ?? null;
  if (observedAt) {
    const stamp = Date.parse(observedAt);
    if (Number.isFinite(stamp) && stamp > watermark.getTime() && stamp <= now.getTime()) {
      if (!input.verdict.clearsGates) {
        return {
          ...base,
          cause: "unobserved-window",
          detail:
            `${label} rests on a reading taken at ${observedAt}, inside your window, but the ` +
            `window is not well enough observed to date the arrival: ${input.verdict.reason}`,
        };
      }
      return {
        ...base,
        cause: "symptom-first-observed",
        detail:
          `The reading this rests on was taken at ${observedAt}, after you looked ` +
          `(${watermark.toISOString()}), so this symptom is new to us rather than newly shown ` +
          `to you.`,
      };
    }
  }

  return {
    ...base,
    cause: "undetermined",
    unreadable: [
      "the device facts as they were at the watermark (no recommendation snapshot is stored)",
    ],
    detail:
      `${label} is in our set and was not in yours, and we cannot date its arrival: its ` +
      `schedule does not explain it and the reading it rests on carries no observation time ` +
      `inside your window. We store no snapshot of the set as it was at ` +
      `${watermark.toISOString()}, so "when did this appear" is not answerable from stored data ` +
      `— only "it is here now and was not in the set you sent".`,
  };
}

// ── the report ───────────────────────────────────────────────────────────────

export const CHURN_BASIS =
  "Churn is a diff between two READS of the recommendation set, not a history: the earlier read " +
  "is the one you sent us and we cannot verify it, and the later read is what we just computed. " +
  "No recommendation snapshots are stored, so nothing here claims to know what the set looked " +
  "like at any instant we were not handed. Every cause is derived from a reading we name, an " +
  "unattributable departure says which reading was missing rather than falling into an `other` " +
  "bucket, and the one cause that asserts an improvement (`applied`) is withheld whenever the " +
  "collector did not watch enough of the window between the two reads to tell a symptom " +
  "clearing from us not looking. This is a diff, not the queue — the full set is " +
  "/api/remediation, and nothing is hidden there for not being new.";

export interface ChurnReport {
  basis: string;
  kind: RecommendationKind;
  reads: { previous: ChurnRead; current: ChurnRead };
  /** How much of the window between the reads we watched, and whether it is enough. */
  window: ChurnObservationVerdict;
  /** Net movement, e.g. 20 → 2. Both ends counted from the same filtered sets. */
  movement: Figure<{ from: number; to: number; net: number }, ChurnFigureUnit>;
  left: DepartedItem[];
  entered: ArrivedItem[];
  /**
   * Items in both reads whose severity moved. `null` — not `[]` — when the
   * caller sent no severities, because "we cannot tell" is not "nothing changed".
   */
  changed: ChangedItem[] | null;
  changedReason: string | null;
  /** Items in both reads. Counted so `left + stillPresent` reconciles to `from`. */
  stillPresent: number;
  /**
   * The breakdown, counted over exactly the `left` array above. `null` when the
   * window was blind — never a map of zeros, which is the shape of a lie here.
   */
  byCause: Figure<Record<ChurnDepartureCause, number>, ChurnFigureUnit> | null;
  byArrivalCause: Figure<Record<ChurnArrivalCause, number>, ChurnFigureUnit> | null;
  /** One sentence an operator can read instead of the whole payload. */
  headline: string;
  notes: string[];
}

/**
 * Count causes over the array we are actually publishing.
 *
 * Takes the items, not the inputs, deliberately: a count derived from anything
 * other than the emitted collection is a count that can disagree with the list
 * beside it, and that has shipped in this codebase three times.
 */
const tally = <C extends string>(
  items: readonly { cause: C | null }[],
  keys: readonly C[],
): Record<C, number> => {
  const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<C, number>;
  for (const item of items) {
    if (item.cause === null) continue;
    out[item.cause] += 1;
  }
  return out;
};

const DEPARTURE_CAUSES: readonly ChurnDepartureCause[] = [
  "applied",
  "schedule-window-closed",
  "schedule-window-opened",
  "device-unreachable",
  "superseded",
  "intent-excluded",
  "device-retired",
  "unobserved-window",
  "undetermined",
];

const ARRIVAL_CAUSES: readonly ChurnArrivalCause[] = [
  "schedule-window-opened",
  "schedule-window-closed",
  "symptom-first-observed",
  "unobserved-window",
  "undetermined",
];

const CAUSE_PHRASE: Record<ChurnDepartureCause, string> = {
  applied: "the symptom cleared",
  "schedule-window-closed": "their schedule closed, not because they were fixed",
  "schedule-window-opened": "their schedule opened, so an informational item stopped applying",
  "device-unreachable": "we can no longer reach them",
  superseded: "they were replaced by a different recommendation",
  "intent-excluded": "device intent demoted them out of the one-click set",
  "device-retired": "the device left the fleet",
  "unobserved-window": "we were not watching enough of the window to say",
  undetermined: "we could not determine why",
};

export function analyzeChurn(input: ChurnInput): ChurnReport {
  const watermark = new Date(input.previous.observedAt);
  const now = new Date(input.current.observedAt);

  // FILTER FIRST, then count the filtered thing. `previousTracked` and
  // `currentTracked` are the only two collections any count in this report is
  // allowed to be derived from.
  //
  // A prior item with no `kind` is kept: the caller sent it as part of the set it
  // was tracking, and dropping it because a field was absent would quietly shrink
  // the "from" end of `20 → 2` and flatter us.
  const previousTracked = input.previous.items.filter(
    (item) => item.kind === undefined || item.kind === input.kind,
  );
  const currentTracked = input.current.recommendations.filter((rec) => rec.kind === input.kind);

  const previousIds = new Set(previousTracked.map((i) => i.id));
  const currentIds = new Set(currentTracked.map((r) => r.id));

  const deviceById = new Map(input.devices.map((d) => [d.id, d]));
  const currentById = new Map(input.current.recommendations.map((r) => [r.id, r]));
  const trackedByDevice = new Map<string, Recommendation[]>();
  for (const rec of currentTracked) {
    const deviceId = rec.deviceIds[0] ?? deviceIdOf(rec);
    if (!deviceId) continue;
    const list = trackedByDevice.get(deviceId);
    if (list) list.push(rec);
    else trackedByDevice.set(deviceId, [rec]);
  }

  const engineInput: Omit<ChurnInput, "previous"> = {
    current: input.current,
    devices: input.devices,
    kind: input.kind,
    verdict: input.verdict,
  };

  const left = previousTracked
    .filter((item) => !currentIds.has(item.id))
    .map((item) =>
      attributeDeparture(
        item,
        engineInput,
        deviceById,
        currentById,
        trackedByDevice,
        previousIds,
        watermark,
        now,
      ),
    );

  const entered = currentTracked
    .filter((rec) => !previousIds.has(rec.id))
    .map((rec) => attributeArrival(rec, engineInput, deviceById, watermark, now));

  const bothIds = previousTracked.filter((item) => currentIds.has(item.id));
  const stillPresent = bothIds.length;

  // `changed` is unknowable without the severities the caller held. Null plus a
  // reason, never an empty array read as "nothing moved".
  const withSeverity = bothIds.filter((item) => item.severity !== undefined);
  let changed: ChangedItem[] | null = null;
  let changedReason: string | null = null;
  if (withSeverity.length === 0 && stillPresent > 0) {
    changedReason =
      `Your read carried no severities, so we cannot say whether any of the ${stillPresent} ` +
      `item(s) present in both reads changed. Send \`severity\` on each prior item to get this.`;
  } else {
    changed = [];
    for (const item of withSeverity) {
      const severityFrom = item.severity;
      const rec = currentById.get(item.id);
      if (severityFrom === undefined || !rec || rec.severity === severityFrom) continue;
      changed.push({
        id: item.id,
        deviceId: deviceIdOf(item),
        deviceLabel: rec.deviceLabel ?? null,
        severityFrom,
        severityTo: rec.severity,
        detail:
          `${rec.deviceLabel}: severity moved ${severityFrom} → ${rec.severity} while the item ` +
          `stayed in the set.`,
      });
    }
    if (withSeverity.length < stillPresent) {
      changedReason =
        `${withSeverity.length} of ${stillPresent} item(s) present in both reads carried a ` +
        `severity we could compare; the rest are absent from this list because we could not ` +
        `compare them, not because they held still.`;
    }
  }

  const from = previousTracked.length;
  const to = currentTracked.length;
  const movementBasis =
    `Both ends are counted from the \`${input.kind}\` set only: ${from} item(s) in the read you ` +
    `sent from ${input.previous.observedAt}, ${to} in ours from ${input.current.observedAt}. ` +
    `The earlier count is yours and is not independently verified.`;

  // Attribution coverage: how many departures we could actually name a cause
  // for. `undetermined` and `unobserved-window` are honest but they are not
  // answers, so neither counts as measured.
  const named = left.filter(
    (item) => item.cause !== null && item.cause !== "undetermined" && item.cause !== "unobserved-window",
  ).length;
  const namedArrivals = entered.filter(
    (item) => item.cause !== null && item.cause !== "undetermined" && item.cause !== "unobserved-window",
  ).length;

  const byCause = input.verdict.blind
    ? null
    : churnFigure(
        tally(left, DEPARTURE_CAUSES),
        `Counted over exactly the ${left.length} departure(s) listed in \`left\`, one cause ` +
          `each, first match on the documented ladder. ` +
          (input.verdict.clearsGates
            ? `The window between the reads clears the observation gates, so \`applied\` is ` +
              `claimable.`
            : `\`applied\` is NOT claimable for this window — ${input.verdict.reason}`),
        named,
        left.length,
        "recommendations",
        left.length === 0
          ? "Nothing left the set, so there was nothing to attribute."
          : `We named a device- or schedule-level cause for ${named} of ${left.length} ` +
            `departure(s); the remaining ${left.length - named} are reported as ` +
            `\`undetermined\` or \`unobserved-window\` and each says which reading was missing ` +
            `or which gate blocked it. None are bucketed as "other".`,
      );

  const byArrivalCause = input.verdict.blind
    ? null
    : churnFigure(
        tally(entered, ARRIVAL_CAUSES),
        `Counted over exactly the ${entered.length} arrival(s) listed in \`entered\`. Arrival ` +
          `causes are deliberately fewer than departure causes: explaining an arrival needs the ` +
          `device facts as they were at your watermark and we store none, so only the schedule ` +
          `and a reading stamped inside the window can date one.`,
        namedArrivals,
        entered.length,
        "recommendations",
        entered.length === 0
          ? "Nothing entered the set, so there was nothing to attribute."
          : `We dated ${namedArrivals} of ${entered.length} arrival(s); the rest say why not.`,
      );

  const movement = churnFigure(
    { from, to, net: to - from },
    movementBasis,
    to,
    to,
    "recommendations",
    `${from} → ${to} in the \`${input.kind}\` set. ${left.length} left, ${entered.length} ` +
      `entered, ${stillPresent} were in both reads.`,
  );

  // The sentence US-8.6.3 asks for, built from the tally rather than restated
  // beside it, so the prose cannot drift from the counts.
  let headline: string;
  if (input.verdict.blind) {
    headline =
      `The \`${input.kind}\` set moved ${from} → ${to} between ${input.previous.observedAt} and ` +
      `${input.current.observedAt}, and we will not say why: ${input.verdict.reason}`;
  } else if (left.length === 0 && entered.length === 0) {
    headline = `The \`${input.kind}\` set is the same ${to} item(s) you last saw.`;
  } else {
    const counts = tally(left, DEPARTURE_CAUSES);
    const ranked = DEPARTURE_CAUSES.filter((c) => counts[c] > 0).sort((a, b) => counts[b] - counts[a]);
    const phrases = ranked.map((c) => `${counts[c]} left because ${CAUSE_PHRASE[c]}`);
    headline =
      `The \`${input.kind}\` set moved ${from} → ${to}` +
      (phrases.length > 0 ? `: ${phrases.join("; ")}` : "") +
      (entered.length > 0 ? `. ${entered.length} entered since you looked.` : ".");
  }

  const notes: string[] = [];
  if (input.verdict.reason) notes.push(input.verdict.reason);
  if (changedReason) notes.push(changedReason);
  const undetermined = left.filter((i) => i.cause === "undetermined");
  const unexplained = undetermined.filter((i) => i.unreadable.length === 0);
  if (unexplained.length > 0) {
    notes.push(
      `${unexplained.length} departure(s) are \`undetermined\` with every reading present, ` +
        `which means the cause ladder has a hole rather than the data. That is a bug in this ` +
        `module, not a fact about the fleet.`,
    );
  }
  if (from === 0) {
    notes.push(
      `The read you sent held no \`${input.kind}\` items, so everything in ours is listed as ` +
        `entered. That is a consequence of your baseline being empty, not evidence of a surge.`,
    );
  }

  return {
    basis: CHURN_BASIS,
    kind: input.kind,
    reads: {
      previous: { observedAt: input.previous.observedAt, attestedBy: "caller", count: from },
      current: { observedAt: input.current.observedAt, attestedBy: "self", count: to },
    },
    window: input.verdict,
    movement,
    left,
    entered,
    changed,
    changedReason,
    stillPresent,
    byCause,
    byArrivalCause,
    headline,
    notes,
  };
}

// ── new-since-you-looked: the watermark itself ───────────────────────────────

/**
 * What the watermark is measured against, in the payload, because a "since" with
 * an unstated reference is an invitation to misread it.
 */
export const WATERMARK_BASIS =
  "The watermark is an absolute instant — the `observedAt` of the read you are diffing against, " +
  "which for this API is the `computedAt` of the /api/remediation envelope you last rendered. " +
  "It is compared against the instant we evaluated the current set, NOT against the age of the " +
  "underlying device readings, which may be older than either instant; `window.observation` " +
  "states how much of the span between them the collector actually watched. Membership is " +
  "half-open: an item that was already in the set AT the watermark is not new, so `entered` is " +
  "strictly `not in the set you attested to at that instant`.";

export type WatermarkProblem =
  | "missing"
  | "unparseable"
  | "in-the-future"
  | "older-than-ceiling"
  | "no-prior-set";

export interface WatermarkVerdict {
  ok: boolean;
  problem: WatermarkProblem | null;
  /** Parsed instant. Null whenever `ok` is false. */
  at: Date | null;
  message: string | null;
  basis: string;
}

/** Windows longer than this are refused outright rather than half-answered. */
export const WATERMARK_MAX_AGE_DAYS = 30;

/**
 * Validate the caller's watermark.
 *
 * A missing watermark is NOT treated as "the beginning of time", which would
 * make the entire current set read as new — the single most tempting bug here
 * and the one the story explicitly forbids. It is a distinct, named problem and
 * the route turns it into a labelled first-look response with a NULL new-count,
 * never a zero and never a number equal to the total.
 *
 * `clockSkewToleranceSeconds` exists because the watermark is a client clock and
 * ours is a server clock; a few seconds of skew is not a malformed request, but
 * a watermark genuinely in the future would make "since" meaningless and is
 * refused.
 */
export function judgeWatermark(
  since: string | undefined,
  now: Date,
  hasPriorSet: boolean,
  clockSkewToleranceSeconds = 120,
  maxAgeDays: number = WATERMARK_MAX_AGE_DAYS,
): WatermarkVerdict {
  const base = { at: null, basis: WATERMARK_BASIS };
  if (since === undefined || since.trim() === "") {
    return {
      ...base,
      ok: false,
      problem: "missing",
      message:
        "No watermark was supplied, so there is nothing to diff against. This is answered as a " +
        "FIRST LOOK: the full current set, with the new-since count reported as null rather " +
        "than as the total, because nothing here has been shown to be new.",
    };
  }
  const ms = Date.parse(since);
  if (!Number.isFinite(ms)) {
    return {
      ...base,
      ok: false,
      problem: "unparseable",
      message:
        `\`since\` must be an absolute ISO-8601 instant (e.g. ${now.toISOString()}); ` +
        `\`${since}\` could not be parsed. Refused rather than defaulted, because a defaulted ` +
        `watermark would report the whole set as new.`,
    };
  }
  const at = new Date(ms);
  const skewMs = ms - now.getTime();
  if (skewMs > clockSkewToleranceSeconds * 1000) {
    return {
      ...base,
      ok: false,
      problem: "in-the-future",
      message:
        `The watermark ${at.toISOString()} is ${Math.round(skewMs / 1000)}s ahead of our ` +
        `observation instant ${now.toISOString()}, beyond the ${clockSkewToleranceSeconds}s ` +
        `clock-skew allowance. "Since a moment that has not happened" has no answer.`,
    };
  }
  const ageDays = (now.getTime() - ms) / 86_400_000;
  if (ageDays > maxAgeDays) {
    return {
      ...base,
      ok: false,
      problem: "older-than-ceiling",
      message:
        `The watermark ${at.toISOString()} is ${ageDays.toFixed(1)} days old, beyond the ` +
        `${maxAgeDays}-day ceiling. Over a window that long the set has turned over completely ` +
        `and a "since" diff would describe our own collection history rather than your queue.`,
    };
  }
  if (!hasPriorSet) {
    return {
      ...base,
      ok: false,
      problem: "no-prior-set",
      message:
        `A watermark of ${at.toISOString()} was supplied but no prior set was. We persist no ` +
        `recommendation snapshots — there is no table for them — so we cannot reconstruct what ` +
        `you saw then; send the ids you held as \`previous\`. Answering from the watermark ` +
        `alone would mean inventing your baseline.`,
    };
  }
  // Clamp skew forward: a watermark a minute ahead of us within tolerance would
  // otherwise produce a negative-length window and an `expectedBuckets` of 0.
  return {
    ok: true,
    problem: null,
    at: skewMs > 0 ? now : at,
    message: null,
    basis: WATERMARK_BASIS,
  };
}

/**
 * The first-look answer: the full current set, labelled as not-a-diff.
 *
 * `newSince` is `null` on purpose. Reporting it as `currentTracked.length` would
 * be the "everything is new" lie; reporting it as 0 would be the fabricated-zero
 * lie. Null with a reason is the only honest option, and the full set is still
 * returned so nothing is hidden for not being new.
 */
export interface FirstLookReport {
  basis: string;
  watermark: { supplied: string | null; basis: string; problem: WatermarkProblem; message: string };
  firstLook: true;
  kind: RecommendationKind;
  observedAt: string;
  /** Every id in the tracked set. Nothing is filtered out for not being new. */
  ids: string[];
  total: Figure<number, ChurnFigureUnit>;
  newSince: null;
  newSinceReason: string;
  headline: string;
}

export function buildFirstLook(
  kind: RecommendationKind,
  observedAt: string,
  recommendations: readonly Recommendation[],
  verdict: WatermarkVerdict,
  supplied: string | null,
): FirstLookReport {
  // Filter first, count the filtered thing.
  const tracked = recommendations.filter((rec) => rec.kind === kind);
  return {
    basis: CHURN_BASIS,
    watermark: {
      supplied,
      basis: WATERMARK_BASIS,
      problem: verdict.problem ?? "missing",
      message: verdict.message ?? "No watermark was supplied.",
    },
    firstLook: true,
    kind,
    observedAt,
    ids: tracked.map((rec) => rec.id),
    total: churnFigure(
      tracked.length,
      `The whole \`${kind}\` set as of ${observedAt}. Not a diff: no watermark was usable, so ` +
        `no item here is asserted to be new or old.`,
      tracked.length,
      tracked.length,
      "recommendations",
      `All ${tracked.length} \`${kind}\` item(s) we currently hold. Nothing is omitted for not ` +
        `being new.`,
    ),
    newSince: null,
    newSinceReason:
      `Unknown, deliberately. ${verdict.message ?? ""} A first look reports the new-since count ` +
      `as null — not as ${tracked.length}, which would claim the whole set arrived since you ` +
      `looked, and not as 0, which would claim none of it did.`,
    headline:
      `First look: ${tracked.length} \`${kind}\` item(s) as of ${observedAt}. This is the full ` +
      `set, not a diff — send \`since\` and \`previous\` to get one.`,
  };
}
