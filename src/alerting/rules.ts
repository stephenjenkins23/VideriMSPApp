/**
 * Alert rule definitions.
 *
 * This is the part of the product the platform does not have. Videri's
 * `alerting` service knows exactly two alert types (`offline`, `showingLogo`),
 * carries no severity field, and its configuration is an on/off switch plus an
 * email address. Severity, thresholds, sustain windows, flap suppression and
 * lifecycle are all ours — see docs/02-VFI-GAP-ANALYSIS.md §3.
 *
 * The four rule kinds are a discriminated union rather than one flat shape,
 * because they need genuinely different fields. A single table with mostly-null
 * columns would make invalid combinations representable, and rules are exactly
 * the place where an invalid combination fires at 3am.
 */

import type { Severity } from "../domain/types.js";

/** Numeric columns a metric rule may read. */
export type MetricField =
  | "cpu_percent"
  | "ram_percent"
  | "temperature_c"
  | "wifi_signal_dbm"
  | "packet_loss_percent"
  | "jitter_ms"
  | "ntp_sync_percent"
  | "storage_percent";
// ping_quality and playback_quality are deliberately NOT here: the live API
// returns them as strings ("no", "unavailable") with an undocumented vocabulary,
// so no numeric threshold can be defined against them (docs/05 §4).

/** Boolean columns a state rule may read. */
export type StateField = "is_black_screen" | "showing_logo" | "is_screen_on" | "downloading";

export type Comparator = "gt" | "gte" | "lt" | "lte";

interface RuleBase {
  id: string;
  name: string;
  enabled: boolean;
  severity: Severity;
  /**
   * Once the condition clears, wait this long before resolving. Flapping alerts
   * are the single most common reason operators mute a system entirely, so the
   * default is deliberately non-zero.
   */
  clearForSeconds: number;
  /**
   * Rule ids this rule outranks. When this rule fires, any open alert from a
   * superseded rule on the same device is resolved.
   *
   * Escalation without duplication: a device down five hours satisfies both
   * `offline-30m` and `offline-4h`, but an operator should see one critical
   * alert, not two alerts for one dark screen.
   */
  supersedes?: string[];
  /**
   * Which list this rule's alerts belong in. Default `incident`.
   *
   * `dormant` is the same idea as `supersedes` taken one step further. Supersedes
   * dedupes *within* a device: one cause, one alert. Dormancy dedupes the device
   * itself out of today's work queue: an asset nobody has been able to reach for
   * a month is one fact about the estate, not a stream of incidents.
   *
   * It is a CLASSIFICATION, not a filter, and the distinction matters:
   *   - the alert still opens, still counts, still carries its evidence;
   *   - it is counted in its own chip so the number stays on screen;
   *   - it is queryable in full by rule id.
   * Nothing is dropped. It is moved, once, with the reason attached — see
   * hygiene.ts, which is the only place that acts on this field.
   */
  alertClass?: AlertClass;
}

/**
 * Whether an alert is something to work today or a fact about the estate.
 *
 * Deliberately NOT a severity. Severity answers "how bad", class answers "is
 * this mine this morning". Conflating them is what produced 110 medium-severity
 * rows for screens that have been dark since last year: individually correctly
 * ranked, collectively a wall the real critical hides behind.
 */
export type AlertClass = "incident" | "dormant";

/** Threshold on a numeric metric, sustained over a window. */
export interface MetricRule extends RuleBase {
  kind: "metric";
  field: MetricField;
  comparator: Comparator;
  threshold: number;
  /** The condition must hold across this window before the alert opens. */
  sustainedForSeconds: number;
  /**
   * Minimum readings inside the window before we are willing to judge. Guards
   * against a single spike, and against firing on one sample after an outage.
   */
  minSamples: number;
}

/** A boolean device state holding true (or false) for a period. */
export interface StateRule extends RuleBase {
  kind: "state";
  field: StateField;
  equals: boolean;
  sustainedForSeconds: number;
  minSamples: number;
}

/**
 * Absence of presence for a duration.
 *
 * Separate from `state` because it is the one condition where *missing data* is
 * itself the signal, so it must be judged against the last known presence
 * timestamp rather than against a window of readings that may not exist.
 */
export interface OfflineRule extends RuleBase {
  kind: "offline";
  forSeconds: number;
}

/** Device attribute comparison — no time component. */
export interface FirmwareRule extends RuleBase {
  kind: "firmware-behind";
  /** Only fire when the installed version is one of these. Empty = any. */
  onlyVersions: string[];
}

export type AlertRule = MetricRule | StateRule | OfflineRule | FirmwareRule;

// ─────────────────────────────────────────────────────────────────────────────
// Default rule set
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rules are split by what they depend on, because that determines whether they
 * work *today*:
 *
 *   TIER A — documented, typed fields. These work the moment the poller runs.
 *   TIER B — undocumented telemetry inside `super_props`. These are configured
 *            but will simply never fire until we know the real payload keys. That
 *            is the correct behaviour: a rule with no readable input must stay
 *            silent, never fire on a default.
 *
 * A deployment that only ever gets Tier A is still a working alerting product —
 * arguably a better one, since "is content actually on screen" matters more to
 * the business than a CPU percentage.
 */
export const DEFAULT_RULES: AlertRule[] = [
  // ── Tier A: dependable today ──
  {
    kind: "offline",
    id: "offline-30m",
    name: "Device offline for 30 minutes",
    enabled: true,
    severity: "high",
    forSeconds: 30 * 60,
    clearForSeconds: 120,
  },
  {
    kind: "offline",
    id: "offline-4h",
    name: "Device offline for 4 hours",
    enabled: true,
    severity: "critical",
    forSeconds: 4 * 60 * 60,
    clearForSeconds: 300,
    // Content-state alerts are outranked too: once a device is offline, any
    // screen-state reading is stale and the outage is the real finding.
    supersedes: ["offline-30m", "showing-logo", "black-screen", "screen-off-during-schedule"],
    // Outranked by offline-30d and offline-6mo, both declared below.
  },
  {
    kind: "offline",
    id: "offline-30d",
    name: "Device dark for over 30 days",
    enabled: true,
    // Deliberately NOT critical. A screen dark for months is an inventory or
    // decommissioning question, not an outage to wake someone for. Firing
    // "offline for 4 hours" at critical on a device dark for 916 days buried 126
    // stale alerts on top of the handful of real new outages — the first real
    // brief flagged exactly this.
    severity: "medium",
    forSeconds: 30 * 24 * 60 * 60,
    clearForSeconds: 3600,
    supersedes: ["offline-30m", "offline-4h", "showing-logo", "black-screen", "screen-off-during-schedule"],
    // The de-escalation above was only half the fix. Medium severity still put
    // 104 rows in the list an operator reads every morning, and a list nobody
    // finishes reading is a list where the one real critical is invisible. The
    // class moves the cohort into its own counted band; severity keeps ranking
    // inside it.
    alertClass: "dormant",
  },
  {
    kind: "offline",
    id: "offline-6mo",
    name: "Device dark for over 6 months",
    enabled: true,
    // Lower again, on purpose. 78 of this fleet's 249 canvases have not been
    // reachable for over half a year; several since 2023. Nothing about that is
    // an incident — no engineer will fix it, and no severity above `info` is
    // honest about the chance that it will change today. It is an asset register
    // question, and the rollup in hygiene.ts is where it gets asked loudly.
    severity: "info",
    forSeconds: 180 * 24 * 60 * 60,
    clearForSeconds: 3600,
    // Extends the existing escalation chain by one link at the far end, so a
    // device dark for years still produces exactly ONE offline alert.
    supersedes: [
      "offline-30m", "offline-4h", "offline-30d",
      "showing-logo", "black-screen", "screen-off-during-schedule",
    ],
    alertClass: "dormant",
  },
  {
    kind: "state",
    id: "black-screen",
    name: "Screen is black",
    enabled: true,
    severity: "critical",
    field: "is_black_screen",
    equals: true,
    // A powered screen showing nothing is the most direct form of revenue loss
    // in this product, so the window is short.
    sustainedForSeconds: 5 * 60,
    minSamples: 3,
    clearForSeconds: 120,
  },
  {
    kind: "state",
    id: "showing-logo",
    name: "Showing logo instead of content",
    enabled: true,
    severity: "high",
    field: "showing_logo",
    equals: true,
    sustainedForSeconds: 15 * 60,
    minSamples: 5,
    clearForSeconds: 300,
  },
  {
    kind: "state",
    id: "screen-off-during-schedule",
    name: "Screen powered off",
    enabled: true,
    severity: "medium",
    field: "is_screen_on",
    equals: false,
    sustainedForSeconds: 30 * 60,
    minSamples: 5,
    clearForSeconds: 300,
  },
  // RETIRED: playback_quality is a string with an unknown vocabulary on the
  // live API, so "below 0.5" was meaningless. Reinstate as a `state` rule once
  // the possible values are documented.
  {
    kind: "firmware-behind",
    id: "firmware-behind",
    name: "Firmware behind latest",
    enabled: true,
    severity: "info",
    onlyVersions: [],
    clearForSeconds: 0,
  },

  // ── Tier B: DISABLED 2026-08-25 ──
  //
  // Verified against the live API: `super_props` carries a software/hardware
  // manifest, not runtime telemetry. There is no CPU utilisation, memory,
  // temperature, signal strength, packet loss, jitter, storage or NTP value
  // anywhere in the metrics payload — `cpu_cores: 8` is a static core count
  // (docs/05-LIVE-API-FINDINGS.md §2).
  //
  // These are kept, disabled, rather than deleted: the developer portal implies
  // the values are reachable via Demo Commands (per-device, synchronous, ~10s
  // timeout). If a command-based collector is built, re-enable them and point
  // them at it. Left enabled they would simply never fire, which is the same
  // outcome with more noise in the inert-rule report.
  {
    kind: "metric",
    id: "cpu-high",
    name: "CPU sustained above 85%",
    enabled: false,
    severity: "medium",
    field: "cpu_percent",
    comparator: "gt",
    threshold: 85,
    sustainedForSeconds: 15 * 60,
    minSamples: 3,
    clearForSeconds: 300,
  },
  {
    kind: "metric",
    id: "ram-high",
    name: "Memory sustained above 90%",
    enabled: false,
    severity: "medium",
    field: "ram_percent",
    comparator: "gt",
    threshold: 90,
    sustainedForSeconds: 15 * 60,
    minSamples: 3,
    clearForSeconds: 300,
  },
  {
    kind: "metric",
    id: "temp-high",
    name: "Temperature above 70°C",
    enabled: false,
    severity: "high",
    field: "temperature_c",
    comparator: "gt",
    threshold: 70,
    sustainedForSeconds: 10 * 60,
    minSamples: 3,
    clearForSeconds: 300,
  },
  {
    kind: "metric",
    id: "wifi-weak",
    name: "WiFi signal below −75 dBm",
    enabled: false,
    severity: "medium",
    field: "wifi_signal_dbm",
    comparator: "lt",
    threshold: -75,
    sustainedForSeconds: 30 * 60,
    minSamples: 5,
    clearForSeconds: 600,
  },
  {
    kind: "metric",
    id: "storage-full",
    name: "Storage above 85%",
    enabled: false,
    severity: "high",
    field: "storage_percent",
    comparator: "gt",
    threshold: 85,
    sustainedForSeconds: 60 * 60,
    minSamples: 3,
    clearForSeconds: 1800,
  },
  {
    kind: "metric",
    id: "ntp-drift",
    name: "NTP sync rate below 80%",
    enabled: false,
    severity: "medium",
    field: "ntp_sync_percent",
    comparator: "lt",
    threshold: 80,
    sustainedForSeconds: 60 * 60,
    minSamples: 5,
    clearForSeconds: 1800,
  },
];

/** Fields whose values come from the undocumented telemetry payload. */
export const TIER_B_FIELDS: ReadonlySet<MetricField> = new Set<MetricField>([
  "cpu_percent",
  "ram_percent",
  "temperature_c",
  "wifi_signal_dbm",
  "packet_loss_percent",
  "jitter_ms",
  "ntp_sync_percent",
  "storage_percent",
]);

export const isTierB = (rule: AlertRule): boolean =>
  rule.kind === "metric" && TIER_B_FIELDS.has(rule.field);

/** A rule with no explicit class is an incident — the safe default. */
export const alertClassOf = (rule: AlertRule): AlertClass => rule.alertClass ?? "incident";

/**
 * The rule ids whose alerts are dormant-class.
 *
 * Read from the rule set rather than hardcoded anywhere downstream, so an
 * operator who disables `offline-6mo` or edits its threshold through the API
 * changes what "dormant" means in the same move. A second hardcoded list would
 * be a second definition of dormancy, and the two would disagree the first time
 * someone tuned a rule.
 */
export function dormantRuleIds(rules: readonly AlertRule[]): Set<string> {
  return new Set(rules.filter((r) => alertClassOf(r) === "dormant").map((r) => r.id));
}

/**
 * The shortest outage any dormant-class rule requires, in seconds — i.e. how
 * long a device must be dark before we stop calling it an incident.
 *
 * `null` when no rule is dormant-classed, which is the honest answer: with no
 * such rule there is no dormancy boundary, and hygiene must classify everything
 * as an incident rather than invent a threshold.
 */
export function dormantAfterSeconds(rules: readonly AlertRule[]): number | null {
  const windows = rules
    .filter((r) => alertClassOf(r) === "dormant" && r.kind === "offline")
    .map((r) => (r as OfflineRule).forSeconds);
  return windows.length === 0 ? null : Math.min(...windows);
}

/** How far back the engine must read samples to satisfy every rule. */
export function requiredWindowSeconds(rules: AlertRule[]): number {
  const windows = rules.map((r) => {
    if (r.kind === "metric" || r.kind === "state") return r.sustainedForSeconds;
    if (r.kind === "offline") return r.forSeconds;
    return 0;
  });
  // A margin so a sustain window is never judged on a truncated view.
  return Math.max(3600, ...windows) * 1.5;
}

export function validateRule(rule: AlertRule): string[] {
  const problems: string[] = [];
  if (!rule.id.trim()) problems.push("id is required");
  if (!rule.name.trim()) problems.push("name is required");
  if (rule.clearForSeconds < 0) problems.push("clearForSeconds must be >= 0");

  if (rule.kind === "metric" || rule.kind === "state") {
    if (rule.sustainedForSeconds < 0) problems.push("sustainedForSeconds must be >= 0");
    if (rule.minSamples < 1) problems.push("minSamples must be >= 1");
  }
  if (rule.kind === "offline" && rule.forSeconds <= 0) {
    problems.push("forSeconds must be > 0");
  }
  if (rule.kind === "metric" && !Number.isFinite(rule.threshold)) {
    problems.push("threshold must be a finite number");
  }
  // Dormancy is a statement about sustained ABSENCE, so only an offline rule can
  // make it. A metric or state rule marked dormant would quietly move a live
  // device's real fault out of the incident list, which is the one failure mode
  // this whole mechanism exists to avoid.
  if (rule.alertClass === "dormant" && rule.kind !== "offline") {
    problems.push('alertClass "dormant" is only valid on an offline rule');
  }
  return problems;
}
