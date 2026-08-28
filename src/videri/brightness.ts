/**
 * Brightness write with preflight → write → verify → rollback.
 *
 * Adopted from the reference integration (darrencremins/videri-serve-qsr), whose
 * brightness worker does exactly this and is the better pattern: it never leaves
 * a device in an unknown state.
 *
 * A naive "send set_brightness and hope" write has three silent failure modes on
 * this hardware, all of which we observed:
 *
 *   - The device ignores the write (SJ Office V4 reports brightness 0 and stays
 *     there). A fire-and-forget send reports success anyway.
 *   - The gateway returns 200 while the device returns a non-SUCCESS code.
 *   - The write half-applies and leaves the panel at a value nobody chose.
 *
 * So every write is bracketed:
 *
 *   1. PREFLIGHT — read the current value. If it cannot be read, change NOTHING
 *      and say so. We never write blind, because without the original value a
 *      rollback is impossible.
 *   2. WRITE — `demo_command set_brightness:=<raw>`.
 *   3. VERIFY — read back. If it matches the request, done.
 *   4. ROLLBACK — if it does not match, write the original value back and
 *      re-read. Report whether the restore itself succeeded; a failed rollback is
 *      the one outcome an operator must be paged about.
 *
 * The decision logic is pure and unit-tested; only `applyBrightness` does IO.
 */

/** Raw brightness is 0..255 on the wire. 0 is display-OFF, so writes clamp to 1. */
export const MIN_RAW = 1;
export const MAX_RAW = 255;

export const rawFromPercent = (pct: number): number =>
  Math.min(MAX_RAW, Math.max(MIN_RAW, Math.round((pct / 100) * MAX_RAW)));
export const percentFromRaw = (raw: number): number =>
  Math.round((raw / MAX_RAW) * 100);

/**
 * Verify tolerance in raw units. The device rounds internally, so an exact match
 * is too strict — a requested 128 can read back 127. Two units of slack absorbs
 * rounding without letting a genuinely-ignored write pass.
 */
export const VERIFY_TOLERANCE_RAW = 2;

export const brightnessMatches = (requestedRaw: number, observedRaw: number): boolean =>
  Math.abs(requestedRaw - observedRaw) <= VERIFY_TOLERANCE_RAW;

/**
 * Parse the set-brightness value from `get_brightness`, whose message is:
 *   "Current brightness is: 102 Default brightness is: 102 Current backlight is: 40"
 * The FIRST number ("Current brightness") is the set value that `set_brightness`
 * writes and that we verify against — NOT the backlight PWM, which is a separate
 * physical measurement.
 */
export function parseBrightnessRaw(message: string): number | null {
  const m = /current brightness is:\s*(-?\d+)/i.exec(message);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export type BrightnessState =
  | "preflight_blocked"
  | "no_change"
  | "verified"
  | "unconfirmed_rolled_back"
  | "unconfirmed_rollback_failed"
  | "write_rejected";

export interface BrightnessResult {
  state: BrightnessState;
  deviceId: string;
  requestedPercent: number;
  requestedRaw: number;
  originalRaw: number | null;
  observedRaw: number | null;
  message: string;
  /** True only for `verified`. Every other state means the panel is NOT at the requested value. */
  applied: boolean;
}

/** One device-command call, already unwrapped to {code, message}. */
export interface CommandRunner {
  (arg: string): Promise<{ code: string; message: string }>;
}

const accepted = (code: string): boolean => code.toUpperCase() === "SUCCESS";

/**
 * Read the current set-brightness. Returns null when the device did not answer
 * or the value could not be parsed — either way, unreadable.
 */
async function readRaw(run: CommandRunner): Promise<number | null> {
  const r = await run("get_brightness");
  if (!accepted(r.code)) return null;
  return parseBrightnessRaw(r.message);
}

export interface LiveBrightnessResult {
  deviceId: string;
  requestedPercent: number;
  requestedRaw: number;
  /** What the device reports after the write — the truth to show the operator. */
  observedRaw: number | null;
  observedPercent: number | null;
  code: string;
  applied: boolean;
}

/**
 * Live brightness — set and read back, no preflight and no rollback.
 *
 * This is the DRAG path, for a slider the operator is moving continuously to
 * match the native Videri experience. The full preflight→verify→rollback cycle
 * is wrong here: rolling back on every drag would fight the operator, and each
 * intermediate value IS what they asked for. So it does the minimum — write,
 * then read the actual value back — and returns the truth for the UI to show.
 *
 * It never rolls back, so it must never be used for a fire-once "apply"; that is
 * what `applyBrightness` is for.
 */
export async function applyBrightnessLive(
  deviceId: string,
  requestedPercent: number,
  run: CommandRunner,
): Promise<LiveBrightnessResult> {
  const requestedRaw = rawFromPercent(requestedPercent);
  const write = await run(`set_brightness:=${requestedRaw}`);
  const observedRaw = accepted(write.code) ? await readRaw(run) : null;
  return {
    deviceId, requestedPercent, requestedRaw,
    observedRaw,
    observedPercent: observedRaw === null ? null : percentFromRaw(observedRaw),
    code: write.code,
    applied: observedRaw !== null && brightnessMatches(requestedRaw, observedRaw),
  };
}

export async function applyBrightness(
  deviceId: string,
  requestedPercent: number,
  run: CommandRunner,
): Promise<BrightnessResult> {
  const requestedRaw = rawFromPercent(requestedPercent);
  const base = { deviceId, requestedPercent, requestedRaw };

  // 1. PREFLIGHT — never write without a readable original to roll back to.
  const originalRaw = await readRaw(run);
  if (originalRaw === null) {
    return {
      ...base, originalRaw: null, observedRaw: null, applied: false,
      state: "preflight_blocked",
      message:
        "Current brightness could not be read, so nothing was written. Without the " +
        "original value a safe rollback is impossible.",
    };
  }
  if (brightnessMatches(requestedRaw, originalRaw)) {
    return {
      ...base, originalRaw, observedRaw: originalRaw, applied: false,
      state: "no_change",
      message: `Already at ${percentFromRaw(originalRaw)}% (raw ${originalRaw}); nothing written.`,
    };
  }

  // 2. WRITE.
  const write = await run(`set_brightness:=${requestedRaw}`);
  if (!accepted(write.code)) {
    return {
      ...base, originalRaw, observedRaw: originalRaw, applied: false,
      state: "write_rejected",
      message: `The device rejected the write (${write.code}). Brightness is unchanged at raw ${originalRaw}.`,
    };
  }

  // 3. VERIFY.
  const observedRaw = await readRaw(run);
  if (observedRaw !== null && brightnessMatches(requestedRaw, observedRaw)) {
    return {
      ...base, originalRaw, observedRaw, applied: true,
      state: "verified",
      message: `Brightness set to ${percentFromRaw(observedRaw)}% (raw ${observedRaw}) and confirmed.`,
    };
  }

  // 4. ROLLBACK — the write did not take (or could not be confirmed). Restore.
  const restore = await run(`set_brightness:=${originalRaw}`);
  const afterRestore = await readRaw(run);
  const restored =
    accepted(restore.code) &&
    afterRestore !== null &&
    brightnessMatches(originalRaw, afterRestore);

  if (restored) {
    return {
      ...base, originalRaw, observedRaw, applied: false,
      state: "unconfirmed_rolled_back",
      message:
        observedRaw === null
          ? "The write could not be confirmed (no read-back), so the device was restored to its original brightness."
          : `The device reported raw ${observedRaw}, not the requested ${requestedRaw}. It was restored to raw ${originalRaw}.`,
    };
  }

  return {
    ...base, originalRaw, observedRaw, applied: false,
    state: "unconfirmed_rollback_failed",
    message:
      `The write did not verify AND the rollback to raw ${originalRaw} could not be confirmed ` +
      `(restore code ${restore.code}, read-back ${afterRestore ?? "unreadable"}). ` +
      `This device may be at an unknown brightness and needs a direct check.`,
  };
}
