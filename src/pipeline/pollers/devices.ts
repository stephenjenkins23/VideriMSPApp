/**
 * Device discovery.
 *
 * Walks `/canvases` and upserts the registry. Runs on a slow interval — devices
 * are provisioned, not created every minute — but it must run *before* the
 * telemetry pollers, because they poll whatever is in the devices table.
 *
 * It is also the only place that can notice a device has GONE. The registry only
 * ever accumulated (250 rows against 249 live devices, 2026-08-31), so every
 * fleet-wide total was inflated by rows for devices that no longer exist. After a
 * sweep we reconcile: devices absent from a genuinely complete sweep are marked
 * `retired_at` (soft, reversible — never deleted), and any retired device that
 * reappears is brought straight back. The rules for when that is safe are pure and
 * live in retirement.ts; this function only supplies the inputs and applies the
 * outcome.
 */

import type { CanvasService } from "../../videri/services/canvas.js";
import type { Repository } from "../../db/repository.js";
import { type PollerResult, emptyResult } from "./types.js";
import { planRetirement, type SweepCoverage } from "./retirement.js";

/** Discovery's result, plus what the reconciliation did. */
export interface DeviceDiscoveryResult extends PollerResult {
  retirement: {
    /** Rows newly marked retired this tick. */
    retired: number;
    /** Rows brought back because the device reappeared. */
    unretired: number;
    /** Both `assigned_to_group` legs paginated to exhaustion. */
    sweepComplete: boolean;
    /** Why retirement was withheld, or null when it ran. */
    blockedReason: string | null;
  };
}

export async function pollDevices(
  canvas: CanvasService,
  repo: Repository,
  log: (message: string) => void = () => {},
): Promise<DeviceDiscoveryResult> {
  const startedAt = new Date();
  const result = emptyResult("devices", startedAt);
  const seen: string[] = [];
  const coverage: SweepCoverage = { assignedToGroupTrue: false, assignedToGroupFalse: false };

  try {
    for await (const page of canvas.sweepDevices(200)) {
      // A leg-completion marker carries no devices — record the coverage and move
      // on. This is the only evidence that a leg genuinely finished, and
      // retirement is not allowed without both.
      if (page.legComplete) {
        if (page.assignedToGroup) coverage.assignedToGroupTrue = true;
        else coverage.assignedToGroupFalse = true;
        continue;
      }
      try {
        const written = await repo.upsertDevices(page.devices);
        result.rowsWritten += written;
        result.devicesTargeted += page.devices.length;
        result.batchesOk += 1;
        // Ids collected regardless of write outcome would be dishonest: an id we
        // failed to persist is still an id we SAW, so it counts as seen — but a
        // failed batch blocks retirement entirely (see retirement.ts).
        for (const device of page.devices) seen.push(device.id);
        log(`  devices: upserted ${page.devices.length} (running total ${result.devicesTargeted})`);
      } catch (error) {
        result.batchesFailed += 1;
        result.errors.push(`upsert page failed: ${(error as Error).message}`);
        for (const device of page.devices) seen.push(device.id);
      }
    }
  } catch (error) {
    // Pagination itself failed — record and let the next tick retry. Coverage
    // stays false for the unfinished leg, so nothing is retired from this tick.
    result.errors.push(`listDevices failed: ${(error as Error).message}`);
    result.batchesFailed += 1;
  }

  const retirement = await reconcileRetirement(repo, seen, coverage, result, log);

  result.durationMs = Date.now() - startedAt.getTime();
  return { ...result, retirement };
}

/**
 * Reconcile the registry against what the sweep saw.
 *
 * Separated so the (small) IO is one readable block and the decision itself stays
 * in the pure planner. A failure here is recorded as an error but never aborts the
 * poll: discovery's primary job — the upserts — has already succeeded.
 */
async function reconcileRetirement(
  repo: Repository,
  seen: string[],
  coverage: SweepCoverage,
  result: PollerResult,
  log: (message: string) => void,
): Promise<DeviceDiscoveryResult["retirement"]> {
  const sweepComplete = coverage.assignedToGroupTrue && coverage.assignedToGroupFalse;
  try {
    const state = await repo.deviceRetirementState();
    const plan = planRetirement({
      seen,
      active: state.active,
      retired: state.retired,
      coverage,
      batchesFailed: result.batchesFailed,
    });

    const applied = await repo.applyRetirement(plan.retire, plan.unretire);
    if (applied.retired > 0) {
      log(`  devices: retired ${applied.retired} absent device(s) (soft, reversible)`);
    }
    if (applied.unretired > 0) {
      log(`  devices: un-retired ${applied.unretired} device(s) that reappeared`);
    }
    if (plan.blockedReason !== null) {
      // Surfaced as an error because a blocked retirement means our counts are
      // knowingly still inflated — that belongs in the run log, not in silence.
      result.errors.push(`retirement skipped: ${plan.blockedReason}`);
      log(`  devices: retirement skipped — ${plan.blockedReason}`);
    }
    return {
      retired: applied.retired,
      unretired: applied.unretired,
      sweepComplete,
      blockedReason: plan.blockedReason,
    };
  } catch (error) {
    const message = `retirement reconcile failed: ${(error as Error).message}`;
    result.errors.push(message);
    return { retired: 0, unretired: 0, sweepComplete, blockedReason: message };
  }
}
