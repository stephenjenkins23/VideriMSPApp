/**
 * Our domain model — deliberately NOT the Videri wire model.
 *
 * Everything the platform gives us passes through `src/videri/adapter.ts` before
 * it becomes one of these types. That indirection is the point: the Videri
 * telemetry payload is an untyped map (see docs/01-API-AUDIT.md §6), so field
 * names we depend on carry no compatibility guarantee. Keeping our own model
 * means a breaking change upstream is a one-file fix, not a refactor.
 */

/** Where a value came from, and how much we trust it. */
export type Provenance =
  /** A typed, documented field in the OpenAPI spec. Safe to depend on. */
  | { kind: "documented"; field: string }
  /** Recovered from an untyped map by key match. Could vanish without notice. */
  | { kind: "inferred"; sourceKey: string; container: "super_props" | "status" }
  /** We computed it from other values. */
  | { kind: "derived"; from: string[] }
  /** We looked and it wasn't there. */
  | { kind: "unavailable"; reason: string };

/**
 * A value that might not exist. Every metric is wrapped in this, because the
 * honest answer for much of the Videri telemetry surface is "we don't know yet".
 * The UI renders `unavailable` as a greyed tile, never as zero — a device
 * reporting 0% CPU and a device whose CPU we cannot read are different facts,
 * and conflating them is how dashboards start lying.
 */
export interface Observed<T> {
  value: T | null;
  provenance: Provenance;
  /** Original units as reported, when they differ from ours. */
  rawUnit?: string;
  /**
   * Set when the value is real but its unit is genuinely undecidable from the
   * payload — e.g. a CPU reading of 0.684, which is either 0.684% on an idle
   * device or 68.4% expressed as a fraction. Nothing in the Videri API declares
   * units, so no client can resolve this.
   *
   * Contract for consumers:
   *   - Display it, but flag it. Never present an ambiguous value as certain.
   *   - NEVER evaluate an alert rule against it. A threshold comparison on an
   *     ambiguous unit will fire wrongly by a factor of 100.
   *   - Exclude it from aggregates and trends.
   */
  ambiguous?: string;
}

export const unavailable = <T>(reason: string): Observed<T> => ({
  value: null,
  provenance: { kind: "unavailable", reason },
});

export const documented = <T>(value: T, field: string): Observed<T> => ({
  value,
  provenance: { kind: "documented", field },
});

export type DeviceClass =
  | "canvas"
  | "spark-bridge"
  | "tcl"
  | "allsee"
  | "allsee-shelf"
  | "unknown";

/** Our status tiers. The platform has presence only — these are our rules. */
export type DeviceStatus = "online" | "warning" | "alert" | "offline" | "unknown";

/** Identity and configuration — all from documented `ResponseCanvas` fields. */
export interface Device {
  /** Videri canvas UUID. Our primary key. */
  id: string;
  /** Physical device id. Needed for canvas-status and command calls. */
  deviceId: string | null;
  /** XMPP JID — required alongside deviceId + playerId to send any command. */
  deviceJid: string | null;
  name: string | null;
  deviceClass: DeviceClass;
  modelType: string | null;
  productName: string | null;
  vendor: string | null;
  serialNo: string | null;

  tenantCode: string | null;
  groupId: string | null;
  groupName: string | null;
  accountName: string | null;

  location: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;

  orientation: string | null;
  screenWidth: number | null;
  screenHeight: number | null;

  /**
   * Live data returns `core_services_versions` as a MAP of component →
   * {current, latest} — up to 16 `com.videri.*` packages per device, not the
   * single pair the spec's `VersionInfo` implies. Richer than the prototype's
   * one `fwVersion`: drift is trackable per component.
   */
  components: Record<string, { current: string | null; latest: string | null }>;
  /**
   * Build identity from `super_props`.
   *
   * KNOWN GAP: `super_props` is returned by the METRICS endpoint, not by
   * `/canvases` — so the device poller cannot populate these and they stay null.
   * The metrics poller has the data but does not write to the devices table.
   * Either have it upsert these two columns, or read them from the latest raw
   * payload. Left visible rather than silently always-null.
   */
  firmwareBuildId: string | null;
  firmwareIncrementalVersion: string | null;
  /** Kept for the summary views: the player package's versions. */
  firmwareCurrent: string | null;
  firmwareLatest: string | null;

  licenseStatus: string | null;
  licenseExpiration: string | null;

  firstActivated: string | null;
  lastOnlineTime: string | null;
  statusChangedTime: string | null;

  tags: string[];
  /** Tenant-defined metafields, flattened. Vocabulary is not guaranteed. */
  metafields: Record<string, string>;
  /** Extracted from metafields. The only fleet-wide location signal we have. */
  city: string | null;
}

/**
 * One telemetry observation for one device at one instant.
 *
 * The `documented` group is safe. The `inferred` group is everything we hope
 * lives inside `super_props` / `status` — every field is `Observed`, so the
 * product degrades field-by-field rather than failing whole.
 */
export interface HealthSample {
  deviceId: string;
  observedAt: Date;

  // ── Documented, typed, dependable ──
  presence: Observed<"online" | "offline">;
  isScreenOn: Observed<boolean>;
  isBlackScreen: Observed<boolean>;
  showingLogo: Observed<boolean>;
  downloading: Observed<boolean>;
  softwareUpdateStatus: Observed<string>;
  /** Undocumented scale — treat as ordinal, not a percentage. */
  /**
   * Quality signals are STRINGS on the live API, not numbers — observed values
   * include `"no"` and `"unavailable"`. Their vocabulary and meaning are
   * undocumented, so we carry them verbatim rather than inventing a scale.
   * No threshold rule may be built on them until the semantics are confirmed.
   */
  pingQuality: Observed<string>;
  playbackQuality: Observed<string>;
  /** From `status.current` — what the device is playing right now. */
  nowPlayingType: Observed<string>;
  nowPlayingId: Observed<string>;

  // ── Inferred from untyped maps. May all be unavailable. ──
  cpuPercent: Observed<number>;
  ramPercent: Observed<number>;
  temperatureC: Observed<number>;
  wifiSignalDbm: Observed<number>;
  packetLossPercent: Observed<number>;
  jitterMs: Observed<number>;
  ntpSyncPercent: Observed<number>;
  storagePercent: Observed<number>;
  uptimeSeconds: Observed<number>;
}

/** Daily network usage — the one genuine time series the platform exposes. */
export interface DataUsageDay {
  deviceId: string;
  date: string;
  rxBytes: number;
  txBytes: number;
}

/**
 * Our alert model. The platform knows two alert types and has no severity
 * field, so this is entirely ours — the detection engine is our product, not
 * an integration. See docs/02-VFI-GAP-ANALYSIS.md §3.
 */
export type Severity = "critical" | "high" | "medium" | "info";

export interface Alert {
  id: string;
  deviceId: string;
  /** Our rule id, not a Videri alertType. */
  ruleId: string;
  severity: Severity;
  title: string;
  /** Human-readable evidence. Also what the AI triage layer reads. */
  evidence: string;
  openedAt: Date;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  resolvedAt: Date | null;
  /** Set when this alert originated from Videri's `alerting` service. */
  videriAlertUuid: string | null;
}

/**
 * Alert rules live in src/alerting/rules.ts as a discriminated union — the four
 * rule kinds need genuinely different fields, and a single flat shape with
 * mostly-null columns made invalid combinations representable.
 */
export type { AlertRule } from "../alerting/rules.js";

/** Fleet-level rollup. Pre-computed, because computing it live means N calls. */
export interface FleetSnapshot {
  computedAt: Date;
  totalDevices: number;
  byStatus: Record<DeviceStatus, number>;
  byDeviceClass: Record<string, number>;
  /** Firmware distribution — derivable today with no platform changes. */
  firmwareDistribution: Array<{ version: string; count: number; isLatest: boolean }>;
  openAlertsBySeverity: Record<Severity, number>;
  /** Share of devices whose telemetry we could actually read, 0–1. */
  telemetryCoverage: number;
}
