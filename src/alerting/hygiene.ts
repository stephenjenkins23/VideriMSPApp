/**
 * Alert hygiene — turning an open-alert table into a list an operator finishes
 * reading.
 *
 * THE PROBLEM THIS SOLVES
 * 305 alerts were open across 182 canvases. 104 of them said "dark for over 30
 * days" and 78 of those devices had not answered in over six months; a further
 * 96 said "firmware behind" about those same unreachable devices. Two thirds of
 * the list was therefore un-actionable by construction: no engineer will fix a
 * screen that has been dark since 2023, and nobody can update firmware on a
 * device that cannot be reached. An operator who scrolls past 200 such rows
 * stops reading the list, and the single genuine critical stops being seen.
 *
 * WHAT THIS IS NOT
 * It is not a filter, and it does not delete, resolve, mute or hide anything.
 * Every alert stays open, keeps its evidence, and stays queryable. What changes
 * is which BAND it is counted in, and there is a chip for the dormant band that
 * is always on screen with its full count. The rule we learned the hard way:
 * never silently suppress — de-escalate or roll up, and say so.
 *
 * WHY IT LIVES NEXT TO `supersedes`
 * `supersedes` (rules.ts) already dedupes within a device: one cause, one alert.
 * Dormancy is the same idea one level up — the cause is "this asset is
 * abandoned", so the whole device rolls up into one estate finding rather than
 * contributing a row per rule. Classification is driven entirely by
 * `alertClass` on the rules, so tuning a rule tunes dormancy with it.
 *
 * Pure. The only I/O is `loadAlertHygiene` at the bottom, which reads three
 * aggregates and hands them to the pure classifier.
 */

import type { Severity } from "../domain/types.js";
import type { Repository } from "../db/repository.js";
import { dormantRuleIds, type AlertRule } from "./rules.js";
import { loadRules } from "./engine.js";
import { formatDuration } from "./evaluate.js";

/** One open alert, reduced to what classification needs. */
export interface OpenAlertFact {
  id: string;
  deviceId: string;
  ruleId: string;
  severity: Severity;
  openedAt: Date;
}

/** How long a device has been unreachable, straight from the registry. */
export interface DeviceDarkFact {
  deviceId: string;
  /** `null` means Videri has never recorded this device online at all. */
  lastOnlineTime: Date | null;
}

export const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "info"];

export type SeverityCounts = Record<Severity, number>;

const zeroCounts = (): SeverityCounts => ({ critical: 0, high: 0, medium: 0, info: 0 });

/**
 * Severities that a dormant device can never absorb.
 *
 * Device-level absorption is safe for the ranks that only ever restate the
 * outage (a stale "firmware behind" on an unreachable panel). It is NOT safe as
 * a blanket rule: if some future rule manages to fire CRITICAL on a device we
 * believe has been dark for six months, that is news — it means the device
 * spoke — and burying it would be exactly the silent suppression this module
 * exists to avoid. So high and critical alerts stay in the incident list even on
 * a dormant device, and the notes say when that happened.
 */
const NEVER_ABSORBED: ReadonlySet<Severity> = new Set<Severity>(["critical", "high"]);

/** One counted band of the alert list. */
export interface AlertBand {
  total: number;
  devices: number;
  bySeverity: SeverityCounts;
}

export interface RuleBreakdown {
  ruleId: string;
  severity: Severity;
  count: number;
  /** True when this rule is itself dormant-classed, false when it was absorbed
   *  only because the device it sits on is dormant. */
  dormantRule: boolean;
}

/** Dark-duration buckets, measured from the registry rather than from alerts. */
export interface DarknessBucket {
  label: string;
  minDays: number | null;
  maxDays: number | null;
  devices: number;
}

/**
 * The single row that stands in for the whole dormant cohort.
 *
 * Its `severity` grades the ESTATE FINDING — "44% of the canvases we manage are
 * dark" is a serious fact even though no one row inside it is urgent. It is
 * never added to a severity chip; see `chips` and `chipsSumToTotal`.
 */
export interface DormancyRollup {
  kind: "dormancy-rollup";
  id: "dormant-estate";
  severity: Severity;
  title: string;
  evidence: string;
  /** Devices in the cohort. */
  deviceCount: number;
  /** Open alerts rolled up — the number that left the incident list. */
  alertCount: number;
  /** Share of the active estate, or null when the estate size is unknown. */
  estateShare: number | null;
  oldestOpenedAt: string | null;
  longestDarkSeconds: number | null;
  byRule: RuleBreakdown[];
  darkness: DarknessBucket[];
  /** Devices Videri has never recorded online at all, so no outage can be dated. */
  neverSeenDevices: number | null;
  /** Exactly how to re-query every alert counted here. Nothing is unreachable. */
  drilldown: { state: "open"; deviceIds: string[] };
}

export type ChipKey = Severity | "dormant";

export interface Chip {
  key: ChipKey;
  label: string;
  count: number;
  /** Whether this chip counts alerts in the default (incident) list. */
  inDefaultList: boolean;
}

export interface AlertHygiene {
  /**
   * Every open alert on an ACTIVE device, incident and dormant. The number
   * nothing in this view may contradict.
   */
  totalOpen: number;
  /**
   * Open alerts excluded because their device is retired. `totalOpen` plus this
   * equals a raw `SELECT count(*) FROM alerts WHERE resolved_at IS NULL`, which
   * is what makes the two reconcilable. Null when the caller did not supply it.
   */
  excludedRetiredAlerts: number | null;
  incidents: AlertBand;
  dormant: AlertBand & {
    byRule: RuleBreakdown[];
    oldestOpenedAt: string | null;
    deviceIds: string[];
    /**
     * The ALERT ids in this band — the authoritative classification.
     *
     * `deviceIds` is not sufficient to reproduce the band, and a client that
     * tried would get it wrong: a critical or high alert stays in the INCIDENT
     * list even when its device is dormant (see NEVER_ABSORBED), so the dormant
     * device set is deliberately a superset of the dormant alert set. A UI
     * filtering on devices swept those held-back criticals into the dormant band
     * and defeated the safety valve. Publishing alert ids means the client never
     * has to know the rule, so the rule cannot drift out from under it.
     */
    alertIds: string[];
    /**
     * Alerts on a dormant device that were KEPT in the incident list, because
     * their severity is never absorbed. Exposed so the decision is auditable
     * rather than merely described in a note.
     */
    heldBackAlertIds: string[];
  };
  rollup: DormancyRollup | null;
  /**
   * Header chips. The four severity chips count INCIDENTS only; the dormant chip
   * carries the rest. They sum to `totalOpen` by construction — see
   * `chipsSumToTotal`, which is asserted in the tests.
   */
  chips: Chip[];
  /** Plain-language statements of what was moved and why. Always populated. */
  notes: string[];
}

export interface ClassifyOptions {
  now: Date;
  /** deviceId → last_online_time, for the dark-duration buckets. */
  darkness?: readonly DeviceDarkFact[];
  /** Active (non-retired) devices, for the estate share. Null keeps it honest. */
  activeDeviceCount?: number | null;
  /** Active devices Videri has never recorded online. */
  neverSeenDeviceCount?: number | null;
  /**
   * Open alerts on RETIRED devices, which this view deliberately excludes.
   * Passed through so the difference between this total and a raw count of the
   * `alerts` table is explainable rather than mysterious.
   */
  retiredAlertCount?: number | null;
}

const DAY = 86_400;

/** Buckets chosen to match how the estate actually splits, not round numbers. */
const BUCKETS: ReadonlyArray<{ label: string; minDays: number | null; maxDays: number | null }> = [
  { label: "30–90 days", minDays: 30, maxDays: 90 },
  { label: "90–180 days", minDays: 90, maxDays: 180 },
  { label: "6–12 months", minDays: 180, maxDays: 365 },
  { label: "over a year", minDays: 365, maxDays: null },
  { label: "never seen online", minDays: null, maxDays: null },
];

/**
 * Split the open alerts into the incident list and the dormant cohort.
 *
 * Two passes, deliberately: the first decides which DEVICES are dormant (a
 * device is dormant when a dormant-classed rule is open on it), the second
 * assigns every alert. A device-level decision is what lets a stale "firmware
 * behind" on an unreachable panel roll up with the outage that explains it,
 * instead of surviving as an orphan row about a screen nobody can touch.
 */
export function classifyOpenAlerts(
  alerts: readonly OpenAlertFact[],
  rules: readonly AlertRule[],
  {
    now,
    darkness = [],
    activeDeviceCount = null,
    neverSeenDeviceCount = null,
    retiredAlertCount = null,
  }: ClassifyOptions,
): AlertHygiene {
  const dormantRules = dormantRuleIds(rules);
  const dormantDevices = new Set<string>();
  for (const alert of alerts) {
    if (dormantRules.has(alert.ruleId)) dormantDevices.add(alert.deviceId);
  }

  const incidentAlerts: OpenAlertFact[] = [];
  const dormantAlerts: OpenAlertFact[] = [];
  /** Alerts kept in the incident list despite sitting on a dormant device. */
  const heldBack: OpenAlertFact[] = [];

  for (const alert of alerts) {
    const ruleIsDormant = dormantRules.has(alert.ruleId);
    const deviceIsDormant = dormantDevices.has(alert.deviceId);
    if (ruleIsDormant) {
      dormantAlerts.push(alert);
    } else if (deviceIsDormant && !NEVER_ABSORBED.has(alert.severity)) {
      dormantAlerts.push(alert);
    } else {
      incidentAlerts.push(alert);
      if (deviceIsDormant) heldBack.push(alert);
    }
  }

  const band = (rows: readonly OpenAlertFact[]): AlertBand => {
    const bySeverity = zeroCounts();
    const devices = new Set<string>();
    for (const row of rows) {
      // An unrecognised severity must not vanish from the chips — that is how a
      // sum invariant breaks silently. Count it as `info` and let the total
      // stay true rather than dropping the row.
      const key = (SEVERITY_ORDER as readonly string[]).includes(row.severity) ? row.severity : "info";
      bySeverity[key as Severity] += 1;
      devices.add(row.deviceId);
    }
    return { total: rows.length, devices: devices.size, bySeverity };
  };

  const incidents = band(incidentAlerts);
  const dormantBand = band(dormantAlerts);

  const byRule = breakdown(dormantAlerts, dormantRules);
  const oldestOpenedAt = dormantAlerts.reduce<Date | null>(
    (oldest, a) => (oldest === null || a.openedAt < oldest ? a.openedAt : oldest),
    null,
  );
  const deviceIds = [...dormantDevices].sort();

  const darkByDevice = new Map(darkness.map((d) => [d.deviceId, d.lastOnlineTime]));
  const buckets = bucketDarkness(deviceIds, darkByDevice, now);
  const longestDarkSeconds = deviceIds.reduce<number | null>((longest, id) => {
    const seen = darkByDevice.get(id);
    if (!seen) return longest;
    const seconds = (now.getTime() - seen.getTime()) / 1000;
    return longest === null || seconds > longest ? seconds : longest;
  }, null);

  const estateShare =
    activeDeviceCount && activeDeviceCount > 0 ? dormantDevices.size / activeDeviceCount : null;

  const rollup: DormancyRollup | null =
    dormantAlerts.length === 0
      ? null
      : {
          kind: "dormancy-rollup",
          id: "dormant-estate",
          severity: rollupSeverity(estateShare),
          title: `${dormantDevices.size} canvas(es) unreachable for 30+ days`,
          evidence: rollupEvidence({
            devices: dormantDevices.size,
            alerts: dormantAlerts.length,
            estateShare,
            longestDarkSeconds,
            buckets,
          }),
          deviceCount: dormantDevices.size,
          alertCount: dormantAlerts.length,
          estateShare,
          oldestOpenedAt: oldestOpenedAt?.toISOString() ?? null,
          longestDarkSeconds,
          byRule,
          darkness: buckets,
          neverSeenDevices: neverSeenDeviceCount,
          drilldown: { state: "open", deviceIds },
        };

  const chips: Chip[] = [
    ...SEVERITY_ORDER.map((severity) => ({
      key: severity as ChipKey,
      label: severity,
      count: incidents.bySeverity[severity],
      inDefaultList: true,
    })),
    {
      key: "dormant" as ChipKey,
      label: "dormant",
      count: dormantBand.total,
      inDefaultList: false,
    },
  ];

  return {
    totalOpen: alerts.length,
    excludedRetiredAlerts: retiredAlertCount,
    incidents,
    dormant: {
      ...dormantBand,
      byRule,
      oldestOpenedAt: oldestOpenedAt?.toISOString() ?? null,
      deviceIds,
      alertIds: dormantAlerts.map((a) => a.id),
      heldBackAlertIds: heldBack.map((a) => a.id),
    },
    rollup,
    chips,
    notes: buildNotes({
      total: alerts.length,
      incidents,
      dormantBand,
      dormantDeviceCount: dormantDevices.size,
      byRule,
      heldBack,
      neverSeenDeviceCount,
      retiredAlertCount,
      dormantRules,
    }),
  };
}

/**
 * The invariant, as an assertable function rather than a comment.
 *
 * We broke this once by filtering rows out of the list without taking them out
 * of the counts, which left an operator staring at chips that added up to more
 * alerts than the list contained — the fastest possible way to lose trust in a
 * monitoring surface. Every chip counts exactly one band, every alert lands in
 * exactly one band, so the chips must sum to the grand total.
 */
export function chipsSumToTotal(view: AlertHygiene): boolean {
  const chipSum = view.chips.reduce((sum, chip) => sum + chip.count, 0);
  const listChipSum = view.chips
    .filter((c) => c.inDefaultList)
    .reduce((sum, chip) => sum + chip.count, 0);
  return (
    chipSum === view.totalOpen &&
    listChipSum === view.incidents.total &&
    view.incidents.total + view.dormant.total === view.totalOpen
  );
}

function breakdown(alerts: readonly OpenAlertFact[], dormantRules: ReadonlySet<string>): RuleBreakdown[] {
  const byRule = new Map<string, RuleBreakdown>();
  for (const alert of alerts) {
    const existing = byRule.get(alert.ruleId);
    if (existing) existing.count += 1;
    else {
      byRule.set(alert.ruleId, {
        ruleId: alert.ruleId,
        severity: alert.severity,
        count: 1,
        dormantRule: dormantRules.has(alert.ruleId),
      });
    }
  }
  return [...byRule.values()].sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId));
}

function bucketDarkness(
  deviceIds: readonly string[],
  darkByDevice: ReadonlyMap<string, Date | null>,
  now: Date,
): DarknessBucket[] {
  const buckets: DarknessBucket[] = BUCKETS.map((b) => ({ ...b, devices: 0 }));
  const unknown = buckets[buckets.length - 1]!;

  for (const id of deviceIds) {
    const seen = darkByDevice.get(id);
    // Not present in the darkness input is not the same as never seen online —
    // the first is our ignorance, the second is a fact — but neither can be
    // bucketed by duration, and both must still be counted somewhere.
    if (seen === null || seen === undefined) {
      unknown.devices += 1;
      continue;
    }
    const days = (now.getTime() - seen.getTime()) / 1000 / DAY;
    const match = buckets.find(
      (b) => b.minDays !== null && days >= b.minDays && (b.maxDays === null || days < b.maxDays),
    );
    // A dormant device younger than the first bucket can only happen if a rule
    // threshold was tuned below 30 days; count it in the first bucket rather
    // than losing it.
    (match ?? buckets[0]!).devices += 1;
  }
  return buckets.filter((b) => b.devices > 0);
}

/** Graded on the share of the estate, because that is what makes it serious. */
function rollupSeverity(estateShare: number | null): Severity {
  if (estateShare === null) return "medium";
  if (estateShare >= 0.25) return "high";
  if (estateShare >= 0.1) return "medium";
  return "info";
}

function rollupEvidence(args: {
  devices: number;
  alerts: number;
  estateShare: number | null;
  longestDarkSeconds: number | null;
  buckets: readonly DarknessBucket[];
}): string {
  const share =
    args.estateShare === null
      ? "share of the estate unknown"
      : `${(args.estateShare * 100).toFixed(0)}% of the active estate`;
  const split = args.buckets.map((b) => `${b.devices} ${b.label}`).join(", ");
  const longest =
    args.longestDarkSeconds === null
      ? ""
      : ` The longest has been dark ${formatDuration(args.longestDarkSeconds)}.`;
  return (
    `${args.devices} canvas(es) — ${share} — have not been reachable for 30+ days: ${split}.` +
    `${longest} ${args.alerts} open alert(s) about them are counted here and in the dormant ` +
    `chip instead of in the incident list, because none of them can be actioned while the ` +
    `device is unreachable. Nothing was resolved or hidden: open the dormant band to see ` +
    `every one. This is an asset-register question — decommission, relocate or send an ` +
    `engineer — not today's incident queue.`
  );
}

function buildNotes(args: {
  total: number;
  incidents: AlertBand;
  dormantBand: AlertBand;
  dormantDeviceCount: number;
  byRule: readonly RuleBreakdown[];
  heldBack: readonly OpenAlertFact[];
  neverSeenDeviceCount: number | null;
  retiredAlertCount: number | null;
  dormantRules: ReadonlySet<string>;
}): string[] {
  const notes: string[] = [];
  if (args.retiredAlertCount && args.retiredAlertCount > 0) {
    notes.push(
      `${args.retiredAlertCount} further open alert(s) sit on devices the platform no longer ` +
        `has (retired). They are excluded from every count here, which is why a raw count of ` +
        `the alerts table reads ${args.total + args.retiredAlertCount} rather than ${args.total}.`,
    );
  }
  if (args.dormantRules.size === 0) {
    notes.push(
      "No rule is classified dormant, so every open alert is in the incident list. " +
        "If the list is unreadably long, enable `offline-30d`/`offline-6mo`.",
    );
    return notes;
  }
  if (args.dormantBand.total === 0) {
    notes.push(
      `All ${args.total} open alert(s) are incidents — no device has an open dormancy ` +
        `alert, so nothing was rolled up.`,
    );
    return notes;
  }

  notes.push(
    `${args.dormantBand.total} of ${args.total} open alert(s), across ${args.dormantDeviceCount} ` +
      `canvas(es), are DORMANT: the device has been unreachable for 30+ days. They remain ` +
      `open and are counted in the dormant chip; they are out of the incident list because ` +
      `nothing about them can be fixed today.`,
  );

  const absorbed = args.byRule.filter((r) => !r.dormantRule);
  if (absorbed.length > 0) {
    notes.push(
      `Rolled up with the outage that explains them: ` +
        `${absorbed.map((r) => `${r.count}× ${r.ruleId}`).join(", ")}. These fired on devices ` +
        `we cannot reach, so the reading behind them is as old as the outage.`,
    );
  }

  if (args.heldBack.length > 0) {
    const rules = [...new Set(args.heldBack.map((a) => a.ruleId))].join(", ");
    notes.push(
      `${args.heldBack.length} alert(s) on dormant devices were deliberately KEPT in the ` +
        `incident list (${rules}) because they are critical or high. A serious alert on a ` +
        `device we believe is dark means the device spoke — that is news, not noise.`,
    );
  }

  if (args.neverSeenDeviceCount && args.neverSeenDeviceCount > 0) {
    notes.push(
      `Separately, ${args.neverSeenDeviceCount} active canvas(es) have never been recorded ` +
        `online by Videri at all. No outage can be dated for them, so no offline alert can ` +
        `fire — their absence from both lists is a gap in what we know, not a clean bill of health.`,
    );
  }

  notes.push(
    `Incident list: ${args.incidents.total} alert(s) — ` +
      SEVERITY_ORDER.map((s) => `${args.incidents.bySeverity[s]} ${s}`).join(", ") + `.`,
  );
  return notes;
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O
// ─────────────────────────────────────────────────────────────────────────────

export interface LoadAlertHygieneOptions {
  now?: Date;
  /** Explicit rules for tests; otherwise the operator-editable set is loaded. */
  rules?: readonly AlertRule[];
}

/**
 * Read the three aggregates the classifier needs and shape them.
 *
 * Three cheap reads, no per-device round trips. The alert facts are the full
 * open set rather than a page: chips computed from a page are chips that lie the
 * moment there is a second page.
 */
export async function loadAlertHygiene(
  repo: Repository,
  { now = new Date(), rules }: LoadAlertHygieneOptions = {},
): Promise<AlertHygiene> {
  const ruleSet = rules ?? ((await loadRules(repo)) as AlertRule[]);
  const [alerts, estate, retiredAlertCount] = await Promise.all([
    repo.openAlertFacts(),
    repo.estateDarkness(),
    repo.openAlertsOnRetiredDevices(),
  ]);
  return classifyOpenAlerts(alerts, ruleSet, {
    now,
    darkness: estate.devices,
    activeDeviceCount: estate.activeDevices,
    neverSeenDeviceCount: estate.neverSeenDevices,
    retiredAlertCount,
  });
}
