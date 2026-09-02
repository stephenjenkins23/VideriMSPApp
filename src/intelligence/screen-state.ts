/**
 * Is the screen dark, and is that darkness EXPECTED? — pure, no I/O.
 *
 * This module exists because of a real false positive we shipped: the
 * remediation engine read `device_settings.settings->>'brightness'` and treated
 * 0 as "the display is off". It is not. On this fleet `brightness` is the
 * SCHEDULED / base value the platform holds; the panel's actual output is
 * `current_brightness`, and whether the backlight is on at all is `display_on`.
 * 21 of the 33 devices we flagged read `brightness = 0` while
 * `current_brightness` was 179–255 and `display_on = "true"` — lit screens, and
 * a one-click "restore brightness" would have CHANGED 21 correctly-working
 * devices.
 *
 * The second half of the problem: a dark panel is not automatically a fault.
 * Every one of those devices runs `brightness_schedule_enabled = "true"` with a
 * `turn_on_time`/`turn_off_time` pair (e.g. "0900"/"0500") evaluated in the
 * device's OWN timezone. A screen that is dark at 03:00 local because its
 * schedule turned it off is working exactly as configured; telling an operator
 * to "fix" it is noise at best and a write to a healthy device at worst.
 *
 * So the verdict is three-way, plus honest unknown:
 *   lit / dark-unexpected / dark-expected / unknown
 * and every input that cannot be read is `null` — never a convenient `false`.
 */

/**
 * The live-state subset of a device the verdict needs. Declared structurally
 * (not imported from remediation.ts) so this module stays a leaf: `DeviceView`
 * satisfies it, and nothing here depends on the engine.
 */
export interface ScreenStateFacts {
  /** `settings->>'current_brightness'` — the panel's ACTUAL output, 0–255. */
  currentBrightnessRaw: number | null;
  /** `settings->>'display_on'` — is the backlight on. Null = never read. */
  displayOn: boolean | null;
  /** `settings->>'brightness_schedule_enabled'` — is an on/off window in force. */
  brightnessScheduleEnabled: boolean | null;
  /** `settings->>'turn_on_time'` / `'turn_off_time'`, "HHmm" in device-local time. */
  turnOnTime: string | null;
  turnOffTime: string | null;
  /** IANA zone from `devices.timezone`, e.g. "America/New_York". */
  timezone: string | null;
}

export type DarknessVerdict = "lit" | "dark-expected" | "dark-unexpected" | "unknown";

/**
 * Live evidence that the panel is dark: the panel reports 0 output, or the
 * backlight reports off. Either one alone is enough — a device can report
 * `current_brightness = 200` with `display_on = false` (value retained across a
 * power-off), and that screen is dark.
 *
 * `null` when NEITHER field was read: we do not know, and "we do not know" must
 * never collapse into "it is fine". Deliberately does NOT look at `brightness`,
 * which is the scheduled/base value and is what caused the false positive.
 */
export function isDark(facts: ScreenStateFacts): boolean | null {
  if (facts.currentBrightnessRaw === 0 || facts.displayOn === false) return true;
  // At least one signal was readable and neither says dark.
  if (facts.currentBrightnessRaw !== null || facts.displayOn !== null) return false;
  return null;
}

/**
 * Minutes-since-midnight from an "HHmm" string ("0900" → 540). Strict on
 * purpose: anything that is not four digits inside a real clock range is `null`,
 * because a mis-parsed schedule silently converts a healthy device into an alert.
 */
export function parseHHmm(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{2})(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** "0900" → "09:00" for operator-facing text. `null` in, `null` out. */
export function formatHHmm(value: string | null | undefined): string | null {
  const minutes = parseHHmm(value);
  if (minutes === null) return null;
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Wall-clock minutes-since-midnight at `at`, in `timeZone`. Uses Intl so DST is
 * handled by the platform's tz database rather than a fixed offset we would get
 * wrong twice a year. Returns `null` for an unknown zone (Intl throws) — never a
 * silent fallback to UTC, which would judge a New York schedule 4–5 hours off.
 */
export function localMinutes(at: Date, timeZone: string): number | null {
  if (!timeZone || Number.isNaN(at.getTime())) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      // h23 explicitly: `hour12: false` has historically rendered midnight as
      // "24" on some ICU builds, which would push a 00:xx device to 24:xx.
      hourCycle: "h23",
    }).formatToParts(at);
  } catch {
    return null;
  }
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return (hour % 24) * 60 + minute;
}

/**
 * Is `at` inside the device's scheduled ON window, judged in the DEVICE's
 * timezone?
 *
 * Half-open by design: the turn-on minute is inside the window, the turn-off
 * minute is outside it. Handles the overnight wrap, which is the common shape on
 * this fleet — "0900"→"0500" is ~20h ON spanning midnight, not a 4h window read
 * backwards.
 *
 * `null` whenever any input is missing or unparseable: we would rather say "we
 * cannot tell" than guess a window and call a working screen broken.
 */
export function withinOnWindow(
  turnOnTime: string | null,
  turnOffTime: string | null,
  timezone: string | null,
  at: Date,
): boolean | null {
  const on = parseHHmm(turnOnTime);
  const off = parseHHmm(turnOffTime);
  if (on === null || off === null || timezone === null) return null;
  // A window whose ends coincide is degenerate — "always on" and "always off"
  // are indistinguishable from the two numbers alone, so we refuse to pick one.
  if (on === off) return null;

  const nowMinutes = localMinutes(at, timezone);
  if (nowMinutes === null) return null;

  return on < off
    ? nowMinutes >= on && nowMinutes < off
    : // Wraps midnight: on from turn_on through end of day, and again from
      // midnight until turn_off.
      nowMinutes >= on || nowMinutes < off;
}

/**
 * The one call the remediation engine makes.
 *
 *   - `lit`             — live evidence says the panel is producing light. NOT a
 *                         finding, whatever the stored `brightness` value says.
 *   - `dark-expected`   — dark, a schedule is enabled, and we are outside its ON
 *                         window. Working as configured.
 *   - `dark-unexpected` — dark inside the ON window, or dark with no schedule
 *                         enabled to explain it. This is the real fault.
 *   - `unknown`         — no live evidence either way, or a schedule is enabled
 *                         but its window cannot be evaluated (unreadable times
 *                         or timezone), so we cannot say whether the darkness is
 *                         expected. No recommendation follows from an unknown.
 *
 * Note the asymmetry on the schedule flag: only `true` buys the device an
 * exemption. `false` means nothing should be holding the panel dark, and `null`
 * (never read) leaves the darkness unexplained — in both cases the live reading
 * stands on its own, and we are not inventing a symptom, only failing to find an
 * excuse for one we measured.
 */
export function darknessVerdict(facts: ScreenStateFacts, at: Date): DarknessVerdict {
  const dark = isDark(facts);
  if (dark === null) return "unknown";
  if (!dark) return "lit";

  if (facts.brightnessScheduleEnabled === true) {
    const inWindow = withinOnWindow(
      facts.turnOnTime,
      facts.turnOffTime,
      facts.timezone,
      at,
    );
    if (inWindow === null) return "unknown";
    return inWindow ? "dark-unexpected" : "dark-expected";
  }

  return "dark-unexpected";
}

/**
 * "09:00–05:00 local (America/New_York)" for rationale text, or `null` when the
 * window is not readable — so callers never print a half-formed window.
 */
export function describeOnWindow(facts: ScreenStateFacts): string | null {
  const on = formatHHmm(facts.turnOnTime);
  const off = formatHHmm(facts.turnOffTime);
  if (on === null || off === null) return null;
  return facts.timezone ? `${on}–${off} local (${facts.timezone})` : `${on}–${off} local`;
}

/**
 * How we know it is dark, in operator words — only from fields we actually read,
 * so the rationale can never claim a reading we do not hold. `null` when nothing
 * says dark.
 */
export function describeDarkEvidence(facts: ScreenStateFacts): string | null {
  const parts: string[] = [];
  if (facts.currentBrightnessRaw === 0) parts.push("the panel reports current brightness 0");
  if (facts.displayOn === false) parts.push("display_on is false");
  return parts.length > 0 ? parts.join(" and ") : null;
}

// ── "this screen is showing nothing" — the CAUSE, not the symptom ────────────
//
// Everything above answers "is the panel dark, and is that expected". That is
// only ONE of the ways a screen ends up showing nothing, and the causes are
// measured by DIFFERENT signals and want OPPOSITE actions. Verified on the live
// fleet 2026-09-02:
//
//   - `is_black_screen` is NOT "the panel is dark". Of 26 reachable panels that
//     are demonstrably powered off (`current_brightness = 0` or
//     `display_on = false`), ZERO carry the flag. So the flag describes RENDERED
//     CONTENT, and two things follow: a screen dark because its backlight is off
//     is INVISIBLE to it, and a screen it DOES flag is, by construction, a LIT
//     panel rendering black.
//   - The live example: Shaun-SparkBridge+ (1027199) at `current_brightness=255`,
//     `display_on=true`, `is_black_screen=true`, `showing_logo=false` — a panel at
//     FULL brightness rendering black, corroborated by the device answering
//     "Black Screen: true" to its own `is_blackscreen` verb, so it is a real
//     content fault and not a stale flag.
//   - 5 reachable devices report `display_on=false` while the status feed reports
//     `is_screen_on=true` (0 disagree the other way, 107 agree). The settings
//     poll and the status feed contradict each other about the same panel.
//
// Why the distinction is load-bearing: for a lit panel rendering black,
// "Restore brightness" is a NO-OP — brightness is already 255. Handing an
// operator an action that cannot possibly work, on a device that genuinely has a
// fault, is worse than saying nothing.

/**
 * Why is this screen showing nothing?
 *
 *   - `not-blank`            — nothing we read says it is blank.
 *   - `panel-off-expected`   — backlight off, outside its own scheduled ON
 *                              window. Working as configured; not a fault.
 *   - `panel-off-unexpected` — backlight off INSIDE the window (or with no
 *                              schedule to explain it). The only cause for which
 *                              restoring brightness is the right action.
 *   - `content-black`        — the panel is lit and the black is what it is being
 *                              asked to render. A content/player fault; a
 *                              brightness action here is a no-op.
 *   - `showing-logo`         — the player is up but resolved no content, so it is
 *                              rendering the Videri logo instead.
 *   - `signals-disagree`     — `display_on` and `is_screen_on` contradict each
 *                              other about the same panel. We report the
 *                              contradiction and act on neither.
 *   - `unknown`              — unreachable, no settings snapshot, or a schedule we
 *                              cannot evaluate. Absence of a reading is never
 *                              evidence of health.
 */
export type BlankCause =
  | "not-blank"
  | "panel-off-expected"
  | "panel-off-unexpected"
  | "content-black"
  | "showing-logo"
  | "signals-disagree"
  | "unknown";

/**
 * The content signals, from the status feed rather than the settings poll. All
 * independently nullable — a flag we never read is `null`, never `false`.
 *
 * `isScreenOn` is optional, not required: it is the feed's OWN view of panel
 * power and was added to this projection after the fact, so older callers
 * legitimately do not carry it. Absent (`undefined`) and unread (`null`) mean the
 * SAME thing here — "we have no second opinion on panel power" — and neither is
 * ever read as `false`. It is normalised to `null` on entry so no branch below
 * can accidentally distinguish them.
 */
export interface ScreenContentSignals {
  /** `health_samples.is_black_screen` — a RENDERED-CONTENT flag, not panel power. */
  isBlackScreen: boolean | null;
  /** `health_samples.showing_logo` — the player's no-content-resolved fallback. */
  showingLogo: boolean | null;
  /** `health_samples.is_screen_on` — the status feed's view of panel power. */
  isScreenOn?: boolean | null;
}

/**
 * Everything `blankCause` reads: live panel state + schedule (above), the content
 * signals, and reachability. Declared structurally so `DeviceView` satisfies it
 * and this module stays a leaf.
 */
export interface ScreenBlankFacts extends ScreenStateFacts {
  /** Derived presence: 'online' | 'warning' | 'alert' | 'offline' | 'unknown'. */
  status: string;
  screen: ScreenContentSignals;
}

/**
 * A named cause, the readings it rests on, and what may be done about it.
 * Discriminated on `cause` so callers switch exhaustively rather than
 * re-deriving the reasoning.
 */
export interface BlankCauseResult {
  cause: BlankCause;
  /**
   * The readings this verdict rests on, in operator words — built ONLY from
   * fields we actually read, so it can never imply a reading we do not hold.
   */
  evidence: string[];
  /** Is there something an operator can usefully DO about this cause? */
  actionable: boolean;
  /**
   * May a brightness write address this? `true` for exactly one cause
   * (`panel-off-unexpected`). Explicitly `false` for `content-black`, where the
   * panel is already at full output and a brightness push would change nothing —
   * the whole reason this classifier exists.
   */
  brightnessActionApplicable: boolean;
  /**
   * Can we SHOW the panel is lit (`current_brightness > 0` AND `display_on`
   * true)? Only meaningful for `content-black`: with it we can say "the panel is
   * at N/255 and lit"; without it we hold a black-content flag and no panel
   * reading to back the claim, and the rationale must not pretend otherwise.
   */
  panelLitConfirmed: boolean;
  rationale: string;
}

/**
 * "Reachable enough to act on": presence is not offline/unknown. A black-screen
 * or logo-fallback device collapses to 'alert'/'warning' but is still reachable —
 * only 'offline'/'unknown' mean we can neither see nor act.
 */
export const isReachableStatus = (status: string): boolean =>
  status !== "offline" && status !== "unknown";

/**
 * Do our two independent readings of panel power contradict each other?
 * `settings->>'display_on'` comes from the settings poll, `is_screen_on` from the
 * status feed, and on this fleet 5 devices have them disagreeing. Returns the
 * contradiction in operator words, or `null` when they agree or either is unread.
 *
 * Deliberately does NOT pick a winner. We have no evidence which source is right,
 * and an action chosen from a guess is exactly the failure this module exists to
 * prevent.
 */
export function screenPowerContradiction(facts: ScreenBlankFacts): string | null {
  const isScreenOn = facts.screen.isScreenOn ?? null;
  if (facts.displayOn === null || isScreenOn === null) return null;
  if (facts.displayOn === isScreenOn) return null;
  return facts.displayOn
    ? "the settings poll reports display_on=true while the status feed reports is_screen_on=false"
    : "the settings poll reports display_on=false while the status feed reports is_screen_on=true";
}

/**
 * How we know the panel is LIT, in operator words — only from readings we hold.
 * `null` when we cannot show it is lit (which is not the same as showing it dark).
 */
export function describeLitEvidence(facts: ScreenStateFacts): string | null {
  if (facts.currentBrightnessRaw === null || facts.currentBrightnessRaw <= 0) return null;
  if (facts.displayOn !== true) return null;
  return `the panel is at ${facts.currentBrightnessRaw}/255 and display_on is true`;
}

/** Is the panel demonstrably producing light? Stricter than `isDark() === false`. */
const isConfirmedLit = (facts: ScreenStateFacts): boolean =>
  facts.currentBrightnessRaw !== null &&
  facts.currentBrightnessRaw > 0 &&
  facts.displayOn === true;

/**
 * Why is this screen showing nothing? Pure.
 *
 * PRECEDENCE, decided deliberately — the order below is the whole design, since
 * several of these signals can be true at once and they want opposite actions:
 *
 *  1. **Unreachable wins over everything.** If we cannot reach the device, every
 *     flag we hold is a snapshot of unknown age and no action is honest.
 *
 *  2. **A contradiction on the panel-power axis beats every branch that reads
 *     that axis** — which is all of them. `panel-off-*` asserts the panel is off
 *     and `content-black` asserts it is lit; both are claims about panel power,
 *     and when our two sources disagree we can support neither. This is the
 *     precedence that matters most in practice: the 5 disagreeing devices read
 *     `display_on=false`, so without this rule they would fall straight into
 *     `panel-off-*` and we would recommend a brightness write off one of two
 *     contradicting readings while the status feed insists the panel is already
 *     on. Report the contradiction, act on neither side.
 *
 *  3. **A dark panel beats the content signals.** With the backlight off nothing
 *     is visible whatever the player renders, so panel power is the PROXIMATE
 *     cause of "showing nothing" and its remedy (or its schedule) is the answer.
 *     This also keeps us consistent with the shipped rule that a dark panel
 *     already accounts for a black capture.
 *
 *  4. **On a lit panel, `showing-logo` beats `content-black`.** Both are
 *     content-side and neither remedy touches the device, so choosing between
 *     them costs nothing — and the logo is the more SPECIFIC diagnosis ("nothing
 *     resolved to play", i.e. a playlist/assignment gap) where black is the
 *     generic symptom. The more precise cause wins.
 *
 *  5. **Absence is never health.** No panel reading and no content flag is
 *     `unknown`, and a dark panel whose schedule we cannot evaluate is `unknown`
 *     too — the same asymmetry `darknessVerdict` already uses, because we would
 *     rather say "we cannot tell" than call a working screen broken.
 */
export function blankCause(facts: ScreenBlankFacts, at: Date): BlankCauseResult {
  // 1. Unreachable — nothing we hold is current, so nothing we say is actionable.
  if (!isReachableStatus(facts.status)) {
    return {
      cause: "unknown",
      evidence: [`presence is ${facts.status}`],
      actionable: false,
      brightnessActionApplicable: false,
      panelLitConfirmed: false,
      rationale:
        "The device is not reachable, so any screen flag we hold is a snapshot of " +
        "unknown age. We cannot say why the screen is blank, and we will not guess.",
    };
  }

  // 2. Our two readings of panel power contradict each other.
  const contradiction = screenPowerContradiction(facts);
  if (contradiction !== null) {
    return {
      cause: "signals-disagree",
      evidence: [contradiction],
      // Actionable as DATA QUALITY, not as a device action — see remediation.ts.
      actionable: true,
      brightnessActionApplicable: false,
      panelLitConfirmed: false,
      rationale:
        `Our two independent readings of panel power disagree: ${contradiction}. ` +
        "We hold no evidence which source is right, so we name the contradiction " +
        "and recommend no device action — an action picked from a guess could " +
        "light a screen that is already on, or fight one that is off on purpose.",
    };
  }

  const dark = isDark(facts);

  // 3. The backlight is off. Nothing the player renders is visible, so panel
  //    power is the cause and the schedule decides whether it is a fault.
  if (dark === true) {
    const evidence = [describeDarkEvidence(facts) ?? "the panel reports no light output"];
    const window = describeOnWindow(facts);

    if (facts.brightnessScheduleEnabled === true) {
      const inWindow = withinOnWindow(facts.turnOnTime, facts.turnOffTime, facts.timezone, at);
      if (inWindow === null) {
        return {
          cause: "unknown",
          evidence,
          actionable: false,
          brightnessActionApplicable: false,
          panelLitConfirmed: false,
          rationale:
            "The panel is off and a brightness schedule is enabled, but its window " +
            "cannot be evaluated (unreadable times or timezone), so we cannot say " +
            "whether being off right now is expected. No action follows from that.",
        };
      }
      if (!inWindow) {
        return {
          cause: "panel-off-expected",
          evidence,
          actionable: false,
          brightnessActionApplicable: false,
          panelLitConfirmed: false,
          rationale:
            (window
              ? `The panel is off and its own schedule (on ${window}) puts it outside `
              : "The panel is off and its own brightness schedule puts it outside ") +
            "its ON window, which fully accounts for the blank screen. Not a fault, " +
            "and forcing brightness here would override a working schedule.",
        };
      }
      return {
        cause: "panel-off-unexpected",
        evidence,
        actionable: true,
        // The one cause where a brightness write can actually change the outcome.
        brightnessActionApplicable: true,
        panelLitConfirmed: false,
        rationale:
          (window
            ? `Scheduled on ${window}, and we are inside that window, but ${evidence[0]}. `
            : `We are inside the device's scheduled ON window, but ${evidence[0]}. `) +
          "Nothing should be holding the panel dark, so restoring brightness is the " +
          "action that addresses the cause.",
      };
    }

    // No schedule enabled (or the flag was never read): nothing should be holding
    // the panel dark, so the measured darkness stands unexplained. Only `true`
    // buys an exemption — we are not inventing a symptom, only failing to find an
    // excuse for one we measured.
    return {
      cause: "panel-off-unexpected",
      evidence,
      actionable: true,
      brightnessActionApplicable: true,
      panelLitConfirmed: false,
      rationale:
        `No brightness schedule is enabled to explain it, and ${evidence[0]}. ` +
        "Nothing should be holding the panel dark, so restoring brightness is the " +
        "action that addresses the cause.",
    };
  }

  // 4. The panel is not dark. Now the content signals get to speak, logo first.
  if (facts.screen.showingLogo === true) {
    const evidence = ["showing_logo is true"];
    const lit = describeLitEvidence(facts);
    if (lit !== null) evidence.push(lit);
    return {
      cause: "showing-logo",
      evidence,
      actionable: true,
      brightnessActionApplicable: false,
      panelLitConfirmed: isConfirmedLit(facts),
      rationale:
        "The player is up and rendering the Videri logo, which is its fallback when " +
        "nothing resolves to play — a playlist or content-assignment gap, not a panel " +
        "fault. The backlight is not what is wrong here, so brightness is not the fix.",
    };
  }

  if (facts.screen.isBlackScreen === true) {
    const litConfirmed = isConfirmedLit(facts);
    const lit = describeLitEvidence(facts);
    const evidence = ["is_black_screen is true"];
    if (lit !== null) evidence.push(lit);
    return {
      cause: "content-black",
      evidence,
      actionable: true,
      // NEVER a brightness action. This is the case Stephen's insight is about:
      // the panel is already at full output, so "Restore brightness" is a no-op
      // handed to an operator on a device that genuinely has a fault.
      brightnessActionApplicable: false,
      panelLitConfirmed: litConfirmed,
      rationale: litConfirmed
        ? `The screen is reporting black content while ${lit} — the panel is lit and ` +
          "the black is what it is being asked to render. That makes this a " +
          "content/player fault. A brightness action would be a no-op: brightness " +
          "is already up."
        : "The screen is reporting black content and the panel is not reporting dark, " +
          "but we hold no reading that shows it lit either, so we will not claim the " +
          "brightness is up. Treat it as a content fault pending a live capture; we " +
          "have no evidence a brightness change would help.",
    };
  }

  // 5. Nothing says blank — but only if we actually read the panel. With no
  //    settings snapshot and no content flag we know nothing, and "we know
  //    nothing" must never render as "it is fine".
  if (dark === null) {
    return {
      cause: "unknown",
      evidence: [],
      actionable: false,
      brightnessActionApplicable: false,
      panelLitConfirmed: false,
      rationale:
        "We hold no settings snapshot for this device and no content flag, so we have " +
        "no reading of the panel at all. That is not evidence the screen is fine.",
    };
  }

  const lit = describeLitEvidence(facts);
  return {
    cause: "not-blank",
    evidence: lit !== null ? [lit] : ["the panel does not report dark"],
    actionable: false,
    brightnessActionApplicable: false,
    panelLitConfirmed: isConfirmedLit(facts),
    rationale: "Nothing we read says this screen is showing nothing.",
  };
}
