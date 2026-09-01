/**
 * Screen-verification slow lane — ask the panels whose black-screen claim we are
 * about to page someone over whether they are actually black, and persist the
 * answer so the alerting engine can read it without ever issuing a command.
 *
 * WHY A LANE AND NOT AN ALERTING STEP
 * Alerting runs every ~450s across the whole fleet and is pure by design. A
 * `demo_command` verb costs ~0.6s when the panel answers and ~11s of timeout
 * when it does not, so verifying inside the engine would turn a synchronous
 * fleet-wide pass into a multi-minute fan-out of device commands. Instead this
 * lane writes `device_screen_verdict` rows and the engine only READS them
 * (see alerting/evaluate.ts `applyScreenVerdict`).
 *
 * WHY THE TARGET SET IS TINY
 * Measured 2026-09-01: 9 devices carried `is_black_screen = true` and 8 of them
 * were offline. Asking an offline panel buys ~11s of silence, and silence is not
 * evidence either way. So `screenVerifyTargets` selects only devices that are
 * online RIGHT NOW and whose newest readable platform flag claims black — the
 * claims that would actually raise a critical. A batch of zero is the expected,
 * correct result on a healthy fleet, and this poller reports it as such rather
 * than widening its net to look busy.
 *
 * Reads only. `readScreenState` issues `is_blackscreen` and `is_showing_logo`,
 * both of which report state and change nothing; the only writes are the verdict
 * rows saved to our own database.
 *
 * As with the other lanes, selection lives in the repository, the parse lives in
 * videri/telemetry.ts, the verdict logic lives in intelligence/screen-verify.ts,
 * and the runner is injected — leaving this module with rotation and aggregation,
 * which are pure and unit-tested against stubs.
 */

import type { ScreenStateReading, TelemetryRunner } from "../../videri/telemetry.js";
import { readScreenState } from "../../videri/telemetry.js";
import {
  verifyBlackScreenClaim,
  type ScreenVerdict,
} from "../../intelligence/screen-verify.js";
import { mapSettled } from "../batching.js";
import { type PollerResult, emptyResult } from "./types.js";

/** Everything the injected runner needs to address one device, plus the claim under test. */
export interface ScreenVerifyTarget {
  /** Canvas UUID — our primary key and the id the verdict is saved under. */
  id: string;
  deviceId: string;
  /** XMPP JID; null means the device cannot be commanded and is skipped. */
  deviceJid: string | null;
  playerId: string | null;
  name: string | null;
  /** The platform flag we are testing. Always true for a selected target. */
  platformClaim: boolean;
  /** When that flag was sampled — persisted so the verdict is dated against it. */
  claimObservedAt: Date;
}

/** The row this lane persists. Mirrors `device_screen_verdict`. */
export interface PersistedScreenVerdict {
  platformClaim: boolean | null;
  deviceIsBlack: boolean | null;
  deviceIsShowingLogo: boolean | null;
  verdict: string;
  detail: string;
  verbsRead: string[];
  observedAt: Date;
}

/** The one repository method this poller touches, narrowed so it stubs cleanly. */
export interface ScreenVerifyRepo {
  saveScreenVerdict(deviceId: string, v: PersistedScreenVerdict): Promise<void>;
}

export interface ScreenVerifyOptions {
  /** Devices asked in parallel. Small on purpose — each is 2 synchronous verbs. */
  concurrency?: number;
  log?: (message: string) => void;
  /** Seam for tests: defaults to the real two-verb read. */
  readScreen?: (run: TelemetryRunner) => Promise<ScreenStateReading>;
  /** Seam for tests: the moment the panel answered. Defaults to wall clock. */
  now?: () => Date;
}

/**
 * Shape one device's reading into the row we store — pure.
 *
 * The verdict itself is delegated to `verifyBlackScreenClaim`, which is the only
 * place allowed to decide what confirmed/contradicted/unanswered/no-claim mean.
 * This function's job is purely the mapping, and its one rule is that an
 * unanswered verb becomes NULL, never false: `device_is_black = false` is the
 * panel actively denying blackness, which is the strongest statement in the
 * table, and inventing it from silence would refute claims we never tested.
 */
export function shapeScreenVerdict(
  target: ScreenVerifyTarget,
  screen: ScreenStateReading,
  observedAt: Date,
): PersistedScreenVerdict {
  const { verdict, detail } = verifyBlackScreenClaim(
    {
      isBlackScreen: target.platformClaim,
      observedAt: target.claimObservedAt.toISOString(),
    },
    {
      isBlack: screen.isBlack,
      isShowingLogo: screen.isShowingLogo,
      observedAt: observedAt.toISOString(),
    },
  );
  return {
    platformClaim: target.platformClaim,
    deviceIsBlack: screen.isBlack,
    deviceIsShowingLogo: screen.isShowingLogo,
    verdict,
    detail,
    verbsRead: screen.read,
    observedAt,
  };
}

/** The outcome of attempting one device, kept small so aggregation stays pure. */
export interface ScreenVerifyOutcome {
  verdict: ScreenVerdict | string;
  /** The panel answered `is_blackscreen` either way. */
  answered: boolean;
  /** The verdict row was persisted. */
  saved: boolean;
}

export interface ScreenVerifyTotals {
  rowsWritten: number;
  confirmed: number;
  contradicted: number;
  unanswered: number;
  /** Share of TARGETED devices whose panel actually answered. */
  answerYield: number | null;
}

/**
 * Fold per-device outcomes into the run's headline numbers.
 *
 * Yield is over the TARGETED denominator, so a batch where no panel answered
 * reads as 0% rather than being hidden — a device that threw outright never
 * produces an outcome and therefore counts against yield, which is correct: we
 * failed to verify it.
 *
 * `confirmed` and `contradicted` are counted separately and neither is derived
 * by subtraction. They answer different questions — "the platform was right" and
 * "the platform was wrong" — and collapsing them into a single ratio would hide
 * the only number this lane exists to produce.
 */
export function aggregateScreenVerifyRun(
  devicesTargeted: number,
  outcomes: readonly ScreenVerifyOutcome[],
): ScreenVerifyTotals {
  return {
    rowsWritten: outcomes.filter((o) => o.saved).length,
    confirmed: outcomes.filter((o) => o.verdict === "confirmed").length,
    contradicted: outcomes.filter((o) => o.verdict === "contradicted").length,
    unanswered: outcomes.filter((o) => o.verdict === "unanswered").length,
    answerYield:
      devicesTargeted === 0
        ? null
        : outcomes.filter((o) => o.answered).length / devicesTargeted,
  };
}

export interface ScreenVerifyResult extends PollerResult {
  totals: ScreenVerifyTotals;
}

export async function pollScreenVerifySlowLane(
  repo: ScreenVerifyRepo,
  targets: readonly ScreenVerifyTarget[],
  makeRunner: (t: ScreenVerifyTarget) => TelemetryRunner,
  {
    concurrency = 3,
    log = () => {},
    readScreen = readScreenState,
    now = () => new Date(),
  }: ScreenVerifyOptions = {},
): Promise<ScreenVerifyResult> {
  const startedAt = new Date();
  const base = emptyResult("screen-verify-slowlane", startedAt);
  const empty: ScreenVerifyTotals = {
    rowsWritten: 0, confirmed: 0, contradicted: 0, unanswered: 0, answerYield: null,
  };

  // An un-addressable device cannot be commanded; drop it rather than throw.
  const batch = targets.filter((t) => t.deviceJid);
  base.devicesTargeted = batch.length;
  if (batch.length === 0) {
    base.durationMs = Date.now() - startedAt.getTime();
    log(
      "  screen-verify-slowlane: no reachable device is claiming a black screen — " +
        "nothing to verify, which is the correct result, not a failure",
    );
    return { ...base, totals: empty };
  }

  const saveErrors: string[] = [];

  const { ok, failures } = await mapSettled<ScreenVerifyTarget, ScreenVerifyOutcome>(
    batch,
    concurrency,
    async (t) => {
      // Each verb inside readScreenState is independently optional, so this
      // throws only when the transport itself rejects — the honest "we could not
      // ask this device at all" signal, which is a failure and not a verdict.
      const screen = await readScreen(makeRunner(t));
      const row = shapeScreenVerdict(t, screen, now());

      let saved = false;
      try {
        await repo.saveScreenVerdict(t.id, row);
        saved = true;
      } catch (error) {
        // A persistence failure is not a device failure — we did learn the
        // answer, so it counts toward yield, but nothing was recorded and the
        // engine will keep treating the claim as unverified. Say so loudly.
        saveErrors.push(`${t.id}: save failed: ${(error as Error).message}`);
      }
      return { verdict: row.verdict, answered: screen.isBlack !== null, saved };
    },
  );

  const totals = aggregateScreenVerifyRun(batch.length, ok);

  base.batchesOk = ok.length;
  base.batchesFailed = failures.length;
  base.rowsWritten = totals.rowsWritten;
  base.telemetryYield = totals.answerYield;

  // Collapse repeated transport failures the way the telemetry lane does — a
  // handful of timing-out devices per tick should not be one log line each.
  const reasons = new Map<string, number>();
  for (const f of failures) {
    const key = f.error.message.slice(0, 60);
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  for (const [reason, count] of reasons) {
    base.errors.push(count > 1 ? `${reason} (×${count})` : reason);
  }
  for (const e of saveErrors) base.errors.push(e);

  const yieldPct =
    totals.answerYield === null ? "n/a" : `${(totals.answerYield * 100).toFixed(0)}%`;
  log(
    `  screen-verify-slowlane: asked ${ok.length}/${batch.length} panel(s) — ` +
      `${totals.contradicted} claim(s) refuted, ${totals.confirmed} confirmed, ` +
      `${totals.unanswered} unanswered, ${totals.rowsWritten} row(s) saved, ` +
      `answer yield ${yieldPct}` +
      (failures.length ? ` (${failures.length} unreachable)` : ""),
  );

  base.durationMs = Date.now() - startedAt.getTime();
  return { ...base, totals };
}
