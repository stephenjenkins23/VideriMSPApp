/**
 * Cross-check our detection against Videri's own alerting service.
 *
 * The platform detects exactly two conditions — `offline` and `showingLogo` —
 * with no severity and no thresholds. Ingesting those as alerts would duplicate
 * rules we already run better, so instead we use them as a **second opinion**:
 *
 *   they say offline, we do not  → our polling may have a blind spot
 *   we say offline, they do not  → we may be over-alerting, or we are faster
 *
 * Two things come out of this. Operationally, disagreement is a signal worth
 * investigating before a customer finds it. Strategically, the agreement rate is
 * direct evidence for the question of whether a third party can build reliable
 * detection on this API at all — if our reading of the platform's own data
 * disagrees with the platform, that is a finding about the API, not just about us.
 */

import type { VideriHttp } from "../videri/http.js";
import type { Pool } from "pg";
import type { PollerResult } from "../pipeline/pollers/types.js";

/**
 * The lane name, written ONCE.
 *
 * Both the scheduler's task name and the recorded `poller` value come from here,
 * so this lane cannot record under a sibling's name. A previous retention change
 * in this project swapped two labels so a `run("poller_runs", …)` call executed
 * the `fleet_snapshots` DELETE — the SQL worked and the counts lied. A swap at
 * this level would be just as quiet.
 */
export const CROSS_CHECK_POLLER = "alert-cross-check";

interface VideriAlertDto {
  uuid?: string;
  alertType?: "offline" | "showingLogo" | string;
  canvasId?: string;
  deviceId?: string;
  canvasName?: string;
  isResolved?: boolean;
  createdAt?: string;
}

/** Their alertType → the rule ids of ours that cover the same condition. */
export const EQUIVALENT_RULES: Record<string, string[]> = {
  // Every rule of ours that covers "device is offline" must be listed. Adding
  // the offline-30d escalation tier without updating this map made the
  // cross-check report 0 agreements and 79 false blind spots — the mapping has
  // to move whenever the rule set does.
  // offline-6mo joined the chain with the dormancy classification (rules.ts
  // `alertClass`): dormant is a presentation band, not a different condition, so
  // the platform still sees these as plain "offline" and the cross-check must
  // count them as agreement.
  offline: ["offline-30m", "offline-4h", "offline-30d", "offline-6mo"],
  showingLogo: ["showing-logo"],
};

export interface CrossCheckResult {
  ranAt: Date;
  /** Wall time of the whole reconciliation, for the run row. */
  durationMs: number;
  /**
   * Did the comparison actually happen?
   *
   * The one field that separates the two kinds of zero. A clean fleet and a
   * failed read both come back `0 agreements · 0 they-only · 0 we-only`, and
   * reading that as agreement would be claiming we looked when we did not. Every
   * consumer — the run row, the log line — keys its "we could not look" wording
   * on this rather than inferring it from the counts.
   */
  completed: boolean;
  videriOpenAlerts: number;
  /**
   * Devices the comparison covered — the union of the devices they flag and the
   * devices we flag. NOT devices "targeted": nothing here contacts a device (see
   * `toPollerRun` below for why the run row keeps that distinction).
   */
  devicesCompared: number;
  /** Videri flags it, we do not. Possible blind spot on our side. */
  theyFlagWeDoNot: Array<{ deviceId: string; deviceName: string | null; alertType: string }>;
  /** We flag it, Videri does not. We may be faster, or over-alerting. */
  weFlagTheyDoNot: Array<{ deviceId: string; ruleId: string }>;
  /** Both agree. */
  agreements: number;
  /** Alert types they returned that we do not model. */
  unknownAlertTypes: string[];
  errors: string[];
}

export async function crossCheckVideriAlerts(
  http: VideriHttp,
  pool: Pool,
  now: () => number = Date.now,
): Promise<CrossCheckResult> {
  const startedAtMs = now();
  const result: CrossCheckResult = {
    ranAt: new Date(startedAtMs),
    durationMs: 0,
    completed: false,
    videriOpenAlerts: 0,
    devicesCompared: 0,
    theyFlagWeDoNot: [],
    weFlagTheyDoNot: [],
    agreements: 0,
    unknownAlertTypes: [],
    errors: [],
  };
  /** Stamps the duration on every exit, so a failed run is still timed. */
  const finish = (completed: boolean): CrossCheckResult => {
    result.durationMs = now() - startedAtMs;
    result.completed = completed;
    return result;
  };

  let theirs: VideriAlertDto[] = [];
  try {
    // Paged to completion, not one 200-row request. A single page silently
    // truncates the moment Videri holds more than 200 alerts — and a truncated
    // "theirs" list turns into phantom we-only findings, because their alerts
    // past the cut look like alerts they never raised. The walk does not trust
    // `meta.totalPages` (unverified on this service): it keeps fetching while
    // full pages come back, with a hard cap as a runaway guard.
    const limit = 200;
    for (let page = 1; page <= 20; page++) {
      const response = await http.request<{ data?: VideriAlertDto[] } | VideriAlertDto[]>(
        "alerting",
        "/api/v1/alerts",
        { query: { page, limit } },
      );
      const batch = Array.isArray(response) ? response : (response.data ?? []);
      theirs.push(...batch);
      if (batch.length < limit) break;
    }
  } catch (error) {
    result.errors.push(`could not read Videri alerts: ${(error as Error).message}`);
    return finish(false);
  }

  const theirOpen = theirs.filter((a) => a.isResolved !== true);
  result.videriOpenAlerts = theirOpen.length;

  const unknown = new Set<string>();
  for (const alert of theirOpen) {
    if (alert.alertType && !(alert.alertType in EQUIVALENT_RULES)) unknown.add(alert.alertType);
  }
  result.unknownAlertTypes = [...unknown];

  // Ours, keyed by canvas id.
  //
  // Caught rather than thrown for the same reason the read above is: a lane that
  // threw recorded nothing at all, which is indistinguishable from a lane that
  // never ran. The comparison result on this path is the same empty one the
  // other failure path already returns — `completed: false` is what says so.
  let rows: Array<{ device_id: string; rule_id: string }>;
  try {
    ({ rows } = await pool.query<{ device_id: string; rule_id: string }>(
      `SELECT device_id, rule_id FROM alerts WHERE resolved_at IS NULL`,
    ));
  } catch (error) {
    result.errors.push(`could not read our own alerts: ${(error as Error).message}`);
    return finish(false);
  }
  const ourRulesByDevice = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = ourRulesByDevice.get(row.device_id) ?? new Set<string>();
    set.add(row.rule_id);
    ourRulesByDevice.set(row.device_id, set);
  }

  // Their alerts key on canvasId, which is our devices.id.
  const theirConditions = new Map<string, Set<string>>();
  for (const alert of theirOpen) {
    if (!alert.canvasId || !alert.alertType) continue;
    const set = theirConditions.get(alert.canvasId) ?? new Set<string>();
    set.add(alert.alertType);
    theirConditions.set(alert.canvasId, set);

    const equivalents = EQUIVALENT_RULES[alert.alertType];
    if (!equivalents) continue;

    const ours = ourRulesByDevice.get(alert.canvasId);
    if (ours && equivalents.some((r) => ours.has(r))) result.agreements += 1;
    else {
      result.theyFlagWeDoNot.push({
        deviceId: alert.canvasId,
        deviceName: alert.canvasName ?? null,
        alertType: alert.alertType,
      });
    }
  }

  for (const [deviceId, ourRules] of ourRulesByDevice) {
    for (const [alertType, equivalents] of Object.entries(EQUIVALENT_RULES)) {
      const weFlag = equivalents.some((r) => ourRules.has(r));
      const theyFlag = theirConditions.get(deviceId)?.has(alertType) ?? false;
      if (weFlag && !theyFlag) {
        result.weFlagTheyDoNot.push({ deviceId, ruleId: equivalents.find((r) => ourRules.has(r))! });
      }
    }
  }

  result.devicesCompared = new Set([
    ...ourRulesByDevice.keys(),
    ...theirConditions.keys(),
  ]).size;

  return finish(true);
}

/**
 * The run row for this lane — pure, so every field is assertable without a pool.
 *
 * WHY THIS EXISTS
 * The lane used to print `renderCrossCheck` and persist nothing: no poller_runs
 * row, no table of its own. `poller_runs` therefore held zero rows for it, and
 * zero rows for a lane that never records is evidence WE CANNOT TELL — not
 * evidence it never ran. The registry had to declare it `observability: "none"`
 * and pipeline-health reported UNKNOWN: honest, and useless. This makes it
 * knowable.
 *
 * HOW THE FIELDS ARE FILLED, AND WHY
 * This is not a device poller and its run row must not pretend to be one:
 *
 *   devicesTargeted — 0 BY NATURE. Nothing here contacts a device: it reads two
 *     alert lists and compares them. The schema's word for this column is "how
 *     much of the fleet did we manage to read", and the answer is none of it.
 *     `devicesCompared` is a different quantity and is reported as a note rather
 *     than smuggled into this column — the counts-must-not-lie rule. The column
 *     is a NOT NULL integer, so the honest null this project prefers is not
 *     available; the zero's meaning is stated in the note instead.
 *   rowsWritten — 0 BY NATURE. The lane persists nothing anywhere. Zero here is
 *     permanent, which is also why pipeline-health's rows-written collapse check
 *     (it needs a prior non-zero) cannot fire on this lane.
 *   batchesOk — 1 when the reconciliation COMPLETED, 0 when it did not. This is
 *     the field that separates "we compared and found nothing to disagree about"
 *     from "we could not look". Deliberately not the page count of the alerts
 *     walk: a walk that fetched two pages and then failed returns before
 *     comparing anything, so a non-zero there would claim a look that never
 *     happened.
 *   batchesFailed — the number of errors that stopped the comparison. Kept at 0
 *     on success because a recent non-zero raises an operator-facing warning in
 *     `api/freshness.ts`.
 *   telemetryYield — null. No meaning for a lane that reads no telemetry, and
 *     0.0 would read as "collected nothing", which is a different claim.
 *   errors — real errors, then NOTES. `errors` is this project's note channel on
 *     a run row (see `alerting/engine.ts` `toPollerRun`), and poller_runs is the
 *     only per-cycle record we keep: until now the cross-check verdict existed
 *     nowhere but stdout, so a disagreement was unfindable the next morning.
 */
export function toPollerRun(result: CrossCheckResult): PollerResult {
  const notes: string[] = [];
  if (result.completed) {
    notes.push(
      `compared ${result.devicesCompared} device(s): ${result.videriOpenAlerts} open Videri ` +
        `alert(s) · ${result.agreements} agreement(s) · ${result.theyFlagWeDoNot.length} ` +
        `they-only · ${result.weFlagTheyDoNot.length} we-only`,
    );
    if (result.theyFlagWeDoNot.length > 0) {
      notes.push(
        `${result.theyFlagWeDoNot.length} device(s) Videri flags and we do not — ` +
          `possible blind spot on our side`,
      );
    }
    if (result.weFlagTheyDoNot.length > 0) {
      notes.push(
        `${result.weFlagTheyDoNot.length} device(s) we flag and Videri does not — we may ` +
          `be faster, or over-alerting`,
      );
    }
    if (result.unknownAlertTypes.length > 0) {
      notes.push(
        `Videri returned alert type(s) we do not model: ${result.unknownAlertTypes.join(", ")}`,
      );
    }
    notes.push(
      "no device was targeted and no row was written: this lane compares two alert " +
        "lists, so those counts are 0 by nature, not by failure",
    );
  } else {
    // The counts on this path are all zero because nothing was compared. Saying
    // so is the difference between an unknown and a clean bill of health.
    notes.push(
      "the comparison did not complete, so every count on this run is UNKNOWN rather " +
        "than zero — 0 agreements here does not mean we and Videri agree",
    );
  }

  return {
    poller: CROSS_CHECK_POLLER,
    startedAt: result.ranAt,
    durationMs: result.durationMs,
    devicesTargeted: 0,
    rowsWritten: 0,
    batchesOk: result.completed ? 1 : 0,
    batchesFailed: result.errors.length,
    telemetryYield: null,
    errors: [...result.errors, ...notes],
  };
}

export function renderCrossCheck(result: CrossCheckResult): string {
  // An incomplete run used to render as "0 open Videri alert(s) · 0 agreement(s)
  // · 0 they-only · 0 we-only" with the error underneath — a clean bill of
  // health printed over a read that never happened. The counts are unknown on
  // that path, so it says so instead of printing them.
  const lines = result.completed
    ? [
        `  cross-check: ${result.videriOpenAlerts} open Videri alert(s) · ` +
          `${result.agreements} agreement(s) · ` +
          `${result.theyFlagWeDoNot.length} they-only · ${result.weFlagTheyDoNot.length} we-only`,
      ]
    : [`  cross-check: DID NOT COMPLETE — no comparison was made, counts unknown`];
  if (result.theyFlagWeDoNot.length > 0) {
    lines.push(
      `  ! Videri flags ${result.theyFlagWeDoNot.length} device(s) we do not — possible blind spot: ` +
        result.theyFlagWeDoNot.slice(0, 5).map((d) => `${d.deviceName ?? d.deviceId} (${d.alertType})`).join(", "),
    );
  }
  if (result.unknownAlertTypes.length > 0) {
    lines.push(
      `  ! Videri returned alert type(s) we do not model: ${result.unknownAlertTypes.join(", ")}. ` +
        `Their alert vocabulary has grown beyond offline|showingLogo.`,
    );
  }
  for (const error of result.errors) lines.push(`  ! ${error}`);
  return lines.join("\n");
}
