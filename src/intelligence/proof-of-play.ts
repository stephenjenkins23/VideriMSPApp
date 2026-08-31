/**
 * Scheduled proof-of-play + screen-state gap detection — pure, no I/O
 * (Epic 3, docs/19).
 *
 * What this engine can honestly say, and what it deliberately will not:
 *
 *   - It reads the platform's SCHEDULE (what content is *supposed* to be on a
 *     canvas right now) and joins it against the latest SCREEN-STATE we already
 *     store (is the panel black / showing the fallback logo / off). Where a
 *     device has active scheduled content AND its screen is black, logo or off,
 *     that is a *gap* worth an operator's attention.
 *
 *   - It NEVER claims confirmed playback. There is no per-device render log we
 *     can read (docs/14 C2), so "scheduled" is exactly that — scheduled, not
 *     confirmed. Every count carries that caveat, and `BASIS` states it once for
 *     the whole report. A device with a schedule and a healthy-looking screen is
 *     reported as "scheduled, not confirmed", never as "playing".
 *
 *   - It NEVER asserts a gap from a missing reading. Screen-state is nullable;
 *     if the fields we would need to judge are all null, the device is reported
 *     as "screen-state unknown" and NO gap is asserted. An unread panel is not a
 *     black one. This is the same honest-null invariant the rest of the system
 *     lives by (a value we cannot read is not a zero, and here not a fault).
 *
 * The schedule side is complicated only by the tenant's degenerate demo data:
 * schedules are "always-on" with empty dayparts, so "scheduled now" is trivially
 * true for any device that has events at all. The window LOGIC below is written
 * to be correct against real dayparts anyway (evaluate the window against a
 * time, handle midnight wrap, handle time-of-day vs absolute bounds) — the demo
 * data just happens to exercise the always-on branch.
 *
 * `scheduledNow(events, at)` and `detectGaps(perDevice)` are both pure, so the
 * whole engine is unit-testable without a database, a network, or a wall clock.
 */

/**
 * One scheduled event as the publisher service reports it, normalised to honest
 * nulls. `startTime`/`endTime` are the daypart bounds — either a time-of-day
 * ("08:00", "18:30:00") or an absolute ISO timestamp; both are handled. An
 * always-on schedule carries neither (or a zero-width window), which the window
 * evaluator treats as "covers every instant".
 */
export interface ScheduledEvent {
  assetUuid: string | null;
  assetType: string | null;
  durationMs: number | null;
  startTime: string | null;
  endTime: string | null;
  priority: number | null;
  frequency: string | null;
}

/** The latest screen-state we hold. Any field null = unread, never "fine". */
export interface ScreenState {
  isScreenOn: boolean | null;
  isBlackScreen: boolean | null;
  showingLogo: boolean | null;
}

/** The per-device facts the gap detector reasons over: schedule ∩ screen. */
export interface PopDevice {
  deviceId: string;
  deviceLabel: string;
  /** The events whose window covers "now" — i.e. the output of scheduledNow(). */
  scheduled: ScheduledEvent[];
  screen: ScreenState;
}

/**
 * Why a device with an active schedule is nonetheless not showing content.
 * Ordered by how fundamental the fault is: an off panel explains everything
 * above it, so it is reported in preference to a black frame, which is reported
 * in preference to a logo fallback.
 */
export type GapReason = "screen off" | "screen black" | "screen logo";

export interface DeviceGap {
  deviceId: string;
  deviceLabel: string;
  /** How many events are scheduled *now* (window covers the evaluation time). */
  scheduledCount: number;
  screen: ScreenState;
  /**
   * False when every screen field we would judge on is null. When false, `gap`
   * is always false (an unread panel is not a fault) and `note` says why.
   */
  screenStateKnown: boolean;
  gap: boolean;
  /** Set iff `gap` is true. */
  reason: GapReason | null;
  /** Human-readable honesty note (unknown screen-state, or "scheduled, not confirmed"). */
  note: string | null;
}

export interface PopSummary {
  /** Devices with at least one event scheduled now. */
  devicesWithSchedule: number;
  /** Of those, how many are a confirmed gap (schedule active + screen black/logo/off). */
  gaps: number;
  /** Gap counts broken down by reason. Keys are the three GapReason values. */
  byReason: Record<GapReason, number>;
  /** Scheduled devices whose screen-state was unreadable — reported, not counted as gaps. */
  screenStateUnknown: number;
}

export interface PopReport {
  devices: DeviceGap[];
  summary: PopSummary;
}

/**
 * The one honesty caveat that governs the whole report. Surfaced to the client
 * so a "scheduled" count is never mistaken for confirmed playback.
 */
export const BASIS =
  "Scheduled, not confirmed. There is no readable per-device render log, so this " +
  "reports what the platform SCHEDULED to play joined against the latest screen-state " +
  "we hold. A gap means a device had active scheduled content AND its screen was off, " +
  "black, or showing the fallback logo — never a claim about actual pixels rendered.";

const MINUTES_PER_DAY = 24 * 60;

type Bound =
  | { kind: "tod"; minutes: number }
  | { kind: "abs"; ms: number }
  | null;

/**
 * Parse one daypart bound. Two shapes occur in the wild:
 *
 *   - a time-of-day: "8:00", "08:00", "18:30:00"  → minutes since midnight
 *   - an absolute ISO timestamp: "2026-08-31T18:00:00Z" → epoch ms
 *
 * "24:00" is accepted as end-of-day (1440). Anything unparseable — including the
 * empty string the platform uses for an open bound — is `null`, which the caller
 * reads as "no bound on this side".
 */
function parseBound(raw: string | null): Bound {
  if (raw === null) return null;
  const s = raw.trim();
  if (s === "") return null;

  const tod = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (tod) {
    const h = Number(tod[1]);
    const m = Number(tod[2]);
    const sec = tod[3] ? Number(tod[3]) : 0;
    if (h > 24 || m > 59 || sec > 59) return null;
    return { kind: "tod", minutes: Math.min(MINUTES_PER_DAY, h * 60 + m + sec / 60) };
  }

  const ms = Date.parse(s);
  return Number.isFinite(ms) ? { kind: "abs", ms } : null;
}

/** Time-of-day for `at`, in minutes since midnight (UTC — see windowCoversAt). */
const todMinutes = (at: Date): number =>
  at.getUTCHours() * 60 + at.getUTCMinutes() + at.getUTCSeconds() / 60;

/**
 * Does this event's daypart window cover the instant `at`?
 *
 * Rules, in order:
 *   - No bounds at all → always-on (the degenerate demo case) → true.
 *   - Any absolute bound → compare on absolute time; a missing side is open.
 *   - Otherwise time-of-day. A zero-width window (start === end) is read as
 *     always-on, not "never" — that is how the demo encodes 24/7. A window whose
 *     end is before its start wraps past midnight and is handled as a union.
 *
 * Time-of-day bounds are evaluated in UTC. Real dayparts are authored in the
 * device's local zone; on this tenant the schedules are always-on so the zone
 * never bites, but a reviewer wiring real dayparts should convert `at` into the
 * device zone before calling. Stated, not hidden.
 */
export function windowCoversAt(event: ScheduledEvent, at: Date): boolean {
  const start = parseBound(event.startTime);
  const end = parseBound(event.endTime);

  // Always-on: nothing constrains the window.
  if (start === null && end === null) return true;

  if (start?.kind === "abs" || end?.kind === "abs") {
    const atMs = at.getTime();
    const lo = start?.kind === "abs" ? start.ms : Number.NEGATIVE_INFINITY;
    const hi = end?.kind === "abs" ? end.ms : Number.POSITIVE_INFINITY;
    return atMs >= lo && atMs <= hi;
  }

  // Time-of-day window. Missing side is open to the edge of the day.
  const lo = start?.kind === "tod" ? start.minutes : 0;
  const hi = end?.kind === "tod" ? end.minutes : MINUTES_PER_DAY;
  const now = todMinutes(at);

  // Zero-width daypart from real bounds = the demo's "always-on".
  if (start !== null && end !== null && lo === hi) return true;

  return lo <= hi
    ? now >= lo && now <= hi
    : // Wraps midnight (e.g. 22:00 → 02:00): covered on either side of the seam.
      now >= lo || now <= hi;
}

/** The events whose window covers `at`. Pure; `at` is injected for determinism. */
export function scheduledNow(events: ScheduledEvent[], at: Date): ScheduledEvent[] {
  return events.filter((e) => windowCoversAt(e, at));
}

/**
 * Join per-device schedule against screen-state and flag the gaps.
 *
 * A device is "with schedule" iff it has at least one event scheduled now. Of
 * those, a gap is asserted ONLY on a definitive bad screen signal (off / black /
 * logo). If the screen fields are all null the device is reported as
 * screen-state unknown and NO gap is claimed — the honest-null invariant.
 */
export function detectGaps(perDevice: PopDevice[]): PopReport {
  const devices: DeviceGap[] = perDevice.map((d) => {
    const scheduledCount = d.scheduled.length;
    const { isScreenOn, isBlackScreen, showingLogo } = d.screen;
    const screenStateKnown =
      isScreenOn !== null || isBlackScreen !== null || showingLogo !== null;

    // No active schedule → nothing to prove, nothing to fault.
    if (scheduledCount === 0) {
      return {
        deviceId: d.deviceId,
        deviceLabel: d.deviceLabel,
        scheduledCount,
        screen: d.screen,
        screenStateKnown,
        gap: false,
        reason: null,
        note: "no content scheduled now",
      };
    }

    // Scheduled but we cannot see the panel → unknown, never a fabricated gap.
    if (!screenStateKnown) {
      return {
        deviceId: d.deviceId,
        deviceLabel: d.deviceLabel,
        scheduledCount,
        screen: d.screen,
        screenStateKnown,
        gap: false,
        reason: null,
        note: "scheduled, but screen-state unknown (no reading to judge against)",
      };
    }

    // Most fundamental fault wins: off explains black explains logo.
    const reason: GapReason | null =
      isScreenOn === false
        ? "screen off"
        : isBlackScreen === true
          ? "screen black"
          : showingLogo === true
            ? "screen logo"
            : null;

    return {
      deviceId: d.deviceId,
      deviceLabel: d.deviceLabel,
      scheduledCount,
      screen: d.screen,
      screenStateKnown,
      gap: reason !== null,
      reason,
      note:
        reason !== null
          ? `scheduled but ${reason}`
          : "scheduled, not confirmed (screen looks healthy)",
    };
  });

  const summary: PopSummary = {
    devicesWithSchedule: 0,
    gaps: 0,
    byReason: { "screen off": 0, "screen black": 0, "screen logo": 0 },
    screenStateUnknown: 0,
  };
  for (const d of devices) {
    if (d.scheduledCount === 0) continue;
    summary.devicesWithSchedule += 1;
    if (!d.screenStateKnown) summary.screenStateUnknown += 1;
    if (d.gap && d.reason) {
      summary.gaps += 1;
      summary.byReason[d.reason] += 1;
    }
  }

  return { devices, summary };
}
