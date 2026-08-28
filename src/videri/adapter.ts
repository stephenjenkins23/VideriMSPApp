/**
 * The adapter — the single place in this codebase that touches Videri's untyped
 * telemetry payload.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `CanvasMetricsResponse` is documented as carrying "CPU, memory, network and
 * display state", but the only typed fields are screen/download/update flags.
 * Everything numeric lives in `status` and `super_props`, both declared as
 * `additionalProperties: {type: object}` — free-form maps with no named keys,
 * no units, and no compatibility promise (docs/01-API-AUDIT.md §6).
 *
 * So we cannot write a normal typed mapping. What we do instead:
 *
 *   1. Flatten the maps to dotted paths.
 *   2. Match each metric we want against a list of *candidate* key names, using
 *      normalised comparison so `cpu_usage`, `cpuUsage` and `CPU.Usage` all hit.
 *   3. Normalise units heuristically, and record what we did.
 *   4. Log every key we have never seen, with sample values.
 *
 * Step 4 is the important one. Run the poller for a day and `discovered_keys`
 * becomes the telemetry documentation the API does not ship. Until then, every
 * metric degrades to `unavailable` rather than to a wrong number.
 *
 * RULE: nothing outside this file may read `super_props` or `status`. When
 * Videri renames a key, this is the only file that changes.
 */

import type { Device, DeviceClass, HealthSample, Observed, Provenance } from "../domain/types.js";
import { documented, unavailable } from "../domain/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Key discovery
// ─────────────────────────────────────────────────────────────────────────────

export interface DiscoveredKey {
  container: "super_props" | "status";
  key: string;
  sampleValue: unknown;
  inferredType: string;
}

/** Collected during a parse pass; the poller persists these. */
export type KeySink = (found: DiscoveredKey) => void;

const normalise = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Flatten nested objects to dotted paths. Arrays are left as leaf values. */
function flatten(input: unknown, prefix = "", out: Map<string, unknown> = new Map()) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    if (prefix) out.set(prefix, input);
    return out;
  }
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

const inferType = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v;

// ─────────────────────────────────────────────────────────────────────────────
// Metric extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Candidate key names per metric, best guess first.
 *
 * These are hypotheses, not knowledge. Populate them properly once
 * `discovered_keys` (or a live response, or the platform team) tells us the real
 * vocabulary — see docs/02-VFI-GAP-ANALYSIS.md §2.
 */
const CANDIDATES = {
  cpuPercent: ["cpu", "cpuusage", "cpupercent", "cpuload", "cpuutilisation", "cpuutilization", "proccpu"],
  ramPercent: ["ram", "ramusage", "rampercent", "memory", "memoryusage", "memusage", "mempercent", "memoryutilisation"],
  temperatureC: ["temp", "temperature", "cputemp", "cputemperature", "soctemp", "thermal"],
  wifiSignalDbm: ["signal", "rssi", "wifisignal", "wifirssi", "signalstrength", "signaldbm"],
  packetLossPercent: ["packetloss", "pktloss", "loss", "packetlosspercent"],
  jitterMs: ["jitter", "jitterms", "networkjitter"],
  ntpSyncPercent: ["ntp", "ntpsync", "ntpsyncrate", "ntpsyncpercent", "timesync"],
  storagePercent: ["storage", "storageused", "diskusage", "disk", "storagepercent", "diskpercent"],
  uptimeSeconds: ["uptime", "uptimeseconds", "uptimesec", "systemuptime"],
} as const satisfies Record<string, readonly string[]>;

type MetricName = keyof typeof CANDIDATES;

interface Bounds {
  min: number;
  max: number;
}

/**
 * Plausible ranges. A value outside these means our unit guess is wrong, so we
 * return `unavailable` rather than render a nonsense number. Silent wrong data
 * is far worse than an honest gap.
 */
const BOUNDS: Record<MetricName, Bounds> = {
  cpuPercent: { min: 0, max: 100 },
  ramPercent: { min: 0, max: 100 },
  temperatureC: { min: -20, max: 130 },
  wifiSignalDbm: { min: -110, max: 0 },
  packetLossPercent: { min: 0, max: 100 },
  jitterMs: { min: 0, max: 10_000 },
  ntpSyncPercent: { min: 0, max: 100 },
  storagePercent: { min: 0, max: 100 },
  uptimeSeconds: { min: 0, max: 60 * 60 * 24 * 3650 },
};

/** Unit corrections we attempt, in order, before giving up on a value. */
function coerceToRange(
  metric: MetricName,
  raw: number,
): { value: number; note?: string; ambiguous?: string } | null {
  const { min, max } = BOUNDS[metric];
  const inRange = (n: number) => n >= min && n <= max;

  if (inRange(raw)) {
    // A percentage in (0, 1] is undecidable: 0.68 could be 0.68% or 68%. Both
    // readings are inside the plausible range, so no heuristic can separate
    // them — the payload simply does not say. Return the raw value and mark it,
    // rather than silently picking an interpretation that may be 100x wrong.
    if (metric.endsWith("Percent") && raw > 0 && raw <= 1) {
      return {
        value: raw,
        ambiguous:
          `Reported as ${raw}. Could be ${raw}% or ${round1(raw * 100)}% — the API declares no unit for this field. ` +
          `Resolve by confirming the unit for this key, then remove the ambiguity branch in adapter.ts.`,
      };
    }
    return { value: raw };
  }

  // Fractional percentage: 0.42 → 42%
  if (metric.endsWith("Percent") && raw > 0 && raw <= 1) {
    return { value: raw * 100, note: "scaled from fraction" };
  }
  // Milli-units: 47000 milli-°C → 47 °C
  if (metric === "temperatureC" && inRange(raw / 1000)) {
    return { value: raw / 1000, note: "scaled from milli-degrees" };
  }
  // Positive RSSI reported as magnitude: 78 → -78 dBm
  if (metric === "wifiSignalDbm" && inRange(-raw)) {
    return { value: -raw, note: "sign corrected" };
  }
  // Uptime in milliseconds
  if (metric === "uptimeSeconds" && inRange(raw / 1000)) {
    return { value: raw / 1000, note: "scaled from milliseconds" };
  }
  return null;
}

const round1 = (n: number) => Number(n.toFixed(1));

function parseNumeric(v: unknown): number | null {
  if (isAbsent(v)) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    // Handles "47", "47.5", "47%", "-62 dBm", "78°C"
    const m = v.match(/-?\d+(\.\d+)?/);
    if (m) {
      const n = Number(m[0]);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The metrics adapter
// ─────────────────────────────────────────────────────────────────────────────

/** Shape of the documented part of `CanvasMetricsResponse` / `StatusResponse`. */
export interface RawMetricsPayload {
  device_id?: string | null;
  downloading?: string | null;
  is_black_screen?: string | null;
  is_screen_on?: string | null;
  showing_logo?: string | null;
  software_update_status?: string | null;
  presence?: string | null;
  /** Strings on the live API, e.g. "no" / "unavailable" — not numbers. */
  ping_quality?: number | string | null;
  playback_quality?: number | string | null;
  timestamp?: string | null;
  status?: Record<string, unknown> | null;
  super_props?: Record<string, unknown> | null;
}

/**
 * The platform uses the STRING `"unavailable"` where a type promises a number,
 * a boolean, or a timestamp. It is the platform's null, and every consumer has
 * to treat it as absence — verified live across canvases, metrics and status
 * payloads (docs/05-LIVE-API-FINDINGS.md §4).
 */
const ABSENT_STRINGS = new Set(["unavailable", "", "n/a", "not set", "null", "undefined"]);

export function isAbsent(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  return typeof v === "string" && ABSENT_STRINGS.has(v.trim().toLowerCase());
}

/**
 * Videri returns booleans as the strings "true"/"false".
 *
 * Note `"no"` is deliberately NOT treated as false here: `ping_quality` returns
 * the literal string `"no"` as a value in its own vocabulary, and folding it into
 * a boolean would silently invent meaning we do not have.
 */
function parseLooseBoolean(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (isAbsent(v)) return null;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
  }
  return null;
}

/** An opaque string value, absent-aware. */
function parseOpaqueString(v: unknown): string | null {
  if (isAbsent(v)) return null;
  return typeof v === "string" ? v.trim() : String(v);
}

/**
 * Flatten `metadata[]` into `{name: value}`.
 *
 * The vocabulary is tenant-defined — 15 distinct metafields on VIDERISALES, of
 * which only NAME and CITY are universal — so this deliberately keeps whatever
 * it finds rather than mapping to a fixed schema. A later tenant may use none of
 * these names, and the product must degrade rather than break.
 *
 * Duplicate names keep the FIRST occurrence: a device with two CITY entries is a
 * data-entry problem, and silently preferring the last one would make the choice
 * invisible.
 */
export function parseMetafields(
  raw: Array<{ metafieldName?: string | null; value?: unknown }> | null | undefined,
): Record<string, string> {
  if (!Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const field of raw) {
    const name = field?.metafieldName;
    if (typeof name !== "string" || name.length === 0) continue;
    if (name in out) continue;
    if (isAbsent(field?.value)) continue;
    out[name] = String(field.value).trim();
  }
  return out;
}

/**
 * The device's city, if the tenant records one.
 *
 * Case-insensitive on the key because a tenant-defined vocabulary is not a
 * contract — this tenant uses `CITY`, and another using `City` should not
 * silently lose its fleet geography.
 */
export function cityFrom(
  raw: Array<{ metafieldName?: string | null; value?: unknown }> | null | undefined,
): string | null {
  const fields = parseMetafields(raw);
  for (const [k, v] of Object.entries(fields)) {
    if (k.toLowerCase() === "city" && v.length > 0) return v;
  }
  return null;
}

/** Tolerated forward clock skew before a device timestamp is treated as faulty. */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Coerce a device-reported timestamp into one that cannot corrupt time-series
 * math: unparseable or future-dated values fall back to ingest time.
 */
export function clampObservedAt(raw: unknown, now = new Date()): Date {
  if (raw === null || raw === undefined || raw === "") return now;
  const t = new Date(raw as string | number);
  if (Number.isNaN(t.getTime())) return now;
  if (t.getTime() > now.getTime() + MAX_CLOCK_SKEW_MS) return now;
  return t;
}

export class MetricsAdapter {
  /** Keys we have already reported this process, to keep the sink quiet. */
  readonly #seen = new Set<string>();

  constructor(private readonly onKeyDiscovered: KeySink = () => {}) {}

  toHealthSample(deviceId: string, raw: RawMetricsPayload): HealthSample {
    const superProps = flatten(raw.super_props ?? {});
    const status = flatten(raw.status ?? {});

    this.#reportUnknown("super_props", superProps);
    this.#reportUnknown("status", status);

    // Device clocks are not trustworthy. A live SparkQ+ ("IST Q", device
    // 1029524) reported `2085-01-02` on 2026-08-25 — a device-side clock fault,
    // stored verbatim, which then made it the permanently "newest" sample and
    // yielded a NEGATIVE telemetry age of ~58 years in the freshness stats.
    //
    // A timestamp from the future is never usable, so it is replaced by ingest
    // time rather than dropped: the reading itself is still real, only its clock
    // is wrong. Small skew is tolerated because clock drift of a few minutes is
    // normal and not worth rewriting.
    const observedAt = clampObservedAt(raw.timestamp);

    const bool = (v: unknown, field: string): Observed<boolean> => {
      const parsed = parseLooseBoolean(v);
      return parsed === null
        ? unavailable<boolean>(`${field} absent or unparseable`)
        : documented(parsed, field);
    };

    // Quality signals are opaque strings with an undocumented vocabulary. We
    // record them faithfully instead of coercing them into a scale that does
    // not exist — see docs/05 §4.
    const quality = (v: unknown, field: string): Observed<string> => {
      const s = parseOpaqueString(v);
      return s === null ? unavailable<string>(`${field} absent`) : documented(s, field);
    };

    // `status.current` = {type, id} — what is on screen right now.
    const current = (raw.status as { current?: { type?: string; id?: string } } | null)?.current;

    const presenceRaw = isAbsent(raw.presence) ? "" : String(raw.presence).toLowerCase();
    const presence: Observed<"online" | "offline"> = presenceRaw
      ? documented(presenceRaw.includes("online") || presenceRaw === "available" ? "online" : "offline", "presence")
      : unavailable<"online" | "offline">("presence absent");

    return {
      deviceId,
      observedAt,

      presence,
      isScreenOn: bool(raw.is_screen_on, "is_screen_on"),
      isBlackScreen: bool(raw.is_black_screen, "is_black_screen"),
      showingLogo: bool(raw.showing_logo, "showing_logo"),
      downloading: bool(raw.downloading, "downloading"),
      softwareUpdateStatus: isAbsent(raw.software_update_status)
        ? unavailable<string>("software_update_status absent")
        : documented(String(raw.software_update_status), "software_update_status"),
      pingQuality: quality(raw.ping_quality, "ping_quality"),
      playbackQuality: quality(raw.playback_quality, "playback_quality"),
      nowPlayingType: current?.type
        ? documented(current.type, "status.current.type")
        : unavailable<string>("status.current absent"),
      nowPlayingId: current?.id
        ? documented(current.id, "status.current.id")
        : unavailable<string>("status.current absent"),

      cpuPercent: this.#extract("cpuPercent", superProps, status),
      ramPercent: this.#extract("ramPercent", superProps, status),
      temperatureC: this.#extract("temperatureC", superProps, status),
      wifiSignalDbm: this.#extract("wifiSignalDbm", superProps, status),
      packetLossPercent: this.#extract("packetLossPercent", superProps, status),
      jitterMs: this.#extract("jitterMs", superProps, status),
      ntpSyncPercent: this.#extract("ntpSyncPercent", superProps, status),
      storagePercent: this.#extract("storagePercent", superProps, status),
      uptimeSeconds: this.#extract("uptimeSeconds", superProps, status),
    };
  }

  #extract(
    metric: MetricName,
    superProps: Map<string, unknown>,
    status: Map<string, unknown>,
  ): Observed<number> {
    for (const [container, map] of [
      ["super_props", superProps],
      ["status", status],
    ] as const) {
      for (const [path, value] of map) {
        // Match on the leaf segment so `system.cpu.usage` matches "cpuusage".
        const leaf = normalise(path.split(".").slice(-2).join(""));
        const whole = normalise(path);
        const hit = CANDIDATES[metric].some((c) => leaf === c || whole.endsWith(c));
        if (!hit) continue;

        const numeric = parseNumeric(value);
        if (numeric === null) continue;

        const coerced = coerceToRange(metric, numeric);
        if (!coerced) continue; // implausible → keep looking

        const provenance: Provenance = { kind: "inferred", sourceKey: path, container };
        return {
          value: coerced.value,
          provenance,
          ...(coerced.note ? { rawUnit: coerced.note } : {}),
          ...(coerced.ambiguous ? { ambiguous: coerced.ambiguous } : {}),
        };
      }
    }
    return unavailable<number>(`no key matched for ${metric}`);
  }

  #reportUnknown(container: "super_props" | "status", map: Map<string, unknown>): void {
    for (const [key, value] of map) {
      const id = `${container}:${key}`;
      if (this.#seen.has(id)) continue;
      this.#seen.add(id);
      this.onKeyDiscovered({ container, key, sampleValue: value, inferredType: inferType(value) });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Device adapter — documented fields only, so this one is straightforward
// ─────────────────────────────────────────────────────────────────────────────

export interface RawCanvas {
  /** INTEGER on the live API (e.g. 1000015), despite the spec implying a uuid. */
  id?: string | number;
  device_id?: string | null;
  xmpp_jid?: string | null;
  /**
   * Tenant-defined metafields. NOT the same thing as `tags`: an array of
   * `{metafieldName, value, metafieldId}` records, populated on every device on
   * this tenant and the only fleet-wide location source we have.
   */
  metadata?: Array<{ metafieldName?: string | null; value?: unknown }> | null;
  name?: string | null;
  model_type?: string | null;
  product_name?: string | null;
  vendor?: string | null;
  serial_no?: string | null;
  tenant_code?: string | null;
  tenant_name?: string | null;
  group_id?: string | null;
  group_name?: string | null;
  /** Not returned by the live API. Retained in case another tenant populates it. */
  account_name?: string | null;
  location?: string | null;
  geo?: { coordinates?: { latitude?: number | null; longitude?: number | null } | null } | null;
  timezone?: string | null;
  orientation?: string | null;
  screen_width?: number | null;
  screen_height?: number | null;
  /**
   * A MAP of component name → {current, latest}, e.g.
   *   { "adsync_version": { current: "5.1.1-…", latest: "6.4.10-…" }, … }
   * NOT the flat {current, latest} pair the spec's VersionInfo describes.
   */
  core_services_versions?: Record<string, { current?: string | null; latest?: string | null }> | null;
  license_status?: string | null;
  license_expiration?: string | null;
  first_activated?: string | null;
  /** `"unavailable"` when the device has never been seen. */
  last_online_time?: string | null;
  status_changed_time?: string | null;
  tags?: string[] | null;
  /** Present on the metrics payload; carries firmware and package identity. */
  super_props?: Record<string, unknown> | null;
}

/**
 * The component we treat as "the firmware version" in summary views.
 *
 * Verified live: `core_services_versions` keys are `icanvasplayer_version`,
 * `adsync_version`, `firmware_version`, `superuserservice_version` — a different
 * naming scheme from the `com.videri.*` keys inside `super_props`. The player is
 * the most meaningful single version to surface.
 */
const PRIMARY_COMPONENT_HINTS = ["icanvasplayer", "firmware_version", "adsync", "player"];

function normaliseComponents(
  raw: RawCanvas["core_services_versions"],
): Record<string, { current: string | null; latest: string | null }> {
  const out: Record<string, { current: string | null; latest: string | null }> = {};
  for (const [name, versions] of Object.entries(raw ?? {})) {
    if (!versions || typeof versions !== "object") continue;
    out[name] = {
      current: isAbsent(versions.current) ? null : String(versions.current),
      latest: isAbsent(versions.latest) ? null : String(versions.latest),
    };
  }
  return out;
}

/** Pick a representative component for the single-version summary columns. */
function primaryComponent(
  components: Record<string, { current: string | null; latest: string | null }>,
): { current: string | null; latest: string | null } {
  for (const hint of PRIMARY_COMPONENT_HINTS) {
    const match = Object.keys(components).find((k) => k.toLowerCase().includes(hint));
    if (match) return components[match]!;
  }
  const first = Object.values(components)[0];
  return first ?? { current: null, latest: null };
}

/** Components whose installed version differs from the latest available. */
export function componentsBehind(
  components: Record<string, { current: string | null; latest: string | null }>,
): Array<{ component: string; current: string; latest: string }> {
  const behind: Array<{ component: string; current: string; latest: string }> = [];
  for (const [component, v] of Object.entries(components)) {
    if (v.current && v.latest && v.current !== v.latest) {
      behind.push({ component, current: v.current, latest: v.latest });
    }
  }
  return behind;
}

/**
 * Device class inference.
 *
 * `ResponseCanvas` is Canvas-shaped and has no device-class field, so we infer
 * from `product_name` / `model_type` / `vendor`. Whether TCL and AllSee hardware
 * appears in this registry at all is still unconfirmed — the `ops_*` Android
 * command family suggests yes (docs/02-VFI-GAP-ANALYSIS.md §1). Until we see
 * live data this returns "unknown" rather than guessing wrong.
 */
export function inferDeviceClass(raw: RawCanvas): DeviceClass {
  const haystack = [raw.product_name, raw.model_type, raw.vendor, raw.name]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  // Matched against the full 20-name hardware catalogue, retrieved live from
  // `canvases/field_values?field=product_name` (docs/09 Part 1). Before this,
  // `H11.1`, `The 4` and `The 5` all fell through to "unknown" — 34 devices.
  if (/tcl/.test(haystack)) return "tcl";
  if (/allsee/.test(haystack)) {
    // Shelf-edge and stretched-bar units sit close to the shopper and take the
    // dimmer, always-silent template.
    return /shelf|stretch|bar\b|\bse\b/.test(haystack) ? "allsee-shelf" : "allsee";
  }
  if (/bridge/.test(haystack)) return "spark-bridge";
  // Any V-series designation (V2, V3, V4, V5, V17EE kit, VQ) is Videri canvas
  // hardware. Note `field_values` only returns products for GROUP-ASSIGNED
  // devices, so the catalogue it gave us was itself incomplete — V3, V5 and
  // V17EE only appear among the 16 unassigned units.
  if (/spark|canvas|\bv\d+\w*\b|\bvq\b|\bthe [45]\b|^h\d/.test(haystack)) return "canvas";
  // A device with no product_name at all is genuinely unclassifiable. Nine such
  // devices exist; guessing would be worse than admitting it.
  return "unknown";
}

/**
 * Sub-capabilities implied by the product name.
 *
 * The catalogue distinguishes variants the device class alone does not: an LTE
 * Spark, a battery-powered outdoor A-Board and a PCAP touch panel have different
 * connectivity, power and interaction characteristics, and therefore want
 * different compliance expectations.
 */
export interface DeviceCapabilities {
  cellular: boolean;
  battery: boolean;
  touch: boolean;
  outdoor: boolean;
  highBrightness: boolean;
}

export function inferCapabilities(raw: RawCanvas): DeviceCapabilities {
  const h = [raw.product_name, raw.model_type, raw.name].filter(Boolean).join(" ").toLowerCase();
  return {
    // Corroborated by `cellular_mac_address` appearing in the telemetry keys.
    cellular: /\blte\b|cellular|modem/.test(h),
    battery: /battery/.test(h),
    touch: /touch|pcap/.test(h),
    outdoor: /outdoor/.test(h),
    highBrightness: /high.?brightness|ultra.?high|high vibrance/.test(h),
  };
}

export function toDevice(raw: RawCanvas): Device | null {
  if (raw.id === undefined || raw.id === null || raw.id === "") return null;

  const components = normaliseComponents(raw.core_services_versions);
  const primary = primaryComponent(components);
  const sp = raw.super_props ?? {};
  const str = (v: unknown): string | null => (isAbsent(v) ? null : String(v));

  return {
    // Live ids are integers; we key on the string form throughout.
    id: String(raw.id),
    deviceId: raw.device_id ?? null,
    deviceJid: raw.xmpp_jid ?? null,
    name: str(raw.name),
    deviceClass: inferDeviceClass(raw),
    modelType: str(raw.model_type),
    productName: str(raw.product_name),
    vendor: str(raw.vendor),
    serialNo: str(raw.serial_no),
    tenantCode: raw.tenant_code ?? raw.tenant_name ?? null,
    groupId: str(raw.group_id),
    groupName: str(raw.group_name),
    accountName: str(raw.account_name),
    location: str(raw.location),
    latitude: raw.geo?.coordinates?.latitude ?? null,
    longitude: raw.geo?.coordinates?.longitude ?? null,
    timezone: str(raw.timezone),
    orientation: str(raw.orientation),
    screenWidth: raw.screen_width ?? null,
    screenHeight: raw.screen_height ?? null,
    components,
    firmwareBuildId: str(sp["firmware_build_id"]),
    firmwareIncrementalVersion: str(sp["firmware_incremental_version"]),
    firmwareCurrent: primary.current,
    firmwareLatest: primary.latest,
    licenseStatus: str(raw.license_status),
    licenseExpiration: str(raw.license_expiration),
    firstActivated: str(raw.first_activated),
    lastOnlineTime: str(raw.last_online_time),
    statusChangedTime: str(raw.status_changed_time),
    tags: raw.tags ?? [],
    metafields: parseMetafields(raw.metadata),
    city: cityFrom(raw.metadata),
  };
}
