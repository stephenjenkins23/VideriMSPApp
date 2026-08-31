/**
 * Device retirement planning — pure, no IO.
 *
 * The devices table only ever accumulates: every sweep upserts, nothing removes.
 * Measured 2026-08-31: 250 rows against 249 devices in the live API, with row
 * 1035066 four days stale and absent from `/canvases` entirely. So every
 * fleet-wide total was inflated by a device that no longer exists.
 *
 * Retiring is a soft, reversible marker (`devices.retired_at`) — never a DELETE,
 * because the history behind a decommissioned device is the only record it was
 * ever there and a hard delete cannot be undone.
 *
 * The danger is the opposite failure: a sweep that half-succeeded would mark the
 * missing 90% of the fleet as retired in one tick. So this planner is deliberately
 * asymmetric:
 *
 *   - UN-retiring is always safe and always applied. Seeing a device live is
 *     positive evidence it exists, regardless of how complete the sweep was.
 *   - RETIRING requires positive evidence of a COMPLETE sweep: both
 *     `assigned_to_group` legs paginated to exhaustion (neither value means "all"
 *     — 233 + 16 = 249), zero failed upsert batches, and the resulting retirement
 *     must stay under a sanity ceiling. Anything else is refused with a reason.
 *
 * All decisions are computed here so they are testable without a database or a
 * network; devices.ts only supplies the inputs and applies the result.
 */

/** Which sweep legs ran to exhaustion. Both are required to retire anything. */
export interface SweepCoverage {
  assignedToGroupTrue: boolean;
  assignedToGroupFalse: boolean;
}

export interface RetirementInputs {
  /** Device ids observed in this sweep. */
  seen: readonly string[];
  /** Device ids currently active in the registry (`retired_at IS NULL`). */
  active: readonly string[];
  /** Device ids currently retired — candidates to bring back. */
  retired: readonly string[];
  coverage: SweepCoverage;
  /** Upsert batches that failed this tick. Any failure blocks retirement. */
  batchesFailed: number;
  /**
   * Ceiling on the share of the active registry one tick may retire. A genuine
   * decommission is a handful of devices; a sweep that "loses" a third of the
   * fleet is a platform hiccup, and acting on it would erase the fleet from every
   * count until the next tick. Refuse instead and say why.
   */
  maxRetireFraction?: number;
}

export interface RetirementPlan {
  /** Active ids the sweep did not see — to be marked retired. */
  retire: string[];
  /** Retired ids the sweep DID see — to be brought back. */
  unretire: string[];
  /** Null when retirement was allowed; otherwise why it was withheld. */
  blockedReason: string | null;
}

/**
 * Default ceiling: a tick may retire at most 20% of the active registry.
 *
 * At 250 devices that is 50 — far above any plausible real decommission batch
 * (we are chasing ONE stale row) and far below the mass-retirement a broken sweep
 * would attempt.
 */
const MAX_RETIRE_FRACTION = 0.2;

export function planRetirement(input: RetirementInputs): RetirementPlan {
  const seen = new Set(input.seen);
  // Always applied: a device we just read from the live API exists, and leaving it
  // retired would keep under-counting the fleet in the other direction.
  const unretire = input.retired.filter((id) => seen.has(id));
  const missing = input.active.filter((id) => !seen.has(id));

  const complete = input.coverage.assignedToGroupTrue && input.coverage.assignedToGroupFalse;
  if (!complete) {
    const legs = [
      input.coverage.assignedToGroupTrue ? null : "assigned_to_group=true",
      input.coverage.assignedToGroupFalse ? null : "assigned_to_group=false",
    ].filter((x): x is string => x !== null);
    return {
      retire: [],
      unretire,
      blockedReason:
        `sweep incomplete (${legs.join(" and ")} did not finish), so ${missing.length} ` +
        `unseen device(s) were NOT retired — absence from a partial sweep is not evidence ` +
        `of deletion`,
    };
  }

  if (input.batchesFailed > 0) {
    return {
      retire: [],
      unretire,
      blockedReason:
        `${input.batchesFailed} upsert batch(es) failed this tick, so the sweep is not ` +
        `trusted as complete and ${missing.length} unseen device(s) were NOT retired`,
    };
  }

  // A sweep that saw nothing at all is a failed sweep however cleanly it returned.
  if (seen.size === 0 && input.active.length > 0) {
    return {
      retire: [],
      unretire,
      blockedReason:
        `the sweep returned 0 devices while ${input.active.length} are active — treated as ` +
        `a failed read, not as an empty fleet`,
    };
  }

  // `max(1, …)` so a genuinely tiny tenant (1–4 devices) can still retire its one
  // decommissioned device; the fraction is what protects a real fleet.
  const ceiling = Math.max(
    1,
    Math.floor(input.active.length * (input.maxRetireFraction ?? MAX_RETIRE_FRACTION)),
  );
  if (missing.length > ceiling) {
    return {
      retire: [],
      unretire,
      blockedReason:
        `${missing.length} of ${input.active.length} active device(s) were absent from an ` +
        `apparently-complete sweep, above the ${Math.round(
          (input.maxRetireFraction ?? MAX_RETIRE_FRACTION) * 100,
        )}% ceiling (${ceiling}) — refusing to mass-retire the fleet on one tick`,
    };
  }

  return { retire: missing, unretire, blockedReason: null };
}
