/**
 * Alert suppression — the operator's own conclusion, recorded. Epic 8.2,
 * GAP-2/GAP-3, US-8.2.4 (snooze) and US-8.2.5 (intent / "by design").
 *
 * THE PROBLEM THIS SOLVES
 * VFI decides a great deal about what is by design — dormancy bands, schedule
 * windows, blank-cause classification — and gave the operator no way to record a
 * single conclusion of their own. 42 of 250 active devices carry their purpose
 * in their own NAME (`SparkBridge (EoL)`, `Lab TCL`, `Travel Case Unit`,
 * `stephen.jenkins@videri.com-6`); 39 of them hold 22% of the open queue. Every
 * shift re-triaged them from scratch, because there was nowhere to put the
 * sentence "this one is meant to be like this".
 *
 * WHAT A SUPPRESSION IS
 * A durable, attributed, reversible statement that named alerts on a named
 * device are expected. It is NOT a delete, a resolve, a filter or a mute:
 *
 *   - the alert stays OPEN in the `alerts` table, keeps its evidence, its
 *     `opened_at` and its severity;
 *   - it moves out of the incident band into a `suppressed` band that is counted
 *     in a chip, drilled into by alert id, and reconciled against the grand
 *     total by `bandsSumToTotal` below;
 *   - it comes BACK, at its normal rank, the moment the suppression lapses. The
 *     expiry is not a courtesy, it is the mechanism that stops this becoming the
 *     way the monitoring rots.
 *
 * This is deliberately the dormant band's pattern (hygiene.ts), which docs/25
 * rates as the thing in this product that works: moved out of the queue, never
 * deleted, count always visible, criticals never absorbed.
 *
 * THE FOUR PROPERTIES, AND WHY EACH IS NON-NEGOTIABLE
 *
 * 1. SCOPE — both per-device and per-device+rule, and we need both.
 *    A whole-device suppression (`ruleId === null`) is blunt, and it is exactly
 *    right for the case that dominates the data: "this unit lives in the lab" is
 *    a statement about the ASSET, and making a tech mute five rules on it
 *    guarantees an incomplete mute that re-fires the day a sixth rule opens.
 *    A device+rule suppression is precise, and it is the only safe scope for a
 *    live production device: "the brightness drift on the lobby screen is
 *    deliberate" must not also silence that screen going offline. So the scope
 *    is chosen by what is being claimed, and the narrower one wins on match so
 *    the operator sees the most specific reason recorded.
 *
 * 2. REASON — mandatory, minimum length enforced in the DATABASE.
 *    A suppression with no reason is indistinguishable from a bug six weeks
 *    later, and the person who has to tell them apart is not the person who
 *    created it. `MIN_REASON_LENGTH` is small but non-zero: enough to stop `.`
 *    and `x`, not enough to be a form to fight.
 *
 * 3. EXPIRY — finite by default, infinite only on request.
 *    Default `DEFAULT_EXPIRY_DAYS` = 30. Chosen to match, not to be round: 30
 *    days is the same horizon as the `offline-30d` dormancy rule, so a
 *    suppression that has outlived its reason resurfaces on the cadence the
 *    operator already reviews the estate on. A hard cap of
 *    `MAX_EXPIRY_DAYS` = 365 exists because a five-year expiry is "forever"
 *    wearing a disguise, and if you mean forever you must say so: `expiresAt
 *    === null` is legal, but only when `neverExpires` was set explicitly — the
 *    database CHECK will not accept one without the other. That is for the
 *    genuinely retired asset, and it is a different decision, made deliberately.
 *
 * 4. ATTRIBUTION — `createdBy` and `createdAt` always; `revokedBy`,
 *    `revokedAt`, `revokedReason` on un-suppression. Revocation is an UPDATE of
 *    those three columns and never a DELETE, so "who un-muted the EoL device the
 *    week it caught fire" has an answer.
 *
 * CRITICAL AND HIGH
 * A whole-device suppression can NEVER absorb a critical or high alert. Not by
 * default, not with a flag — the database CHECK forbids the combination. This
 * mirrors `NEVER_ABSORBED` in hygiene.ts and for the same reason: if a rule
 * fires CRITICAL on a device we believe is a lab spare, that is news, and
 * burying it is the exact failure this module exists to prevent.
 *
 * A device+RULE suppression may absorb them, and only with
 * `includeCriticalHigh: true` set explicitly on that record. That is admissible
 * because naming the rule names the alert class: the operator has said "the
 * `offline-30d` critical on THIS device is expected", which is a specific
 * claim about a specific known alert, not a blanket. Every such record is listed
 * by id in `notes` so it is loud rather than merely legal.
 *
 * Pure. `loadSuppressionView` at the bottom is the only I/O.
 */

import type { Severity } from "../domain/types.js";
import type { Repository } from "../db/repository.js";
import type { DeviceIntentKind, RecordedIntent } from "../intelligence/device-intent.js";
import { SEVERITY_ORDER, type AlertBand, type OpenAlertFact } from "./hygiene.js";

/** Minimum trimmed reason length. See property 2 in the header. */
export const MIN_REASON_LENGTH = 8;
/** Default suppression lifetime, in days. Matches the `offline-30d` horizon. */
export const DEFAULT_EXPIRY_DAYS = 30;
/** Hard cap on a finite expiry. Beyond this, say `neverExpires` and mean it. */
export const MAX_EXPIRY_DAYS = 365;

/**
 * Severities a WHOLE-DEVICE suppression can never absorb. Deliberately the same
 * set, and the same name, as hygiene.ts — if one of them is ever widened the
 * other must be too, and identical names make that grep-able.
 */
export const NEVER_ABSORBED: ReadonlySet<Severity> = new Set<Severity>(["critical", "high"]);

/** One suppression record, as stored. Dates are real `Date`s in this layer. */
export interface SuppressionRecord {
  id: string;
  deviceId: string;
  /** `null` = the whole device. A rule id = that rule on that device only. */
  ruleId: string | null;
  reason: string;
  /**
   * The operator's recorded purpose for the asset, when they gave one. This is
   * what outranks `inferDeviceIntent` — including `"none"`, which is how an
   * operator says "the name is lying, this is production". `null` means they
   * suppressed without making a claim about purpose (a snooze, not an intent).
   */
  intent: DeviceIntentKind | null;
  /** Only ever true on a rule-scoped record; the database CHECK enforces it. */
  includeCriticalHigh: boolean;
  createdBy: string;
  createdAt: Date;
  /** `null` only in combination with `neverExpires` — see the header. */
  expiresAt: Date | null;
  neverExpires: boolean;
  revokedAt: Date | null;
  revokedBy: string | null;
  revokedReason: string | null;
}

/** Why a suppression is not in force. `null` in `state` means it is. */
export type SuppressionLapseReason = "revoked" | "expired";

export interface SuppressionStatus {
  active: boolean;
  /** Non-null exactly when `active` is false. */
  lapsed: SuppressionLapseReason | null;
  /** Seconds until expiry; negative once lapsed, `null` when it never expires. */
  secondsUntilExpiry: number | null;
}

/**
 * Is this record in force right now?
 *
 * The expiry boundary is CLOSED at the start and OPEN at the end: a suppression
 * is active while `now < expiresAt` and lapsed at `now === expiresAt`. Picked so
 * that two consecutive suppressions cannot both cover the same instant, which is
 * the same half-open convention the audit window uses.
 */
export function suppressionStatus(record: SuppressionRecord, now: Date): SuppressionStatus {
  if (record.revokedAt !== null) {
    return { active: false, lapsed: "revoked", secondsUntilExpiry: null };
  }
  if (record.expiresAt === null) {
    return { active: true, lapsed: null, secondsUntilExpiry: null };
  }
  const seconds = (record.expiresAt.getTime() - now.getTime()) / 1000;
  return seconds > 0
    ? { active: true, lapsed: null, secondsUntilExpiry: seconds }
    : { active: false, lapsed: "expired", secondsUntilExpiry: seconds };
}

/**
 * Which suppression, if any, silences this alert — and if none does, why not.
 *
 * Returns the winning record plus the ones that MATCHED THE DEVICE but were
 * refused, because "there is a suppression on this device and your critical came
 * through anyway" is a thing an operator must be able to see without reading
 * this file.
 */
export interface SuppressionMatch {
  /** The record that suppresses it, or `null` if it is not suppressed. */
  by: SuppressionRecord | null;
  /**
   * Active records that cover this alert's device but did NOT suppress it, with
   * the reason they were refused. Almost always the critical/high safety valve.
   */
  refused: Array<{ record: SuppressionRecord; because: string }>;
}

/**
 * Match one alert against the active suppressions. Most specific wins.
 *
 * Precedence is rule-scoped over device-scoped, and among equals the most
 * recently created. Not arbitrary: the narrowest record is the one whose reason
 * is actually about this alert, and it is that reason the operator needs to read
 * six weeks later.
 */
export function matchSuppression(
  alert: Pick<OpenAlertFact, "deviceId" | "ruleId" | "severity">,
  active: readonly SuppressionRecord[],
): SuppressionMatch {
  const refused: SuppressionMatch["refused"] = [];
  const candidates: SuppressionRecord[] = [];

  for (const record of active) {
    if (record.deviceId !== alert.deviceId) continue;
    if (record.ruleId !== null && record.ruleId !== alert.ruleId) continue;

    // An intent of `none` is an operator saying "this device is production" — it
    // is a statement ABOUT the asset, not a request to silence it, so it never
    // suppresses. Recording it is still the point: it beats the name heuristic.
    if (record.intent === "none") {
      refused.push({
        record,
        because:
          "this record states the device IS production (intent `none`); it overrides the " +
          "name heuristic but suppresses nothing",
      });
      continue;
    }

    if (NEVER_ABSORBED.has(alert.severity)) {
      if (record.ruleId === null) {
        refused.push({
          record,
          because:
            `a whole-device suppression can never absorb a ${alert.severity} alert. If a ` +
            `${alert.severity} rule fires on a device we believe is by-design, the device ` +
            `spoke — that is news. Suppress the specific rule instead, with ` +
            `includeCriticalHigh.`,
        });
        continue;
      }
      if (!record.includeCriticalHigh) {
        refused.push({
          record,
          because:
            `this rule-scoped suppression did not set includeCriticalHigh, so the ` +
            `${alert.severity} alert stays in the incident list`,
        });
        continue;
      }
    }
    candidates.push(record);
  }

  candidates.sort((a, b) => {
    const specificity = (a.ruleId === null ? 1 : 0) - (b.ruleId === null ? 1 : 0);
    if (specificity !== 0) return specificity;
    const recency = b.createdAt.getTime() - a.createdAt.getTime();
    if (recency !== 0) return recency;
    return a.id.localeCompare(b.id);
  });

  return { by: candidates[0] ?? null, refused };
}

/** The suppression band, shaped like the dormant band so the UI reuses its pattern. */
export interface SuppressionBand extends AlertBand {
  /**
   * The ALERT ids in this band — the authoritative membership.
   *
   * Published for the same reason `dormant.alertIds` is: a client that tried to
   * reproduce the band from device ids would get it WRONG, because a critical on
   * a device-suppressed device stays in the incident list. The suppressed device
   * set is deliberately a superset of the suppressed alert set.
   */
  alertIds: string[];
  /** Devices with at least one alert actually suppressed. */
  deviceIds: string[];
  /** Alerts kept in the incident list despite a matching suppression. */
  heldBackAlertIds: string[];
  /** Per-record effect, so "what is this suppression actually doing" is answerable. */
  byRecord: Array<{
    suppressionId: string;
    deviceId: string;
    ruleId: string | null;
    reason: string;
    intent: DeviceIntentKind | null;
    createdBy: string;
    createdAt: string;
    expiresAt: string | null;
    neverExpires: boolean;
    /** Open alerts this record is suppressing right now. May be 0. */
    alertCount: number;
    secondsUntilExpiry: number | null;
  }>;
}

export interface SuppressionView {
  /** Every open alert considered — the number nothing here may contradict. */
  totalOpen: number;
  /** Open alerts NOT suppressed. `incidents.total + suppressed.total === totalOpen`. */
  incidents: AlertBand;
  suppressed: SuppressionBand;
  /**
   * Records in force but suppressing nothing, and records that have lapsed. Both
   * are answers to "why is this still on my screen": the first says the
   * suppression is fine and the alert is new, the second says your mute ran out.
   */
  inertRecords: number;
  lapsed: Array<{
    suppressionId: string;
    deviceId: string;
    ruleId: string | null;
    reason: string;
    lapsedBecause: SuppressionLapseReason;
    /** Open alerts that came BACK because of this. Re-escalation, made visible. */
    returnedAlertCount: number;
  }>;
  chips: Array<{ key: "incident" | "suppressed"; label: string; count: number; inDefaultList: boolean }>;
  notes: string[];
}

const zeroCounts = (): Record<Severity, number> => ({ critical: 0, high: 0, medium: 0, info: 0 });

const band = (rows: readonly OpenAlertFact[]): AlertBand => {
  const bySeverity = zeroCounts();
  const devices = new Set<string>();
  for (const row of rows) {
    // Same discipline as hygiene.ts: an unrecognised severity is counted as
    // `info` rather than dropped, because a dropped row breaks the sum invariant
    // silently and that is how a monitoring surface loses trust.
    const key = (SEVERITY_ORDER as readonly string[]).includes(row.severity) ? row.severity : "info";
    bySeverity[key as Severity] += 1;
    devices.add(row.deviceId);
  }
  return { total: rows.length, devices: devices.size, bySeverity };
};

/**
 * Split the open alerts into incidents and the suppressed band.
 *
 * Runs over ALL open alerts, not a page: a chip computed from one page is a chip
 * that lies as soon as there is a second page.
 */
export function classifySuppressed(
  alerts: readonly OpenAlertFact[],
  records: readonly SuppressionRecord[],
  { now }: { now: Date },
): SuppressionView {
  const active: SuppressionRecord[] = [];
  const lapsedRecords: Array<{ record: SuppressionRecord; because: SuppressionLapseReason }> = [];
  for (const record of records) {
    const status = suppressionStatus(record, now);
    if (status.active) active.push(record);
    else lapsedRecords.push({ record, because: status.lapsed! });
  }

  const incidentAlerts: OpenAlertFact[] = [];
  const suppressedAlerts: OpenAlertFact[] = [];
  const heldBack: OpenAlertFact[] = [];
  const countByRecord = new Map<string, number>();

  for (const alert of alerts) {
    const match = matchSuppression(alert, active);
    if (match.by) {
      suppressedAlerts.push(alert);
      countByRecord.set(match.by.id, (countByRecord.get(match.by.id) ?? 0) + 1);
    } else {
      incidentAlerts.push(alert);
      // A refusal that is only the `none` override is not a "held back" alert —
      // nothing was ever asked to suppress it. Only a genuine refusal counts.
      if (match.refused.some((r) => r.record.intent !== "none")) heldBack.push(alert);
    }
  }

  const incidents = band(incidentAlerts);
  const suppressedBand = band(suppressedAlerts);

  const byRecord = active
    .map((record) => ({
      suppressionId: record.id,
      deviceId: record.deviceId,
      ruleId: record.ruleId,
      reason: record.reason,
      intent: record.intent,
      createdBy: record.createdBy,
      createdAt: record.createdAt.toISOString(),
      expiresAt: record.expiresAt?.toISOString() ?? null,
      neverExpires: record.neverExpires,
      alertCount: countByRecord.get(record.id) ?? 0,
      secondsUntilExpiry: suppressionStatus(record, now).secondsUntilExpiry,
    }))
    .sort((a, b) => b.alertCount - a.alertCount || a.suppressionId.localeCompare(b.suppressionId));

  // What came BACK because a suppression lapsed. This is US-8.2.4's
  // re-escalation clause made countable rather than merely promised.
  const lapsed = lapsedRecords
    .map(({ record, because }) => ({
      suppressionId: record.id,
      deviceId: record.deviceId,
      ruleId: record.ruleId,
      reason: record.reason,
      lapsedBecause: because,
      returnedAlertCount: incidentAlerts.filter(
        (a) => a.deviceId === record.deviceId && (record.ruleId === null || record.ruleId === a.ruleId),
      ).length,
    }))
    .sort((a, b) => b.returnedAlertCount - a.returnedAlertCount || a.suppressionId.localeCompare(b.suppressionId));

  return {
    totalOpen: alerts.length,
    incidents,
    suppressed: {
      ...suppressedBand,
      alertIds: suppressedAlerts.map((a) => a.id),
      deviceIds: [...new Set(suppressedAlerts.map((a) => a.deviceId))].sort(),
      heldBackAlertIds: heldBack.map((a) => a.id),
      byRecord,
    },
    inertRecords: byRecord.filter((r) => r.alertCount === 0).length,
    lapsed,
    chips: [
      { key: "incident", label: "incidents", count: incidents.total, inDefaultList: true },
      { key: "suppressed", label: "suppressed", count: suppressedBand.total, inDefaultList: false },
    ],
    notes: buildNotes({ alerts, active, incidents, suppressedBand, heldBack, lapsed, byRecord }),
  };
}

/**
 * The invariant, as an assertable function rather than a comment — exactly as
 * `chipsSumToTotal` is for the dormant band.
 *
 * Every open alert lands in exactly one band, so the two must sum to the total.
 * We broke this once in the dormant band by filtering rows out of the list
 * without taking them out of the counts; a suppression feature is the single
 * most likely place to break it again, because "hidden" is its whole job.
 */
export function bandsSumToTotal(view: SuppressionView): boolean {
  const chipSum = view.chips.reduce((sum, chip) => sum + chip.count, 0);
  return (
    chipSum === view.totalOpen &&
    view.incidents.total + view.suppressed.total === view.totalOpen &&
    view.suppressed.alertIds.length === view.suppressed.total
  );
}

function buildNotes(args: {
  alerts: readonly OpenAlertFact[];
  active: readonly SuppressionRecord[];
  incidents: AlertBand;
  suppressedBand: AlertBand;
  heldBack: readonly OpenAlertFact[];
  lapsed: SuppressionView["lapsed"];
  byRecord: SuppressionBand["byRecord"];
}): string[] {
  const notes: string[] = [];
  const total = args.alerts.length;

  if (args.active.length === 0) {
    notes.push(
      `No suppression is in force, so all ${total} open alert(s) are in the incident list. ` +
        `Suppressing requires a reason and an expiry, and never deletes anything.`,
    );
  } else if (args.suppressedBand.total === 0) {
    notes.push(
      `${args.active.length} suppression(s) are in force but none currently matches an open ` +
        `alert, so all ${total} are in the incident list. That is the expected steady state ` +
        `once the noise they were created for has cleared.`,
    );
  } else {
    notes.push(
      `${args.suppressedBand.total} of ${total} open alert(s), across ` +
        `${args.suppressedBand.devices} device(s), are SUPPRESSED: an operator recorded that ` +
        `they are expected. They remain OPEN, are counted in the suppressed chip, and return ` +
        `to the incident list at their normal rank the moment the suppression lapses. Nothing ` +
        `was resolved, hidden or deleted.`,
    );
  }

  // Every high/critical suppression, named. Legal, but never quiet.
  const withCritical = args.active.filter((r) => r.includeCriticalHigh);
  if (withCritical.length > 0) {
    notes.push(
      `${withCritical.length} suppression(s) are permitted to absorb CRITICAL or HIGH alerts, ` +
        `each scoped to one rule on one device and each set explicitly: ` +
        `${withCritical.map((r) => `${r.id} (${r.deviceId} / ${r.ruleId})`).join(", ")}. ` +
        `A whole-device suppression can never do this.`,
    );
  }

  if (args.heldBack.length > 0) {
    const severities = [...new Set(args.heldBack.map((a) => a.severity))].join(", ");
    notes.push(
      `${args.heldBack.length} alert(s) on suppressed devices were deliberately KEPT in the ` +
        `incident list (${severities}) because a whole-device suppression may never absorb ` +
        `critical or high. A serious alert on a device we believe is by-design means the ` +
        `device spoke — that is news, not noise.`,
    );
  }

  const returned = args.lapsed.filter((l) => l.returnedAlertCount > 0);
  if (returned.length > 0) {
    const expired = returned.filter((l) => l.lapsedBecause === "expired");
    notes.push(
      `${returned.reduce((n, l) => n + l.returnedAlertCount, 0)} alert(s) are back in the ` +
        `incident list because ${returned.length} suppression(s) lapsed ` +
        `(${expired.length} expired, ${returned.length - expired.length} revoked). Age is a ` +
        `reason to rank lower, never a reason to stop looking.`,
    );
  }

  const inert = args.byRecord.filter((r) => r.alertCount === 0).length;
  if (inert > 0) {
    notes.push(
      `${inert} suppression(s) in force are currently suppressing nothing. Left visible on ` +
        `purpose: a suppression with no effect is a candidate for revocation, and it is also ` +
        `the answer to "I muted this, why am I seeing it" when the answer is that the alert ` +
        `is a different one.`,
    );
  }

  notes.push(
    `Incident list: ${args.incidents.total} alert(s) — ` +
      SEVERITY_ORDER.map((s) => `${args.incidents.bySeverity[s]} ${s}`).join(", ") + `.`,
  );
  return notes;
}

/**
 * The recorded intent per device, for the remediation engine.
 *
 * ONLY device-scoped records carry an intent claim about the asset: a rule-scoped
 * suppression says "this alert is expected", which is not the same as "this
 * device is a lab spare", and reading it as one would demote recommendations on a
 * production screen because somebody snoozed one drift on it.
 *
 * When a device has several, the most recent wins — an operator who records
 * `none` today after `eol` last month has changed their mind, and the newer
 * decision is the decision.
 */
export function recordedIntentByDevice(
  records: readonly SuppressionRecord[],
  now: Date,
): Map<string, RecordedIntent> {
  const out = new Map<string, { at: Date; value: RecordedIntent }>();
  for (const record of records) {
    if (record.ruleId !== null || record.intent === null) continue;
    if (!suppressionStatus(record, now).active) continue;
    const existing = out.get(record.deviceId);
    if (existing && existing.at >= record.createdAt) continue;
    out.set(record.deviceId, {
      at: record.createdAt,
      value: {
        kind: record.intent,
        reason: record.reason,
        by: record.createdBy,
        at: record.createdAt.toISOString(),
      },
    });
  }
  return new Map([...out].map(([deviceId, v]) => [deviceId, v.value]));
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read the open alerts and every suppression record, and classify.
 *
 * Deliberately reads LAPSED records too, not just active ones: the `lapsed`
 * block is how re-escalation is reported, and you cannot report what you did not
 * load. Two reads, no per-device round trips.
 */
export async function loadSuppressionView(
  repo: Repository,
  { now = new Date() }: { now?: Date } = {},
): Promise<SuppressionView> {
  const [alerts, records] = await Promise.all([
    repo.openAlertFacts(),
    repo.listSuppressions({ includeLapsed: true }),
  ]);
  return classifySuppressed(alerts, records, { now });
}
