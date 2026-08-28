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
  return { readings, spanSeconds, maxGapSeconds, values };
}

/** A run stitched across a gap this large is not evidence of continuity. */
const gapTolerance = (sustainedForSeconds: number) =>
  Math.max(600, sustainedForSeconds * 0.5);

export interface EvaluateContext {
  device: DeviceRow;
  samples: SampleRow[];
  now: Date;
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
  return {
    ...base,
    firing: true,
    evidence:
      `${description} continuously for ${Math.round(run.spanSeconds / 60)} minutes ` +
      `across ${run.readings} readings.`,
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

  return {
    ...base,
    firing: true,
    evidence: `${inScope.length} of ${Object.keys(components).length} components behind: ${detail}${more}.`,
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
