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
