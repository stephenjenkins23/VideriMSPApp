/**
 * The alerting engine.
 *
 * Loads devices and their recent samples, evaluates every rule, then reconciles
 * the verdicts against the alerts already open:
 *
 *   firing  + no open alert  → open one
 *   firing  + open alert     → refresh evidence, push out the resolution clock
 *   clear   + open alert     → resolve, but only after clearForSeconds
 *   fired by a superseding rule → resolve the outranked alert
 *
 * Evaluation itself is pure (see evaluate.ts); this file is the I/O and lifecycle
 * around it.
 */

import type { Repository, OpenAlertRow } from "../db/repository.js";
import { DEFAULT_RULES, requiredWindowSeconds, validateRule, isTierB, type AlertRule } from "./rules.js";
import {
  evaluateDevice,
  type Verdict,
  type SampleRow,
  type DeviceRow,
  type ScreenVerdictRecord,
} from "./evaluate.js";

export interface AlertingResult {
  startedAt: Date;
  durationMs: number;
  devicesEvaluated: number;
  rulesEvaluated: number;
  opened: number;
  refreshed: number;
  resolved: number;
  supersededResolved: number;
  /**
   * Claims the DEVICE ITSELF refuted this cycle — a critical we did not raise
   * because we could disprove it (see evaluate.ts `applyScreenVerdict`).
   *
   * Counted and reported rather than left implicit: every one of these is a
   * disagreement between the platform's flag and its own hardware, and a number
   * that quietly grows is the signal that the platform's `is_black_screen` is
   * broken fleet-wide rather than flaky on one panel. Free to compute — the
   * verdicts are already in hand.
   */
  refutedClaims: number;
  /** Rules that could not be judged for any device, and why. */
  inertRules: Array<{ ruleId: string; reason: string; tierB: boolean }>;
  /**
   * Set when the engine refused to evaluate because OUR data was too old to
   * distinguish a fleet outage from a collector outage. Device-level alerting is
   * suppressed and this is the finding instead.
   */
  collectionStale: { ageSeconds: number; thresholdSeconds: number; message: string } | null;
  errors: string[];
}

export interface RunAlertingOptions {
  rules?: AlertRule[];
  now?: Date;
  maxSamplesPerDevice?: number;
  log?: (message: string) => void;
  /**
   * How stale our own collection may get before device alerting is suppressed.
   * Default 45 min: devices push every ~15-22 min (docs, E-001), so three
   * missed cycles means the collector, not the fleet.
   */
  maxCollectionAgeSeconds?: number;
}

/**
 * Load the rule set the engine should evaluate.
 *
 * Database first, DEFAULT_RULES only as the seed. Previously the engine took
 * DEFAULT_RULES directly, which meant an operator could edit a threshold through
 * the API, see it stored, and have the engine quietly keep using the compiled-in
 * value — configurable in appearance only.
 */
export async function loadRules(repo: Repository): Promise<AlertRule[]> {
  const stored = (await repo.loadRuleDefinitions()) as AlertRule[];
  if (stored.length === 0) return DEFAULT_RULES;

  // A rule added in code but not yet seeded should still run, so union by id
  // with the database winning on conflict.
  const byId = new Map<string, AlertRule>(DEFAULT_RULES.map((r) => [r.id, r]));
  for (const r of stored) if (r && r.id) byId.set(r.id, r);
  return [...byId.values()];
}

export async function runAlerting(
  repo: Repository,
  {
    rules,
    now = new Date(),
    maxSamplesPerDevice = 240,
    log = () => {},
    maxCollectionAgeSeconds = 45 * 60,
  }: RunAlertingOptions = {},
): Promise<AlertingResult> {
  const startedAt = new Date();
  const result: AlertingResult = {
    startedAt,
    durationMs: 0,
    devicesEvaluated: 0,
    rulesEvaluated: 0,
    opened: 0,
    refreshed: 0,
    resolved: 0,
    supersededResolved: 0,
    refutedClaims: 0,
    inertRules: [],
    collectionStale: null,
    errors: [],
  };

  // Explicit rules win (used by tests and the preview endpoint); otherwise read
  // the operator-editable set from the database.
  const source = rules ?? (await loadRules(repo));
  const active = source.filter((rule) => {
    const problems = validateRule(rule);
    if (problems.length > 0) {
      result.errors.push(`rule "${rule.id}" is invalid: ${problems.join("; ")}`);
      return false;
    }
    return rule.enabled;
  });

  if (active.length === 0) {
    result.durationMs = Date.now() - startedAt.getTime();
    return result;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Guard: never page the fleet for our own outage.
  //
  // Every offline rule ultimately compares "now" against the last time we saw a
  // device. If collection stops, that gap grows for EVERY device at once, and
  // the engine cheerfully opens an alert on all of them. Measured on this fleet:
  // after a 20-hour collection gap the 30-minute offline rule fired on 236 of
  // 250 devices, none of which had changed state. That is the classic monitoring
  // failure mode — the monitor's own outage reported as a total fleet outage,
  // arriving as 236 pages that bury the real signal.
  //
  // So when our data is older than several device push cycles, device-level
  // evaluation is suppressed and the staleness itself becomes the finding.
  if (typeof repo.collectionAgeSeconds === "function") {
    const { overall } = await repo.collectionAgeSeconds();
    if (overall === null || overall > maxCollectionAgeSeconds) {
      const age = overall ?? Number.POSITIVE_INFINITY;
      const message =
        overall === null
          ? "No telemetry has ever been collected, so no device can be judged. " +
            "Device alerting is suppressed; fix collection first."
          : `Our newest telemetry is ${Math.round(age / 60)} min old (limit ` +
            `${Math.round(maxCollectionAgeSeconds / 60)} min). Device alerting is ` +
            `suppressed: at this age an offline rule would fire on the whole fleet ` +
            `whether or not anything is actually down. The collector is the fault.`;
      result.collectionStale = { ageSeconds: overall ?? -1, thresholdSeconds: maxCollectionAgeSeconds, message };
      result.durationMs = Date.now() - startedAt.getTime();
      log(message);
      return result;
    }
  }

  const windowSeconds = requiredWindowSeconds(active);
  const [input, openAlerts, screenVerdicts] = await Promise.all([
    repo.loadEvaluationInput(windowSeconds, maxSamplesPerDevice),
    repo.loadOpenAlerts(),
    // One fleet-wide read of the newest verdict per device, alongside the other
    // two — never a per-device round trip, and never a device command. Guarded
    // the same way `collectionAgeSeconds` is, so a repository (or stub) without
    // the method degrades to "unverified everywhere", which is exactly the
    // behaviour that predates this feature.
    typeof repo.latestScreenVerdicts === "function"
      ? repo.latestScreenVerdicts().catch((error) => {
          result.errors.push(`latestScreenVerdicts: ${(error as Error).message}`);
          return new Map<string, ScreenVerdictRecord>();
        })
      : Promise.resolve(new Map<string, ScreenVerdictRecord>()),
  ]);

  result.devicesEvaluated = input.size;
  result.rulesEvaluated = active.length;

  const toOpen: Array<{ deviceId: string; ruleId: string; severity: string; title: string; evidence: string }> = [];
  const toRefresh: Array<{ id: string; evidence: string; severity: string }> = [];
  const toResolve: Array<{ id: string; clearForSeconds: number }> = [];
  const supersededIds = new Set<string>();

  // Tracks whether each rule was judgeable anywhere, so we can report rules that
  // are silently inert rather than genuinely quiet.
  const judgeable = new Map<string, boolean>();
  const skipReasons = new Map<string, string>();
  const rulesById = new Map(active.map((r) => [r.id, r]));

  for (const [deviceId, entry] of input) {
    const device: DeviceRow = entry.device;
    const samples: SampleRow[] = entry.samples;
    const verdicts = evaluateDevice(active, {
      device,
      samples,
      now,
      screenVerdict: screenVerdicts.get(deviceId) ?? null,
    });

    const firingIds = new Set(verdicts.filter((v) => v.firing).map((v) => v.ruleId));

    for (const verdict of verdicts) {
      const rule = rulesById.get(verdict.ruleId);
      if (!rule) continue;

      if (verdict.refuted) result.refutedClaims += 1;

      if (verdict.firing) judgeable.set(verdict.ruleId, true);
      else if (!judgeable.has(verdict.ruleId)) {
        judgeable.set(verdict.ruleId, verdict.skipped === undefined);
        if (verdict.skipped) skipReasons.set(verdict.ruleId, verdict.skipped);
      }

      const key = `${deviceId}:${verdict.ruleId}`;
      const open = openAlerts.get(key);

      // A rule outranked by something firing on this device stands down, so the
      // operator sees one alert per underlying problem.
      const outranked = active.some(
        (other) => firingIds.has(other.id) && other.supersedes?.includes(verdict.ruleId),
      );

      if (verdict.firing && !outranked) {
        if (open) toRefresh.push({ id: open.id, evidence: verdict.evidence, severity: verdict.severity });
        else {
          toOpen.push({
            deviceId,
            ruleId: verdict.ruleId,
            severity: verdict.severity,
            title: verdict.title,
            evidence: verdict.evidence,
          });
        }
        continue;
      }

      if (open) {
        if (outranked) supersededIds.add(open.id);
        else toResolve.push({ id: open.id, clearForSeconds: rule.clearForSeconds });
      }
    }
  }

  // ── persist ──
  for (const alert of toOpen) {
    try {
      if (await repo.openAlert(alert)) result.opened += 1;
    } catch (error) {
      result.errors.push(`openAlert ${alert.deviceId}/${alert.ruleId}: ${(error as Error).message}`);
    }
  }

  if (toRefresh.length > 0) {
    try {
      result.refreshed = await repo.touchAlerts(toRefresh);
    } catch (error) {
      result.errors.push(`touchAlerts: ${(error as Error).message}`);
    }
  }

  if (supersededIds.size > 0) {
    try {
      // Superseded alerts resolve immediately — the condition has not cleared,
      // it has been absorbed by a higher-severity alert, so waiting out a clear
      // window would leave the duplicate visible.
      result.supersededResolved = await repo.resolveStaleAlerts(
        [...supersededIds].map((id) => ({ id, clearForSeconds: 0 })),
      );
    } catch (error) {
      result.errors.push(`resolve superseded: ${(error as Error).message}`);
    }
  }

  const resolvable = toResolve.filter((r) => !supersededIds.has(r.id));
  if (resolvable.length > 0) {
    try {
      result.resolved = await repo.resolveStaleAlerts(resolvable);
    } catch (error) {
      result.errors.push(`resolveStaleAlerts: ${(error as Error).message}`);
    }
  }

  // ── report inert rules ──
  // A rule that never fires because its input is unreadable looks identical to a
  // rule that never fires because the fleet is healthy. Distinguishing the two
  // is the difference between "no problems" and "no visibility".
  for (const rule of active) {
    if (judgeable.get(rule.id) === false) {
      result.inertRules.push({
        ruleId: rule.id,
        reason: skipReasons.get(rule.id) ?? "not judgeable on any device",
        tierB: isTierB(rule),
      });
    }
  }

  result.durationMs = Date.now() - startedAt.getTime();

  log(
    `  alerting: ${result.devicesEvaluated} device(s) × ${result.rulesEvaluated} rule(s) — ` +
      `opened ${result.opened}, refreshed ${result.refreshed}, resolved ${result.resolved}` +
      (result.supersededResolved > 0 ? ` (+${result.supersededResolved} superseded)` : "") +
      (result.refutedClaims > 0 ? ` (+${result.refutedClaims} claim(s) refuted by the device)` : ""),
  );

  const inertTierB = result.inertRules.filter((r) => r.tierB);
  if (inertTierB.length > 0) {
    log(
      `  alerting: ${inertTierB.length} rule(s) inert because their telemetry is unreadable ` +
        `(${inertTierB.map((r) => r.ruleId).join(", ")}). Expected until \`npm run discover\` ` +
        `resolves the payload vocabulary.`,
    );
  }

  return result;
}

/** Seed rule definitions on first run. Never overwrites operator tuning. */
export async function seedRules(repo: Repository): Promise<number> {
  return repo.seedRuleDefinitions(DEFAULT_RULES.map((rule) => ({ id: rule.id, definition: rule })));
}

/** Shape for the poller_runs log. */
export function toPollerRun(result: AlertingResult) {
  return {
    poller: "alerting",
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    devicesTargeted: result.devicesEvaluated,
    rowsWritten: result.opened + result.refreshed + result.resolved + result.supersededResolved,
    batchesOk: result.rulesEvaluated,
    batchesFailed: result.errors.length,
    telemetryYield: null,
    errors: [
      ...result.errors,
      // Not an error, but poller_runs is the only per-cycle record we keep and a
      // refuted claim must be findable after the fact — an alert that was never
      // raised leaves no other trace.
      ...(result.refutedClaims > 0
        ? [
            `${result.refutedClaims} black-screen claim(s) refuted by the device itself — ` +
              `no critical raised; see device_screen_verdict`,
          ]
        : []),
      ...result.inertRules
        .filter((r) => r.tierB)
        .map((r) => `rule "${r.ruleId}" inert: ${r.reason}`),
    ],
  };
}

export type { Verdict };
