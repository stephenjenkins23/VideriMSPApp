/**
 * Compliance engine — evaluate cached settings against templates, persist verdicts.
 *
 * Deliberately decoupled from the settings poller. Evaluation is cheap and pure,
 * so it can re-run whenever a template changes without touching a single device;
 * collection is expensive and rate-limited. Coupling them would mean a template
 * tweak triggered a fleet-wide command sweep.
 */

import type { Repository } from "../db/repository.js";
import { DEFAULT_TEMPLATES, templateFor, validateTemplate, type ComplianceTemplate } from "./templates.js";
import { evaluateCompliance, complianceBand, type ComplianceResult } from "./evaluate.js";
import type { DeviceClass } from "../domain/types.js";

export interface ComplianceRunResult {
  startedAt: Date;
  durationMs: number;
  devicesEvaluated: number;
  /** Devices with no cached settings — cannot be assessed at all. */
  devicesWithoutSettings: number;
  /** Devices whose class has no matching template. */
  devicesWithoutTemplate: number;
  averageScore: number | null;
  averagePolicyScore: number | null;
  byBand: Record<"compliant" | "minor-drift" | "non-compliant", number>;
  /** The drifted checks seen most often — where a fleet action pays off most. */
  topDrift: Array<{ checkId: string; label: string; deviceCount: number }>;
  /** Settings snapshots older than this are flagged as stale in the output. */
  stalestSettingsAgeSeconds: number | null;
  errors: string[];
}

export interface RunComplianceOptions {
  templates?: ComplianceTemplate[];
  log?: (message: string) => void;
}

export async function runCompliance(
  repo: Repository,
  { templates = DEFAULT_TEMPLATES, log = () => {} }: RunComplianceOptions = {},
): Promise<ComplianceRunResult> {
  const startedAt = new Date();
  const result: ComplianceRunResult = {
    startedAt,
    durationMs: 0,
    devicesEvaluated: 0,
    devicesWithoutSettings: 0,
    devicesWithoutTemplate: 0,
    averageScore: null,
    averagePolicyScore: null,
    byBand: { compliant: 0, "minor-drift": 0, "non-compliant": 0 },
    topDrift: [],
    stalestSettingsAgeSeconds: null,
    errors: [],
  };

  const valid = templates.filter((t) => {
    const problems = validateTemplate(t);
    if (problems.length > 0) {
      result.errors.push(`template "${t.id}" invalid: ${problems.join("; ")}`);
      return false;
    }
    return true;
  });
  if (valid.length === 0) {
    result.durationMs = Date.now() - startedAt.getTime();
    return result;
  }

  const rows = await repo.loadComplianceInput();
  const evaluated: Array<ComplianceResult & { settingsAgeSeconds: number }> = [];
  const driftCounts = new Map<string, { label: string; count: number }>();

  for (const row of rows) {
    if (!row.settings) {
      result.devicesWithoutSettings += 1;
      continue;
    }
    const template = templateFor(row.deviceClass as DeviceClass, row.assignedTemplateId, valid);
    if (!template) {
      result.devicesWithoutTemplate += 1;
      continue;
    }

    const outcome = evaluateCompliance(row.id, row.deviceClass as DeviceClass, row.settings, template);
    evaluated.push({ ...outcome, settingsAgeSeconds: row.settingsAgeSeconds });
    const band = complianceBand(outcome.score);
    result.byBand[band] = (result.byBand[band] ?? 0) + 1;

    for (const d of outcome.drift) {
      const entry = driftCounts.get(d.checkId) ?? { label: d.label, count: 0 };
      entry.count += 1;
      driftCounts.set(d.checkId, entry);
    }
  }

  result.devicesEvaluated = evaluated.length;
  if (evaluated.length > 0) {
    result.averageScore = Math.round(
      evaluated.reduce((s, e) => s + e.score, 0) / evaluated.length,
    );
    const withPolicy = evaluated.filter((e) => e.policyScore !== null);
    result.averagePolicyScore =
      withPolicy.length === 0
        ? null
        : Math.round(withPolicy.reduce((s, e) => s + (e.policyScore ?? 0), 0) / withPolicy.length);
    result.stalestSettingsAgeSeconds = Math.max(...evaluated.map((e) => e.settingsAgeSeconds));

    try {
      await repo.insertComplianceResults(evaluated);
    } catch (error) {
      result.errors.push(`insertComplianceResults failed: ${(error as Error).message}`);
    }
  }

  result.topDrift = [...driftCounts.entries()]
    .map(([checkId, v]) => ({ checkId, label: v.label, deviceCount: v.count }))
    .sort((a, b) => b.deviceCount - a.deviceCount)
    .slice(0, 8);

  log(
    `  compliance: ${result.devicesEvaluated} evaluated · drift score ${result.averageScore ?? "n/a"}% · ` +
      `${result.byBand["compliant"]} compliant / ${result.byBand["minor-drift"]} minor / ` +
      `${result.byBand["non-compliant"]} non-compliant`,
  );
  if (result.averagePolicyScore !== null) {
    log(
      `  compliance: policy adoption ${result.averagePolicyScore}% — a remediation ` +
        `backlog, deliberately excluded from the drift score`,
    );
  }
  if (result.devicesWithoutSettings > 0) {
    // Not an error — it is the expected steady state while the slow lane works
    // through the fleet, and it must be visible so nobody reads the average as
    // covering everything.
    log(
      `  compliance: ${result.devicesWithoutSettings} device(s) have no cached settings yet ` +
        `— excluded from the average, not scored as failures`,
    );
  }

  result.durationMs = Date.now() - startedAt.getTime();
  return result;
}

export async function seedTemplates(repo: Repository): Promise<number> {
  return repo.seedComplianceTemplates(
    DEFAULT_TEMPLATES.map((t) => ({ id: t.id, name: t.name, definition: t })),
  );
}

export function toPollerRun(result: ComplianceRunResult) {
  return {
    poller: "compliance",
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    devicesTargeted: result.devicesEvaluated + result.devicesWithoutSettings,
    rowsWritten: result.devicesEvaluated,
    batchesOk: result.devicesEvaluated,
    batchesFailed: result.errors.length,
    telemetryYield: null,
    errors: [
      ...result.errors,
      ...(result.devicesWithoutSettings > 0
        ? [`${result.devicesWithoutSettings} device(s) without cached settings`]
        : []),
    ],
  };
}
