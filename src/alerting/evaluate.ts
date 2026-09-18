/**
 * Rule evaluation — pure functions, no I/O.
 *
 * Everything here takes data in and returns a verdict, so the whole detection
 * surface is unit-testable without a database. Alerting is the one subsystem
 * where a subtle bug wakes someone at 3am or, worse, stays silent during a real
 * outage, so it is deliberately kept free of side effects.
 *
 * THE RULE THAT GOVERNS EVERYTHING BELOW
 * A missing reading is not a low reading. `NULL` never satisfies a comparator —
 * not `lt`, not `gt`. Given that most of our hardware telemetry is undocumented
 * and frequently unreadable, treating absence as zero would carpet the fleet in
 * false "CPU below threshold" and "signal weak" alerts on day one. Unreadable
 * metrics produce silence, and silence is the correct output.
 */

import type { AlertRule, Comparator, MetricField, StateField } from "./rules.js";
import type { Severity } from "../domain/types.js";
import type { ScreenVerdict } from "../intelligence/screen-verify.js";

/** One row from health_samples, as the engine needs it. */
export interface SampleRow {
  observedAt: Date;
  source: string;
  presence: string | null;
  isScreenOn: boolean | null;
  isBlackScreen: boolean | null;
  showingLogo: boolean | null;
  downloading: boolean | null;
  /** Strings on the live API ("no", "unavailable") — not numbers. */
  pingQuality: string | null;
  playbackQuality: string | null;
  nowPlayingType: string | null;
  nowPlayingId: string | null;
  cpuPercent: number | null;
  ramPercent: number | null;
  temperatureC: number | null;
  wifiSignalDbm: number | null;
  packetLossPercent: number | null;
  jitterMs: number | null;
  ntpSyncPercent: number | null;
  storagePercent: number | null;
}

/** Device attributes rules may read. */
export interface DeviceRow {
  id: string;
  name: string | null;
  location: string | null;
  /**
   * The platform's `device_class` — canvas, spark-bridge, tcl, allsee,
   * allsee-shelf, or the literal "unknown" it sends when it does not know.
   * Absent/null means we were never told, which the firmware rule states rather
   * than guesses around.
   */
  deviceClass?: string | null;
  firmwareCurrent: string | null;
  firmwareLatest: string | null;
  /** component → {current, latest}. Up to 16 packages per device. */
  components: Record<string, { current: string | null; latest: string | null }>;
  lastOnlineTime: Date | null;
}

export interface Verdict {
  ruleId: string;
  deviceId: string;
  firing: boolean;
  severity: Severity;
  title: string;
  /** Human-readable, with real numbers. Feeds the UI and the AI triage layer. */
  evidence: string;
  /** Why the rule did not fire, when it did not. */
  skipped?: string;
  /**
   * True only when the rule could not be judged AT ALL because its input does
   * not exist on this device — as opposed to being judged and found fine.
   *
   * These two must never share a counter. "No device fired" means the fleet is
   * healthy; "no device could be judged" means the rule is structurally dead
   * and will stay silent through a real outage. A UI that reports one number
   * for both tells the operator the opposite of the truth.
   */
  unreadable?: true;
  /**
   * Set when the rule's condition genuinely held on platform data but the DEVICE
   * ITSELF refuted the claim underneath it (see the black-screen branch below).
   *
   * The verdict still FIRES — a refuted platform flag is a data-quality finding,
   * not nothing — but at `info` rather than `critical`, and this flag is what
   * makes the de-escalation countable. Suppressing the alert outright would hide
   * the disagreement, which is the one outcome worse than the false critical.
   */
  refuted?: true;
}

const METRIC_ACCESSORS: Record<MetricField, (s: SampleRow) => number | null> = {
  cpu_percent: (s) => s.cpuPercent,
  ram_percent: (s) => s.ramPercent,
  temperature_c: (s) => s.temperatureC,
  wifi_signal_dbm: (s) => s.wifiSignalDbm,
  packet_loss_percent: (s) => s.packetLossPercent,
  jitter_ms: (s) => s.jitterMs,
  ntp_sync_percent: (s) => s.ntpSyncPercent,
  storage_percent: (s) => s.storagePercent,
};

const STATE_ACCESSORS: Record<StateField, (s: SampleRow) => boolean | null> = {
  is_black_screen: (s) => s.isBlackScreen,
  showing_logo: (s) => s.showingLogo,
  is_screen_on: (s) => s.isScreenOn,
  downloading: (s) => s.downloading,
};

const METRIC_LABELS: Record<MetricField, { label: string; unit: string }> = {
  cpu_percent: { label: "CPU", unit: "%" },
  ram_percent: { label: "Memory", unit: "%" },
  temperature_c: { label: "Temperature", unit: "°C" },
  wifi_signal_dbm: { label: "WiFi signal", unit: " dBm" },
  packet_loss_percent: { label: "Packet loss", unit: "%" },
  jitter_ms: { label: "Jitter", unit: " ms" },
  ntp_sync_percent: { label: "NTP sync rate", unit: "%" },
  storage_percent: { label: "Storage", unit: "%" },
};

const STATE_LABELS: Record<StateField, { whenTrue: string; whenFalse: string }> = {
  is_black_screen: { whenTrue: "Screen is black", whenFalse: "Screen is not black" },
  showing_logo: { whenTrue: "Showing logo instead of content", whenFalse: "Not showing logo" },
  is_screen_on: { whenTrue: "Screen powered on", whenFalse: "Screen powered off" },
  downloading: { whenTrue: "Downloading content", whenFalse: "Not downloading" },
};

const compare = (value: number, comparator: Comparator, threshold: number): boolean => {
  switch (comparator) {
    case "gt": return value > threshold;
    case "gte": return value >= threshold;
    case "lt": return value < threshold;
    case "lte": return value <= threshold;
  }
};

const COMPARATOR_WORDS: Record<Comparator, string> = {
  gt: "above", gte: "at or above", lt: "below", lte: "at or below",
};

const round = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** Newest first. */
const byNewest = (a: SampleRow, b: SampleRow) => b.observedAt.getTime() - a.observedAt.getTime();

interface RunSummary {
  /** Consecutive readings satisfying the condition, newest first. */
  readings: number;
  /** Seconds spanned by that run. */
  spanSeconds: number;
  /** Largest gap between consecutive considered readings, in seconds. */
  maxGapSeconds: number;
  values: number[];
  /** Newest reading in the run. null when the run is empty. */
  newestAt: Date | null;
  /** Oldest reading in the run — i.e. when the episode started. */
  oldestAt: Date | null;
}

/**
 * Walks samples newest-to-oldest and measures the unbroken run satisfying the
 * predicate.
 *
 * Readings where the field is NULL are **skipped, not counted as failures**. An
 * intermittently-readable metric should still be judgeable — but because skipping
 * could stitch two distant readings into a fake "continuous" run, we also track
 * the largest gap and let the caller reject runs that are too sparse to trust.
 */
function measureRun<T>(
  samples: SampleRow[],
  read: (s: SampleRow) => T | null,
  satisfies: (value: T) => boolean,
): RunSummary {
  const ordered = [...samples].sort(byNewest);
  let readings = 0;
  let maxGapSeconds = 0;
  let newest: Date | null = null;
  let oldest: Date | null = null;
  let previous: Date | null = null;
  const values: number[] = [];

  for (const sample of ordered) {
    const value = read(sample);
    if (value === null || value === undefined) continue; // unknown, not failing
    if (!satisfies(value)) break; // the run ends here

    readings += 1;
    newest ??= sample.observedAt;
    oldest = sample.observedAt;
    if (typeof value === "number") values.push(value);
    if (previous) {
      maxGapSeconds = Math.max(
        maxGapSeconds,
        (previous.getTime() - sample.observedAt.getTime()) / 1000,
      );
    }
    previous = sample.observedAt;
  }

  const spanSeconds =
    newest && oldest ? (newest.getTime() - oldest.getTime()) / 1000 : 0;
  return { readings, spanSeconds, maxGapSeconds, values, newestAt: newest, oldestAt: oldest };
}

/** A run stitched across a gap this large is not evidence of continuity. */
const gapTolerance = (sustainedForSeconds: number) =>
  Math.max(600, sustainedForSeconds * 0.5);

// ─────────────────────────────────────────────────────────────────────────────
// What the fleet itself says about a firmware target
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evidence, counted from the devices we hold, about one
 * (device class, component, target build) triple.
 *
 * This exists because `current !== latest` proves only that two strings differ.
 * Verified live 2026-09-16: `icanvasplayer_version`, `adsync_version` and
 * `superuserservice_version` each carry exactly ONE `latest` value across all six
 * device classes in this fleet, so for those components `latest` is a single
 * tenant-wide value rather than a per-model target (docs/14 §B15). A single value
 * shared by a Videri Canvas, a TCL panel and an AllSee shelf label cannot be read
 * as "the build for this model" on the strength of the platform saying so.
 *
 * So the rule cites the fleet instead: if other devices OF THE SAME CLASS report
 * RUNNING that exact build, the build demonstrably runs on this model and
 * "an upgrade exists" is a claim we can stand behind. If none do, the honest
 * statement is that the strings differ and nothing more.
 *
 * Every number here is counted, never assumed.
 */
export interface FirmwareTargetEvidence {
  /** Devices of this class reporting this component's `current` AS the target. */
  peersAtTarget: number;
  /** Devices of this class that report this component at all. */
  classCohort: number;
  /** Distinct `latest` values this component carries across the whole fleet. */
  distinctTargetsFleetWide: number;
  /** Device classes carrying this component at all, fleet-wide. */
  classesFleetWide: number;
}

/** `class \0 component \0 target` → evidence. Built by buildFirmwareTargetIndex. */
export type FirmwareTargetIndex = ReadonlyMap<string, FirmwareTargetEvidence>;

/** NUL, because it cannot occur inside a class, component or version string. */
const targetKey = (deviceClass: string, component: string, target: string) =>
  `${deviceClass}\u0000${component}\u0000${target}`;

/** Blank and whitespace-only class labels are absent, not a class called "". */
const normaliseClass = (deviceClass: string | null | undefined): string | null =>
  deviceClass && deviceClass.trim() !== "" ? deviceClass.trim() : null;

const trimmed = (value: string | null | undefined): string | null =>
  value && value.trim() !== "" ? value.trim() : null;

/**
 * Count, across the fleet, which firmware targets are actually attested per class.
 *
 * Pure: takes every device we are about to evaluate and returns counts. The engine
 * builds this once per cycle from the devices it has already loaded, so it costs
 * no extra query and no device command.
 */
export function buildFirmwareTargetIndex(
  devices: Iterable<DeviceRow>,
): FirmwareTargetIndex {
  const peers = new Map<string, number>();
  const cohorts = new Map<string, number>();
  const targetsByComponent = new Map<string, Set<string>>();
  const classesByComponent = new Map<string, Set<string>>();

  for (const device of devices) {
    const deviceClass = normaliseClass(device.deviceClass);
    for (const [component, versions] of Object.entries(device.components ?? {})) {
      const latest = trimmed(versions?.latest);
      const current = trimmed(versions?.current);

      if (latest) {
        let targets = targetsByComponent.get(component);
        if (!targets) targetsByComponent.set(component, (targets = new Set()));
        targets.add(latest);
      }
      if (deviceClass) {
        let classes = classesByComponent.get(component);
        if (!classes) classesByComponent.set(component, (classes = new Set()));
        classes.add(deviceClass);

        const cohortKey = `${deviceClass}\u0000${component}`;
        cohorts.set(cohortKey, (cohorts.get(cohortKey) ?? 0) + 1);

        // Keyed on what the device is RUNNING, not on what it was told to run.
        // That is the whole point: `current` is the one version string on this
        // row that we know describes real installed software.
        if (current) {
          const key = targetKey(deviceClass, component, current);
          peers.set(key, (peers.get(key) ?? 0) + 1);
        }
      }
    }
  }

  const index = new Map<string, FirmwareTargetEvidence>();
  for (const [cohortKey, classCohort] of cohorts) {
    const [deviceClass, component] = cohortKey.split("\u0000") as [string, string];
    for (const target of targetsByComponent.get(component) ?? []) {
      index.set(targetKey(deviceClass, component, target), {
        peersAtTarget: peers.get(targetKey(deviceClass, component, target)) ?? 0,
        classCohort,
        distinctTargetsFleetWide: targetsByComponent.get(component)?.size ?? 0,
        classesFleetWide: classesByComponent.get(component)?.size ?? 0,
      });
    }
  }
  return index;
}

/** Whether the fleet corroborates a target for this device's model, and why. */
export interface FirmwareTargetStanding {
  corroborated: boolean;
  /**
   * The counted reason, phrased as a clause about the component and target passed
   * in — the evidence sentence renders it as `component → why`, so it names the
   * target build but says "this component" rather than repeating the package name.
   */
  why: string;
}

/**
 * Decide what we are entitled to claim about one target for one device — pure.
 *
 * Absence is never corroboration. No index, no class, no cohort all land on
 * `corroborated: false` with the reason attached, exactly as an unreadable metric
 * lands on silence rather than on zero.
 */
export function firmwareTargetStanding(
  index: FirmwareTargetIndex | null | undefined,
  deviceClass: string | null | undefined,
  component: string,
  target: string,
): FirmwareTargetStanding {
  if (!index) {
    return {
      corroborated: false,
      why:
        `no fleet-wide version comparison was available in this evaluation, so nothing ` +
        `corroborates ${target} as a build for this model`,
    };
  }

  const cls = normaliseClass(deviceClass);
  if (!cls) {
    return {
      corroborated: false,
      why:
        `the platform reports no device class for this device, so ${target} cannot be ` +
        `attributed to a model at all`,
    };
  }

  const evidence = index.get(targetKey(cls, component, target));
  if (!evidence || evidence.classCohort === 0) {
    return {
      corroborated: false,
      why:
        `no device of class "${cls}" in this fleet reports ${component} at all, so there is ` +
        `nothing to compare ${target} against for this model`,
    };
  }

  if (evidence.peersAtTarget > 0) {
    return {
      corroborated: true,
      why:
        `${evidence.peersAtTarget} of the ${evidence.classCohort} "${cls}" device(s) in this ` +
        `fleet reporting this component already run ${target}`,
    };
  }

  // A cohort of one is this device. Saying "none of the 1 device runs it" would be
  // technically true and useless; the real finding is that there is no peer.
  if (evidence.classCohort === 1) {
    return {
      corroborated: false,
      why:
        `this is the only "${cls}" device in this fleet reporting this component, so nothing ` +
        `corroborates ${target} as a build for this model`,
    };
  }

  // The tenant-wide-value case, stated only when the data shows it: one `latest`
  // for this component across more than one class means the platform is not
  // differentiating by model here.
  const tenantWide =
    evidence.distinctTargetsFleetWide === 1 && evidence.classesFleetWide > 1
      ? `, and it carries exactly one \`latest\` value across all ` +
        `${evidence.classesFleetWide} device classes in this fleet — a single tenant-wide ` +
        `value, not a per-model target`
      : "";
  return {
    corroborated: false,
    why:
      `none of the ${evidence.classCohort} "${cls}" device(s) in this fleet reporting this ` +
      `component runs ${target}${tenantWide}`,
  };
}

/**
 * The newest persisted screen-check for a device, as the engine reads it.
 *
 * Written by the verification slow lane (pipeline/pollers/screen-verify-slowlane.ts)
 * into `device_screen_verdict`. NOTHING here issues a device command: alerting
 * runs every ~450s across the whole fleet, and a synchronous verb costs ~11s
 * when the panel does not answer. The lane asks; the engine only reads.
 */
export interface ScreenVerdictRecord {
  verdict: ScreenVerdict | string;
  /** When the panel was asked — not when the platform sampled. */
  observedAt: Date;
  /** The panel's own answer. null = it did not answer. Reported, never inferred. */
  deviceIsBlack?: boolean | null;
}

/**
 * How old a screen-check may be and still speak for the current episode.
 *
 * 20 minutes. The status poller runs every 120s (config.POLL_STATUS_INTERVAL_MS)
 * and the black-screen rule needs 5 minutes of sustain, so 20 minutes is about
 * ten status cycles — long enough that a verification lane on any sane cadence
 * (15 min matches the other slow lanes) always has a usable answer, short enough
 * that a panel's answer is still describing the screen an operator would see if
 * they walked up to it. Past that we say "unverified" rather than pretend.
 */
export const SCREEN_VERDICT_MAX_AGE_SECONDS = 20 * 60;

/** What a stored screen-check is entitled to say about the episode in front of us. */
export type ScreenVerdictStanding = "refutes" | "confirms" | "unverified";

/**
 * Decide whether a stored verdict may speak, and what it says — pure.
 *
 * TWO independent freshness gates, because they catch different lies:
 *
 *   age vs `now`  — a verdict from yesterday describes yesterday's screen.
 *   age vs the EPISODE START — a verdict recorded before the current unbroken
 *     run of `is_black_screen = true` began says nothing about this episode,
 *     even if it is only minutes old. This is the gate that stops a `contradicted`
 *     answer from silencing a genuinely new outage that started right after it.
 *
 * The episode gate is deliberately measured against the OLDEST reading in the
 * current run, not the newest. Anchoring it to the newest sample would mean the
 * next status poll (120s away) invalidates every refutation, so the feature would
 * be inert within one cycle — and inert here means we keep paging on claims we
 * have already disproved. A verdict recorded anywhere inside an unbroken black
 * run is an observation OF that run, so it is entitled to contradict it.
 *
 * `unanswered` and `no-claim` both land on `unverified`. Silence from a panel is
 * neither agreement nor refutation, and folding it into either would rebuild the
 * exact failure this whole path exists to stop.
 */
export function screenVerdictStanding(
  record: ScreenVerdictRecord | null | undefined,
  episodeStartedAt: Date | null,
  now: Date,
  maxAgeSeconds: number = SCREEN_VERDICT_MAX_AGE_SECONDS,
): { standing: ScreenVerdictStanding; why: string } {
  if (!record) {
    return {
      standing: "unverified",
      why: "no screen-check has ever been recorded for this device",
    };
  }

  const ageSeconds = (now.getTime() - record.observedAt.getTime()) / 1000;
  if (ageSeconds > maxAgeSeconds) {
    return {
      standing: "unverified",
      why:
        `the last screen-check (${record.verdict}, ${record.observedAt.toISOString()}) is ` +
        `${formatDuration(ageSeconds)} old, past the ${formatDuration(maxAgeSeconds)} limit`,
    };
  }

  // Strictly newer: a verdict stamped at the same instant the episode started is
  // not evidence about it.
  if (episodeStartedAt && record.observedAt.getTime() <= episodeStartedAt.getTime()) {
    return {
      standing: "unverified",
      why:
        `the last screen-check (${record.verdict}, ${record.observedAt.toISOString()}) predates ` +
        `this black episode, which began at ${episodeStartedAt.toISOString()}`,
    };
  }

  switch (record.verdict) {
    case "contradicted": return { standing: "refutes", why: "" };
    case "confirmed": return { standing: "confirms", why: "" };
    case "unanswered":
      return {
        standing: "unverified",
        why:
          `the panel was asked at ${record.observedAt.toISOString()} and did not answer ` +
          `is_blackscreen — silence is neither agreement nor refutation`,
      };
    case "no-claim":
      return {
        standing: "unverified",
        why:
          `the last screen-check at ${record.observedAt.toISOString()} found no black-screen ` +
          `claim to test, so the current claim is unchecked`,
      };
    default:
      return {
        standing: "unverified",
        why: `the last screen-check carries an unrecognised verdict "${record.verdict}"`,
      };
  }
}

export interface EvaluateContext {
  device: DeviceRow;
  samples: SampleRow[];
  now: Date;
  /**
   * The device's newest stored screen-check, if we hold one. Absent/null is the
   * normal case and means "unverified" — never "fine" and never "refuted".
   */
  screenVerdict?: ScreenVerdictRecord | null;
  /**
   * Fleet-wide firmware-target counts, built once per cycle by
   * `buildFirmwareTargetIndex`. Absent means the firmware rule still fires and
   * still names the components, but says plainly that nothing corroborates the
   * target for this model — never that an upgrade exists.
   */
  firmwareTargets?: FirmwareTargetIndex | null;
}

export function evaluateRule(rule: AlertRule, ctx: EvaluateContext): Verdict {
  const { device } = ctx;
  const base = { ruleId: rule.id, deviceId: device.id, severity: rule.severity, title: rule.name };

  if (!rule.enabled) return { ...base, firing: false, evidence: "", skipped: "rule disabled" };

  switch (rule.kind) {
    case "metric": return evaluateMetric(rule, ctx, base);
    case "state": return evaluateState(rule, ctx, base);
    case "offline": return evaluateOffline(rule, ctx, base);
    case "firmware-behind": return evaluateFirmware(rule, ctx, base);
  }
}

type VerdictBase = Pick<Verdict, "ruleId" | "deviceId" | "severity" | "title">;

function evaluateMetric(
  rule: Extract<AlertRule, { kind: "metric" }>,
  ctx: EvaluateContext,
  base: VerdictBase,
): Verdict {
  const read = METRIC_ACCESSORS[rule.field];
  const { label, unit } = METRIC_LABELS[rule.field];

  const anyReadable = ctx.samples.some((s) => read(s) !== null);
  if (!anyReadable) {
    // The Tier B case: the metric is not in the payload at all. Silence is the
    // only correct output — firing here would flood the fleet with alerts about
    // data we never had.
    return {
      ...base,
      firing: false,
      evidence: "",
      skipped: `${rule.field} is not readable for this device — no alert can be evaluated.`,
      unreadable: true,
    };
  }

  const run = measureRun(ctx.samples, read, (v) => compare(v, rule.comparator, rule.threshold));

  if (run.readings < rule.minSamples) {
    return {
      ...base,
      firing: false,
      evidence: "",
      skipped: `only ${run.readings} qualifying reading(s), need ${rule.minSamples}`,
    };
  }
  if (run.maxGapSeconds > gapTolerance(rule.sustainedForSeconds)) {
    return {
      ...base,
      firing: false,
      evidence: "",
      skipped: `readings too sparse to prove continuity (largest gap ${Math.round(run.maxGapSeconds / 60)} min)`,
    };
  }
  if (run.spanSeconds < rule.sustainedForSeconds) {
    return {
      ...base,
      firing: false,
      evidence: "",
      skipped: `condition has held ${Math.round(run.spanSeconds / 60)} min, needs ${Math.round(rule.sustainedForSeconds / 60)} min`,
    };
  }

  const latest = run.values[0]!;
  const worst =
    rule.comparator === "gt" || rule.comparator === "gte"
      ? Math.max(...run.values)
      : Math.min(...run.values);
  const mean = run.values.reduce((a, b) => a + b, 0) / run.values.length;

  return {
    ...base,
    firing: true,
    evidence:
      `${label} has been ${COMPARATOR_WORDS[rule.comparator]} ${round(rule.threshold)}${unit} ` +
      `for ${Math.round(run.spanSeconds / 60)} minutes across ${run.readings} readings. ` +
      `Latest ${round(latest)}${unit}, mean ${round(mean)}${unit}, peak ${round(worst)}${unit}.`,
  };
}

function evaluateState(
  rule: Extract<AlertRule, { kind: "state" }>,
  ctx: EvaluateContext,
  base: VerdictBase,
): Verdict {
  const read = STATE_ACCESSORS[rule.field];
  const labels = STATE_LABELS[rule.field];

  if (!ctx.samples.some((s) => read(s) !== null)) {
    return {
      ...base,
      firing: false,
      evidence: "",
      skipped: `${rule.field} is not readable for this device`,
      unreadable: true,
    };
  }

  // A state reading from an offline device is the last thing we heard before it
  // went dark, not a description of the screen now. Videri's own alerting does
  // not make this distinction: it currently reports "showing logo" on nine
  // devices, seven of which have been offline for months — one since November
  // 2025. Sending a technician to fix content on a device with no power or
  // network is the most expensive kind of false positive.
  //
  // Only suppress when we positively know it is offline. An absent or
  // unparseable presence means we cannot tell, and guessing either way is worse
  // than judging on the state reading we do have.
  const newestPresence = [...ctx.samples]
    .sort(byNewest)
    .find((s) => s.presence !== null);
  if (newestPresence?.presence === "offline") {
    const staleFor = Math.round(
      (ctx.now.getTime() - newestPresence.observedAt.getTime()) / 60000,
    );
    return {
      ...base,
      firing: false,
      evidence: "",
      skipped:
        `device is offline, so its ${rule.field} reading is stale ` +
        `(last presence ${staleFor} min ago) — the actionable fault is the outage`,
      unreadable: true,
    };
  }

  const run = measureRun(ctx.samples, read, (v) => v === rule.equals);

  if (run.readings < rule.minSamples) {
    return {
      ...base, firing: false, evidence: "",
      skipped: `only ${run.readings} qualifying reading(s), need ${rule.minSamples}`,
    };
  }
  if (run.maxGapSeconds > gapTolerance(rule.sustainedForSeconds)) {
    return {
      ...base, firing: false, evidence: "",
      skipped: `readings too sparse (largest gap ${Math.round(run.maxGapSeconds / 60)} min)`,
    };
  }
  if (run.spanSeconds < rule.sustainedForSeconds) {
    return {
      ...base, firing: false, evidence: "",
      skipped: `state has held ${Math.round(run.spanSeconds / 60)} min, needs ${Math.round(rule.sustainedForSeconds / 60)} min`,
    };
  }

  const description = rule.equals ? labels.whenTrue : labels.whenFalse;
  const held =
    `continuously for ${Math.round(run.spanSeconds / 60)} minutes across ${run.readings} readings`;

  // The condition has held. For the black-screen claim specifically there may be
  // a second opinion on file from the panel itself, and it changes what we are
  // entitled to say. Keyed on the FIELD, not the rule id, because rule ids are
  // operator-editable while `is_black_screen`/`equals: true` is what actually
  // identifies "the platform claims this screen is black".
  if (rule.field === "is_black_screen" && rule.equals === true) {
    return applyScreenVerdict(ctx, base, run, held);
  }

  // A sustained "screen is off" is the fleet's largest single alert cohort, and
  // the one whose finding is most often over-read. Keyed on the FIELD, like the
  // black-screen branch above, because rule ids are operator-editable — and
  // because THIS rule's id (`screen-off-during-schedule`) promises a schedule
  // check that no alert rule anywhere in this codebase performs. The id is kept
  // as-is deliberately: 463 stored rows carry it and the incident model keys on
  // (site, rule_id), so renaming it is a data migration, not an edit. The limit
  // therefore has to be stated in the text an operator actually reads.
  if (rule.field === "is_screen_on" && rule.equals === false) {
    return { ...base, firing: true, evidence: `${description} ${held}. ${SCREEN_OFF_LIMIT}` };
  }

  return { ...base, firing: true, evidence: `${description} ${held}.` };
}

/**
 * The caveat carried by every "screen powered off" alert.
 *
 * Deliberately placed immediately after the measurement, not at the end: the
 * compact alert list truncates evidence, so a limit appended last is a limit the
 * operator never sees.
 *
 * It says the same thing docs/22 Ask 11 asks Videri for, because it is the same
 * gap: `is_screen_on` is panel power, `publisher` is content, and whether a panel
 * is SUPPOSED to be powered on right now lives in a power schedule for which this
 * platform exposes no verified read (docs/14 §D5). Gating this rule on the content
 * schedule instead would read as a fix while encoding the wrong dimension — on this
 * tenant it would change nothing at all, since all 891 scheduled items carry
 * `frequency: null` and 883 of them end more than ten years out.
 */
export const SCREEN_OFF_LIMIT =
  "CANNOT distinguish dark-by-design from dark-and-broken. This rule reads panel power " +
  "(is_screen_on) and consults NO schedule — despite its rule id, no schedule is checked " +
  "here. Whether this panel is supposed to be powered on right now is governed by a power " +
  "schedule, and this platform exposes no verified read of one (docs/14 §D5, docs/22 " +
  "Ask 11); the content schedule says what would play if the panel were on, not whether it " +
  "should be on, so it is not a substitute. Established: the panel is off. Not established: " +
  "whether it should be on.";

/**
 * Reconcile a sustained black-screen claim with the panel's own answer.
 *
 * Three outcomes, and the one thing none of them do is go quiet:
 *
 *   refutes  → fires at `info` with `refuted: true`, title changed, evidence
 *              naming both observations. NOT a critical, because we can disprove
 *              it; NOT silence, because a platform flag contradicting its own
 *              hardware is a real data-quality fault someone should see.
 *   confirms → fires the critical, and says the panel confirmed it. Same
 *              severity as before, strictly higher confidence.
 *   unverified → fires the critical exactly as it did before this code existed,
 *              and says so. Unverified is the honest default, not a downgrade.
 */
function applyScreenVerdict(
  ctx: EvaluateContext,
  base: VerdictBase,
  run: RunSummary,
  held: string,
): Verdict {
  const { standing, why } = screenVerdictStanding(
    ctx.screenVerdict,
    run.oldestAt,
    ctx.now,
  );
  const claimAt = run.newestAt?.toISOString() ?? "an unrecorded time";
  const verdictAt = ctx.screenVerdict?.observedAt;

  if (standing === "refutes") {
    // The lag between the two observations is the whole point: an operator has to
    // see that the panel spoke AFTER the platform did.
    const lag = verdictAt && run.newestAt
      ? formatDuration((verdictAt.getTime() - run.newestAt.getTime()) / 1000)
      : null;
    return {
      ...base,
      // `medium`, not `info`: a refuted claim is a platform data-quality fault and
      // should reach triage rather than sink to the bottom of the list. It can
      // still never outrank a real outage. (`info` IS valid on the alert scale —
      // critical|high|medium|info — this is a deliberate choice, not a fix.)
      severity: "medium",
      title: "Black-screen claim refuted by the device",
      firing: true,
      refuted: true,
      evidence:
        `The platform reported is_black_screen=true ${held} (latest ${claimAt}); the screen ` +
        `itself answered not-black at ${verdictAt!.toISOString()}` +
        (lag ? `, ${lag} later` : "") +
        ` — claim refuted, so no critical was raised. The panel's own answer outranks the ` +
        `platform flag, which has been observed asserting black on a device demonstrably ` +
        `showing content. The disagreement is the finding: treat this as a platform ` +
        `data-quality fault, not a dark screen.`,
    };
  }

  if (standing === "confirms") {
    return {
      ...base,
      firing: true,
      evidence:
        `Screen is black ${held} (latest ${claimAt}), and the screen itself answered ` +
        `is_blackscreen=true at ${verdictAt!.toISOString()} — the device confirms the ` +
        `platform's claim. Higher confidence than an unverified black-screen alert: this ` +
        `is the panel's own report, not just the platform flag.`,
    };
  }

  return {
    ...base,
    firing: true,
    evidence:
      `Screen is black ${held} (latest ${claimAt}). UNVERIFIED by the device — ${why}. ` +
      `The platform flag alone has been wrong on this fleet, so this may be a dark screen ` +
      `or may be a bad flag; nothing here settles it.`,
  };
}

function evaluateOffline(
  rule: Extract<AlertRule, { kind: "offline" }>,
  ctx: EvaluateContext,
  base: VerdictBase,
): Verdict {
  const ordered = [...ctx.samples].sort(byNewest);
  const withPresence = ordered.filter((s) => s.presence !== null);
  const latest = withPresence[0];

  // No presence reading at all — fall back to the registry's last_online_time,
  // which Videri maintains independently of our polling. Without this a device
  // we have never successfully polled would never alert, which is precisely
  // backwards.
  if (!latest) {
    const lastOnline = ctx.device.lastOnlineTime;
    if (!lastOnline) {
      return {
        ...base, firing: false, evidence: "",
        skipped: "no presence readings and no last_online_time — cannot judge",
        unreadable: true,
      };
    }
    const secondsDown = (ctx.now.getTime() - lastOnline.getTime()) / 1000;
    return secondsDown >= rule.forSeconds
      ? {
          ...base,
          firing: true,
          evidence:
            `No presence reading from this device. Videri last recorded it online at ` +
            `${lastOnline.toISOString()}, ${formatDuration(secondsDown)} ago.`,
        }
      : { ...base, firing: false, evidence: "", skipped: `last seen ${formatDuration(secondsDown)} ago` };
  }

  if (latest.presence !== "offline") {
    return { ...base, firing: false, evidence: "", skipped: "device is currently present" };
  }

  // Walk back through the consecutive offline run to find two DIFFERENT things,
  // which an earlier version of this function conflated:
  //
  //   lastPresent  — the newest moment we have positive evidence it was UP.
  //   oldestOffline — the oldest reading in the current offline run.
  //
  // Those are not interchangeable. If every reading we hold is offline there is
  // no lastPresent, and the old code used oldestOffline in its place while
  // labelling it "Last present at" — asserting the device was up at a moment we
  // had already recorded it down. It also took the EARLIER of that and the
  // registry timestamp, which inflated the outage rather than dating it.
  let lastPresent: Date | null = null;
  let oldestOffline = latest.observedAt;
  for (const sample of withPresence) {
    if (sample.presence === "offline") {
      oldestOffline = sample.observedAt;
    } else {
      lastPresent = sample.observedAt;
      break;
    }
  }

  // Videri maintains last_online_time independently of our polling, so it can
  // know about a presence more recent than anything in our window.
  const registryLastOnline = ctx.device.lastOnlineTime;
  if (registryLastOnline && (!lastPresent || registryLastOnline > lastPresent)) {
    lastPresent = registryLastOnline;
  }

  // With a known lastPresent the outage is dated. Without one, all we can claim
  // is a LOWER BOUND — it has been down at least as long as our oldest offline
  // reading — and the evidence has to say that rather than overstate it.
  const since = lastPresent ?? oldestOffline;
  const secondsDown = (ctx.now.getTime() - since.getTime()) / 1000;
  if (secondsDown < rule.forSeconds) {
    return {
      ...base, firing: false, evidence: "",
      skipped: `offline ${formatDuration(secondsDown)}, needs ${formatDuration(rule.forSeconds)}`,
    };
  }

  return {
    ...base,
    firing: true,
    evidence: lastPresent
      ? `Offline for ${formatDuration(secondsDown)}. Last present at ${lastPresent.toISOString()}.`
      : `Offline for at least ${formatDuration(secondsDown)}. Every reading we hold is ` +
        `offline, back to ${oldestOffline.toISOString()}, and the platform reports no ` +
        `last-online time for this device — so the outage may be considerably longer.`,
  };
}

/**
 * Firmware currency, evaluated per component.
 *
 * The live API reports `core_services_versions` as a map of up to 16
 * `com.videri.*` packages, each with its own {current, latest}. That is richer
 * than a single firmware version, and it is one of the genuinely good surfaces
 * this API offers — so the rule names the components that are behind rather than
 * collapsing everything to one number.
 *
 * WHAT THIS RULE MAY AND MAY NOT CLAIM. `current !== latest` establishes that two
 * strings differ. It does NOT establish that an upgrade exists for the device in
 * front of you: on this fleet three of the four components carry a single `latest`
 * value shared by every device class, from Videri Canvas to TCL panel to AllSee
 * shelf label (docs/14 §B15). So each behind-component is checked against what the
 * fleet actually runs — see `firmwareTargetStanding`. Corroborated targets keep the
 * strong wording; uncorroborated ones get the weaker, true one. Nothing is
 * suppressed and the severity does not move: `info` was already the honest rank for
 * a version-string difference, and being less sure than we were is not a reason to
 * raise it.
 */
function evaluateFirmware(
  rule: Extract<AlertRule, { kind: "firmware-behind" }>,
  ctx: EvaluateContext,
  base: VerdictBase,
): Verdict {
  const components = ctx.device.components ?? {};
  const behind = Object.entries(components)
    .filter(([, v]) => v.current && v.latest && v.current !== v.latest)
    .map(([component, v]) => ({ component, current: v.current!, latest: v.latest! }));

  if (Object.keys(components).length === 0) {
    return { ...base, firing: false, evidence: "", skipped: "no component versions reported", unreadable: true };
  }
  if (behind.length === 0) {
    return { ...base, firing: false, evidence: "", skipped: "all components current" };
  }

  const inScope =
    rule.onlyVersions.length === 0
      ? behind
      : behind.filter((b) => rule.onlyVersions.includes(b.current));
  if (inScope.length === 0) {
    return { ...base, firing: false, evidence: "", skipped: "no in-scope component is behind" };
  }

  const detail = inScope
    .slice(0, 4)
    .map((b) => `${b.component} ${b.current} → ${b.latest}`)
    .join("; ");
  const more = inScope.length > 4 ? ` (+${inScope.length - 4} more)` : "";

  // Same firing set as before this split existed — the standings change only what
  // the alert SAYS. An honest claim and a suppressed alert are not the same thing.
  const standings = inScope.map((b) => ({
    ...b,
    standing: firmwareTargetStanding(
      ctx.firmwareTargets,
      ctx.device.deviceClass,
      b.component,
      b.latest,
    ),
  }));
  const corroborated = standings.filter((s) => s.standing.corroborated);
  const uncorroborated = standings.filter((s) => !s.standing.corroborated);

  const cite = (items: typeof standings) =>
    items
      .slice(0, 3)
      .map((s) => `${s.component} → ${s.standing.why}`)
      .join("; ") + (items.length > 3 ? `; +${items.length - 3} more` : "");

  const claims: string[] = [];
  if (corroborated.length > 0) {
    claims.push(
      (uncorroborated.length === 0
        ? "An upgrade exists for this model — every target above is corroborated by the fleet: "
        : "An upgrade exists for: ") + `${cite(corroborated)}.`,
    );
  }
  if (uncorroborated.length > 0) {
    claims.push(
      (corroborated.length === 0
        ? "We CANNOT say an upgrade exists for this model: "
        : "But NOT for: ") +
        `${cite(uncorroborated)}. For those the version strings differ, and that is all ` +
        `this establishes — do not schedule an upgrade on it without confirming the build ` +
        `for this model.`,
    );
  }

  return {
    ...base,
    firing: true,
    evidence:
      `${inScope.length} of ${Object.keys(components).length} components behind: ` +
      `${detail}${more}. ${claims.join(" ")}`,
  };
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} seconds`;
  const minutes = Math.round(s / 60);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = s / 3600;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)} hours`;
  return `${Math.round(hours / 24)} days`;
}

/** Evaluate every rule for one device. */
export function evaluateDevice(rules: AlertRule[], ctx: EvaluateContext): Verdict[] {
  return rules.map((rule) => evaluateRule(rule, ctx));
}
