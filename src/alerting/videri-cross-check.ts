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
  videriOpenAlerts: number;
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
): Promise<CrossCheckResult> {
  const result: CrossCheckResult = {
    ranAt: new Date(),
    videriOpenAlerts: 0,
    theyFlagWeDoNot: [],
    weFlagTheyDoNot: [],
    agreements: 0,
    unknownAlertTypes: [],
    errors: [],
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
    return result;
  }

  const theirOpen = theirs.filter((a) => a.isResolved !== true);
  result.videriOpenAlerts = theirOpen.length;

  const unknown = new Set<string>();
  for (const alert of theirOpen) {
    if (alert.alertType && !(alert.alertType in EQUIVALENT_RULES)) unknown.add(alert.alertType);
  }
  result.unknownAlertTypes = [...unknown];

  // Ours, keyed by canvas id.
  const { rows } = await pool.query<{ device_id: string; rule_id: string }>(
    `SELECT device_id, rule_id FROM alerts WHERE resolved_at IS NULL`,
  );
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

  return result;
}

export function renderCrossCheck(result: CrossCheckResult): string {
  const lines = [
    `  cross-check: ${result.videriOpenAlerts} open Videri alert(s) · ` +
      `${result.agreements} agreement(s) · ` +
      `${result.theyFlagWeDoNot.length} they-only · ${result.weFlagTheyDoNot.length} we-only`,
  ];
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
