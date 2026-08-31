/**
 * Schedule slow lane — rotate through the whole fleet reading each canvas's
 * platform SCHEDULE from the publisher's per-canvas events endpoint and
 * persisting a "scheduled now" snapshot, so proof-of-play gap detection can run
 * FLEET-WIDE from stored rows instead of live-sampling a bounded batch on every
 * `/api/proof-of-play` request (US-4.5).
 *
 * Why a slow lane, and why persisting: v1 events are per-canvas — one publisher
 * call per device — so a fleet-wide fan-out on the hot path is exactly the
 * bounded, truncating batch the endpoint has today. The fix is the same one the
 * telemetry and screenshot lanes use: every tick, take the N devices whose
 * persisted schedule is stalest (or absent), read each, persist it, and let the
 * fresh row move it to the back of the queue. A full sweep completes in
 * (fleet / batch) ticks, then loops, so nothing ages past roughly one cycle.
 *
 * Unlike telemetry, this is NOT online-only: a canvas has a platform schedule
 * whether or not it is reachable right now, and reading it is a control-plane
 * call (`GET /publisher/api/v1/canvases/{id}/events/{date}`), not a device
 * command. So every device is a candidate and coverage can span the whole fleet.
 *
 * Reads only — GET against the publisher; the sole writes are the schedule rows
 * persisted into `device_schedule`.
 *
 * Selection lives in the repository (`scheduleSlowLaneTargets`); the per-canvas
 * publisher fetch + `normalizeEvents` parse lives in the injected reader; the
 * pure "which events cover now" logic is `scheduledNow`. That leaves this module
 * with just rotation and aggregation, unit-tested against a stubbed reader+repo.
 */

import {
  scheduledNow,
  type ScheduledEvent,
} from "../../intelligence/proof-of-play.js";
import { mapSettled } from "../batching.js";
import { type PollerResult, emptyResult } from "./types.js";

/** Everything the injected reader needs to address one canvas. */
export interface ScheduleSlowLaneTarget {
  /** Canvas UUID — our primary key and the id the publisher events endpoint uses. */
  id: string;
  /** Human label for logs; falls back to the id when absent. */
  name: string | null;
}

/** The "scheduled now" snapshot persisted for one device. */
export interface PersistedSchedule {
  /** The schedule date the publisher was queried for (YYYY-MM-DD, UTC). */
  date: string;
  /** How many events cover the evaluation instant. */
  scheduledCount: number;
  /** True iff at least one event is scheduled now. */
  hasActiveSchedule: boolean;
  /** The events whose window covered `at` — the input the gap detector reasons over. */
  scheduledItems: ScheduledEvent[];
  /** When the publisher was read, so the snapshot is never presented as live. */
  fetchedAt: Date;
}

/** The one repository method this poller touches, narrowed so it stubs cleanly. */
export interface ScheduleSlowLaneRepo {
  saveSchedule(deviceId: string, s: PersistedSchedule): Promise<void>;
}

/**
 * Reads and normalises one canvas's events for `date`, returning ALL events for
 * the day (not yet filtered to "now"). The poller applies `scheduledNow`, so the
 * pure window logic stays in one tested place and the reader owns only the IO +
 * publisher-shape parse. Rejecting = "we could not read this canvas at all".
 */
export type ScheduleReader = (
  t: ScheduleSlowLaneTarget,
  date: string,
) => Promise<ScheduledEvent[]>;

export interface ScheduleSlowLaneOptions {
  /** Canvases read in parallel. Modest — one publisher call each, no rate budget. */
  concurrency?: number;
  /** Schedule date (YYYY-MM-DD). Defaults to `at`'s UTC date. */
  date?: string;
  /** Evaluation instant for `scheduledNow`. Injected for deterministic tests. */
  at?: Date;
  log?: (message: string) => void;
}

/** The outcome of attempting one device, kept small so aggregation stays pure. */
export interface ScheduleReadOutcome {
  /** At least one event was scheduled now. */
  hadSchedule: boolean;
  /** The snapshot was persisted. */
  saved: boolean;
}

/**
 * Fold per-device outcomes into the run's headline numbers.
 *
 * Yield is the share of TARGETED devices that had an active schedule — the honest
 * denominator. A device with no scheduled content is a valid read, not a failure,
 * so it counts against yield exactly like a telemetry device that answered
 * nothing; a device whose read THREW never produces an outcome and also counts
 * against yield. This keeps "yield" meaning "share of the fleet actually carrying
 * schedule data", never inflated by empty or unreadable canvases.
 */
export function aggregateScheduleRun(
  devicesTargeted: number,
  outcomes: readonly ScheduleReadOutcome[],
): { rowsWritten: number; devicesWithSchedule: number; scheduleYield: number | null } {
  const rowsWritten = outcomes.filter((o) => o.saved).length;
  const devicesWithSchedule = outcomes.filter((o) => o.hadSchedule).length;
  return {
    rowsWritten,
    devicesWithSchedule,
    scheduleYield: devicesTargeted === 0 ? null : devicesWithSchedule / devicesTargeted,
  };
}

export async function pollScheduleSlowLane(
  repo: ScheduleSlowLaneRepo,
  targets: readonly ScheduleSlowLaneTarget[],
  readSchedule: ScheduleReader,
  { concurrency = 8, date, at = new Date(), log = () => {} }: ScheduleSlowLaneOptions = {},
): Promise<PollerResult> {
  const startedAt = new Date();
  const result = emptyResult("schedule-slowlane", startedAt);
  const scheduleDate = date ?? at.toISOString().slice(0, 10);

  result.devicesTargeted = targets.length;
  if (targets.length === 0) {
    result.durationMs = Date.now() - startedAt.getTime();
    return result;
  }

  const saveErrors: string[] = [];

  const { ok, failures } = await mapSettled<ScheduleSlowLaneTarget, ScheduleReadOutcome>(
    targets,
    concurrency,
    async (t) => {
      // Rejects only when the publisher read itself fails — the honest "we could
      // not read this canvas at all" signal. An empty schedule resolves normally.
      const events = await readSchedule(t, scheduleDate);
      const scheduledItems = scheduledNow(events, at);
      const scheduledCount = scheduledItems.length;

      const snapshot: PersistedSchedule = {
        date: scheduleDate,
        scheduledCount,
        hasActiveSchedule: scheduledCount > 0,
        scheduledItems,
        fetchedAt: at,
      };

      let saved = false;
      try {
        await repo.saveSchedule(t.id, snapshot);
        saved = true;
      } catch (error) {
        // A persistence failure is not a read failure — the schedule was read, so
        // it stays in `ok` and counts toward yield, but the row was not written.
        saveErrors.push(`${t.id}: save failed: ${(error as Error).message}`);
      }
      return { hadSchedule: scheduledCount > 0, saved };
    },
  );

  const { rowsWritten, devicesWithSchedule, scheduleYield } = aggregateScheduleRun(
    targets.length,
    ok,
  );

  result.batchesOk = ok.length;
  result.batchesFailed = failures.length;
  result.rowsWritten = rowsWritten;
  result.telemetryYield = scheduleYield;

  // Collapse repeated identical read failures — at fleet scale a handful of
  // unreadable canvases per tick is unremarkable and should not spam the log.
  const reasons = new Map<string, number>();
  for (const f of failures) {
    const key = f.error.message.slice(0, 60);
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  for (const [reason, count] of reasons) {
    result.errors.push(count > 1 ? `${reason} (×${count})` : reason);
  }
  for (const e of saveErrors) result.errors.push(e);

  const yieldPct = scheduleYield === null ? "n/a" : `${(scheduleYield * 100).toFixed(0)}%`;
  log(
    `  schedule-slowlane: read ${ok.length}/${targets.length} canvas(es), ` +
      `${devicesWithSchedule} with active schedule, ${rowsWritten} row(s) saved, yield ${yieldPct}` +
      (failures.length ? ` (${failures.length} unreadable)` : ""),
  );

  result.durationMs = Date.now() - startedAt.getTime();
  return result;
}
