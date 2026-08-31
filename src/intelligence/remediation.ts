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
 */

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
    isBlackScreen: boolean | null;
    showingLogo: boolean | null;
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
   * Latest known set-brightness on the 0–255 wire scale. 0 is display-OFF (see
   * videri/brightness.ts). `null` = we have no reading, so no recommendation.
   */
  brightnessRaw: number | null;
}

export type Severity = "critical" | "high" | "medium" | "low";
export type RecommendationKind = "auto-safe" | "manual";

export interface Recommendation {
  /** Stable per device+rule, so the UI can key and dedupe across polls. */
  id: string;
  deviceIds: string[];
  deviceLabel: string;
  category: "display" | "content" | "telemetry" | "compliance";
  symptom: string;
  action: string;
  rationale: string;
  severity: Severity;
  /** 0..1 — how sure we are the action addresses the symptom. */
  confidence: number;
  kind: RecommendationKind;
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
 * "Online" for the purpose of acting: presence is online (the platform reports
 * it), regardless of what is on the panel. The derived status collapses a
 * black-screen or logo-fallback device into 'alert'/'warning', but those devices
 * are still reachable — only 'offline'/'unknown' mean we cannot see or act on
 * them. Every rule gates on this: a recommendation implies we could do something
 * about it, which requires a device we can currently reach.
 */
const isOnline = (status: string): boolean => status !== "offline" && status !== "unknown";

const labelOf = (d: DeviceView): string => d.name ?? d.id;

/** A brightness compliance check we could actually fix with our one verified write. */
const isBrightnessValueDrift = (field: string): boolean => field === "brightness";

export function recommendationsFor(devices: DeviceView[]): Recommendation[] {
  const out: Recommendation[] = [];

  for (const d of devices) {
    // Everything below advises an action on the device; if we cannot reach it,
    // we have nothing honest to recommend.
    if (!isOnline(d.status)) continue;

    const label = labelOf(d);
    // Brightness at raw 0 is the panel being dark at the backlight, which fully
    // explains a black capture. When it fires, it OWNS the darkness — we suppress
    // the content-fault and the brightness-value drift recs so we do not tell an
    // operator to re-push content or "apply expected brightness" when the real,
    // one-click fix is simply to turn the backlight up.
    const displayOff = d.brightnessRaw === 0;

    // US-1.2 — Display-off / brightness-0 while online → one-click restore.
    if (displayOff) {
      out.push({
        id: `${d.id}::display-off`,
        deviceIds: [d.id],
        deviceLabel: label,
        category: "display",
        symptom: "Display is off — brightness reads 0 while the device is online.",
        action: "Restore brightness",
        rationale:
          "Brightness 0 is an effectively dark panel. We hold the verified brightness " +
          "write (preflight → verify → rollback), so this is a safe one-click restore.",
        severity: "high",
        confidence: 0.9,
        kind: "auto-safe",
      });
    }

    // US-1.3 — Black screen while ONLINE → content/player fault. Suppressed when
    // the darkness is already explained by brightness 0.
    if (d.screen.isBlackScreen === true && !displayOff) {
      out.push({
        id: `${d.id}::black-screen`,
        deviceIds: [d.id],
        deviceLabel: label,
        category: "content",
        symptom: "Screen is black while the device is online.",
        action:
          "Capture a fresh frame to confirm; if still black, this is a content/player " +
          "fault — re-push content. (Reboot is device-rejected on this hardware.)",
        rationale:
          "Online + black points at content or the player, not the network. A stale " +
          "black flag is worth confirming with a live capture before re-pushing.",
        severity: "high",
        confidence: 0.7,
        kind: "manual",
      });
    }

    // US-1.4 — Logo fallback → no content resolved.
    if (d.screen.showingLogo === true) {
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
      // Brightness-value drift while brightness is 0 is the same fault the
      // display-off rule already owns as a one-click — don't say it twice.
      if (displayOff && isBrightnessValueDrift(drift.field)) continue;

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
}

export function summarize(recs: Recommendation[]): RemediationSummary {
  const summary: RemediationSummary = {
    total: recs.length,
    byKind: { "auto-safe": 0, manual: 0 },
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
  };
  for (const r of recs) {
    summary.byKind[r.kind] += 1;
    summary.bySeverity[r.severity] += 1;
  }
  return summary;
}
