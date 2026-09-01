/**
 * Does the DEVICE agree that its screen is black? — pure, no I/O.
 *
 * The motivating case, verified live 2026-09-01: device 1000152 "Center Spark 5"
 * reported `is_black_screen = true` in EVERY platform status sample for 25+
 * minutes, and our alert engine raised a CRITICAL "Screen is black" from it. An
 * on-demand screenshot returned a frame showing a live dashboard, and telemetry
 * read CPU 28% / RAM 25%. Four devices fleet-wide were in the same state. The
 * platform's flag was contradicted by direct evidence.
 *
 * So this module refuses to restate the platform's claim as a finding. It takes
 * the claim and the panel's own answer (`is_blackscreen`, see
 * videri/telemetry.ts) and reports which of four things happened:
 *
 *   confirmed    — the platform says black and the panel agrees;
 *   contradicted — the platform says black and the panel says it is not;
 *   unanswered   — the platform says black and the panel did not answer;
 *   no-claim     — the platform is not claiming black, so there is nothing to check.
 *
 * `unanswered` is the load-bearing one. A silent device is the commonest outcome
 * on this fleet — offline panels, unsupported verbs, timeouts — and silence is
 * neither agreement nor disagreement. Folding it into either would recreate the
 * exact failure this module exists to stop: an unverified claim presented as a
 * verified one.
 *
 * `detail` states only what was observed, with the time each observation was
 * made, because a claim from 40 minutes ago and an answer from one second ago
 * are not the same kind of evidence and the operator has to see which is which.
 */

export type ScreenVerdict = "confirmed" | "contradicted" | "unanswered" | "no-claim";

/** What the platform asserts, from the most recent status sample we hold. */
export interface PlatformScreenClaim {
  /** `health_samples.is_black_screen`. null = no readable sample. */
  isBlackScreen: boolean | null;
  /** When that sample was observed. null = unknown, and said so. */
  observedAt: string | null;
}

/** What the panel itself answered, just now. */
export interface DeviceScreenAnswer {
  /** `is_blackscreen`. null = the verb did not answer (see ScreenStateReading). */
  isBlack: boolean | null;
  /**
   * `is_showing_logo`. Not part of the verdict — the claim under test is about
   * blackness — but reported in `detail` when known, because "lit but showing
   * the logo" and "lit and playing content" are different problems.
   */
  isShowingLogo?: boolean | null;
  observedAt: string | null;
}

export interface ScreenVerification {
  verdict: ScreenVerdict;
  detail: string;
}

/** "at 2026-09-01T14:02:11.000Z" / "at an unrecorded time" — never invented. */
const at = (observedAt: string | null): string =>
  observedAt === null ? "at an unrecorded time" : `at ${observedAt}`;

/**
 * The logo clause, appended only when the panel actually answered that verb.
 * Silence about the logo produces no sentence rather than a reassuring one.
 */
const logoClause = (isShowingLogo: boolean | null | undefined): string =>
  isShowingLogo === true
    ? " The panel also reports it is showing the logo rather than content."
    : isShowingLogo === false
      ? " The panel also reports it is not showing the logo."
      : "";

export function verifyBlackScreenClaim(
  platform: PlatformScreenClaim,
  device: DeviceScreenAnswer,
): ScreenVerification {
  // No claim to verify. Kept distinct from "confirmed not black": we are not
  // asserting the screen is fine, only that nothing alleged otherwise.
  if (platform.isBlackScreen !== true) {
    const observation = platform.isBlackScreen === false
      ? `The platform's most recent sample ${at(platform.observedAt)} does not report a black screen.`
      : "We hold no readable is_black_screen sample for this device.";
    const answered = device.isBlack === null
      ? ""
      : ` The panel answered is_blackscreen=${String(device.isBlack)} ${at(device.observedAt)}.`;
    return {
      verdict: "no-claim",
      detail: `${observation} There is no black-screen claim to verify.${answered}${logoClause(device.isShowingLogo)}`,
    };
  }

  const claim = `The platform reported is_black_screen=true ${at(platform.observedAt)}`;

  if (device.isBlack === null) {
    return {
      verdict: "unanswered",
      detail:
        `${claim}. The panel did not answer is_blackscreen ${at(device.observedAt)}, so the ` +
        `claim is neither confirmed nor refuted.${logoClause(device.isShowingLogo)}`,
    };
  }

  return device.isBlack
    ? {
        verdict: "confirmed",
        detail:
          `${claim}, and the panel itself answered is_blackscreen=true ${at(device.observedAt)}.` +
          logoClause(device.isShowingLogo),
      }
    : {
        verdict: "contradicted",
        detail:
          `${claim}, but the panel itself answered is_blackscreen=false ${at(device.observedAt)}.` +
          logoClause(device.isShowingLogo),
      };
}
