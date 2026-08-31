/**
 * Data correlation engine — pure, no I/O (Epic 2, docs/19 US-2.1..2.4).
 *
 * Where the remediation engine (Epic 1) reasons about ONE device at a time,
 * this engine reasons across the fleet: it looks for the shape a single root
 * cause leaves behind — a venue-wide outage, a bad firmware build, a symptom
 * that always travels with resource exhaustion, a wave of devices dropping in
 * the same minute. Each pattern it is confident about becomes a typed `Finding`;
 * each pattern it cannot honestly assert (degenerate or missing data) becomes a
 * `Note` instead of a fabricated cluster.
 *
 * It shares the exact `DeviceView` assembly the remediation engine uses (one
 * query, one shape), and it keeps the same two invariants:
 *
 *   - Honest nulls. A field we never read is `null` and contributes nothing — it
 *     is never counted as a healthy zero or a failing one. A correlation drawn
 *     from telemetry only ever counts devices that actually answered.
 *
 *   - No fabrication from thin data. The `city`/location field on this tenant is
 *     degenerate placeholder data (~1-2 distinct values across the estate), so
 *     grouping by it would invent one giant meaningless "venue". We detect that
 *     and emit an honest note instead of a bogus cluster (mirrors the way the
 *     Insights cityModule flags NO DATA SOURCE).
 *
 * The whole engine is `correlate(devices)` — a pure `DeviceView[] → report`, so
 * every rule is unit-testable without a database or a clock. `now` is an
 * injectable parameter (defaulting to the wall clock) purely so the temporal
 * rule is deterministic under test.
 */

import type { DeviceView } from "./remediation.js";

export type Severity = "critical" | "high" | "medium" | "low";

/** One correlated pattern the engine is confident enough to assert. */
export interface Finding {
  /** Stable per correlation kind + key, so the UI can key and dedupe across polls. */
  id: string;
  kind: "venue" | "firmware-cohort" | "symptom-cooccurrence" | "temporal-cluster";
  severity: Severity;
  /** 0..1 — how sure we are these devices share one cause. */
  confidence: number;
  affectedDeviceIds: string[];
  summary: string;
  rationale: string;
}

/**
 * An honest "we could not correlate this" — degenerate or missing data. Kept
 * distinct from a Finding so the UI never renders absence-of-data as a signal.
 */
export interface Note {
  kind: "location-degenerate" | "location-absent" | "symptom-telemetry-absent";
  message: string;
}

export interface CorrelationReport {
  findings: Finding[];
  notes: Note[];
  /** How many devices were reasoned over, so an empty findings list reads as
   * "nothing correlated" rather than "we saw nothing". */
  devicesConsidered: number;
}

// ── thresholds ───────────────────────────────────────────────────────────────
// Named and centralised so the numbers an operator argues about live in one
// place, next to why they were chosen. All are deliberately conservative: this
// surface earns trust by NOT crying wolf.

/**
 * Location degeneracy (US-2.1 guard). This tenant's `city` is placeholder data,
 * so grouping by it finds one useless mega-venue. We refuse to cluster when the
 * location field is not discriminating enough to mean anything:
 *   - fewer than 3 distinct non-null values, OR
 *   - a single value covers more than 90% of the located devices.
 * Either way we emit a note, never a cluster.
 */
const MIN_DISTINCT_LOCATIONS = 3;
const LOCATION_TOP_SHARE_MAX = 0.9;

/**
 * Venue cluster (US-2.1). A real venue outage shows up as several co-located
 * devices failing at once; a single failure is a device problem, not a site
 * problem. Three is the smallest count that reads as "the site, not the device".
 */
const MIN_VENUE_CLUSTER = 3;

/**
 * Firmware cohort (US-2.2). We only compare a version against the fleet when its
 * cohort is big enough for a rate to mean anything (5 devices), and we only flag
 * it when its failing rate is materially — 20 percentage points — worse than the
 * fleet baseline. Both guards stop us blaming a build for what is really a tiny,
 * noisy sample.
 */
const MIN_FIRMWARE_COHORT = 5;
const FIRMWARE_WORSE_DELTA = 0.2;

/**
 * Symptom co-occurrence (US-2.3). A black screen that travels with a CPU or RAM
 * reading above 90% points at resource exhaustion, not content; a black screen
 * with healthy, readable telemetry points at content/player. Either pattern is
 * only a fleet "finding" when at least 2 devices show it — one device is the
 * remediation engine's job, not a correlation. Resource pressure is >90% to
 * match the remediation engine's RESOURCE_PRESSURE_PERCENT.
 */
const RESOURCE_PRESSURE_PERCENT = 90;
const MIN_SYMPTOM_COOCCURRENCE = 2;

/**
 * Temporal cluster (US-2.4). We only look at devices that went offline within
 * the last 6 hours (older is history, not an incident), and we call it a
 * "correlated drop" when at least 3 of them went dark inside the same 30-minute
 * window — the fingerprint of one upstream event (an AP, a switch, a power blip)
 * rather than independent failures.
 */
const RECENT_OFFLINE_WINDOW_MS = 6 * 60 * 60 * 1000;
const TEMPORAL_CLUSTER_WINDOW_MS = 30 * 60 * 1000;
const MIN_TEMPORAL_CLUSTER = 3;

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

// ── shared predicates ────────────────────────────────────────────────────────

/** Down = we cannot see or reach it. Distinct from 'alert', which is reachable. */
const isOffline = (d: DeviceView): boolean =>
  d.status === "offline" || d.status === "unknown";

/**
 * "Failing" for venue clustering: anything that is not healthy — down, in the
 * alert state, or showing a hard screen symptom (black / logo fallback). Null
 * screen flags never count as failing (honest null: unread is not broken).
 */
const isFailing = (d: DeviceView): boolean =>
  isOffline(d) ||
  d.status === "alert" ||
  d.screen.isBlackScreen === true ||
  d.screen.showingLogo === true;

const labelOf = (d: DeviceView): string => d.name ?? d.id;

/** A parsed lastOnlineTime in epoch ms, or null if absent/unparseable. */
const onlineAtMs = (d: DeviceView): number | null => {
  if (d.lastOnlineTime === null) return null;
  const t = Date.parse(d.lastOnlineTime);
  return Number.isNaN(t) ? null : t;
};

// ── the engine ───────────────────────────────────────────────────────────────

export function correlate(devices: DeviceView[], now: Date = new Date()): CorrelationReport {
  const findings: Finding[] = [];
  const notes: Note[] = [];

  correlateVenue(devices, findings, notes);
  correlateFirmwareCohort(devices, findings);
  correlateSymptomCooccurrence(devices, findings, notes);
  correlateTemporal(devices, now.getTime(), findings);

  // Ranked: severity first, then how many devices are implicated (a bigger blast
  // radius outranks a smaller one at equal severity), then a stable id tiebreak
  // so the order is deterministic across identical items and across polls.
  findings.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (b.affectedDeviceIds.length !== a.affectedDeviceIds.length) {
      return b.affectedDeviceIds.length - a.affectedDeviceIds.length;
    }
    return a.id.localeCompare(b.id);
  });

  return { findings, notes, devicesConsidered: devices.length };
}

// ── US-2.1 venue ─────────────────────────────────────────────────────────────

function correlateVenue(devices: DeviceView[], findings: Finding[], notes: Note[]): void {
  // Degeneracy is a property of the whole dataset, not just the failing subset —
  // judge it over every device's location.
  const counts = new Map<string, number>();
  for (const d of devices) {
    if (d.city === null || d.city.trim() === "") continue;
    counts.set(d.city, (counts.get(d.city) ?? 0) + 1);
  }

  const located = [...counts.values()].reduce((a, b) => a + b, 0);
  if (located === 0) {
    notes.push({
      kind: "location-absent",
      message:
        "No location data is set on any device, so venue-level correlation is not " +
        "possible. Devices carry no city/site, not an empty one.",
    });
    return;
  }

  const distinct = counts.size;
  const topShare = Math.max(...counts.values()) / located;
  if (distinct < MIN_DISTINCT_LOCATIONS || topShare > LOCATION_TOP_SHARE_MAX) {
    // The honest degenerate-location note — NOT a bogus one-giant-venue cluster.
    notes.push({
      kind: "location-degenerate",
      message:
        `Location data is too degenerate to correlate: ${distinct} distinct value(s) ` +
        `across ${located} located device(s), top value covering ` +
        `${Math.round(topShare * 100)}%. Grouping by it would invent one meaningless ` +
        `"venue", so no venue clusters are emitted. (Placeholder location data — see docs/14 A5.)`,
    });
    return;
  }

  // Non-degenerate: group the FAILING devices by location and emit a cluster
  // wherever enough co-located devices are failing at once.
  const failingByCity = new Map<string, DeviceView[]>();
  for (const d of devices) {
    if (d.city === null || d.city.trim() === "") continue;
    if (!isFailing(d)) continue;
    const bucket = failingByCity.get(d.city) ?? [];
    bucket.push(d);
    failingByCity.set(d.city, bucket);
  }

  for (const [city, group] of failingByCity) {
    if (group.length < MIN_VENUE_CLUSTER) continue;
    const n = group.length;
    // A whole site failing at once is more urgent the more of it is dark.
    const severity: Severity = n >= 10 ? "critical" : n >= 5 ? "high" : "medium";
    findings.push({
      id: `venue::${city}`,
      kind: "venue",
      severity,
      // Co-location plus simultaneous failure is a strong site-cause signal, but
      // not certain (a coincidence of independent device faults is possible), so
      // confidence rises with the count rather than sitting at 1.
      confidence: n >= 10 ? 0.85 : n >= 5 ? 0.75 : 0.65,
      affectedDeviceIds: group.map((d) => d.id),
      summary: `${n} devices at ${city} are offline or failing together.`,
      rationale:
        `${n} co-located devices (${group.map(labelOf).slice(0, 5).join(", ")}` +
        `${n > 5 ? ", …" : ""}) are failing at the same site. A site-level cause — ` +
        `power, network, or the local AP — explains a co-located cluster far better ` +
        `than that many independent device faults.`,
    });
  }
}

// ── US-2.2 firmware cohort ───────────────────────────────────────────────────

function correlateFirmwareCohort(devices: DeviceView[], findings: Finding[]): void {
  // Baseline and cohorts are both computed over devices with a KNOWN firmware —
  // an unknown-firmware device tells us nothing about a version and is excluded
  // from both sides, keeping the comparison apples-to-apples.
  const known = devices.filter((d) => d.firmwareCurrent !== null);
  if (known.length === 0) return;

  const fleetFailing = known.filter(isFailing).length;
  const baseline = fleetFailing / known.length;

  const cohorts = new Map<string, { total: number; failing: number; ids: string[] }>();
  for (const d of known) {
    const v = d.firmwareCurrent!;
    const c = cohorts.get(v) ?? { total: 0, failing: 0, ids: [] };
    c.total += 1;
    if (isFailing(d)) {
      c.failing += 1;
      c.ids.push(d.id);
    }
    cohorts.set(v, c);
  }

  for (const [version, c] of cohorts) {
    if (c.total < MIN_FIRMWARE_COHORT) continue;
    const rate = c.failing / c.total;
    const delta = rate - baseline;
    if (delta < FIRMWARE_WORSE_DELTA) continue;

    const pct = (x: number): string => `${Math.round(x * 100)}%`;
    // A version running very far above baseline is a stronger firmware signal.
    const severity: Severity = delta >= 0.4 ? "high" : "medium";
    findings.push({
      id: `firmware::${version}`,
      kind: "firmware-cohort",
      severity,
      // Rate comparisons are suggestive, not proof (the cohort could be skewed by
      // where those devices live), so confidence is moderate and grows with the delta.
      confidence: delta >= 0.4 ? 0.7 : 0.6,
      affectedDeviceIds: c.ids,
      summary:
        `Firmware ${version} is failing at ${pct(rate)} vs a ${pct(baseline)} fleet baseline.`,
      rationale:
        `${c.failing} of ${c.total} devices on ${version} are failing (${pct(rate)}), ` +
        `${Math.round(delta * 100)} points above the ${pct(baseline)} fleet baseline. ` +
        `A version running materially worse than the fleet points at the build, not the devices.`,
    });
  }
}

// ── US-2.3 symptom co-occurrence ─────────────────────────────────────────────

function correlateSymptomCooccurrence(
  devices: DeviceView[],
  findings: Finding[],
  notes: Note[],
): void {
  const blackScreen = devices.filter((d) => d.screen.isBlackScreen === true);
  if (blackScreen.length === 0) return;

  // Only devices whose telemetry actually answered can be split into
  // resource-linked vs content-linked — a null CPU/RAM reading cannot tell the
  // two apart, so such a device joins NEITHER bucket (honest null).
  const resourceLinked: DeviceView[] = [];
  const contentLinked: DeviceView[] = [];
  let withReadableTelemetry = 0;

  for (const d of blackScreen) {
    const t = d.telemetry;
    const cpu = t?.cpuPercent ?? null;
    const ram = t?.ramUsedPercent ?? null;
    if (cpu === null && ram === null) continue; // no readable resource metric
    withReadableTelemetry += 1;
    const underPressure =
      (cpu !== null && cpu > RESOURCE_PRESSURE_PERCENT) ||
      (ram !== null && ram > RESOURCE_PRESSURE_PERCENT);
    (underPressure ? resourceLinked : contentLinked).push(d);
  }

  if (withReadableTelemetry === 0) {
    // We have black screens but no readable telemetry to explain any of them —
    // say so rather than guessing a cause.
    notes.push({
      kind: "symptom-telemetry-absent",
      message:
        `${blackScreen.length} device(s) are black-screen, but none had a readable ` +
        `CPU/RAM reading, so resource-caused cannot be separated from content-caused. ` +
        `Coverage builds as the slow-lane poller reaches them.`,
    });
    return;
  }

  if (resourceLinked.length >= MIN_SYMPTOM_COOCCURRENCE) {
    const n = resourceLinked.length;
    findings.push({
      id: "symptom::black-screen+resource",
      kind: "symptom-cooccurrence",
      // Black screens that co-occur with genuine resource exhaustion are a strong,
      // actionable signal — the cause is on the device, not the playlist.
      severity: "high",
      confidence: 0.7,
      affectedDeviceIds: resourceLinked.map((d) => d.id),
      summary: `${n} black-screen devices are also over 90% CPU/RAM — resource-linked.`,
      rationale:
        `On ${n} devices a black screen co-occurs with CPU or RAM above ` +
        `${RESOURCE_PRESSURE_PERCENT}%. When the black-out travels with resource ` +
        `exhaustion the panel is likely a symptom of the device running out of ` +
        `headroom — distinct from a content/player fault.`,
    });
  }

  if (contentLinked.length >= MIN_SYMPTOM_COOCCURRENCE) {
    const n = contentLinked.length;
    findings.push({
      id: "symptom::black-screen+content",
      kind: "symptom-cooccurrence",
      // Healthy device, dark screen → points at content/player. Real but less
      // urgent than resource exhaustion, and never a device we can one-click.
      severity: "medium",
      confidence: 0.6,
      affectedDeviceIds: contentLinked.map((d) => d.id),
      summary: `${n} black-screen devices have healthy CPU/RAM — content-linked.`,
      rationale:
        `On ${n} devices a black screen co-occurs with healthy, readable telemetry ` +
        `(CPU and RAM at or below ${RESOURCE_PRESSURE_PERCENT}%). With the hardware ` +
        `fine, the black-out points at content or the player, not resources.`,
    });
  }
}

// ── US-2.4 temporal clustering ───────────────────────────────────────────────

function correlateTemporal(devices: DeviceView[], nowMs: number, findings: Finding[]): void {
  // Only recently-offline devices with a real lastOnlineTime — an old drop is
  // history, and a null timestamp cannot be placed on the timeline.
  const recent = devices
    .map((d) => ({ d, t: onlineAtMs(d) }))
    .filter(
      (x): x is { d: DeviceView; t: number } =>
        x.t !== null && isOffline(x.d) && nowMs - x.t <= RECENT_OFFLINE_WINDOW_MS,
    )
    .sort((a, b) => a.t - b.t);

  if (recent.length < MIN_TEMPORAL_CLUSTER) return;

  // Greedy non-overlapping windows: starting at the earliest unclustered drop,
  // take everything within TEMPORAL_CLUSTER_WINDOW_MS; if that many devices fall
  // in one window it is a correlated drop, and we skip past them so a single
  // event is reported once.
  let i = 0;
  let seq = 0;
  while (i < recent.length) {
    let j = i;
    while (j < recent.length && recent[j]!.t - recent[i]!.t <= TEMPORAL_CLUSTER_WINDOW_MS) {
      j += 1;
    }
    const group = recent.slice(i, j);
    if (group.length >= MIN_TEMPORAL_CLUSTER) {
      const n = group.length;
      const spanMin = Math.round((group[n - 1]!.t - group[0]!.t) / 60000);
      const startedAt = new Date(group[0]!.t).toISOString();
      // A wider wave is a bigger, more urgent incident.
      const severity: Severity = n >= 8 ? "critical" : n >= 5 ? "high" : "medium";
      findings.push({
        id: `temporal::${startedAt}::${seq}`,
        kind: "temporal-cluster",
        severity,
        // Tight co-timing is a strong shared-cause signal; a loose spread within
        // the window is weaker, so confidence eases off as the span widens.
        confidence: spanMin <= 5 ? 0.8 : 0.65,
        affectedDeviceIds: group.map((x) => x.d.id),
        summary: `${n} devices went offline within ${spanMin} min of each other.`,
        rationale:
          `${n} devices dropped offline inside a ${spanMin}-minute window starting ` +
          `${startedAt}. Simultaneous drops share a cause — an upstream network or ` +
          `power event — far more often than they fail independently at the same moment.`,
      });
      seq += 1;
      i = j;
    } else {
      i += 1;
    }
  }
}
