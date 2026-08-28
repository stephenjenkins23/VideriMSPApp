/**
 * Runtime-telemetry slow lane — rotate through the online estate reading
 * per-device CPU / memory / signal / NTP / storage and persisting each reading,
 * so fleet-wide health can be populated from data that today only exists when a
 * human opens one device's drawer.
 *
 * The batch `metrics/fetch_all` payload carries none of this (see
 * videri/telemetry.ts); it is readable only per-device through the demo_command
 * shell, one field at a time, at roughly a second a field. That makes this the
 * SLOW lane by nature — it can never be a fleet-wide fan-out on the hot path.
 * The strategy is the same one `evidence.ts` uses for screenshots: every tick,
 * take the N online devices whose telemetry is stalest (or absent), read each,
 * and let the fresh row move it to the back of the queue. A full sweep of the
 * online estate completes in (online / batch) ticks, then loops, so nothing
 * ages past roughly one sweep cycle.
 *
 * Reads only. `readDeviceTelemetry` issues demo_command verbs that report state
 * and change nothing on the device; this poller adds no writes of its own beyond
 * persisting what it read into `device_telemetry`. It is deliberately gentle:
 * a small batch, low concurrency, online devices only.
 *
 * Selection lives in the repository (`telemetrySlowLaneTargets`); the per-field
 * read + parse lives in `readDeviceTelemetry`; the runner that actually talks to
 * a device is injected. That leaves this module with just the rotation and
 * aggregation logic, which is pure and unit-tested against a stubbed runner+repo.
 */

import type { DeviceTelemetry, TelemetryRunner } from "../../videri/telemetry.js";
import { readDeviceTelemetry } from "../../videri/telemetry.js";
import { mapSettled } from "../batching.js";
import { type PollerResult, emptyResult } from "./types.js";

/** Everything the injected runner needs to address one device. */
export interface TelemetrySlowLaneTarget {
  /** Canvas UUID — our primary key and the id telemetry is saved under. */
  id: string;
  deviceId: string;
  /** XMPP JID; null means the device cannot be commanded and is skipped. */
  deviceJid: string | null;
  playerId: string | null;
}

/** The one repository method this poller touches, narrowed so it stubs cleanly. */
export interface TelemetrySlowLaneRepo {
  saveTelemetry(deviceId: string, t: DeviceTelemetry): Promise<void>;
}

export interface TelemetrySlowLaneOptions {
  /** Devices read in parallel. Small on purpose — each device is ~6 commands. */
  concurrency?: number;
  log?: (message: string) => void;
  /** Seam for tests: defaults to the real per-device read. */
  readTelemetry?: (run: TelemetryRunner) => Promise<DeviceTelemetry>;
}

/** True when at least one telemetry field actually resolved for this device. */
export function hasTelemetryValue(t: DeviceTelemetry): boolean {
  return t.read.length > 0;
}

/** The outcome of attempting one device, kept small so aggregation stays pure. */
export interface DeviceReadOutcome {
  /** At least one field resolved. */
  hadValue: boolean;
  /** The reading was persisted. */
  saved: boolean;
}

/**
 * Fold per-device outcomes into the run's headline numbers.
 *
 * Yield is the share of TARGETED devices that returned at least one field — the
 * honest denominator, so a batch where every device answered nothing reads as
 * 0% rather than being quietly hidden. A device that threw outright never
 * produces an outcome, so it too counts against yield.
 */
export function aggregateTelemetryRun(
  devicesTargeted: number,
  outcomes: readonly DeviceReadOutcome[],
): { rowsWritten: number; devicesWithValue: number; telemetryYield: number | null } {
  const rowsWritten = outcomes.filter((o) => o.saved).length;
  const devicesWithValue = outcomes.filter((o) => o.hadValue).length;
  return {
    rowsWritten,
    devicesWithValue,
    telemetryYield: devicesTargeted === 0 ? null : devicesWithValue / devicesTargeted,
  };
}

export async function pollTelemetrySlowLane(
  repo: TelemetrySlowLaneRepo,
  targets: readonly TelemetrySlowLaneTarget[],
  makeRunner: (t: TelemetrySlowLaneTarget) => TelemetryRunner,
  { concurrency = 4, log = () => {}, readTelemetry = readDeviceTelemetry }: TelemetrySlowLaneOptions = {},
): Promise<PollerResult> {
  const startedAt = new Date();
  const result = emptyResult("telemetry-slowlane", startedAt);

  // An un-addressable device cannot be commanded; drop it rather than throw.
  const batch = targets.filter((t) => t.deviceJid);
  result.devicesTargeted = batch.length;
  if (batch.length === 0) {
    result.durationMs = Date.now() - startedAt.getTime();
    return result;
  }

  const saveErrors: string[] = [];

  const { ok, failures } = await mapSettled<TelemetrySlowLaneTarget, DeviceReadOutcome>(
    batch,
    concurrency,
    async (t) => {
      // Reads are independently optional inside readDeviceTelemetry; this throws
      // only when the runner itself rejects (e.g. transport failure), which is
      // the honest "we could not reach this device at all" signal.
      const telemetry = await readTelemetry(makeRunner(t));
      const hadValue = hasTelemetryValue(telemetry);

      let saved = false;
      try {
        await repo.saveTelemetry(t.id, telemetry);
        saved = true;
      } catch (error) {
        // A persistence failure is not a device failure — the read succeeded, so
        // it stays in `ok` and counts toward yield, but the row was not written.
        saveErrors.push(`${t.id}: save failed: ${(error as Error).message}`);
      }
      return { hadValue, saved };
    },
  );

  const { rowsWritten, devicesWithValue, telemetryYield } = aggregateTelemetryRun(
    batch.length,
    ok,
  );

  result.batchesOk = ok.length;
  result.batchesFailed = failures.length;
  result.rowsWritten = rowsWritten;
  result.telemetryYield = telemetryYield;

  // Collapse repeated read failures the way evidence.ts does — at fleet scale a
  // handful of offline/timing-out devices per tick is unremarkable and should
  // not spam the run log with one line each.
  const reasons = new Map<string, number>();
  for (const f of failures) {
    const key = f.error.message.slice(0, 60);
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  for (const [reason, count] of reasons) {
    result.errors.push(count > 1 ? `${reason} (×${count})` : reason);
  }
  for (const e of saveErrors) result.errors.push(e);

  const yieldPct = telemetryYield === null ? "n/a" : `${(telemetryYield * 100).toFixed(0)}%`;
  log(
    `  telemetry-slowlane: read ${ok.length}/${batch.length} device(s), ` +
      `${devicesWithValue} with data, ${rowsWritten} row(s) saved, yield ${yieldPct}` +
      (failures.length ? ` (${failures.length} unreachable)` : ""),
  );

  result.durationMs = Date.now() - startedAt.getTime();
  return result;
}
