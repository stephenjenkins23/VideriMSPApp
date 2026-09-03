/**
 * Self-heal remediation engine — pure, no I/O (Epic 1, docs/19 US-1.1..1.6).
 *
 * Maps a device's symptoms → a recommended action, ranked by severity ×
 * confidence, and marks which actions we can one-click (`auto-safe`) versus only
 * advise on (`manual`). It is honest by design:
 *
 *   - It NEVER fires a device action. The one verified write we own is
 *     brightness (videri/brightness.ts, preflight→verify→rollback); an
 *     `auto-safe` recommendation is a claim that the UI *could* route through
 *     that path later, not that anything was changed here.
 *
 *   - It NEVER fabricates a symptom from a missing reading. A field that could
 *     not be read is `null`, and a null produces NO recommendation — never a
 *     false one. This is the same honest-null invariant the rest of the system
 *     lives by (a value we cannot read is not a zero).
 *
 * Every rule is a pure `DeviceView → Recommendation | null` (or per-drift), so
 * the whole engine is `recommendationsFor(devices)` — trivially unit-testable.
 * Correlation across co-located devices (many symptoms → one root cause) is a
 * separate concern (Epic 2); here each recommendation targets one device.
 *
 * The display rules read LIVE panel state and the device's own schedule via
 * intelligence/screen-state.ts. They used to read the stored `brightness`
 * setting, which is the scheduled/base value, and told operators to "restore
 * brightness" on 21 demonstrably lit screens. See that module's header.
 *
 * "The screen is showing nothing" is not one symptom, so it does not get one
 * rule. `blankCause()` classifies WHY the screen is blank and this engine routes
 * each cause to the action that can actually change it — a dark panel inside its
 * window to the brightness restore, a LIT panel rendering black to a
 * content/player fix with brightness explicitly SUPPRESSED (it is already at
 * 255, so the write would be a no-op on a device that genuinely has a fault),
 * and two contradicting readings of panel power to a data-quality item rather
 * than a device action. Exactly one such recommendation per device, so a screen
 * never appears twice under two different causes.
 */

import {
  blankCause,
  darknessVerdict,
  describeOnWindow,
  isReachableStatus,
} from "./screen-state.js";
import { resolveIntent, type DeviceIntent, type RecordedIntent } from "./device-intent.js";

/** The assembled per-device facts the engine reasons over. Honest nulls throughout. */
export interface DeviceView {
  id: string;
  name: string | null;
  /** Derived status: 'online' | 'warning' | 'alert' | 'offline' | 'unknown'. */
  status: string;
  lastOnlineTime: string | null;
  city: string | null;
  /**
   * The device's group uuid — the join key into the `rpm /v1/groups` tree. NEVER
   * join on group_name: at least one device (1000015) carries a populated
   * group_id with an EMPTY display name, and a name is not an identity in a tree
   * where siblings may share one. group_id covers 234 devices, group_name 233.
   */
  groupId: string | null;
  /**
   * Depth-1 ancestor of that group — the site the device sits at, resolved from
   * the group hierarchy (videri/services/group-hierarchy.ts). `null` when the
   * device has no group, its group is unknown to us, or the tree could not be
   * read. Null means "we do not know which site", never "no site", so nothing
   * clusters on it.
   */
  site: { uuid: string; name: string | null } | null;
  firmwareCurrent: string | null;
  firmwareBehind: boolean;
  /** Latest screen-state reading. Any field null = unread, not "fine". */
  screen: {
    /**
     * `is_black_screen` — a RENDERED-CONTENT flag, NOT panel power. Verified
     * 2026-09-02: of 26 reachable panels demonstrably powered off, zero carry it.
     * So a device it flags is by construction a LIT panel rendering black, and a
     * panel dark because its backlight is off is invisible to it.
     */
    isBlackScreen: boolean | null;
    showingLogo: boolean | null;
    /**
     * `is_screen_on` — the status feed's OWN view of panel power, and the second
     * opinion that lets us catch it contradicting `display_on` (5 devices do).
     *
     * Optional rather than required: it was added to this projection after the
     * fact and older callers legitimately do not carry it. Absent and `null` mean
     * the same thing — "no second opinion" — and NEITHER is ever read as `false`
     * (screen-state.ts normalises it on entry).
     */
    isScreenOn?: boolean | null;
    nowPlayingId: string | null;
  };
  /**
   * Latest slow-lane telemetry snapshot, or null if we have never read any.
   * Individual metrics are independently nullable — a device that answered RSSI
   * but not storage carries one number and one null, never a fabricated zero.
   */
  telemetry: {
    observedAt: string | null;
    cpuPercent: number | null;
    ramUsedPercent: number | null;
    storageUsedPercent: number | null;
    rssiDbm: number | null;
    ntpOffsetMs: number | null;
  } | null;
  /** Latest compliance drift, heaviest first. `field` is the dotted settings path. */
  drift: Array<{ kind: string; label: string; field: string }>;
  /**
   * The SCHEDULED / base brightness the platform holds for this device
   * (`settings->>'brightness'`), on the 0–255 wire scale — NOT what the panel is
   * currently emitting, and NOT a display-on/off flag. 0 here routinely coexists
   * with a fully lit screen (21 devices on this fleet read 0 while
   * `current_brightness` was 179–255). Live panel state is `currentBrightnessRaw`
   * + `displayOn`; read those, never this, to decide whether a screen is dark.
   */
  brightnessRaw: number | null;
  /**
   * What the panel is ACTUALLY emitting (`settings->>'current_brightness'`,
   * 0–255). This, with `displayOn`, is the live truth about darkness.
   */
  currentBrightnessRaw: number | null;
  /** `settings->>'display_on'` — is the backlight on. Null = never read. */
  displayOn: boolean | null;
  /**
   * Is a scheduled on/off window in force (`brightness_schedule_enabled`)? When
   * true, a dark panel outside the window is expected behaviour, not a fault.
   */
  brightnessScheduleEnabled: boolean | null;
  /**
   * Is the device managing its own brightness from ambient light
   * (`auto_brightness_enabled`)? When it is, the stored base value drifting from
   * a template is not evidence of a broken screen.
   */
  autoBrightnessEnabled: boolean | null;
  /** Schedule bounds, "HHmm" in DEVICE-local time (e.g. "0900" / "0500"). */
  turnOnTime: string | null;
  turnOffTime: string | null;
  /** IANA zone from `devices.timezone` — the schedule is evaluated in it, not UTC. */
  timezone: string | null;
}

export type Severity = "critical" | "high" | "medium" | "low";
export type RecommendationKind = "auto-safe" | "manual";

export interface Recommendation {
  /** Stable per device+rule, so the UI can key and dedupe across polls. */
  id: string;
  deviceIds: string[];
  deviceLabel: string;
  category: "display" | "content" | "telemetry" | "compliance" | "data-quality";
  symptom: string;
  action: string;
  rationale: string;
  severity: Severity;
  /** 0..1 — how sure we are the action addresses the symptom. */
  confidence: number;
  kind: RecommendationKind;
  /**
   * What we believe this device is FOR, when anything says so — US-8.2.7.
   *
   * Present only when the device carries intent, and then it is the REASON this
   * recommendation is `manual`. Never a reason the recommendation is absent: a
   * lab unit with a genuinely dark screen is still a finding, and dropping it
   * would be the silent suppression the alerting side of this product refuses to
   * do. Read `source` before believing it — `device-name` is a heuristic and the
   * UI must render it as one.
   */
  intent?: DeviceIntent;
  /**
   * True when `intent` took this item out of `auto-safe`. Explicit rather than
   * inferable from `kind`, because "manual because we hold no verified write for
   * it" and "manual because the device's name says End of Life" are different
   * facts and only one of them is overridable by the operator.
   */
  demotedByIntent?: boolean;
}

// ── thresholds ───────────────────────────────────────────────────────────────
// Named and centralised so the numbers an operator argues about live in one
// place, next to why they were chosen.

/** Storage is a hard ceiling: above this, cache eviction and downloads start failing. */
const STORAGE_FULL_PERCENT = 90;
/**
 * -75 dBm is the usual "marginal" line for 2.4/5 GHz. -127 is the telemetry
 * sentinel for "no Wi-Fi radio / on Ethernet" (see videri/telemetry.ts), NOT a
 * weak signal — flagging it would nag every wired device, so it is excluded.
 */
const WEAK_RSSI_DBM = -75;
const NO_WIFI_SENTINEL_DBM = -127;
/**
 * A single snapshot can only ever say "high right now", not "sustained"; the
 * slow lane samples too coarsely for a duration claim. So the bar is set high
 * (>90%) and confidence is deliberately modest — this is a pointer to look, not
 * a verdict.
 */
const RESOURCE_PRESSURE_PERCENT = 90;
/**
 * NTP: only a genuinely bad offset counts. chrony's rms offset is normally
 * sub-millisecond; a full second of skew is enough to fire a schedule in the
 * wrong minute. A null offset (the common case — the field is rarely populated)
 * yields nothing, by rule.
 */
const NTP_DRIFT_MS = 1000;

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * How each intent kind reads in a sentence an operator will actually see.
 *
 * Hedged wording throughout ("looks like", "appears to be") on purpose: for the
 * name heuristic this IS a guess, and a product that states a guess as a fact
 * about a customer's asset has earned the mistrust it gets. Where the intent was
 * recorded by a human, `DeviceIntent.rationale` says so in the next sentence and
 * names them, which is what un-hedges it.
 */
const INTENT_PHRASE: Record<string, string> = {
  eol: "End of Life",
  "not-product": "not a product unit",
  repair: "away for repair or return",
  prototype: "engineering or prototype hardware",
  lab: "a lab unit",
  test: "a test unit",
  "demo-unit": "a demo or travel unit",
  "internal-account": "an internal Videri staff canvas rather than a managed asset",
  none: "production (an operator has recorded this explicitly)",
};

/**
 * "Online" for the purpose of acting: presence is online (the platform reports
 * it), regardless of what is on the panel. The derived status collapses a
 * black-screen or logo-fallback device into 'alert'/'warning', but those devices
 * are still reachable — only 'offline'/'unknown' mean we cannot see or act on
 * them. Every rule gates on this: a recommendation implies we could do something
 * about it, which requires a device we can currently reach.
 */
const isOnline = isReachableStatus;

const labelOf = (d: DeviceView): string => d.name ?? d.id;

/** A brightness compliance check we could actually fix with our one verified write. */
const isBrightnessValueDrift = (field: string): boolean => field === "brightness";

/**
 * Everything the engine needs beyond the device facts themselves.
 *
 * `recordedIntent` is the operator's own decision per device id, loaded from the
 * suppression records (alerting/suppression.ts `recordedIntentByDevice`). It
 * ALWAYS outranks the name heuristic, including the `none` value, which is how
 * an operator tells us that a device called `Repairs Desk Menu Board` is a
 * production screen and we should stop demoting it. Absent means "nobody has
 * recorded anything", which is not the same as "this is production".
 */
export interface RemediationOptions {
  recordedIntent?: ReadonlyMap<string, RecordedIntent> | undefined;
}

export function recommendationsFor(
  devices: DeviceView[],
  now: Date = new Date(),
  { recordedIntent }: RemediationOptions = {},
): Recommendation[] {
  const out: Recommendation[] = [];

  for (const d of devices) {
    // Everything below advises an action on the device; if we cannot reach it,
    // we have nothing honest to recommend.
    if (!isOnline(d.status)) continue;

    const label = labelOf(d);
    // Live panel state, judged against the device's own on/off schedule in its
    // own timezone. Four outcomes, and only ONE of them is a fault. Kept as the
    // gate on the brightness-DRIFT rule below: the blank-cause classifier owns
    // which display/content recommendation fires, while this owns whether the
    // stored brightness value is worth pushing, and they are different questions
    // (a lit panel is not a drift to fix; a scheduled-off panel is a schedule to
    // leave alone).
    const verdict = darknessVerdict(d, now);
    // A dark panel explains a black capture, and a scheduled-off panel explains
    // it just as well as a faulty one. Either way the darkness is accounted for,
    // so the brightness-drift rule stands down rather than fighting it.
    const darknessExplained = verdict === "dark-unexpected" || verdict === "dark-expected";

    // WHY is this screen showing nothing? One classification per device
    // (screen-state.ts `blankCause`), and exactly ONE display/content
    // recommendation follows from it — so a device can never surface twice under
    // two causes that want opposite actions.
    const blank = blankCause(d, now);
    const evidence = blank.evidence.join(" and ");

    switch (blank.cause) {
      // US-1.2 — the backlight is off INSIDE its ON window, or with no schedule
      // to explain it. The one and only cause a brightness write can address,
      // which is why `brightnessActionApplicable` is asserted rather than
      // assumed: if this branch ever stops being the brightness case, the
      // assertion fails loudly instead of quietly shipping a no-op action.
      case "panel-off-unexpected": {
        const scheduled = d.brightnessScheduleEnabled === true;
        out.push({
          id: `${d.id}::display-off`,
          deviceIds: [d.id],
          deviceLabel: label,
          category: "display",
          symptom: scheduled
            ? `Display is dark inside its scheduled ON window — ${evidence}.`
            : `Display is dark with no schedule to explain it — ${evidence}.`,
          action: "Restore brightness",
          rationale:
            `${blank.rationale} ` +
            "We hold the verified brightness write (preflight → verify → rollback), so " +
            "this is a safe one-click restore.",
          severity: "high",
          confidence: 0.9,
          kind: "auto-safe",
        });
        break;
      }

      // Dark BECAUSE its schedule says so. Informational only — never auto-safe,
      // never above `low`, and worded so it cannot be read as a fault: an
      // operator staring at a black screen still needs to be told why it is
      // black, and the answer here is "because you asked it to be".
      case "panel-off-expected": {
        const window = describeOnWindow(d);
        out.push({
          id: `${d.id}::display-off-scheduled`,
          deviceIds: [d.id],
          deviceLabel: label,
          category: "display",
          symptom: window
            ? `Display is off per its own schedule (on ${window}) — working as configured.`
            : "Display is off per its own brightness schedule — working as configured.",
          action: "No action needed. Change the schedule only if this screen should be lit now.",
          rationale: blank.rationale,
          severity: "low",
          confidence: 0.85,
          kind: "manual",
        });
        break;
      }

      // US-1.3 — a LIT panel rendering black. The panel is at full output, so
      // this is the player or the content, and a brightness action is a no-op we
      // must not offer. The rationale says so in as many words, because an
      // operator who has just been told "the screen is black" will otherwise
      // reach for the brightness control themselves.
      case "content-black": {
        out.push({
          id: `${d.id}::black-screen`,
          deviceIds: [d.id],
          deviceLabel: label,
          category: "content",
          symptom: blank.panelLitConfirmed
            ? `Screen is rendering black on a LIT panel — ${evidence}.`
            : "Screen is black while the device is online.",
          action:
            "Capture a fresh frame to confirm; if still black, this is a content/player " +
            "fault — re-push content. (Reboot is device-rejected on this hardware.)",
          rationale:
            `${blank.rationale} A stale black flag is worth confirming with a live ` +
            "capture before re-pushing.",
          severity: "high",
          confidence: blank.panelLitConfirmed ? 0.8 : 0.7,
          kind: "manual",
        });
        break;
      }

      // US-1.4 — logo fallback → no content resolved.
      case "showing-logo": {
        out.push({
          id: `${d.id}::logo-fallback`,
          deviceIds: [d.id],
          deviceLabel: label,
          category: "content",
          symptom: "Showing the Videri logo — no content resolved to play.",
          action: "Check the playlist / content assignment for this device or its group.",
          rationale:
            "The logo is the fallback when nothing resolves to play — usually a missing " +
            "or empty playlist assignment rather than a device fault.",
          severity: "medium",
          confidence: 0.6,
          kind: "manual",
        });
        break;
      }

      // Our two readings of panel power contradict each other. This is a data
      // problem, NOT a device action: we cannot say which source is right, and
      // both candidate actions (light it / leave it) are wrong against the other
      // reading. So it is filed against the pipeline, not the panel.
      case "signals-disagree": {
        out.push({
          id: `${d.id}::screen-signals-disagree`,
          deviceIds: [d.id],
          deviceLabel: label,
          category: "data-quality",
          symptom: `Panel-power signals contradict each other — ${evidence}.`,
          action:
            "Re-read this device's settings and status together and reconcile the two " +
            "sources. No device action until they agree.",
          rationale: blank.rationale,
          severity: "medium",
          // We are certain of the CONTRADICTION; the confidence is in the
          // finding, not in any guess about which side is true.
          confidence: 0.9,
          kind: "manual",
        });
        break;
      }

      // `unknown` and `not-blank` produce nothing, by rule. A missing reading is
      // not a symptom, and a screen nothing flags as blank is not a finding.
      case "unknown":
      case "not-blank":
        break;
    }

    // US-1.5 — telemetry-driven advice. Each gate requires a real reading; a
    // null metric is skipped, never treated as a problem or a zero.
    const t = d.telemetry;
    if (t) {
      if (t.storageUsedPercent !== null && t.storageUsedPercent > STORAGE_FULL_PERCENT) {
        out.push({
          id: `${d.id}::storage-full`,
          deviceIds: [d.id],
          deviceLabel: label,
          category: "telemetry",
          symptom: `Storage ${t.storageUsedPercent}% used — near full.`,
          action: "Clear cache / trim content to recover headroom.",
          rationale:
            "Above ~90% used, content downloads and cache eviction start to fail, which " +
            "shows up as stale or missing playback.",
          severity: "medium",
          confidence: 0.8,
          kind: "manual",
        });
      }

      // Weak Wi-Fi, excluding the -127 "no radio / Ethernet" sentinel.
      if (
        t.rssiDbm !== null &&
        t.rssiDbm < WEAK_RSSI_DBM &&
        t.rssiDbm > NO_WIFI_SENTINEL_DBM
      ) {
        out.push({
          id: `${d.id}::weak-wifi`,
          deviceIds: [d.id],
          deviceLabel: label,
          category: "telemetry",
          symptom: `Weak Wi-Fi — RSSI ${t.rssiDbm} dBm.`,
          action: "Check AP placement / interference; dropouts and slow downloads are likely.",
          rationale:
            "Below -75 dBm the link is marginal, so download stalls and brief offline " +
            "flaps become likely. (-127 would mean no Wi-Fi radio / wired, not weak.)",
          severity: "medium",
          confidence: 0.7,
          kind: "manual",
        });
      }

      // Resource pressure — CPU or RAM. One snapshot, so this is a pointer, not a
      // verdict; confidence reflects that.
      const cpuHot = t.cpuPercent !== null && t.cpuPercent > RESOURCE_PRESSURE_PERCENT;
      const ramHot = t.ramUsedPercent !== null && t.ramUsedPercent > RESOURCE_PRESSURE_PERCENT;
      if (cpuHot || ramHot) {
        const parts: string[] = [];
        if (cpuHot) parts.push(`CPU ${t.cpuPercent}%`);
        if (ramHot) parts.push(`RAM ${t.ramUsedPercent}%`);
        out.push({
          id: `${d.id}::resource-pressure`,
          deviceIds: [d.id],
          deviceLabel: label,
          category: "telemetry",
          symptom: `Resource pressure — ${parts.join(", ")} on the latest reading.`,
          action: "Watch for playback stutter; re-push a lighter creative if it persists.",
          rationale:
            "This is the latest single sample, not a sustained average — treat it as a " +
            "prompt to check the device, not proof of a fault.",
          severity: "medium",
          confidence: 0.5,
          kind: "manual",
        });
      }

      // NTP clock drift — LOW confidence, and ONLY from a genuinely bad offset.
      // A null offset (the usual case) never fires.
      if (t.ntpOffsetMs !== null && Math.abs(t.ntpOffsetMs) > NTP_DRIFT_MS) {
        out.push({
          id: `${d.id}::clock-drift`,
          deviceIds: [d.id],
          deviceLabel: label,
          category: "telemetry",
          symptom: `Clock drift — NTP offset ${Math.round(t.ntpOffsetMs)} ms.`,
          action: "Check the device's NTP/chrony sync; scheduled events may fire at the wrong time.",
          rationale:
            "Schedules are evaluated in device-local time, so a large clock offset shifts " +
            "on/off and content timing. Rarely reported, so flagged only on a real bad offset.",
          severity: "low",
          confidence: 0.4,
          kind: "manual",
        });
      }
    }

    // US-1.6 — config drift → apply expected value. auto-safe ONLY for the
    // brightness VALUE (the single write we hold); everything else is advice.
    for (const drift of d.drift) {
      // Brightness-value drift is only worth acting on when the live panel
      // agrees something is wrong:
      //   - dark-unexpected: the display-off rule already owns it as a one-click.
      //   - dark-expected:   the 0 IS the schedule doing its job; "apply expected
      //                      brightness" would fight it and light a screen that
      //                      is meant to be off.
      //   - lit:             the stored base value differs from the template but
      //                      the panel is demonstrably producing light, so this
      //                      is a config note, not a repair — pushing brightness
      //                      would change a working device. Compliance still
      //                      reports the drift; remediation just won't act on it.
      if (isBrightnessValueDrift(drift.field) && (darknessExplained || verdict === "lit")) continue;

      const brightnessFix = isBrightnessValueDrift(drift.field);
      out.push({
        id: `${d.id}::compliance::${drift.field}`,
        deviceIds: [d.id],
        deviceLabel: label,
        category: "compliance",
        symptom: `Config drift — "${drift.label}" does not match the expected value.`,
        action: `Apply expected ${drift.label}.`,
        rationale: brightnessFix
          ? "Brightness is the one setting we can push with a verified write, so this " +
            "drift is a safe one-click to correct."
          : "We can surface this drift but do not hold a verified write for it — an " +
            "operator applies it through the platform.",
        severity: brightnessFix ? "high" : "low",
        confidence: brightnessFix ? 0.75 : 0.55,
        kind: brightnessFix ? "auto-safe" : "manual",
      });
    }
  }

  // ── US-8.2.7 — intent DEMOTES, and never drops ─────────────────────────────
  //
  // One post-pass rather than a check inside each of the eight branches above.
  // "A recommendation on an intent-tagged device is never auto-safe" is an
  // INVARIANT, and an invariant enforced in one place cannot be forgotten by the
  // ninth rule somebody adds next month. The live queue had exactly two auto-safe
  // items and one of them was a HIGH brightness restore at 0.9 confidence on
  // `SparkBridge (EoL)` — a one-click write onto a device whose own name says End
  // of Life.
  //
  // Demotion is the whole effect: the item keeps its severity, its confidence and
  // its place in the ranking, and gains a sentence saying why it is no longer a
  // one-click. That asymmetry is what makes a NAME-derived heuristic admissible
  // here at all — a false positive costs an operator one extra click, whereas the
  // same heuristic used to suppress would cost them a dark screen.
  const intentByDevice = new Map<string, DeviceIntent | null>();
  for (const rec of out) {
    // One device per recommendation at this layer (correlation is Epic 2), so the
    // first id is the subject. Memoised because several recommendations share a
    // device and the matcher is regex work.
    const deviceId = rec.deviceIds[0];
    if (deviceId === undefined) continue;
    if (!intentByDevice.has(deviceId)) {
      const device = devices.find((d) => d.id === deviceId);
      intentByDevice.set(
        deviceId,
        resolveIntent(device?.name ?? null, recordedIntent?.get(deviceId) ?? null),
      );
    }
    const intent = intentByDevice.get(deviceId);
    if (!intent) continue;

    rec.intent = intent;
    if (rec.kind === "auto-safe") {
      rec.kind = "manual";
      rec.demotedByIntent = true;
      rec.rationale =
        `${rec.rationale} NOT offered as a one-click: this device looks like it is ` +
        `${INTENT_PHRASE[intent.kind]}. ${intent.rationale} The finding itself stands — ` +
        `an operator can still act on it, deliberately.`;
    } else {
      // Already manual, so nothing changes except that the operator is told. Said
      // anyway: "why is this lab unit in my list at all" is a fair question, and
      // the answer belongs on the item rather than in a wiki.
      rec.demotedByIntent = false;
      rec.rationale =
        `${rec.rationale} Context: this device looks like it is ` +
        `${INTENT_PHRASE[intent.kind]}. ${intent.rationale}`;
    }
  }

  // US-1.1 — ranked: severity first, then confidence. Stable id tiebreak keeps
  // the order deterministic across identical-rank items (and across polls).
  return out.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.id.localeCompare(b.id);
  });
}

/** Counts by kind and severity — the endpoint's summary block. */
export interface RemediationSummary {
  total: number;
  byKind: Record<RecommendationKind, number>;
  bySeverity: Record<Severity, number>;
  /**
   * How much of the list is on devices that carry intent, and how many one-clicks
   * that cost. Counted rather than merely applied: "the auto-safe queue went from
   * 2 to 1" is a claim about our own behaviour and it must be checkable from the
   * payload, not taken on trust.
   */
  intent: {
    /** Recommendations on an intent-carrying device, demoted or already manual. */
    onIntentDevices: number;
    /** Recommendations that WERE auto-safe and are now manual because of intent. */
    demotedFromAutoSafe: number;
    /** How many of those rested on a NAME heuristic rather than a recorded decision. */
    fromNameHeuristic: number;
    /** ...and of those, how many matched only a bare word (the shakiest case). */
    fromWeakNameMatch: number;
    byKind: Record<string, number>;
  };
}

export function summarize(recs: Recommendation[]): RemediationSummary {
  const summary: RemediationSummary = {
    total: recs.length,
    byKind: { "auto-safe": 0, manual: 0 },
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    intent: {
      onIntentDevices: 0,
      demotedFromAutoSafe: 0,
      fromNameHeuristic: 0,
      fromWeakNameMatch: 0,
      byKind: {},
    },
  };
  for (const r of recs) {
    summary.byKind[r.kind] += 1;
    summary.bySeverity[r.severity] += 1;
    if (!r.intent) continue;
    summary.intent.onIntentDevices += 1;
    if (r.demotedByIntent) summary.intent.demotedFromAutoSafe += 1;
    if (r.intent.source === "device-name") {
      summary.intent.fromNameHeuristic += 1;
      if (r.intent.strength === "weak") summary.intent.fromWeakNameMatch += 1;
    }
    summary.intent.byKind[r.intent.kind] = (summary.intent.byKind[r.intent.kind] ?? 0) + 1;
  }
  return summary;
}
