/**
 * `Figure<T>` — the one definition of how a number states its measurement basis.
 *
 * WHY THIS FILE EXISTS. The wrapper existed three ways: `Figure<T>` in
 * `src/api/routes/reports.ts`, a field-for-field copy called `ChurnFigure<T>` in
 * `churn.ts`, and that copy surfaced a third time through the remediation
 * summary's `byCause.figure`. The copy was deliberate — `src/intelligence/` is
 * engine land and must not import a route module — and the comment on it said so
 * and asked for this lift. Two competing definitions of "how a number states its
 * basis" is precisely how a bare number eventually escapes: the moment one copy
 * grows a field the other lacks, a consumer that renders the lean one prints a
 * figure without its denominator.
 *
 * WHY IT LIVES UNDER `src/intelligence/` AND NOT `src/api/`. The layering rule
 * that forced the duplication only runs one way: engines must not reach into the
 * API, but the API already reaches into the engines (`reports.ts` imports the
 * proof-of-play `BASIS` from here today). Putting the shared wrapper in
 * `src/api/figure.ts` would make `churn.ts` import from `src/api/` — the same
 * violation in a thinner disguise. Here, both sides import DOWNWARDS and the
 * rule holds. This module imports nothing at all, so it cannot participate in a
 * cycle either.
 *
 * WHAT IS SHARED AND WHAT IS NOT. The shape, the share arithmetic and the
 * wording of the coverage note are shared — those are the invariant. The UNIT
 * VOCABULARY is not: a report measures over screens, alerts, actions and SLA
 * dimensions, churn measures over recommendations, and their labels for the same
 * `time-buckets` code legitimately differ ("of the window" vs "of the window
 * between the two reads") because the windows are different things. So the
 * vocabulary is a parameter — `makeFigureOf(UNIT_LABEL)` binds it once per
 * domain — rather than a union welded together here, which would have changed
 * payload text to unify strings that were never meant to be one string.
 */

/**
 * What a figure was measured over. `unit` is explicit because the denominators
 * in play are genuinely different things — screens, time buckets, alerts,
 * actions, SLA dimensions, recommendations — and a bare "142 of 248" invites the
 * reader to assume screens.
 *
 * Generic over the unit vocabulary so each domain keeps the narrow union it had
 * before the lift; `string` is the fallback for a consumer that only reads.
 */
export interface FigureCoverage<U extends string = string> {
  /** Units the figure could actually be computed from. */
  measured: number;
  /** Units in scope — the denominator the reader is entitled to see. */
  inScope: number;
  unit: U;
  /** `measured / inScope`, or null when there is nothing in scope to divide by. */
  share: number | null;
  note: string;
}

/**
 * One reportable number plus what it was computed from.
 *
 * Deliberately a wrapper rather than a sibling `notes` block: a consumer that
 * renders `value` gets `basis` and `coverage` in the same object and cannot
 * accidentally print the figure without them. The invariant the tests in every
 * consuming module enforce is that EVERY figure in a payload has a non-empty
 * basis and a coverage block.
 */
export interface Figure<T, U extends string = string> {
  value: T;
  basis: string;
  coverage: FigureCoverage<U>;
}

const shareOf = (measured: number, inScope: number): number | null =>
  inScope === 0 ? null : Number((measured / inScope).toFixed(4));

/**
 * Bind a unit vocabulary to the one figure constructor.
 *
 * Returns the `figureOf` a domain uses, so the note wording — including the
 * "never counted as zero" clause, which is the honest-nulls rule written into
 * the payload — exists exactly once no matter how many vocabularies there are.
 */
export function makeFigureOf<U extends string>(unitLabel: Record<U, string>) {
  return function figureOf<T>(
    value: T,
    basis: string,
    measured: number,
    inScope: number,
    unit: U,
    note?: string,
  ): Figure<T, U> {
    const label = unitLabel[unit];
    const resolvedNote =
      note ??
      (inScope === 0
        ? `There are no ${label} in scope, so there was nothing to measure.`
        : measured === inScope
          ? `Computed from all ${inScope} ${label} in scope.`
          : `Computed from ${measured} of ${inScope} ${label} in scope; the other ` +
            `${inScope - measured} could not be measured and are excluded from this figure, ` +
            `never counted as zero.`);
    return {
      value,
      basis,
      coverage: { measured, inScope, unit, share: shareOf(measured, inScope), note: resolvedNote },
    };
  };
}
