/**
 * Compliance templates — expected configuration, per device class.
 *
 * Field names here are taken from a REAL `ops_get_settings` response, not from
 * the OpenAPI specs (which do not document this payload at all). Verified live
 * against a TCL TM55N on 2026-08-25 — see `evidence/tcl-ops-get-settings.json`.
 *
 * THE RULE THAT SHAPES THIS FILE
 * A check whose field does not exist on the device is **not applicable**, never a
 * failure. Videri Canvas hardware has no HDMI input and no volume; flagging it
 * for "wrong input source" would make compliance scores meaningless and train
 * operators to ignore them. Applicability is therefore explicit on every check,
 * and `notApplicable` is a first-class verdict that is excluded from the score.
 */

import type { DeviceClass } from "../domain/types.js";

export type Comparator =
  | { kind: "equals"; value: string | number | boolean }
  | { kind: "oneOf"; values: Array<string | number> }
  | { kind: "range"; min: number; max: number }
  | { kind: "notEmpty" };

/**
 * Two genuinely different questions, which the first version of this file
 * conflated — and the conflation produced a 61% score with 109 of 110 devices
 * "non-compliant", which no operator would read twice.
 *
 *  - `calibrated` — deviation from what the fleet overwhelmingly does. A failure
 *    here is real drift on one device and is immediately actionable.
 *  - `policy`     — deviation from what we have decided SHOULD be true, which
 *    most of the fleet may legitimately violate today. That is a remediation
 *    backlog, not non-compliance, and it must not drown out the first category.
 *
 * They are scored separately for that reason.
 */
export type CheckKind = "calibrated" | "policy";

export interface ComplianceCheck {
  id: string;
  /** Defaults to `calibrated` when omitted. */
  kind?: CheckKind;
  /** Dotted path into the settings object, e.g. `color_table_offsets.r`. */
  field: string;
  /** Human-readable name for the UI. */
  label: string;
  expected: Comparator;
  /** Relative weight in the score. Config that affects what viewers see ranks higher. */
  weight: number;
  /**
   * Device classes this check applies to. A check is skipped as notApplicable
   * for any other class, AND whenever the field is absent from the payload —
   * belt and braces, because hardware varies within a class.
   */
  appliesTo: DeviceClass[] | "all";
  /** Why this matters, surfaced in the UI and to the AI explanation layer. */
  rationale: string;
}

export interface ComplianceTemplate {
  id: string;
  name: string;
  /** Default template for these classes when a device has no explicit assignment. */
  defaultFor: DeviceClass[];
  checks: ComplianceCheck[];
}

const ALL_ANDROID: DeviceClass[] = ["tcl", "allsee", "allsee-shelf"];

/**
 * Fields only TCL panels report. Audited live (`npm run audit:settings`,
 * evidence/settings-field-audit.txt): of the 17 settings fields our templates
 * name, TCL returns all 17 — but AllSee and Canvas never return `cec_enabled`
 * or `source_auto_switch`. Scoping them here keeps an AllSee report honest
 * instead of carrying two checks that can only ever read "not applicable".
 */
const TCL_ONLY: DeviceClass[] = ["tcl"];
const VIDERI: DeviceClass[] = ["canvas", "spark-bridge"];

/** Checks that apply to every device class we manage. */
const UNIVERSAL_CHECKS: ComplianceCheck[] = [
  {
    id: "timezone-set",
    kind: "calibrated",
    field: "timezone",
    label: "Timezone configured",
    expected: { kind: "notEmpty" },
    weight: 2,
    appliesTo: "all",
    rationale:
      "Content schedules are evaluated in device-local time. A wrong or empty " +
      "timezone silently shifts every scheduled slot.",
  },
  {
    id: "daily-reboot-enabled",
    // POLICY, not calibrated: 93% of the fleet has this OFF. We believe a nightly
    // reboot prevents the most common black-screen causes, so this stays as a
    // target — but it is reported as a backlog item, not as drift.
    kind: "policy",
    field: "daily_reboot_enabled",
    label: "Nightly reboot enabled",
    expected: { kind: "equals", value: true },
    weight: 2,
    appliesTo: "all",
    rationale:
      "A nightly reboot clears the most common causes of a frozen or black " +
      "screen before opening hours.",
  },
  {
    id: "daily-reboot-window",
    kind: "calibrated",
    field: "daily_reboot_time",
    label: "Reboot outside trading hours",
    // 00:00–05:00 expressed in the device's HHMM string format.
    expected: { kind: "oneOf", values: ["0000", "0100", "0200", "0300", "0400", "0500"] },
    weight: 1,
    appliesTo: "all",
    rationale: "Rebooting during trading hours takes a screen dark in front of customers.",
  },
  {
    id: "storage-headroom",
    kind: "calibrated",
    field: "storage_target_free_percent",
    label: "Storage headroom target",
    expected: { kind: "range", min: 20, max: 60 },
    weight: 2,
    appliesTo: "all",
    rationale:
      "Too little headroom and new content fails to download; too much wastes " +
      "capacity and forces needless re-downloads.",
  },
  {
    id: "display-on",
    // POLICY: 25% of the fleet reports display_on = false. Some are legitimately
    // powered down; a screen that should be trading and is not is the single most
    // expensive failure in this product, so it stays a target.
    kind: "policy",
    field: "display_on",
    label: "Display powered on",
    expected: { kind: "equals", value: true },
    weight: 3,
    appliesTo: "all",
    rationale: "A powered-off panel shows nothing regardless of what is scheduled.",
  },
];

/**
 * Power-schedule checks.
 *
 * Calibrated against 110 real devices: 95% run 0900→0500 and 98% have
 * `auto_on_off_enabled = false`. The original template assumed retail hours
 * (0900→2100) and a schedule switched on — wrong on both counts, and between
 * them they accounted for most of the false failures.
 */
const scheduleChecks = (onTime: string, offTime: string): ComplianceCheck[] => [
  {
    id: "power-schedule-enabled",
    // POLICY: the fleet norm is OFF (98%). Running 24/7 wastes backlight life,
    // so enabling it is a target — but flagging 98% of devices as
    // non-compliant would make the score meaningless.
    kind: "policy",
    field: "auto_on_off_enabled",
    label: "Power schedule enabled",
    expected: { kind: "equals", value: true },
    weight: 3,
    appliesTo: "all",
    rationale:
      "Without a schedule the panel runs 24/7 — wasted power and shortened " +
      "backlight life — or stays off when it should be trading.",
  },
  {
    id: "power-on-time",
    kind: "calibrated",
    field: "turn_on_time",
    label: `Powers on at ${onTime}`,
    expected: { kind: "equals", value: onTime },
    weight: 2,
    appliesTo: "all",
    rationale: "A screen that wakes late misses the opening trading window.",
  },
  {
    id: "power-off-time",
    kind: "calibrated",
    field: "turn_off_time",
    label: `Powers off at ${offTime}`,
    expected: { kind: "equals", value: offTime },
    weight: 1,
    appliesTo: "all",
    rationale: "Consistent off-time keeps power reporting and backlight wear predictable.",
  },
];

/** Display calibration — brightness and colour. */
const displayChecks = (brightness: number, saturation: number): ComplianceCheck[] => [
  {
    id: "brightness-nonzero",
    // Brightness is reported on a 0–255 scale (NOT 0–100 — the original template
    // got this wrong) and the fleet has no consensus: 30 distinct values, median
    // 107, range 0–255. A target band would flag 86% of devices for nothing.
    //
    // So we check only the unambiguous failure: brightness at or near zero while
    // the panel is supposedly on. 35 of 110 devices report brightness 0, which is
    // worth an operator's attention regardless of what the target should be.
    kind: "calibrated",
    field: "brightness",
    label: "Brightness above minimum",
    expected: { kind: "range", min: 10, max: 255 },
    weight: 3,
    appliesTo: "all",
    rationale:
      "Brightness at zero means an effectively dark screen. Reported on a 0–255 " +
      "scale; the fleet has no common target, so only the zero case is enforced.",
  },
  {
    id: "auto-brightness-off",
    kind: "calibrated",
    field: "auto_brightness_enabled",
    label: "Auto-brightness disabled",
    expected: { kind: "equals", value: false },
    weight: 1,
    appliesTo: "all",
    rationale:
      "Auto-brightness makes appearance inconsistent across a wall and " +
      "undermines any calibrated brightness target.",
  },
  {
    id: "colour-saturation",
    kind: "calibrated",
    field: "color_saturation",
    label: `Saturation near ${saturation}`,
    // Calibrated: 98% of the fleet reports exactly 50.
    expected: { kind: "range", min: saturation - 10, max: saturation + 10 },
    weight: 2,
    appliesTo: "all",
    rationale: "Brand colour accuracy — advertisers notice when their red is wrong.",
  },
  {
    id: "colour-offset-r",
    kind: "calibrated",
    field: "color_table_offsets.r",
    label: "Red channel offset neutral",
    expected: { kind: "range", min: -5, max: 5 },
    weight: 1,
    appliesTo: "all",
    rationale: "Non-zero channel offsets indicate a manual calibration that was never reverted.",
  },
  {
    id: "colour-offset-g",
    kind: "calibrated",
    field: "color_table_offsets.g",
    label: "Green channel offset neutral",
    expected: { kind: "range", min: -5, max: 5 },
    weight: 1,
    appliesTo: "all",
    rationale: "As above, for the green channel.",
  },
  {
    id: "colour-offset-b",
    kind: "calibrated",
    field: "color_table_offsets.b",
    label: "Blue channel offset neutral",
    expected: { kind: "range", min: -5, max: 5 },
    weight: 1,
    appliesTo: "all",
    rationale: "As above, for the blue channel.",
  },
];

/**
 * Android-only checks.
 *
 * These are the "greater management fields" TCL and AllSee expose and Videri
 * Canvas hardware does not — input source, audio routing, CEC, HDMI. Marked
 * `appliesTo: ALL_ANDROID` so a Canvas is never scored against them.
 */
const ANDROID_CHECKS: ComplianceCheck[] = [
  {
    id: "input-source",
    kind: "calibrated",
    field: "current_source",
    label: "Input on internal player",
    expected: { kind: "equals", value: "ANDROID" },
    weight: 3,
    appliesTo: ALL_ANDROID,
    rationale:
      "If the panel is switched to HDMI it shows whatever is plugged in, not the " +
      "scheduled content. A common and silent failure after on-site maintenance.",
  },
  {
    id: "source-auto-switch-off",
    kind: "calibrated",
    field: "source_auto_switch",
    label: "Auto source-switch disabled",
    expected: { kind: "equals", value: false },
    weight: 2,
    appliesTo: TCL_ONLY,
    rationale:
      "Auto-switching lets any device plugged into HDMI hijack the screen away " +
      "from scheduled content.",
  },
  {
    id: "volume-muted",
    kind: "calibrated",
    // NOT raw `volume` — the scale is per-device. Audited live: `max_volume` is
    // 100 on TCL but 15 on Canvas and AllSee, so a flat "volume <= 5" meant
    // "under 5%" on a TCL and "under 33%" on an AllSee. The device reports its
    // own maximum, so we normalise against it instead of guessing a scale.
    field: "volume_percent",
    label: "Volume muted",
    expected: { kind: "range", min: 0, max: 10 },
    weight: 2,
    appliesTo: ALL_ANDROID,
    rationale:
      "Most retail placements are silent by policy. Unexpected audio generates " +
      "venue complaints. Scored as a percentage of the panel's own maximum, " +
      "because the raw scale differs by hardware class.",
  },
  {
    id: "cec-disabled",
    kind: "calibrated",
    field: "cec_enabled",
    label: "HDMI-CEC disabled",
    expected: { kind: "equals", value: false },
    weight: 1,
    appliesTo: TCL_ONLY,
    rationale:
      "CEC lets an attached device power the panel off or change its input " +
      "without our knowledge.",
  },
  {
    id: "custom-logo-off",
    kind: "calibrated",
    field: "custom_logo",
    label: "Custom boot logo disabled",
    expected: { kind: "equals", value: false },
    weight: 1,
    appliesTo: ALL_ANDROID,
    rationale: "A custom logo can mask the standard boot/idle state used for diagnosis.",
  },
];

export const DEFAULT_TEMPLATES: ComplianceTemplate[] = [
  {
    id: "retail-standard",
    name: "Retail — Standard Hours",
    defaultFor: ["canvas", "spark-bridge", "unknown"],
    checks: [
      ...UNIVERSAL_CHECKS,
      ...scheduleChecks("0900", "0500"),
      ...displayChecks(85, 50),
    ],
  },
  {
    id: "retail-android",
    name: "Retail — Android Display",
    defaultFor: ["tcl", "allsee"],
    checks: [
      ...UNIVERSAL_CHECKS,
      ...scheduleChecks("0900", "0500"),
      ...displayChecks(85, 50),
      ...ANDROID_CHECKS,
    ],
  },
  {
    id: "shelf-edge",
    name: "Shelf Edge",
    defaultFor: ["allsee-shelf"],
    checks: [
      ...UNIVERSAL_CHECKS,
      ...scheduleChecks("0800", "0500"),
      // Shelf-edge units sit close to the shopper: dimmer, and always silent.
      ...displayChecks(70, 50),
      ...ANDROID_CHECKS.map((c) =>
        c.id === "volume-muted"
          ? { ...c, expected: { kind: "equals", value: 0 } as Comparator, weight: 3 }
          : c,
      ),
    ],
  },
  {
    id: "airport-extended",
    name: "Airport — Extended Hours",
    defaultFor: [],
    checks: [
      ...UNIVERSAL_CHECKS,
      // Concourse screens run almost around the clock.
      ...scheduleChecks("0400", "2300"),
      ...displayChecks(90, 55),
      ...ANDROID_CHECKS,
    ],
  },
];

export function templateFor(
  deviceClass: DeviceClass,
  assigned: string | null,
  templates: ComplianceTemplate[] = DEFAULT_TEMPLATES,
): ComplianceTemplate | null {
  if (assigned) {
    const explicit = templates.find((t) => t.id === assigned);
    if (explicit) return explicit;
  }
  return templates.find((t) => t.defaultFor.includes(deviceClass)) ?? null;
}

export function validateTemplate(template: ComplianceTemplate): string[] {
  const problems: string[] = [];
  if (!template.id.trim()) problems.push("id is required");
  if (template.checks.length === 0) problems.push("template has no checks");
  const ids = template.checks.map((c) => c.id);
  if (new Set(ids).size !== ids.length) problems.push("duplicate check ids");
  for (const check of template.checks) {
    if (check.weight <= 0) problems.push(`check "${check.id}" has a non-positive weight`);
    if (!check.field.trim()) problems.push(`check "${check.id}" has no field`);
    if (check.expected.kind === "range" && check.expected.min > check.expected.max) {
      problems.push(`check "${check.id}" has an inverted range`);
    }
    if (check.expected.kind === "oneOf" && check.expected.values.length === 0) {
      problems.push(`check "${check.id}" has an empty oneOf`);
    }
  }
  return problems;
}
