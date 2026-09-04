/**
 * The customer-facing estate report (Epic 8.4).
 *
 * WHAT WAS WRONG. The only export in the product emitted one fleet-level JSON
 * blob: a health score, a snapshot, an SLA methodology paragraph, an alert
 * COUNT, compliance counts and a gap list. A QA pass judged it "a developer
 * artefact, not something a customer could read", and judged the SLA tab "a
 * methodology page, not an SLA — you cannot tell a single customer what their
 * SLA was" (docs/25 GAP-11, GAP-12, GAP-13). No device list, no alert list, no
 * site breakdown, no CSV, and — the one that matters most for an MSP — no
 * per-customer scoping.
 *
 * The site axis landed first (232 of 248 devices resolve into 10 real sites, and
 * `/api/devices` filters by `siteIds`), which is what makes this possible: a
 * customer IS a site here, so a per-site report is a report a technician can
 * hand over.
 *
 * FOUR RULES RUN THROUGH EVERY FIGURE BELOW, and each is a thing this project
 * has already been burned by:
 *
 *   1. SCOPE IS THE POINT, AND "NO SITE" IS A SCOPE. The 16 devices that resolve
 *      to no site are reportable as an `unplaced` cohort. They are never dropped
 *      from a count and never bucketed into an invented site, because a customer
 *      count that quietly omits screens is worse than one that says "16 screens
 *      are not placed at a site and here is why".
 *
 *   2. EVERY FIGURE CARRIES ITS BASIS AND ITS DENOMINATOR (`Figure<T>`). Presence
 *      history is only dense for the last few days, hardware telemetry reaches a
 *      fraction of the fleet on a multi-hour rotation, and fewer than half the
 *      devices have a config snapshot. A report that implies full coverage is
 *      worse than no report, so there is no bare number anywhere in the payload.
 *
 *   3. WE NEVER CLAIM WHAT WE CANNOT CLAIM. Proof-of-play is reported as
 *      SCHEDULED, NOT CONFIRMED using the same `BASIS` string the POP engine
 *      publishes — there is no readable render log at any scope. And the
 *      readable-but-not-SLA-grade tier from `sla/measurability.ts` is kept in its
 *      own list and never promoted into a customer-facing number; promoting it
 *      was a bug we fixed (BUG-3).
 *
 *   4. WE SAY WHAT WE DID. `device_action_log` is joined in, half-open on the
 *      same window, and "nothing was changed on your estate in this period" is
 *      printed as a sentence rather than left as an empty array.
 *
 * WHY ONE ENDPOINT WITH `format`, NOT TWO ENDPOINTS. `/api/reports/estate`
 * serves both the JSON document and the CSV tables, and the CSV is rendered from
 * the SAME in-memory report object the JSON serialises. That is the whole reason:
 * a second endpoint would mean a second window parser, a second scope resolver
 * and a second set of counts — a second chance to disagree, silently, in the one
 * artefact a customer reads (the same argument that put `limit=0` inside the list
 * endpoint instead of a `/count` sibling — see count-only.ts). CSV additionally
 * needs `section`, because a CSV cannot carry a nested document: asking for
 * `format=csv` without naming a table is a 400 that lists the tables.
 *
 * READ-ONLY. Nothing here writes to a device or to Postgres.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { envelope } from "../freshness.js";
import {
  NO_HIERARCHY_REASON,
  groupIdsForSites,
  type DeviceListItem,
  type SiteResolution,
} from "../queries.js";
import { GroupSiteCache } from "../../videri/services/group-hierarchy.js";
import { assessDevice, buildFleetReport, type DeviceSlaWindow } from "../../sla/coverage.js";
import { loadMeasurability, type CapabilitySources } from "../../sla/capability.js";
import {
  humanDuration,
  type ClassifiedDimension,
  type MeasurabilityAssessment,
} from "../../sla/measurability.js";
import { BASIS as PROOF_OF_PLAY_BASIS } from "../../intelligence/proof-of-play.js";
import { AUDIT_RETAIN_DAYS, type DeviceActionRow } from "../../db/repository.js";
import type { ApiContext } from "../server.js";

// ── figures: a number is never served on its own ─────────────────────────────

/**
 * What a figure was measured over. `unit` is explicit because the denominators
 * in this report are genuinely different things — screens, time buckets, alerts,
 * actions, SLA dimensions — and a bare "142 of 248" invites the reader to assume
 * screens.
 */
export type FigureUnit = "screens" | "time-buckets" | "alerts" | "actions" | "dimensions";

const UNIT_LABEL: Record<FigureUnit, string> = {
  screens: "screen(s)",
  "time-buckets": "time bucket(s) of the window",
  alerts: "alert(s)",
  actions: "logged action(s)",
  dimensions: "measurement dimension(s)",
};

export interface FigureCoverage {
  /** Units the figure could actually be computed from. */
  measured: number;
  /** Units in scope — the denominator the customer is entitled to see. */
  inScope: number;
  unit: FigureUnit;
  /** `measured / inScope`, or null when there is nothing in scope to divide by. */
  share: number | null;
  note: string;
}

/**
 * One reportable number plus what it was computed from.
 *
 * Deliberately a wrapper rather than a sibling `notes` block: a consumer that
 * renders `value` gets `basis` and `coverage` in the same object and cannot
 * accidentally print the figure without them. The invariant a test enforces is
 * that EVERY figure in the payload has a non-empty basis and a coverage block.
 */
export interface Figure<T> {
  value: T;
  basis: string;
  coverage: FigureCoverage;
}

const shareOf = (measured: number, inScope: number): number | null =>
  inScope === 0 ? null : Number((measured / inScope).toFixed(4));

export function figureOf<T>(
  value: T,
  basis: string,
  measured: number,
  inScope: number,
  unit: FigureUnit,
  note?: string,
): Figure<T> {
  const label = UNIT_LABEL[unit];
  const resolvedNote =
    note ??
    (inScope === 0
      ? `There are no ${label} in scope, so there was nothing to measure.`
      : measured === inScope
        ? `Computed from all ${inScope} ${label} in scope.`
        : `Computed from ${measured} of ${inScope} ${label} in scope; the other ` +
          `${inScope - measured} could not be measured and are excluded from this figure, ` +
          `never counted as zero.`);
  return {
    value,
    basis,
    coverage: { measured, inScope, unit, share: shareOf(measured, inScope), note: resolvedNote },
  };
}

/** The common case: a figure measured over screens. */
export const figure = <T>(
  value: T,
  basis: string,
  measured: number,
  inScope: number,
  note?: string,
): Figure<T> => figureOf(value, basis, measured, inScope, "screens", note);

// ── the window: half-open, always stated ─────────────────────────────────────

export interface ReportWindow {
  /** Inclusive lower bound, ISO. */
  from: string;
  /** EXCLUSIVE upper bound, ISO. */
  to: string;
  seconds: number;
  hours: number;
  bucketSeconds: number;
  /** Buckets the window contains — the denominator for collection coverage. */
  expectedBuckets: number;
  /** True, always. Present so a consumer never has to assume it. */
  halfOpen: true;
  statement: string;
}

/**
 * Buckets in `[from, to)`, aligned the way the SQL aligns them.
 *
 * `availabilityBuckets()` groups with `time_bucket`, whose boundaries are fixed
 * multiples of the interval, so the first bucket a window touches starts at or
 * BEFORE `from`. Counting `(to - from) / bucket` would therefore under-state the
 * denominator on an unaligned window and quietly inflate coverage above 100%.
 */
export function bucketsInWindow(fromIso: string, toIso: string, bucketSeconds: number): number {
  const bucketMs = Math.max(1, bucketSeconds) * 1000;
  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return 1;
  const alignedFrom = Math.floor(fromMs / bucketMs) * bucketMs;
  return Math.max(1, Math.ceil((toMs - alignedFrom) / bucketMs));
}

export function buildWindow(fromIso: string, toIso: string, bucketSeconds: number): ReportWindow {
  const seconds = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
  return {
    from: fromIso,
    to: toIso,
    seconds,
    hours: Number((seconds / 3600).toFixed(4)),
    bucketSeconds,
    expectedBuckets: bucketsInWindow(fromIso, toIso, bucketSeconds),
    halfOpen: true,
    statement:
      `Covers ${fromIso} up to — but NOT including — ${toIso} (${humanDuration(seconds)}). ` +
      `The window is half-open, so this report and a report for the adjoining period ` +
      `can never count the same event twice.`,
  };
}

// ── scope: a site, the unplaced cohort, or the whole estate ───────────────────

export type ScopeKind = "site" | "unplaced" | "fleet";

export interface ReportScope {
  kind: ScopeKind;
  /** The depth-1 group uuid. Null for `unplaced` and `fleet`. */
  siteId: string | null;
  siteName: string | null;
  /** What to print at the top of the artefact. */
  label: string;
  statement: string;
  hierarchy: {
    available: boolean;
    ageSeconds: number | null;
    groupsRead: number;
    groupsTotal: number | null;
    truncated: boolean;
    reason: string | null;
    /** Groups the requested site resolved to. Zero on a site scope = failed closed. */
    groupsMatched: number | null;
  };
}

/**
 * Pure: is this device in scope?
 *
 * The authority for scoping, even when SQL has already narrowed by group id. It
 * reads `device.site`, which is projected by `deviceSite()` from the SAME
 * `resolveSite` walk `groupIdsForSites()` uses, so the filter and the site
 * printed on the row cannot disagree.
 *
 * `unplaced` is a first-class scope, not a fallback: a device with no group, a
 * group we could not read, or a group sitting at the tenant root is a screen
 * somebody paid for, and it stays countable.
 */
export function inScope(device: DeviceListItem, scope: { kind: ScopeKind; siteId: string | null }): boolean {
  if (scope.kind === "fleet") return true;
  if (scope.kind === "unplaced") return !device.site.resolved;
  return device.site.resolved && device.site.id === scope.siteId;
}

// ── alerts against the window ────────────────────────────────────────────────

export interface ReportAlertInput {
  id: string;
  deviceId: string;
  deviceName: string | null;
  ruleId: string | null;
  severity: string;
  title: string | null;
  openedAt: string;
  lastFiredAt: string | null;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

/**
 * How one alert relates to the window.
 *
 * `opened-in-window` is the only role counted as "what broke in this period",
 * and it is half-open on `openedAt`. `carried-in` is an alert that was already
 * open when the period began and is still open — it belongs in a customer's
 * "still outstanding" list but must NEVER be added to the new-faults count, or
 * two adjacent monthly reports would both claim it.
 */
export type AlertWindowRole = "opened-in-window" | "resolved-in-window" | "carried-in" | "outside";

export function alertWindowRole(alert: ReportAlertInput, window: ReportWindow): AlertWindowRole {
  const opened = Date.parse(alert.openedAt);
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (opened >= from && opened < to) return "opened-in-window";
  const resolved = alert.resolvedAt === null ? null : Date.parse(alert.resolvedAt);
  if (resolved !== null && resolved >= from && resolved < to) return "resolved-in-window";
  // Opened before the window and never resolved: outstanding, but not new.
  if (opened < from && alert.resolvedAt === null) return "carried-in";
  return "outside";
}

export interface ReportAlert extends ReportAlertInput {
  role: Exclude<AlertWindowRole, "outside">;
  /** Open or resolved AS AT `generatedAt` — not as at the end of the window. */
  stateNow: "open" | "resolved";
  siteName: string | null;
}

const SEVERITIES = ["critical", "high", "medium", "info"] as const;
type Severity = (typeof SEVERITIES)[number];
const emptySeverityCounts = (): Record<Severity, number> => ({ critical: 0, high: 0, medium: 0, info: 0 });
const bumpSeverity = (counts: Record<Severity, number>, severity: string): void => {
  if ((SEVERITIES as readonly string[]).includes(severity)) counts[severity as Severity] += 1;
};

// ── actions against the window ───────────────────────────────────────────────

export interface ReportAction {
  id: number;
  startedAt: string;
  finishedAt: string;
  deviceId: string;
  deviceName: string | null;
  siteName: string | null;
  action: string;
  verb: string | null;
  requestedValue: string | null;
  observedValue: string | null;
  outcome: string;
  actor: string;
  durationMs: number | null;
  error: string | null;
}

// ── the report ───────────────────────────────────────────────────────────────

export interface EstateReport {
  reportType: "estate";
  /** Bumped when the shape changes, so a stored artefact stays interpretable. */
  formatVersion: 1;
  generatedAt: string;
  title: string;
  scope: ReportScope;
  window: ReportWindow;
  estate: {
    screens: Figure<number>;
    byStatus: Figure<Record<string, number>>;
    byClass: Figure<Record<string, number>>;
    firmwareBehind: Figure<number>;
    unplacedScreensInScope: Figure<number>;
    inventory: DeviceInventoryRow[];
  };
  availability: {
    statement: string;
    screensObserved: Figure<number>;
    screensNeverObserved: Figure<number>;
    screensReachable: Figure<number>;
    screensClaimable: Figure<number>;
    observedUptimeClaimable: Figure<number | null>;
    collectionCoverage: Figure<number>;
    collectorCoverage: Figure<number>;
    confidence: Figure<Record<string, number>>;
    warnings: string[];
    screens: DeviceSlaWindow[];
  };
  faults: {
    statement: string;
    /** Non-null exactly when there is nothing to tabulate. */
    emptyStatement: string | null;
    openedInWindow: Figure<number>;
    openedBySeverity: Figure<Record<string, number>>;
    resolvedInWindow: Figure<number>;
    stillOpen: Figure<number>;
    stillOpenBySeverity: Figure<Record<string, number>>;
    alerts: ReportAlert[];
  };
  changes: {
    statement: string;
    emptyStatement: string | null;
    total: Figure<number>;
    byOutcome: Figure<Record<string, number>>;
    actions: ReportAction[];
    retention: { retainDays: number; enforced: boolean; note: string };
  };
  content: {
    claim: "scheduled, not confirmed";
    basis: string;
    statement: string;
    screensWithScheduleSnapshot: Figure<number>;
    screensWithContentScheduled: Figure<number>;
  };
  configuration: {
    statement: string;
    screensWithSnapshot: Figure<number>;
  };
  claims: {
    note: string;
    counts: Figure<{ slaGrade: number; readableNotClaimable: number; unmeasurable: number }>;
    slaGrade: ClassifiedDimension[];
    /** Diagnostic only. Quoting one of these to a customer is the BUG-3 mistake. */
    readableNotClaimable: ClassifiedDimension[];
    unmeasurable: ClassifiedDimension[];
  };
  /** What we could NOT see, in plain sentences. Never empty in practice. */
  limitations: string[];
}

/** One row of the device inventory table — the CSV's primary section. */
export interface DeviceInventoryRow {
  deviceId: string;
  name: string | null;
  location: string | null;
  siteName: string | null;
  siteResolved: boolean;
  siteNote: string | null;
  deviceClass: string;
  modelType: string | null;
  status: string;
  lastOnlineTime: string | null;
  firmwareCurrent: string | null;
  firmwareBehind: boolean;
  openAlerts: number;
  /** 0–1 over the window. */
  collectionCoverage: number;
  /** 0–1 of OBSERVED time. Null when we never observed it — never a zero. */
  observedUptime: number | null;
  uptimeClaimable: boolean;
  availabilityStatement: string;
  /** When the last per-device hardware reading landed. Null = never reached. */
  hardwareReadingAt: string | null;
}

export interface EstateReportInputs {
  generatedAt: string;
  scope: ReportScope;
  window: ReportWindow;
  /** Already narrowed to the scope by `inScope`. */
  devices: readonly DeviceListItem[];
  devicesTruncated: boolean;
  /** Active devices in the whole tenant, for context on a scope's share. */
  fleetScreens: number;
  presence: readonly { deviceId: string; observedBuckets: number; onlineBuckets: number }[];
  /** Distinct buckets in which ANY device reported — our collector's own uptime. */
  collectorObservedBuckets: number;
  alerts: readonly ReportAlertInput[];
  alertsTruncated: boolean;
  actions: readonly DeviceActionRow[];
  actionsTruncated: boolean;
  /** Rows in the whole action log, so an empty section can say which empty it is. */
  actionsLogSize: number;
  configSnapshotDeviceIds: ReadonlySet<string>;
  /** Null when the schedule snapshot table was not read at all. */
  schedule: {
    snapshotDeviceIds: ReadonlySet<string>;
    scheduledDeviceIds: ReadonlySet<string>;
    oldestSnapshotAt: string | null;
  } | null;
  measurability: MeasurabilityAssessment;
}

const pct = (n: number | null): string => (n === null ? "not measurable" : `${(n * 100).toFixed(1)}%`);

/**
 * Assemble the whole report. PURE — every input is already fetched, so the
 * scoping rules, the window arithmetic and every coverage sentence are unit
 * testable without a database, a network or a wall clock.
 */
export function buildEstateReport(input: EstateReportInputs): EstateReport {
  const { devices, window, scope } = input;
  const inScopeCount = devices.length;
  const deviceIds = new Set(devices.map((d) => d.id));
  const siteNameFor = new Map(devices.map((d) => [d.id, d.site.name] as const));

  // ── availability, via the SLA engine ──
  //
  // `assessDevice` is reused rather than re-derived: it owns the rule that
  // observed uptime and collection coverage are never blended into one figure,
  // and the claimable floor. A second implementation here is exactly how a
  // customer-facing number would drift from the SLA tab.
  const presenceById = new Map(input.presence.map((p) => [p.deviceId, p] as const));
  const deviceWindows: DeviceSlaWindow[] = devices.map((d) => {
    const p = presenceById.get(d.id);
    return assessDevice(
      {
        deviceId: d.id,
        name: d.name,
        // Absent from the bucket read means no presence row in the window at
        // all: a real zero observations, which `assessDevice` turns into a NULL
        // uptime rather than 0% uptime.
        observedBuckets: p?.observedBuckets ?? 0,
        onlineBuckets: p?.onlineBuckets ?? 0,
        expectedBuckets: window.expectedBuckets,
        // NOT COMPUTED for an arbitrary window — the bucket read returns counts,
        // not the run lengths between them. Zero here only omits the
        // "longest single gap" clause from a non-claimable statement; it can
        // never inflate a claim, and the limitation is stated in `limitations`.
        longestGapSeconds: 0,
        stalenessSeconds: null,
      },
      window.bucketSeconds,
    );
  });
  const fleetView = buildFleetReport(
    window.hours,
    window.bucketSeconds,
    deviceWindows,
    // Blind-window detection is anchored to "now" in the SLA engine and is not
    // recomputed for an arbitrary window here. `collectorCoverage` below is the
    // honest substitute, and `limitations` says so.
    [],
    input.measurability,
  );
  const observedCount = deviceWindows.filter((d) => d.observedUptime !== null).length;
  const reachableCount = devices.filter((d) => (presenceById.get(d.id)?.onlineBuckets ?? 0) > 0).length;

  // ── estate ──
  const byStatus: Record<string, number> = {};
  const byClass: Record<string, number> = {};
  for (const d of devices) {
    byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
    byClass[d.deviceClass] = (byClass[d.deviceClass] ?? 0) + 1;
  }
  const unplacedInScope = devices.filter((d) => !d.site.resolved).length;

  const inventory: DeviceInventoryRow[] = devices.map((d) => {
    const w = deviceWindows.find((x) => x.deviceId === d.id)!;
    return {
      deviceId: d.id,
      name: d.name,
      location: d.location,
      siteName: d.site.name,
      siteResolved: d.site.resolved,
      siteNote: d.site.reason,
      deviceClass: d.deviceClass,
      modelType: d.modelType,
      status: d.status,
      lastOnlineTime: d.lastOnlineTime,
      firmwareCurrent: d.firmwareCurrent,
      firmwareBehind: d.firmwareBehind,
      openAlerts: d.openAlerts.total,
      collectionCoverage: w.collectionCoverage,
      observedUptime: w.observedUptime,
      uptimeClaimable: w.claimable,
      availabilityStatement: w.statement,
      hardwareReadingAt: d.latest.hardwareObservedAt,
    };
  });

  // ── faults ──
  //
  // The detection denominator is screens we OBSERVED, not screens in scope: a
  // fault that happened while a screen was unobserved could not have raised an
  // alert, and reporting "0 faults" against the full estate would imply we were
  // watching all of it.
  const roles = new Map<string, AlertWindowRole>();
  for (const a of input.alerts) roles.set(a.id, alertWindowRole(a, window));
  const reportable = input.alerts.filter(
    (a) => deviceIds.has(a.deviceId) && roles.get(a.id) !== "outside",
  );
  const openedBySeverity = emptySeverityCounts();
  const stillOpenBySeverity = emptySeverityCounts();
  let openedInWindow = 0;
  let resolvedInWindow = 0;
  let stillOpen = 0;
  const alerts: ReportAlert[] = reportable.map((a) => {
    const role = roles.get(a.id) as Exclude<AlertWindowRole, "outside">;
    if (role === "opened-in-window") {
      openedInWindow += 1;
      bumpSeverity(openedBySeverity, a.severity);
    }
    if (a.resolvedAt !== null) {
      const resolved = Date.parse(a.resolvedAt);
      if (resolved >= Date.parse(window.from) && resolved < Date.parse(window.to)) resolvedInWindow += 1;
    } else {
      stillOpen += 1;
      bumpSeverity(stillOpenBySeverity, a.severity);
    }
    return {
      ...a,
      role,
      stateNow: a.resolvedAt === null ? "open" : "resolved",
      siteName: siteNameFor.get(a.deviceId) ?? null,
    };
  });
  // Severity order first, then newest, so the top of a customer's list is the
  // thing that mattered most rather than an id ordering.
  const severityRank = (s: string) => {
    const i = (SEVERITIES as readonly string[]).indexOf(s);
    return i === -1 ? SEVERITIES.length : i;
  };
  alerts.sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      Date.parse(b.openedAt) - Date.parse(a.openedAt),
  );

  const alertBasis =
    `Alerts raised by VFI's own rules against the readings we hold for these screens. ` +
    `A fault occurring while a screen was unobserved cannot appear here, so this is a ` +
    `floor, not a certified total. "Opened" is half-open on the window; an alert that ` +
    `was already open when the period began is listed as carried-in and is NOT counted ` +
    `as a new fault.`;

  // ── changes ──
  const scopedActions = input.actions.filter((a) => deviceIds.has(a.deviceId));
  const byOutcome: Record<string, number> = {};
  for (const a of scopedActions) byOutcome[a.outcome] = (byOutcome[a.outcome] ?? 0) + 1;
  const actions: ReportAction[] = scopedActions.map((a) => ({
    id: a.id,
    startedAt: a.startedAt.toISOString(),
    finishedAt: a.finishedAt.toISOString(),
    deviceId: a.deviceId,
    deviceName: a.deviceName,
    siteName: siteNameFor.get(a.deviceId) ?? null,
    action: a.action,
    verb: a.verb,
    requestedValue: a.requestedValue,
    observedValue: a.observedValue,
    outcome: a.outcome,
    actor: a.actor,
    durationMs: a.durationMs,
    error: a.error,
  }));

  // ── content ──
  const scheduleSnapshotCount = input.schedule
    ? devices.filter((d) => input.schedule!.snapshotDeviceIds.has(d.id)).length
    : 0;
  const scheduledCount = input.schedule
    ? devices.filter((d) => input.schedule!.scheduledDeviceIds.has(d.id)).length
    : 0;

  // ── configuration ──
  const configCount = devices.filter((d) => input.configSnapshotDeviceIds.has(d.id)).length;

  // ── hardware telemetry reach, for the limitations block ──
  const hardwareReached = devices.filter((d) => d.latest.hardwareObservedAt !== null).length;

  const collectorCoverageValue = Number(
    Math.min(1, input.collectorObservedBuckets / Math.max(1, window.expectedBuckets)).toFixed(4),
  );

  const limitations = buildLimitations({
    scope,
    window,
    inScopeCount,
    unknownStatusCount: byStatus["unknown"] ?? 0,
    observedCount,
    claimableCount: fleetView.devicesClaimable,
    collectorCoverage: collectorCoverageValue,
    hardwareReached,
    configCount,
    scheduleSnapshotCount,
    unplacedInScope,
    measurability: input.measurability,
    devicesTruncated: input.devicesTruncated,
    alertsTruncated: input.alertsTruncated,
    actionsTruncated: input.actionsTruncated,
    scheduleRead: input.schedule !== null,
  });

  return {
    reportType: "estate",
    formatVersion: 1,
    generatedAt: input.generatedAt,
    title: `Estate report — ${scope.label}`,
    scope,
    window,
    estate: {
      screens: figure(
        inScopeCount,
        `Screens VFI holds a record for in this scope, from our own device inventory ` +
          `(retired devices excluded). The tenant holds ${input.fleetScreens} active screen(s) ` +
          `in total.`,
        inScopeCount,
        inScopeCount,
        inScopeCount === 0
          ? "No screen in our inventory resolves to this scope."
          : `A complete count for this scope: ${inScopeCount} of the tenant's ` +
            `${input.fleetScreens} active screen(s).`,
      ),
      byStatus: figure(
        byStatus,
        `A POINT-IN-TIME status as at ${input.generatedAt}, derived from the single most ` +
          `recent sample we hold per screen. "unknown" means that newest sample carries no ` +
          `presence value — several collection lanes write rows that do not — so it is ` +
          `neither an outage NOR proof we never saw the screen. For the window view, read ` +
          `the availability section: a screen can be "unknown" here and observed all week ` +
          `there, and the two do not disagree.`,
        inScopeCount,
        inScopeCount,
      ),
      byClass: figure(byClass, "Device class as the platform reports it.", inScopeCount, inScopeCount),
      firmwareBehind: figure(
        devices.filter((d) => d.firmwareBehind).length,
        `Screens whose reported firmware is behind the latest the platform offers for ` +
          `them. Screens where either version is unreadable are not counted either way.`,
        devices.filter((d) => d.firmwareCurrent !== null && d.firmwareLatest !== null).length,
        inScopeCount,
      ),
      unplacedScreensInScope: figure(
        unplacedInScope,
        scope.kind === "site"
          ? `Zero by construction: every screen in a site scope resolved to that site. ` +
            `Screens that resolve to NO site are reportable on their own, as scope=unplaced.`
          : `Screens carrying no group, a group we could not read, or a group at the tenant ` +
            `root. They are counted here rather than dropped or filed under an invented site.`,
        inScopeCount,
        inScopeCount,
      ),
      inventory: inventory,
    },
    availability: {
      statement:
        inScopeCount === 0
          ? "No screens in scope, so there is no availability to report."
          : observedCount === 0
            ? `We hold NO presence readings for any of the ${inScopeCount} screen(s) in this ` +
              `scope across this window, so no uptime can be asserted at all.`
            : `${reachableCount} of ${inScopeCount} screen(s) were reachable at least once. ` +
              (fleetView.devicesClaimable === 0
                ? `NO uptime figure is stated for this period: not one screen here was observed ` +
                  `for enough of the window for us to defend a number. Mean collection coverage ` +
                  `was ${pct(fleetView.fleetCollectionCoverage)}, below the bar we hold ` +
                  `ourselves to, so the per-screen figures below are for diagnosis only.`
                : `Across the ${fleetView.devicesClaimable} screen(s) whose coverage is high ` +
                  `enough to support an external claim, observed uptime was ` +
                  `${pct(fleetView.fleetObservedUptimeClaimable)}. Mean collection coverage was ` +
                  `${pct(fleetView.fleetCollectionCoverage)} — uptime and coverage are separate ` +
                  `figures and are never multiplied together.`),
      screensObserved: figure(
        observedCount,
        `Screens for which we hold at least one presence reading inside the window.`,
        inScopeCount,
        inScopeCount,
      ),
      screensNeverObserved: figure(
        inScopeCount - observedCount,
        `Screens with no presence reading at all inside the window. Their uptime is null, ` +
          `not zero: we do not know whether they were up.`,
        inScopeCount,
        inScopeCount,
      ),
      screensReachable: figure(
        reachableCount,
        `Screens observed online in at least one time bucket of the window. This is the ` +
          `"did we ever see it" figure, not an uptime.`,
        observedCount,
        inScopeCount,
        `Computed from the ${observedCount} of ${inScopeCount} screen(s) we observed at all; ` +
          `the remaining ${inScopeCount - observedCount} are unknown rather than unreachable.`,
      ),
      screensClaimable: figure(
        fleetView.devicesClaimable,
        `Screens whose collection coverage is high enough that we would defend their uptime ` +
          `figure externally. The bar is shared with the SLA engine, so this report and the ` +
          `SLA page use one claimability rule.`,
        inScopeCount,
        inScopeCount,
      ),
      observedUptimeClaimable: figure(
        fleetView.fleetObservedUptimeClaimable,
        `Mean observed uptime across CLAIMABLE screens only. Averaging in screens we barely ` +
          `observed would produce a number nobody could defend. Null when no screen in scope ` +
          `clears the coverage bar.`,
        fleetView.devicesClaimable,
        inScopeCount,
        fleetView.devicesClaimable === 0
          ? `No screen in this scope has enough collection coverage to support an external ` +
            `uptime claim for this window, so this figure is deliberately null.`
          : `Computed from the ${fleetView.devicesClaimable} of ${inScopeCount} screen(s) that ` +
            `clear the coverage bar. The other ${inScopeCount - fleetView.devicesClaimable} are ` +
            `excluded from the claim, not averaged in.`,
      ),
      collectionCoverage: figure(
        fleetView.fleetCollectionCoverage,
        `Mean share of the window for which we hold any reading per screen. This is OUR ` +
          `measurement coverage, not the customer's uptime.`,
        inScopeCount,
        inScopeCount,
      ),
      collectorCoverage: figureOf(
        collectorCoverageValue,
        `Share of the window's time buckets in which ANY screen on the tenant reported. ` +
          `A low figure means our own collector was quiet, which is not a customer outage — ` +
          `it is measured tenant-wide because a per-site figure could not tell the two apart.`,
        Math.min(input.collectorObservedBuckets, window.expectedBuckets),
        window.expectedBuckets,
        "time-buckets",
      ),
      confidence: figure(
        fleetView.confidenceBreakdown as unknown as Record<string, number>,
        `Screens banded by how much of the window we observed them for.`,
        inScopeCount,
        inScopeCount,
      ),
      warnings: fleetView.warnings,
      screens: deviceWindows,
    },
    faults: {
      statement:
        openedInWindow === 0 && stillOpen === 0
          ? `No alert was raised for this scope in this window, and nothing is outstanding.`
          : `${openedInWindow} alert(s) were raised in this window; ${resolvedInWindow} were ` +
            `resolved in it; ${stillOpen} remain open as at ${input.generatedAt}` +
            (alerts.some((a) => a.role === "carried-in")
              ? `, including ${alerts.filter((a) => a.role === "carried-in").length} carried in ` +
                `from before the window.`
              : `.`),
      emptyStatement:
        alerts.length > 0
          ? null
          : inScopeCount === 0
            ? "No screens in scope, so there are no alerts to report."
            : observedCount === 0
              ? `No alerts in this window — but we also hold no readings for any screen in ` +
                `this scope across the window, so read this as "nothing was detected", not ` +
                `"nothing happened".`
              : `No alerts in this window. Nothing was raised for these ${inScopeCount} ` +
                `screen(s) between ${window.from} and ${window.to}, and nothing is outstanding ` +
                `from before it. This is an empty section because the estate was quiet, not ` +
                `because data is missing.`,
      openedInWindow: figure(openedInWindow, alertBasis, observedCount, inScopeCount,
        `Detected across the ${observedCount} of ${inScopeCount} screen(s) we hold readings ` +
          `for in this window; a fault on an unobserved screen could not raise an alert.`),
      openedBySeverity: figure(openedBySeverity, alertBasis, observedCount, inScopeCount),
      resolvedInWindow: figure(
        resolvedInWindow,
        `Alerts whose resolution timestamp falls inside the window, half-open. An alert opened ` +
          `before the window and resolved inside it counts here and not in "opened".`,
        observedCount,
        inScopeCount,
      ),
      stillOpen: figure(
        stillOpen,
        `Alerts for these screens with no resolution timestamp as at ${input.generatedAt}. ` +
          `This is a live figure, not an end-of-window one, because it is the list a customer ` +
          `is being asked to act on.`,
        observedCount,
        inScopeCount,
      ),
      stillOpenBySeverity: figure(stillOpenBySeverity, alertBasis, observedCount, inScopeCount),
      alerts,
    },
    changes: {
      statement:
        actions.length === 0
          ? `VFI made no changes to this estate in this window.`
          : `VFI performed ${actions.length} logged action(s) on this estate in this window.`,
      emptyStatement:
        actions.length > 0
          ? null
          : input.actionsLogSize === 0
            ? `VFI has never written to a device under this build, so nothing was changed on ` +
              `this estate. This log is only written when a write actually happens — nothing ` +
              `in it is inferred or backfilled.`
            : `VFI made no changes to this estate between ${window.from} and ${window.to}. ` +
              `Other estates were touched in this period, so the log is working; this scope ` +
              `simply had no writes.`,
      total: figure(
        actions.length,
        `Every device write VFI performed on these screens in the window, half-open on when ` +
          `the action STARTED. Sourced from our own append-only action log, not from the ` +
          `platform — it records what WE did, including the attempts that failed or were ` +
          `rolled back.`,
        inScopeCount,
        inScopeCount,
      ),
      byOutcome: figureOf(
        byOutcome,
        `Outcome of each logged action. A rolled-back or refused write is reported, not ` +
          `hidden: a preflight that declined to write is a safety feature and reads as one.`,
        actions.length,
        actions.length,
        "actions",
      ),
      actions,
      retention: {
        retainDays: AUDIT_RETAIN_DAYS,
        enforced: false,
        note:
          `The action log is bounded at ${AUDIT_RETAIN_DAYS} days as a ceiling and no pruning ` +
          `is wired up, so nothing has aged out: absence of a row means the action was not ` +
          `logged, not that it expired.`,
      },
    },
    content: {
      claim: "scheduled, not confirmed",
      basis: PROOF_OF_PLAY_BASIS,
      statement:
        `We can report what the platform SCHEDULED to play on these screens. We cannot ` +
        `confirm playback: there is no readable per-device render log at any scope, so ` +
        `nothing in this report evidences that a specific asset was rendered. Treat every ` +
        `content figure as scheduled, not confirmed.`,
      screensWithScheduleSnapshot: figure(
        scheduleSnapshotCount,
        input.schedule === null
          ? `The schedule snapshot store was not read for this report, so no screen can be ` +
            `reported as carrying a schedule.`
          : `Screens for which we hold a schedule snapshot from the schedule sweep. The sweep ` +
            `rotates, so a screen without a snapshot has not been reached yet — it does not ` +
            `mean the screen has no content.`,
        inScopeCount,
        inScopeCount,
      ),
      screensWithContentScheduled: figure(
        scheduledCount,
        `Screens whose most recent snapshot carried at least one scheduled item. SCHEDULED, ` +
          `NOT CONFIRMED — this is not evidence of playback.`,
        scheduleSnapshotCount,
        inScopeCount,
        `Computed from the ${scheduleSnapshotCount} of ${inScopeCount} screen(s) the schedule ` +
          `sweep has reached; the rest are unknown, not empty.`,
      ),
    },
    configuration: {
      statement:
        configCount === inScopeCount && inScopeCount > 0
          ? `We hold a configuration snapshot for every screen in this scope.`
          : `We hold a configuration snapshot for ${configCount} of ${inScopeCount} screen(s) ` +
            `in this scope. Configuration drift can only be reported for those; the rest are ` +
            `unassessed, not compliant.`,
      screensWithSnapshot: figure(
        configCount,
        `Screens with a stored settings snapshot and a compliance verdict computed from it. ` +
          `A screen without one is UNASSESSED — never reported as passing.`,
        inScopeCount,
        inScopeCount,
      ),
    },
    claims: {
      note:
        `Only the sla-grade list may be quoted as a commitment. The readable list is ` +
        `diagnostic: those dimensions can be read per device, on a rotation, at partial ` +
        `coverage — useful in a fault conversation and NOT something to promise. Promoting a ` +
        `readable dimension into a customer-facing number is a mistake this product has ` +
        `already made once. The unmeasurable list has no source at all.`,
      counts: figureOf(
        {
          slaGrade: input.measurability.slaGrade.length,
          readableNotClaimable: input.measurability.readable.length,
          unmeasurable: input.measurability.unmeasurable.length,
        },
        input.measurability.fromLiveCapability
          ? `Graded from what the fleet actually returned in the last capability window. ` +
            `Platform-wide, not per site: what we can measure is a property of the platform.`
          : `Graded with NO live capability sample, so nothing was promoted to SLA grade. ` +
            `This under-claims rather than over-claims.`,
        input.measurability.dimensions.length,
        input.measurability.dimensions.length,
        "dimensions",
      ),
      slaGrade: input.measurability.slaGrade,
      readableNotClaimable: input.measurability.readable,
      unmeasurable: input.measurability.unmeasurable,
    },
    limitations,
  };
}

/**
 * "What we could not see", as sentences.
 *
 * Its own function because it is the section a reviewer should read first, and
 * because the honest thing is for it to be assembled from the SAME numbers the
 * report publishes rather than written once as prose that then goes stale.
 */
function buildLimitations(x: {
  scope: ReportScope;
  window: ReportWindow;
  inScopeCount: number;
  /** Screens whose newest sample carries no presence value. */
  unknownStatusCount: number;
  observedCount: number;
  claimableCount: number;
  collectorCoverage: number;
  hardwareReached: number;
  configCount: number;
  scheduleSnapshotCount: number;
  unplacedInScope: number;
  measurability: MeasurabilityAssessment;
  devicesTruncated: boolean;
  alertsTruncated: boolean;
  actionsTruncated: boolean;
  scheduleRead: boolean;
}): string[] {
  const out: string[] = [];
  const n = x.inScopeCount;

  if (!x.scope.hierarchy.available) {
    out.push(
      `The group hierarchy could not be read, so no screen could be placed at a site: ` +
        `${x.scope.hierarchy.reason ?? NO_HIERARCHY_REASON}`,
    );
  } else if (x.scope.hierarchy.truncated) {
    out.push(
      `The group list was truncated when we read it, so some screens may be missing from ` +
        `this scope: ${x.scope.hierarchy.reason ?? "reason not reported"}.`,
    );
  }
  if (x.scope.hierarchy.ageSeconds !== null && x.scope.hierarchy.ageSeconds > 0) {
    out.push(
      `The site-to-screen mapping was read ${humanDuration(x.scope.hierarchy.ageSeconds)} ago ` +
        `and is cached, so a screen moved between sites since then is reported at its old site.`,
    );
  }
  if (x.unknownStatusCount > 0) {
    out.push(
      `${x.unknownStatusCount} of ${n} screen(s) show a point-in-time status of "unknown" ` +
        `because the newest sample we hold for them carries no presence value. That is a ` +
        `property of the newest row, not evidence the screen was never seen — ${x.observedCount} ` +
        `screen(s) in this scope were observed during the window. Read the two sections ` +
        `together, not against each other.`,
    );
  }
  if (x.observedCount < n) {
    out.push(
      `${n - x.observedCount} of ${n} screen(s) produced no presence reading at all in this ` +
        `window. Their uptime is reported as null, and any fault they had is invisible to us.`,
    );
  }
  if (x.claimableCount < n) {
    out.push(
      `${n - x.claimableCount} of ${n} screen(s) do not have enough collection coverage for ` +
        `their uptime to be quoted externally. Their figures are shown for diagnosis only.`,
    );
  }
  if (x.collectorCoverage < 1) {
    out.push(
      `Tenant-wide, we hold readings for ${pct(x.collectorCoverage)} of this window's time ` +
        `buckets. The rest is time in which NO screen anywhere reported, which is our ` +
        `collector being quiet rather than the estate being down — either the collector was ` +
        `not running, or the window reaches back before continuous collection began. We ` +
        `cannot tell those two apart from bucket counts alone, and uptime is not assertable ` +
        `across the gap either way.`,
    );
  }
  out.push(
    `Per-screen longest outage gap is not computed for a custom window in this report — only ` +
      `total unobserved time is. The SLA endpoint computes gaps for windows ending now.`,
  );
  out.push(
    `Fleet-wide collector blind windows (the exact minutes nobody reported) are not ` +
      `recomputed for a custom window here; tenant-wide collector coverage above is the ` +
      `substitute.`,
  );
  if (x.hardwareReached < n) {
    out.push(
      `Per-device hardware telemetry (CPU, memory, storage, signal) has reached ` +
        `${x.hardwareReached} of ${n} screen(s). It is collected by a rotating per-device ` +
        `sweep, not a fleet feed, so a screen it has not reached shows no reading rather than ` +
        `a zero — and the readings it does hold can be hours old.`,
    );
  }
  if (x.configCount < n) {
    out.push(
      `${n - x.configCount} of ${n} screen(s) have no configuration snapshot, so their ` +
        `compliance is UNASSESSED. They are not counted as compliant.`,
    );
  }
  if (!x.scheduleRead) {
    out.push(`Schedule snapshots were not read for this report, so content is unreported.`);
  } else if (x.scheduleSnapshotCount < n) {
    out.push(
      `${n - x.scheduleSnapshotCount} of ${n} screen(s) have not been reached by the schedule ` +
        `sweep yet, so we cannot say what was scheduled on them.`,
    );
  }
  out.push(
    `Playback is NEVER confirmed. There is no readable per-device render log at any scope, so ` +
      `nothing here evidences that a specific asset was rendered on a specific screen.`,
  );
  if (x.measurability.readable.length > 0) {
    out.push(
      `${x.measurability.readable.length} measurement dimension(s) are readable per device but ` +
        `NOT to SLA grade (${x.measurability.readable.map((d) => d.dimension).join(", ")}). ` +
        `They appear in this report for diagnosis and must not be quoted as a commitment.`,
    );
  }
  if (x.measurability.unmeasurable.length > 0) {
    out.push(
      `${x.measurability.unmeasurable.length} dimension(s) cannot be measured at all on this ` +
        `platform (${x.measurability.unmeasurable.map((d) => d.dimension).join(", ")}). Do not ` +
        `agree SLA language referencing them.`,
    );
  }
  if (!x.measurability.fromLiveCapability) {
    out.push(
      `Measurability was graded with no live capability sample, so nothing was promoted to SLA ` +
        `grade; that list under-claims until the capability probe runs.`,
    );
  }
  if (x.scope.kind === "site" && x.scope.hierarchy.groupsMatched === 0) {
    out.push(
      `The requested site resolved to no groups, so this report is empty by construction ` +
        `rather than because the site has no screens. Check the site id.`,
    );
  }
  if (x.scope.kind !== "unplaced" && x.unplacedInScope > 0) {
    out.push(
      `${x.unplacedInScope} screen(s) in this scope resolve to no site. They are counted here ` +
        `and are also reportable on their own as scope=unplaced.`,
    );
  }
  if (x.devicesTruncated) out.push(`The screen list hit this report's page ceiling and is TRUNCATED.`);
  if (x.alertsTruncated) out.push(`The alert list hit this report's page ceiling and is TRUNCATED.`);
  if (x.actionsTruncated) out.push(`The action log read hit this report's page ceiling and is TRUNCATED.`);
  return out;
}

// ── CSV ──────────────────────────────────────────────────────────────────────
//
// JSON is the API shape; a customer needs something they can open. Only the
// TABULAR parts are offered as CSV, because a nested document flattened into a
// spreadsheet stops being readable — which is the complaint this whole endpoint
// answers.

export const CSV_SECTIONS = ["devices", "alerts", "actions"] as const;
export type CsvSection = (typeof CSV_SECTIONS)[number];

/** RFC 4180 line ending. Excel is the target reader and it wants CRLF. */
const CRLF = "\r\n";

/**
 * Escape ONE field, RFC 4180.
 *
 * Quoting rules, each earned by something in this fleet's data:
 *   - a comma, a double quote, CR or LF forces quoting; internal quotes double;
 *   - LEADING OR TRAILING WHITESPACE forces quoting too, which RFC 4180 does not
 *     require. This tenant has device names with trailing spaces and names
 *     wrapped in brackets; an unquoted trailing space is silently eaten by most
 *     readers, and then the name in the customer's spreadsheet is not the name on
 *     the platform. Quoting preserves it byte-for-byte.
 *
 * `null` and `undefined` become an EMPTY cell, never `0` and never the string
 * "null" — the honest-null rule, carried into a format that has no null. The
 * preamble states what an empty cell means so the reader is not left to guess.
 *
 * Nothing is ever rewritten. A value that would be interpreted as a formula by a
 * spreadsheet is quoted and reported (see `hasFormulaRisk`) rather than prefixed
 * with an apostrophe, because mutating a device name to make a spreadsheet
 * behave is exactly the kind of quiet falsification this codebase refuses.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "boolean") text = value ? "true" : "false";
  else if (typeof value === "number") text = Number.isFinite(value) ? String(value) : "";
  else text = JSON.stringify(value) ?? "";
  const needsQuote =
    text.includes(",") ||
    text.includes('"') ||
    text.includes("\n") ||
    text.includes("\r") ||
    text !== text.trim();
  return needsQuote ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Leading characters a spreadsheet treats as the start of a formula. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function hasFormulaRisk(rows: readonly (readonly unknown[])[]): boolean {
  return rows.some((row) =>
    row.some((cell) => typeof cell === "string" && FORMULA_LEAD.test(cell)),
  );
}

export function toCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [headers.map(csvField).join(",")];
  for (const row of rows) lines.push(row.map(csvField).join(","));
  return lines.join(CRLF) + CRLF;
}

interface CsvTable {
  headers: readonly string[];
  rows: unknown[][];
  /** Non-null when the table is legitimately empty. */
  emptyStatement: string | null;
  /** The section's own coverage sentence, for the preamble. */
  coverageNote: string;
}

/** Pure: one section of a built report as a table. */
export function csvTable(report: EstateReport, section: CsvSection): CsvTable {
  switch (section) {
    case "devices":
      return {
        headers: [
          "device_id", "name", "location", "site", "site_resolved", "site_note",
          "device_class", "model", "status", "last_online_time", "firmware_current",
          "firmware_behind", "open_alerts", "collection_coverage", "observed_uptime",
          "uptime_claimable", "availability_statement", "hardware_reading_at",
        ],
        rows: report.estate.inventory.map((d) => [
          d.deviceId, d.name, d.location, d.siteName, d.siteResolved, d.siteNote,
          d.deviceClass, d.modelType, d.status, d.lastOnlineTime, d.firmwareCurrent,
          d.firmwareBehind, d.openAlerts, d.collectionCoverage, d.observedUptime,
          d.uptimeClaimable, d.availabilityStatement, d.hardwareReadingAt,
        ]),
        emptyStatement:
          report.estate.inventory.length > 0
            ? null
            : "No screen in our inventory resolves to this scope, so there is no inventory to list.",
        coverageNote: report.estate.screens.coverage.note,
      };
    case "alerts":
      return {
        headers: [
          "alert_id", "device_id", "device_name", "site", "severity", "rule_id", "title",
          "window_role", "state_now", "opened_at", "last_fired_at", "acknowledged_at",
          "resolved_at",
        ],
        rows: report.faults.alerts.map((a) => [
          a.id, a.deviceId, a.deviceName, a.siteName, a.severity, a.ruleId, a.title,
          a.role, a.stateNow, a.openedAt, a.lastFiredAt, a.acknowledgedAt, a.resolvedAt,
        ]),
        emptyStatement: report.faults.emptyStatement,
        coverageNote: report.faults.openedInWindow.coverage.note,
      };
    case "actions":
      return {
        headers: [
          "action_id", "started_at", "finished_at", "device_id", "device_name", "site",
          "action", "verb", "requested_value", "observed_value", "outcome", "actor",
          "duration_ms", "error",
        ],
        rows: report.changes.actions.map((a) => [
          a.id, a.startedAt, a.finishedAt, a.deviceId, a.deviceName, a.siteName,
          a.action, a.verb, a.requestedValue, a.observedValue, a.outcome, a.actor,
          a.durationMs, a.error,
        ]),
        emptyStatement: report.changes.emptyStatement,
        coverageNote: report.changes.total.coverage.note,
      };
  }
}

/**
 * Render one section as a self-describing CSV.
 *
 * The `#` preamble is the "self-describing artefact" requirement: a file
 * detached from the API — mailed to a customer, dropped in a ticket — must still
 * say what it covers, when it was generated, over what window, and at what
 * coverage. A spreadsheet shows the preamble as a few leading rows, which is a
 * readability cost worth paying for a file nobody can misattribute; machine
 * consumers turn it off with `preamble=false` and get the header on line 1.
 *
 * An empty table emits its header AND a `# NOTE:` line saying which empty it is,
 * so a quiet estate never reads as a broken export.
 */
export function renderCsv(
  report: EstateReport,
  section: CsvSection,
  options: { preamble?: boolean } = {},
): string {
  const table = csvTable(report, section);
  const body = toCsv(table.headers, table.rows);
  if (options.preamble === false) return body;

  const lines = [
    `# Videri Fleet Intelligence — estate report, "${section}" table`,
    `# Scope: ${report.scope.label}${report.scope.siteId ? ` (site ${report.scope.siteId})` : ""}`,
    `# Screens in scope: ${report.estate.screens.value}`,
    `# Window: ${report.window.from} up to (not including) ${report.window.to}` +
      ` — half-open, so adjacent reports never double-count`,
    `# Generated at: ${report.generatedAt}`,
    `# Rows: ${table.rows.length}`,
    `# Coverage: ${table.coverageNote}`,
    `# An empty cell means the value could not be read. It is never a zero.`,
    `# Playback is scheduled, not confirmed: nothing here evidences rendered pixels.`,
  ];
  if (table.emptyStatement) lines.push(`# NOTE: ${table.emptyStatement}`);
  if (hasFormulaRisk(table.rows)) {
    lines.push(
      `# WARNING: at least one value begins with =, +, - or @ and will be read as a formula` +
        ` by a spreadsheet. The values are unmodified here on purpose; open with an import` +
        ` that treats every column as text.`,
    );
  }
  // Comment lines are NOT CSV fields — quoting them would put stray quotes in
  // front of a human reader — but any CR/LF inside one is collapsed so a value
  // interpolated into the preamble can never inject a fake data row.
  return lines.map((line) => line.replace(/[\r\n]+/g, " ")).join(CRLF) + CRLF + body;
}

/** Filesystem-safe slug for the download filename. Never used as an identity. */
export function filenameSlug(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug === "" ? "scope" : slug.slice(0, 60);
}

// ── the route ────────────────────────────────────────────────────────────────

/** Rows per underlying read. */
const PAGE_SIZE = 500;
/**
 * Page ceiling per collection. 10,000 rows is far above this tenant (248 screens,
 * ~300 alerts) and exists so a report request can never turn into an unbounded
 * walk. Hitting it is DISCLOSED in `limitations`, never silently truncated.
 */
const MAX_PAGES = 20;

/** The longest window this report will compute. Beyond it, sample history thins. */
const MAX_WINDOW_DAYS = 92;

async function collectPages<T>(
  fetchPage: (page: number) => Promise<{ items: T[]; totalItems: number }>,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let page = 1;
  for (;;) {
    const result = await fetchPage(page);
    items.push(...result.items);
    if (items.length >= result.totalItems || result.items.length === 0) {
      return { items, truncated: false };
    }
    page += 1;
    if (page > MAX_PAGES) return { items, truncated: true };
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/**
 * `queries.alerts()` returns loosely typed records (it serves several consumers
 * with different needs). Narrow ONCE, here, and drop a row we cannot key or
 * place in time rather than defaulting its timestamp — a fabricated `openedAt`
 * would land the alert in the wrong window.
 */
export function toReportAlert(record: Record<string, unknown>): ReportAlertInput | null {
  const id = str(record["id"]);
  const deviceId = str(record["deviceId"]);
  const openedAt = str(record["openedAt"]);
  const severity = str(record["severity"]);
  if (!id || !deviceId || !openedAt || !severity) return null;
  return {
    id,
    deviceId,
    deviceName: str(record["deviceName"]),
    ruleId: str(record["ruleId"]),
    severity,
    title: str(record["title"]),
    openedAt,
    lastFiredAt: str(record["lastFiredAt"]),
    acknowledgedAt: str(record["acknowledgedAt"]),
    resolvedAt: str(record["resolvedAt"]),
  };
}

const Query = z.object({
  /**
   * `unplaced` is a scope, not an error state. 16 of this tenant's 248 screens
   * resolve to no site; a product that can only report per-site would leave them
   * uncounted, which is the failure this whole axis exists to avoid.
   */
  scope: z.enum(["site", "unplaced", "fleet"]).default("site"),
  siteId: z.string().min(1).max(200).optional(),
  /** Half-open window [from, to). Both optional; `windowDays` fills the gap. */
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  windowDays: z.coerce.number().int().min(1).max(MAX_WINDOW_DAYS).default(7),
  bucketSeconds: z.coerce.number().int().min(60).max(3600).default(300),
  format: z.enum(["json", "csv"]).default("json"),
  section: z.enum(CSV_SECTIONS).optional(),
  /** Preamble on by default: the artefact has to describe itself. */
  preamble: z.enum(["true", "false", "1", "0"]).default("true").transform((v) => v === "true" || v === "1"),
});

export async function registerReportRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  /**
   * Its own cache instance, matching routes/devices.ts: sharing one would mean
   * widening ApiContext, and each consumer reports its own mapping age honestly
   * so neither can borrow the other's freshness.
   */
  const siteCache = ctx.videri ? new GroupSiteCache(ctx.videri) : null;

  const capability: CapabilitySources = {
    telemetryAvailability: () => ctx.queries.telemetryAvailability(),
    pollerRunHistory: (opts) => ctx.repo.pollerRunHistory(opts),
    screenshotTargets: (onlineOnly, limit) => ctx.repo.screenshotTargets(onlineOnly, limit),
  };

  const readHierarchy = async (): Promise<{
    resolution: SiteResolution;
    ageSeconds: number | null;
    groupsRead: number;
    groupsTotal: number | null;
    truncated: boolean;
  }> => {
    const hierarchy = await (siteCache?.get() ?? Promise.resolve(null));
    return {
      resolution: {
        index: hierarchy?.index ?? null,
        reason: hierarchy === null ? NO_HIERARCHY_REASON : hierarchy.reason,
      },
      ageSeconds: hierarchy?.ageSeconds ?? null,
      groupsRead: hierarchy?.groupsRead ?? 0,
      groupsTotal: hierarchy?.groupsTotal ?? null,
      truncated: hierarchy?.truncated ?? false,
    };
  };

  const allDevices = async (
    resolution: SiteResolution,
    siteGroupIds: string[] | undefined,
  ): Promise<{ items: DeviceListItem[]; truncated: boolean }> =>
    collectPages((page) =>
      ctx.queries.devices(
        {
          page,
          limit: PAGE_SIZE,
          sort: "name",
          direction: "asc",
          ...(siteGroupIds === undefined ? {} : { siteGroupIds }),
        },
        resolution,
      ),
    );

  /**
   * The scope picker: every site with a screen count, plus the unplaced cohort.
   *
   * Exists because a report you cannot address is not a feature — a technician
   * needs the list of things they can run a report FOR, and until now the site
   * axis was only discoverable by paging /api/devices and grouping by hand.
   * `unplaced` appears in the same list as a real site, with `kind` telling them
   * apart, so it can never be mistaken for a customer and can never be forgotten.
   */
  app.get("/api/reports/sites", async (_request, reply) => {
    const [hierarchy, freshness] = await Promise.all([readHierarchy(), ctx.freshness()]);
    const devices = await allDevices(hierarchy.resolution, undefined);

    const bySite = new Map<string, { siteId: string; siteName: string | null; screens: number }>();
    let unplaced = 0;
    const unplacedReasons = new Map<string, number>();
    for (const d of devices.items) {
      if (d.site.resolved && d.site.id) {
        const entry = bySite.get(d.site.id) ?? { siteId: d.site.id, siteName: d.site.name, screens: 0 };
        entry.screens += 1;
        bySite.set(d.site.id, entry);
        continue;
      }
      unplaced += 1;
      const reason = d.site.reason ?? "No reason recorded.";
      unplacedReasons.set(reason, (unplacedReasons.get(reason) ?? 0) + 1);
    }

    return reply.send(
      envelope(
        {
          scopes: [
            ...[...bySite.values()]
              .sort((a, b) => b.screens - a.screens || (a.siteName ?? "").localeCompare(b.siteName ?? ""))
              .map((s) => ({
                kind: "site" as const,
                siteId: s.siteId,
                label: s.siteName ?? `Unnamed site ${s.siteId}`,
                screens: s.screens,
                reportUrl: `/api/reports/estate?scope=site&siteId=${encodeURIComponent(s.siteId)}`,
              })),
            {
              kind: "unplaced" as const,
              siteId: null,
              label: "Unplaced screens (no site resolved)",
              screens: unplaced,
              reportUrl: "/api/reports/estate?scope=unplaced",
            },
          ],
          totals: {
            screens: devices.items.length,
            placed: devices.items.length - unplaced,
            unplaced,
            sites: bySite.size,
          },
          /** Why each unplaced screen is unplaced, so the cohort is actionable. */
          unplacedReasons: [...unplacedReasons.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([reason, screens]) => ({ reason, screens })),
          hierarchy: {
            available: hierarchy.resolution.index !== null,
            ageSeconds: hierarchy.ageSeconds,
            groupsRead: hierarchy.groupsRead,
            groupsTotal: hierarchy.groupsTotal,
            truncated: hierarchy.truncated,
            reason: hierarchy.resolution.reason,
          },
          truncated: devices.truncated,
        },
        freshness,
      ),
    );
  });

  /**
   * The estate report — one site (i.e. one customer), one stated window.
   *
   * Answers the six questions a technician is actually asked: how many screens,
   * how many were reachable, what broke, what is still open, what we changed,
   * and what we could NOT see. Every figure carries its basis and its
   * denominator; the last question has its own section rather than a footnote.
   */
  app.get("/api/reports/estate", async (request, reply) => {
    const parsed = Query.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "bad_request",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }
    const q = parsed.data;

    if (q.scope === "site" && !q.siteId) {
      return reply.code(400).send({
        error: "bad_request",
        message:
          "`siteId` is required for scope=site. Call GET /api/reports/sites for the list of " +
          "sites and their screen counts, or use scope=unplaced for the screens that resolve " +
          "to no site, or scope=fleet for the whole estate.",
      });
    }
    if (q.scope !== "site" && q.siteId) {
      return reply.code(400).send({
        error: "bad_request",
        message: `\`siteId\` is meaningless with scope=${q.scope}; drop one or the other rather ` +
          `than letting the report claim a scope it did not apply.`,
      });
    }
    if (q.format === "csv" && !q.section) {
      return reply.code(400).send({
        error: "bad_request",
        message:
          `\`section\` is required for format=csv — a CSV cannot carry the whole report. ` +
          `Choose one of: ${CSV_SECTIONS.join(", ")}. Use format=json for the full document.`,
      });
    }

    // Window: half-open [from, to). `to` defaults to now, `from` to `windowDays`
    // before it. Given both, they are used verbatim so a monthly report is
    // reproducible; given neither, the default is a rolling week.
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - q.windowDays * 86_400_000);
    if (from.getTime() >= to.getTime()) {
      return reply.code(400).send({
        error: "bad_request",
        message: "`from` must be earlier than `to`; the window is half-open [from, to).",
      });
    }
    if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * 86_400_000) {
      return reply.code(400).send({
        error: "bad_request",
        message:
          `The window may not exceed ${MAX_WINDOW_DAYS} days. Beyond that, sample history is ` +
          `too thin for the coverage figures in this report to mean anything.`,
      });
    }
    const window = buildWindow(from.toISOString(), to.toISOString(), q.bucketSeconds);

    const hierarchy = await readHierarchy();
    // Site → group ids via the SAME resolveSite the row projection uses, so the
    // SQL narrowing and the printed site can never disagree. Fails closed: a
    // site id that resolves to no group matches nothing, and `limitations` says
    // the report is empty by construction rather than by fact.
    const siteGroupIds =
      q.scope === "site"
        ? hierarchy.resolution.index === null
          ? []
          : groupIdsForSites(hierarchy.resolution.index, [q.siteId!])
        : undefined;

    const fetched = await allDevices(hierarchy.resolution, siteGroupIds);
    // Narrowed again in-process. `inScope` is the authority — it reads the same
    // projection the report prints — and it is the ONLY way to express the
    // unplaced cohort, which no group-id predicate can select.
    const devices = fetched.items.filter((d) => inScope(d, { kind: q.scope, siteId: q.siteId ?? null }));
    const deviceIds = devices.map((d) => d.id);
    const siteName = devices.find((d) => d.site.resolved)?.site.name ?? null;

    const label =
      q.scope === "fleet"
        ? "Whole estate (all sites, including unplaced screens)"
        : q.scope === "unplaced"
          ? "Unplaced screens (no site resolved)"
          : (siteName ?? `Unnamed site ${q.siteId}`);

    const scope: ReportScope = {
      kind: q.scope,
      siteId: q.siteId ?? null,
      siteName: q.scope === "site" ? siteName : null,
      label,
      statement:
        q.scope === "site"
          ? `This report covers only the screens VFI resolves to site ${q.siteId}` +
            `${siteName ? ` ("${siteName}")` : ""} — ${devices.length} screen(s). Screens at ` +
            `other sites, and screens that resolve to no site, are excluded and are reported ` +
            `separately.`
          : q.scope === "unplaced"
            ? `This report covers the ${devices.length} screen(s) that resolve to NO site: they ` +
              `carry no group, a group we could not read, or a group at the tenant root. They ` +
              `are reported here rather than dropped from a customer's count or filed under an ` +
              `invented site.`
            : `This report covers all ${devices.length} active screen(s) on the tenant, placed ` +
              `and unplaced together. It is not a per-customer report.`,
      hierarchy: {
        available: hierarchy.resolution.index !== null,
        ageSeconds: hierarchy.ageSeconds,
        groupsRead: hierarchy.groupsRead,
        groupsTotal: hierarchy.groupsTotal,
        truncated: hierarchy.truncated,
        reason: hierarchy.resolution.reason,
        groupsMatched: siteGroupIds?.length ?? null,
      },
    };

    const [
      freshness,
      fleetCount,
      presence,
      alertPages,
      actionPages,
      actionsLogSize,
      compliancePages,
      schedules,
      measurability,
    ] = await Promise.all([
      ctx.freshness(),
      // Count-only: the tenant's active screen total, for scope context.
      ctx.queries.devices({ page: 1, limit: 0, sort: "name", direction: "asc" }, hierarchy.resolution),
      ctx.queries.availabilityBuckets(window.from, window.to, window.bucketSeconds),
      collectPages((page) =>
        ctx.queries.alerts({ page, limit: PAGE_SIZE, state: "all", deviceIds }),
      ),
      collectPages(async (page) => {
        // No `deviceIds` filter exists on the action log yet, so the window is
        // pushed into SQL and the scope is applied in process. Correct, and
        // cheap at this log size; see the note in the report for reviewers.
        const result = await ctx.repo.listDeviceActions({
          since: from,
          until: to,
          page,
          limit: PAGE_SIZE,
        });
        return { items: result.items, totalItems: result.totalItems };
      }),
      ctx.repo.deviceActionLogSize(),
      collectPages((page) => ctx.queries.compliance({ page, limit: PAGE_SIZE })),
      ctx.queries.popPersistedSchedules(),
      loadMeasurability(capability),
    ]);

    const alerts = alertPages.items
      .map((r) => toReportAlert(r))
      .filter((a): a is ReportAlertInput => a !== null);

    const report = buildEstateReport({
      generatedAt: new Date().toISOString(),
      scope,
      window,
      devices,
      devicesTruncated: fetched.truncated,
      fleetScreens: fleetCount.totalItems,
      presence: presence.devices.map((d) => ({
        deviceId: d.deviceId,
        observedBuckets: d.observedBuckets,
        onlineBuckets: d.onlineBuckets,
      })),
      collectorObservedBuckets: presence.fleetObservedBuckets,
      alerts,
      alertsTruncated: alertPages.truncated,
      actions: actionPages.items,
      actionsTruncated: actionPages.truncated,
      actionsLogSize,
      configSnapshotDeviceIds: new Set(
        compliancePages.items.map((r) => String(r["deviceId"] ?? "")).filter(Boolean),
      ),
      schedule: {
        snapshotDeviceIds: new Set(schedules.devices.map((d) => d.id)),
        scheduledDeviceIds: new Set(
          schedules.devices.filter((d) => d.scheduledCount > 0).map((d) => d.id),
        ),
        oldestSnapshotAt: schedules.devices[0]?.fetchedAt ?? null,
      },
      measurability,
    });

    if (q.format === "csv") {
      const section = q.section!;
      const name =
        `vfi-estate-${filenameSlug(report.scope.label)}-${section}-` +
        `${window.from.slice(0, 10)}-to-${window.to.slice(0, 10)}.csv`;
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="${name}"`)
        .send(renderCsv(report, section, { preamble: q.preamble }));
    }

    return reply.send(envelope(report, freshness));
  });
}
