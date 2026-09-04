/**
 * Bulk apply — one already-proven action, many devices (Epic 8.3).
 *
 * THE PROBLEM THIS SOLVES
 * `/api/remediation` returns ~283 recommendations that are really a handful of
 * ACTIONS: "apply expected Power schedule enabled" ×98 and "Nightly reboot
 * enabled" ×90 dominate it. The correct operator move is one reviewed policy
 * push; the product offered 98 separate drawer visits, each firing its own live
 * device reads. At a few thousand screens that difference is the whole product.
 *
 * WHY THE SCOPE IS DELIBERATELY NARROW — ONE ACTION
 * The only write VFI holds that is safe to multiply is the brightness write in
 * ./brightness.ts, because it is the only one with a preflight → write → verify
 * → rollback cycle: it reads the original value first, refuses to write blind,
 * reads back, and restores when the read-back disagrees. Multiplying a write
 * without that cycle by 98 is not a feature, it is an incident.
 *
 * Explicitly NOT bulk-appliable, and these are not oversights:
 *
 *   reboot_device   — ACCEPTED by the gateway and REFUSED by the hardware. It
 *                     comes back "rejected_by_device" across the fleet (see
 *                     COMMANDS in api/routes/commands.ts). A bulk verb that
 *                     cannot succeed once cannot succeed 90 times, and offering
 *                     it would manufacture 90 failures an operator has to read.
 *   power_display   — no documented params contract. `command_params` in the
 *                     spec is `additionalProperties: {type: object}` and the
 *                     field names for a power write would be guessed. We guessed
 *                     once already on brightness (`ops_set_settings
 *                     {brightness: N}`) and were wrong: the real shape was
 *                     `demo_command {arg: "set_brightness:=<0..255>"}`. A guess
 *                     is survivable on one device and not on ninety-eight.
 *   power schedule /
 *   nightly reboot  — the two drifts that MOTIVATED this endpoint. We hold no
 *                     verified write for either, which is exactly why the
 *                     remediation engine already marks them `manual`. This
 *                     endpoint therefore cannot apply them, and it says so at
 *                     the API surface rather than quietly attempting something
 *                     adjacent. See BULK_APPLICABLE_ACTIONS.
 *
 * SHAPE
 * Two pure functions and one orchestrator with all IO injected:
 *
 *   dedupeDeviceIds  — pure. The same device twice in one batch is one write.
 *   planBulkApply    — pure. Every requested device → attempt or refuse-with-a-
 *                      reason. This is the blast radius, and it is what `dryRun`
 *                      returns without touching anything.
 *   executeBulkApply — runs the per-device cycle with bounded concurrency,
 *                      isolating each device and recording each one.
 *
 * Nothing here opens a socket or a connection; the runner and the recorder are
 * arguments, so every requirement below is assertable against stubs.
 */

import { mapSettled } from "../pipeline/batching.js";
import {
  applyBrightness,
  percentFromRaw,
  rawFromPercent,
  type BrightnessResult,
  type BrightnessState,
  type CommandRunner,
} from "./brightness.js";
import { isReachableStatus } from "../intelligence/screen-state.js";
import {
  resolveIntent,
  type DeviceIntent,
  type RecordedIntent,
} from "../intelligence/device-intent.js";
import { suppressionStatus, type SuppressionRecord } from "../alerting/suppression.js";
/**
 * The brightness-state → audit-vocabulary mapper lives in the audit route on
 * purpose (see its header: the CHECK constraint is only as good as the single
 * mapper the app funnels through). Importing it here rather than re-deriving the
 * mapping is the point — a bulk row and a single-device row for the same cycle
 * MUST carry the same outcome word, or "everything that failed" stops being one
 * question. The import direction is unusual and there is no cycle: audit.ts does
 * not know this module exists.
 */
import { auditOutcomeForBrightness } from "../api/routes/audit.js";
import type { DeviceActionOutcome } from "../db/repository.js";

/** The only actions this endpoint will ever multiply. See the header. */
export const BULK_APPLICABLE_ACTIONS = ["set_brightness"] as const;
export type BulkAction = (typeof BULK_APPLICABLE_ACTIONS)[number];

/**
 * Batch cap — 100 devices.
 *
 * Three constraints meet here and 100 is the only number that satisfies all
 * three:
 *
 *  - it must be sized against the cohorts this feature exists for. The
 *    motivating groups are the two big compliance drifts, measured at 98 and 90
 *    when this was specified and at 106 and 99 on 2026-09-04. NOTE HONESTLY that
 *    neither is bulk-appliable today (no verified write — see above); the cohort
 *    for the action we CAN multiply, "Restore brightness", was 7 devices on the
 *    same read. So 100 is sized for the case where a second verified write
 *    exists, and the 106-device group already needs two batches. Raising the cap
 *    to chase a growing cohort is the wrong move — see the next constraint.
 *  - it must stay REVIEWABLE. A dry run of 100 devices is a list a human can
 *    actually read before committing. At 1,000 the confirm step becomes a
 *    rubber stamp, which is worse than no confirm at all because it looks like
 *    a control.
 *  - it must stay BOUNDED in time. Worst case per device is five device
 *    commands (preflight, write, verify, rollback write, rollback verify) at the
 *    ~10s command timeout. 100 devices × 5 × 10s ÷ 4 concurrent ≈ 21 minutes
 *    worst case, and the realistic case is far shorter because unreachable
 *    devices are refused before any command is sent. That is a job an operator
 *    can wait out; ten times that is a job that gets abandoned half-applied.
 *
 * A fleet of thousands is served by repeating a reviewable batch, not by raising
 * the cap until nobody reads the confirm screen.
 */
export const BULK_MAX_DEVICES = 100;

/**
 * Concurrent device writes — 4.
 *
 * The same number the telemetry slow lane runs at (run-telemetry-slowlane.ts),
 * against the same messaging service with the same `demo_command` shape, so it
 * is a proven-not-to-upset-the-gateway figure rather than a fresh guess. And the
 * reason it is modest is recorded in pipeline/batching.ts: **no rate limit is
 * documented anywhere in the Videri API and no operation declares a 429.** With
 * no published budget the only defensible posture is to stay well under any
 * plausible one — a bulk write that trips an undocumented limit would fail some
 * devices mid-cycle, which is the one state this design exists to avoid.
 */
export const BULK_CONCURRENCY = 4;

/**
 * Why a device was left out. `refused` in the audit vocabulary means the device
 * was never touched, and every reason here is that kind of refusal — nothing in
 * this list reached the panel.
 */
export type BulkRefusalReason =
  | "not_found"
  | "not_addressable"
  | "unreachable"
  | "intent_tagged"
  | "suppressed";

/** Everything the planner needs about one requested device. Honest nulls. */
export interface BulkTargetFacts {
  deviceId: string;
  /** `null` when the device is not in our active fleet view at all. */
  device: { name: string | null; status: string } | null;
  /**
   * Whether we hold an XMPP JID for it — presence of an ADDRESS, nothing more.
   * (This module never reads, probes or persists anything XMPP; addressability
   * is a boolean handed in by the caller.)
   */
  addressable: boolean;
  /** The operator's recorded intent claim for this device, if they made one. */
  recordedIntent: RecordedIntent | null;
  /** Suppression records naming this device, any scope. Expiry is judged here. */
  suppressions: readonly SuppressionRecord[];
}

export interface BulkPlanItem {
  deviceId: string;
  deviceLabel: string;
  decision: "attempt" | "refuse";
  /** Non-null exactly when `decision` is `refuse`. */
  reason: BulkRefusalReason | null;
  explanation: string;
  /**
   * Every OTHER reason that also blocked this device. Published because an
   * offline EoL unit is refused for one reason and disqualified by two, and
   * reporting only the winner is how an operator brings a lab spare back online
   * and expects it to join the next batch.
   */
  alsoBlockedBy: BulkRefusalReason[];
  /** The intent that excluded it, when that is why. Render `source` before believing it. */
  intent: DeviceIntent | null;
  /** The suppression that excluded it, when that is why. */
  suppression: { id: string; reason: string; createdBy: string; ruleId: string | null } | null;
}

export interface BulkPlan {
  items: BulkPlanItem[];
  counts: {
    requested: number;
    attempt: number;
    refuse: number;
    byReason: Record<BulkRefusalReason, number>;
  };
}

const label = (deviceId: string, name: string | null | undefined): string =>
  name && name.trim() !== "" ? name : deviceId;

/**
 * The same device twice in one request is one write, not two.
 *
 * Not pedantry: the console builds the id list from a recommendation list, and a
 * device with two drifts appears twice in it. Writing to the same panel twice
 * inside one batch would race its own preflight — the second cycle would read
 * the first cycle's value as the "original" it must roll back to.
 */
export function dedupeDeviceIds(ids: readonly string[]): {
  ids: string[];
  duplicatesRemoved: number;
} {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return { ids: out, duplicatesRemoved: ids.length - out.length };
}

/**
 * Which suppression, if any, means "leave this device alone"?
 *
 * Mirrors `matchSuppression`'s rule about `intent: "none"`: that value is an
 * operator saying "this device IS production, the name is lying". It is a claim
 * ABOUT the asset, not a request to silence it, so it never suppresses anything
 * — including a bulk apply. Reading it as an exclusion would mean the one way an
 * operator can overrule the name heuristic also removes the device from the
 * bulk path, which is precisely backwards.
 *
 * Both device-scoped and rule-scoped records exclude. A rule-scoped record says
 * "this alert is expected here", which is a weaker claim than "this device is a
 * spare" — but it is still an operator's recorded reason to expect this device
 * to look wrong, and a bulk push is the wrong place to litigate it. The narrow
 * per-device path is still open and shows the record.
 */
function blockingSuppression(
  suppressions: readonly SuppressionRecord[],
  now: Date,
): SuppressionRecord | null {
  const active = suppressions
    .filter((r) => r.intent !== "none" && suppressionStatus(r, now).active)
    // Most specific first, then most recent — the same precedence matchSuppression
    // uses, so the record we NAME is the record an operator would expect to see.
    .sort((a, b) => {
      const specificity = (a.ruleId === null ? 1 : 0) - (b.ruleId === null ? 1 : 0);
      if (specificity !== 0) return specificity;
      const recency = b.createdAt.getTime() - a.createdAt.getTime();
      if (recency !== 0) return recency;
      return a.id.localeCompare(b.id);
    });
  return active[0] ?? null;
}

/**
 * Turn a requested device list into the blast radius: attempt, or refuse and why.
 *
 * Pure, and the whole reason `dryRun` can be trusted — the mode that "touches
 * nothing" is not a separate code path with its own bugs, it is this function
 * returning before anything is called.
 *
 * REASON ORDER is deliberate. `not_found` first because with no device row we
 * hold no other facts. Then the POLICY exclusions (intent, suppression), because
 * a decision about whether we should touch the asset at all does not change when
 * the device comes back online, and telling an operator "offline" about an EoL
 * unit sends them to fix the wrong thing. Then addressability, then reachability
 * — the two transient ones, last.
 */
export function planBulkApply(
  targets: readonly BulkTargetFacts[],
  now: Date,
): BulkPlan {
  const items: BulkPlanItem[] = targets.map((t) => {
    const deviceLabel = label(t.deviceId, t.device?.name);
    const base = {
      deviceId: t.deviceId,
      deviceLabel,
      alsoBlockedBy: [] as BulkRefusalReason[],
      intent: null as DeviceIntent | null,
      suppression: null as BulkPlanItem["suppression"],
    };

    if (!t.device) {
      return {
        ...base,
        decision: "refuse" as const,
        reason: "not_found" as const,
        explanation:
          "No active device with this id. It may have been retired upstream since " +
          "the list was built; nothing was sent.",
      };
    }

    // US-8.2.7's whole point, applied to the bulk path. `resolveIntent` takes the
    // operator's recorded decision first and only then the name heuristic, so a
    // recorded `none` correctly yields no intent at all.
    const intent = resolveIntent(t.device.name, t.recordedIntent);
    const suppression = blockingSuppression(t.suppressions, now);
    // Presence, NOT the derived status. `isReachableStatus` permits 'warning' and
    // 'alert': a screen showing black or the logo fallback collapses to one of
    // those and is perfectly writable. Only 'offline'/'unknown' mean we can
    // neither see nor act. Reading a dark-but-reachable panel as unwritable has
    // bitten this codebase repeatedly.
    const reachable = isReachableStatus(t.device.status);

    const blockers: BulkRefusalReason[] = [];
    if (intent) blockers.push("intent_tagged");
    if (suppression) blockers.push("suppressed");
    if (!t.addressable) blockers.push("not_addressable");
    if (!reachable) blockers.push("unreachable");

    if (blockers.length === 0) {
      return {
        ...base,
        decision: "attempt" as const,
        reason: null,
        explanation: `Reachable (${t.device.status}), addressable, and nothing says leave it alone.`,
      };
    }

    const reason = blockers[0]!;
    const explanation =
      reason === "intent_tagged"
        ? `Excluded: we believe this device is ${intent!.kind}. ${intent!.rationale} ` +
          `A bulk apply will not write to it. Act on it from its own drawer, where the ` +
          `intent is in front of you — or record intent "none" against it if this is a ` +
          `production screen and the name is misleading.`
        : reason === "suppressed"
          ? `Excluded: an active suppression covers this device — "${suppression!.reason}" ` +
            `(${suppression!.createdBy}${suppression!.ruleId ? `, rule ${suppression!.ruleId}` : ", whole device"}). ` +
            `Someone recorded a reason to expect this device to look wrong; a bulk push ` +
            `is not the place to overrule it.`
          : reason === "not_addressable"
            ? "No XMPP JID recorded, so sync_command cannot address it. Nothing was sent."
            : `Presence is "${t.device.status}", so we can neither read its current ` +
              `brightness nor verify a write. Nothing was sent.`;

    return {
      ...base,
      decision: "refuse" as const,
      reason,
      explanation,
      alsoBlockedBy: blockers.slice(1),
      intent,
      suppression: suppression
        ? {
            id: suppression.id,
            reason: suppression.reason,
            createdBy: suppression.createdBy,
            ruleId: suppression.ruleId,
          }
        : null,
    };
  });

  const byReason: Record<BulkRefusalReason, number> = {
    not_found: 0, not_addressable: 0, unreachable: 0, intent_tagged: 0, suppressed: 0,
  };
  for (const item of items) if (item.reason) byReason[item.reason] += 1;

  return {
    items,
    counts: {
      requested: items.length,
      attempt: items.filter((i) => i.decision === "attempt").length,
      refuse: items.filter((i) => i.decision === "refuse").length,
      byReason,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// execution — IO injected
// ─────────────────────────────────────────────────────────────────────────────

/** One device's place in the batch, handed to the recorder. Never aggregated. */
export interface BulkDeviceEvent {
  batchId: string;
  batchSize: number;
  deviceId: string;
  deviceLabel: string;
  requestedPercent: number;
  /** Non-null exactly when NOTHING was sent to this device. */
  refusedBecause: BulkRefusalReason | null;
  /** The planner's sentence, or the cycle's. Always the reason for the outcome. */
  explanation: string;
  /** The full preflight → write → verify → rollback result, or null if never attempted. */
  result: BrightnessResult | null;
  /** Non-null only when the runner itself threw — "we could not reach it at all". */
  transportError: string | null;
  outcome: DeviceActionOutcome;
  startedAt: Date;
  durationMs: number;
}

export interface BulkApplyDeps {
  /** A `CommandRunner` bound to one device. Called only for `attempt` items. */
  runnerFor: (deviceId: string) => CommandRunner;
  /**
   * Record one device's outcome. Contracted not to throw; the executor guards
   * anyway, because "logging never breaks the write" must not depend on a
   * contract in another file staying true.
   */
  record: (event: BulkDeviceEvent) => Promise<void>;
  concurrency?: number;
  /** Injectable clock, so durations are assertable. */
  nowMs?: () => number;
}

export interface BulkDeviceResult {
  deviceId: string;
  deviceLabel: string;
  /** The audit word, so a bulk row and a drawer row read identically. */
  outcome: DeviceActionOutcome;
  /** Non-null exactly when nothing was sent. */
  refusedBecause: BulkRefusalReason | null;
  /** The cycle's own state, or null when the device was never touched. */
  state: BrightnessState | null;
  requestedPercent: number;
  observedPercent: number | null;
  /** True only for a verified write. Every other value means the panel is NOT there. */
  applied: boolean;
  message: string;
  /** Whether this device's audit row was written. */
  audited: boolean;
  durationMs: number;
}

export interface BulkBatchResult {
  batchId: string;
  requestedPercent: number;
  requestedRaw: number;
  results: BulkDeviceResult[];
  counts: {
    attempted: number;
    /** Keyed by the audit vocabulary — `refused` and `failed` stay separate. */
    byOutcome: Record<DeviceActionOutcome, number>;
    auditRowsWritten: number;
    auditRowsFailed: number;
  };
  /**
   * Devices whose write did not verify AND whose rollback could not be
   * confirmed. These panels may be at a brightness nobody chose. This is the one
   * field in the response that means "a human must look now".
   */
  needsAttention: string[];
  /**
   * Anything `mapSettled` caught that the per-device path did not. Should always
   * be empty; non-empty means a bug in this module, not a device problem.
   */
  unexpectedFailures: string[];
}

const emptyOutcomeCounts = (): Record<DeviceActionOutcome, number> => ({
  applied: 0, verified: 0, no_change: 0, rolled_back: 0, rollback_failed: 0,
  refused: 0, failed: 0,
});

/**
 * Run the batch. Every device keeps its own full cycle, and its own failure.
 *
 * Per-device isolation is the requirement that shapes everything here:
 *
 *  - each device is wrapped in its own try/catch, so a transport failure on one
 *    panel produces THAT panel's `failed` result and the other 97 continue. The
 *    `mapSettled` around it is belt-and-braces (its collected failures surface
 *    as `unexpectedFailures`, which should never be populated);
 *  - a refused device is recorded as `refused`, never as a success and never as
 *    a `failed` — we declined and the panel was never touched, and collapsing
 *    those two would make "what did that push break?" unanswerable;
 *  - the audit call is awaited INSIDE the worker and its failure is caught
 *    there, so a broken audit table costs one `audited: false` flag and does not
 *    stop the batch or mask an outcome.
 *
 * There is no aggregate verdict returned, on purpose. The counts are a summary
 * of per-device facts, not a judgement about the batch.
 */
export async function executeBulkApply(
  plan: BulkPlan,
  requestedPercent: number,
  batchId: string,
  deps: BulkApplyDeps,
): Promise<BulkBatchResult> {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const batchSize = plan.items.length;
  const byOutcome = emptyOutcomeCounts();
  let auditRowsWritten = 0;
  let auditRowsFailed = 0;

  const settled = await mapSettled<BulkPlanItem, BulkDeviceResult>(
    plan.items,
    Math.max(1, deps.concurrency ?? BULK_CONCURRENCY),
    async (item) => {
      const startedMs = nowMs();
      const startedAt = new Date(startedMs);

      let result: BrightnessResult | null = null;
      let transportError: string | null = null;

      if (item.decision === "attempt") {
        try {
          // The FULL cycle, per device. Bulk does not get a cheaper write: a
          // batch of 98 fire-and-forget sends is exactly the thing this endpoint
          // exists so that nobody builds.
          result = await applyBrightness(item.deviceId, requestedPercent, deps.runnerFor(item.deviceId));
        } catch (error) {
          transportError = (error as Error).message;
        }
      }

      const outcome: DeviceActionOutcome =
        item.decision === "refuse"
          ? "refused"
          : transportError !== null
            ? "failed"
            : auditOutcomeForBrightness(result!.state);

      const explanation =
        item.decision === "refuse"
          ? item.explanation
          : transportError !== null
            ? `The device could not be reached: ${transportError}`
            : result!.message;

      const durationMs = nowMs() - startedMs;

      let audited = false;
      try {
        await deps.record({
          batchId, batchSize,
          deviceId: item.deviceId,
          deviceLabel: item.deviceLabel,
          requestedPercent,
          refusedBecause: item.decision === "refuse" ? item.reason : null,
          explanation,
          result,
          transportError,
          outcome,
          startedAt,
          durationMs,
        });
        audited = true;
      } catch {
        // Swallowed deliberately. An audit failure must never turn a completed
        // write into an error the operator reads as "it did not happen"; the
        // device outcome below is reported exactly as it happened, with
        // `audited: false` saying the row is missing.
        audited = false;
      }

      byOutcome[outcome] += 1;
      if (audited) auditRowsWritten += 1;
      else auditRowsFailed += 1;

      return {
        deviceId: item.deviceId,
        deviceLabel: item.deviceLabel,
        outcome,
        refusedBecause: item.decision === "refuse" ? item.reason : null,
        state: result?.state ?? null,
        requestedPercent,
        // Honest null: unread is null, never 0 — raw 0 on this scale is a
        // display-OFF panel and would read as a screen we blanked.
        observedPercent:
          result && result.observedRaw !== null ? percentFromRaw(result.observedRaw) : null,
        applied: result?.applied ?? false,
        message: explanation,
        audited,
        durationMs,
      };
    },
  );

  return {
    batchId,
    requestedPercent,
    requestedRaw: rawFromPercent(requestedPercent),
    results: settled.ok,
    counts: {
      attempted: plan.counts.attempt,
      byOutcome,
      auditRowsWritten,
      auditRowsFailed,
    },
    needsAttention: settled.ok
      .filter((r) => r.outcome === "rollback_failed")
      .map((r) => r.deviceId),
    unexpectedFailures: settled.failures.map(
      (f) => `${plan.items[f.index]?.deviceId ?? `#${f.index}`}: ${f.error.message}`,
    ),
  };
}
