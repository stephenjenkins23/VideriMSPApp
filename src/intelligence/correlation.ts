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
 * VENUE DIMENSION (rewired 2026-08-31). Venue correlation clusters on `site` —
 * the depth-1 ancestor of the device's group in the `rpm /v1/groups` tree, which
 * gives ten real buckets (Videri Sales 78, Techops 56, Montreal Office 31, NYC
 * Office 31, …) over 234 of 250 devices. `city` remains only as the fallback
 * dimension when the group tree could not be read at all, because on this tenant
 * it is 99.6% "LONDON" and can never produce anything but the degenerate note.
 * Sites are resolved upstream (videri/services/group-hierarchy.ts) and arrive on
 * the DeviceView, so this engine stays pure.
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
  /**
   * `unverifiable-claim` is the odd one out: it is not a device pattern at all
   * but an observation about the PLATFORM'S DATA (see correlateUnverifiableClaims).
   * It is named for what is wrong — the claim cannot be checked — rather than for
   * our guess at why, because "latched" is our reading and "unverifiable" is a fact.
   */
  kind:
    | "venue"
    | "firmware-cohort"
    | "symptom-cooccurrence"
    | "temporal-cluster"
    | "unverifiable-claim";
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
  kind:
    | "location-degenerate"
    | "location-absent"
    | "site-degenerate"
    | "site-absent"
    | "symptom-telemetry-absent";
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
 * Dimension degeneracy (US-2.1 guard) — applied to whichever venue dimension we
 * use, site or city. This tenant's `city` is placeholder data, so grouping by it
 * finds one useless mega-venue; a tenant with a single top-level group would have
 * the same problem on `site`. We refuse to cluster when the dimension is not
 * discriminating enough to mean anything:
 *   - fewer than 3 distinct non-null values, OR
 *   - a single value covers more than 90% of the placed devices.
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
  correlateUnverifiableClaims(devices, now.getTime(), findings);

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

/**
 * Venue correlation, on the group-hierarchy SITE dimension.
 *
 * Site (the depth-1 group ancestor) is the primary dimension because it is the
 * only one on this tenant that actually discriminates. `city` is kept strictly as
 * a fallback for when the group tree is unavailable — no site on any device means
 * either the tenant genuinely has no groups or (far more likely) we could not read
 * `rpm /v1/groups`, and in both cases saying so beats silently emitting nothing.
 */
function correlateVenue(devices: DeviceView[], findings: Finding[], notes: Note[]): void {
  const sited = devices.filter((d) => d.site !== null);
  if (sited.length === 0) {
    notes.push({
      kind: "site-absent",
      message:
        "No device resolved to a site in the group hierarchy, so venue correlation " +
        "fell back to the city field. Either the group tree could not be read or no " +
        "device carries a group_id — this is an unknown, not a fleet without sites.",
    });
    correlateVenueByCity(devices, findings, notes);
    return;
  }

  // Degeneracy is a property of the whole dataset, not just the failing subset.
  const counts = new Map<string, { label: string; total: number }>();
  for (const d of sited) {
    const site = d.site!;
    const entry = counts.get(site.uuid) ?? { label: site.name ?? site.uuid, total: 0 };
    entry.total += 1;
    counts.set(site.uuid, entry);
  }

  const placed = [...counts.values()].reduce((a, b) => a + b.total, 0);
  const distinct = counts.size;
  const topShare = Math.max(...[...counts.values()].map((c) => c.total)) / placed;
  if (distinct < MIN_DISTINCT_LOCATIONS || topShare > LOCATION_TOP_SHARE_MAX) {
    // Same honest guard as the city path: a collapsed dimension yields a note.
    notes.push({
      kind: "site-degenerate",
      message:
        `The group hierarchy is too degenerate to correlate on: ${distinct} distinct ` +
        `site(s) across ${placed} placed device(s), the largest covering ` +
        `${Math.round(topShare * 100)}%. Clustering by it would invent one meaningless ` +
        `"venue", so no venue clusters are emitted.`,
    });
    return;
  }

  // Non-degenerate: group the FAILING devices by site and emit a cluster wherever
  // enough co-sited devices are failing at once.
  const failingBySite = new Map<string, DeviceView[]>();
  for (const d of sited) {
    if (!isFailing(d)) continue;
    const bucket = failingBySite.get(d.site!.uuid) ?? [];
    bucket.push(d);
    failingBySite.set(d.site!.uuid, bucket);
  }

  for (const [uuid, group] of failingBySite) {
    if (group.length < MIN_VENUE_CLUSTER) continue;
    const n = group.length;
    const label = counts.get(uuid)?.label ?? uuid;
    const siteTotal = counts.get(uuid)?.total ?? n;
    // A whole site failing at once is more urgent the more of it is dark.
    const severity: Severity = n >= 10 ? "critical" : n >= 5 ? "high" : "medium";
    findings.push({
      // Keyed by uuid, not name: the display name can be renamed or empty, the
      // uuid is the identity the hierarchy joins on.
      id: `venue::site::${uuid}`,
      kind: "venue",
      severity,
      // Co-location plus simultaneous failure is a strong site-cause signal, but
      // not certain (a coincidence of independent device faults is possible), so
      // confidence rises with the count rather than sitting at 1.
      confidence: n >= 10 ? 0.85 : n >= 5 ? 0.75 : 0.65,
      affectedDeviceIds: group.map((d) => d.id),
      summary: `${n} of ${siteTotal} devices at ${label} are offline or failing together.`,
      rationale:
        `${n} devices in the ${label} group tree (${group.map(labelOf).slice(0, 5).join(", ")}` +
        `${n > 5 ? ", …" : ""}) are failing at the same site, out of ${siteTotal} there. ` +
        `A site-level cause — power, network, or the local AP — explains a co-located ` +
        `cluster far better than that many independent device faults. Site is the ` +
        `depth-1 group ancestor, joined on group_id.`,
    });
  }
}

/**
 * The pre-rewire city path, kept ONLY as the fallback when no site resolved.
 *
 * On VIDERISALES this can only ever produce the degenerate note (CITY is 99.6%
 * "LONDON"), which is precisely why it is no longer the primary dimension. It
 * stays because a tenant that sets real cities and no groups would still get a
 * venue signal out of it.
 */
function correlateVenueByCity(devices: DeviceView[], findings: Finding[], notes: Note[]): void {
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
      // Namespaced by dimension so a city cluster and a site cluster can never
      // collide on one id in the UI's dedupe.
      id: `venue::city::${city}`,
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

// ── data quality: unverifiable black-screen claims ───────────────────────────

/**
 * ONE fleet-level observation about the platform's own data (added 2026-09-01).
 *
 * We now verify black-screen claims by asking the panel (intelligence/screen-verify.ts):
 * the platform says `is_black_screen=true`, we ask the device, and we refute the
 * claim if it disagrees. On this fleet that path has almost no surface — of the 9
 * devices flagged black, 8 were OFFLINE and only 1 could be asked. An unreachable
 * panel cannot be asked anything, so those 8 claims can be neither confirmed nor
 * refuted, and the alerting engine's presence short-circuit (offline supersedes
 * black-screen, alerting/rules.ts) means nobody ever sees them.
 *
 * The repeatable finding here is therefore NOT "the flag is wrong" — we have no
 * standing to say that. It is that the platform keeps asserting a LIVE screen
 * condition for panels nothing has reached in hours or days: the shape of a value
 * that was latched once and never re-derived. That is worth one line on the
 * Actions view, so:
 *
 *   - ONE finding, never N. An operator cannot act on Videri's flag; N per-device
 *     alerts would be pure noise and would read as N new dark screens. The device
 *     list rides along in `affectedDeviceIds` purely for drill-down.
 *
 *   - Never critical/high, and never phrased as breakage. These devices are ALREADY
 *     covered by their offline alerts; double-counting them as screen faults would
 *     inflate the fleet's fault count with devices we already page on.
 *
 *   - Never an assertion about the screens. We say the claim is uncheckable. We do
 *     not say the panels are black, and we do not say they are fine.
 *
 * REACHABILITY MAPPING — read this before "improving" it. `DeviceView.status` is
 * derived upstream from PRESENCE only: 'offline' when presence <> 'online' and
 * 'unknown' when presence IS NULL. So `status === "offline" || status === "unknown"`
 * (the shared `isOffline` predicate) faithfully means "we cannot reach this device".
 * It is NOT the derived-status trap we hit twice — that trap is reading a *health*
 * status ('alert'/'warning') as if it implied a specific fault; 'alert' devices are
 * reachable and are deliberately excluded here, because a reachable claim IS
 * verifiable and screen-verify.ts owns it.
 *
 * GAP (deliberate): the second unverifiable cause is the `unanswered` verdict — the
 * panel was reachable, we asked, and it stayed silent. That verdict lives in the
 * screen-verdict store and is NOT on `DeviceView`, and expanding this engine's
 * input contract to carry it would couple the pure fleet reasoner to the verify
 * pipeline for one extra sentence. Left out on purpose: this finding covers the
 * unreachable cause only, and says so in its rationale.
 */
function correlateUnverifiableClaims(
  devices: DeviceView[],
  nowMs: number,
  findings: Finding[],
): void {
  // The claim must be an explicit `true`: a null flag is unread, not a claim
  // (honest null), and generates nothing.
  const claims = devices.filter((d) => d.screen.isBlackScreen === true && isOffline(d));
  if (claims.length === 0) return; // degeneracy discipline: no set, no zero-count finding

  const n = claims.length;

  // How stale the asserted "live" condition is, from presence alone. A device with
  // no lastOnlineTime is counted separately rather than folded in as a zero.
  const ages = claims
    .map(onlineAtMs)
    .filter((t): t is number => t !== null)
    .map((t) => nowMs - t);
  const undated = n - ages.length;
  const window =
    ages.length === 0
      ? `none of them carries a last-seen timestamp, so how long the claim has gone unchecked is unknown`
      : `unreached for ${describeSpan(Math.min(...ages))} to ${describeSpan(Math.max(...ages))}` +
        `${undated > 0 ? ` (${undated} with no last-seen timestamp at all)` : ""}`;

  findings.push({
    // Single stable id: this is one standing observation about the data, so it
    // dedupes across polls even as the affected set changes.
    id: "data-quality::unverifiable-black-screen::unreachable",
    kind: "unverifiable-claim",
    // MEDIUM, deliberately — not critical, not high. It is a data-quality defect,
    // not a device fault, so it must never outrank a real outage in the ranked
    // list; but `low` is where things go to be ignored, and a platform flag that
    // cannot be trusted is worth an operator's attention once. There is no `info`
    // rung in `Severity` (and adding one would leave the UI's severity colour map
    // undefined for it), so medium is both the honest and the safe rung.
    severity: "medium",
    // The unverifiability itself is directly observed from two fields, not inferred
    // across devices — hence high. Not 1.0 because "latched rather than re-derived"
    // is our interpretation of the cause, and we cannot see inside the platform.
    confidence: 0.9,
    affectedDeviceIds: claims.map((d) => d.id),
    summary:
      `Data quality: the platform claims a black screen on ${n} device(s) it cannot reach — ` +
      `${n} unverifiable claim(s), not ${n} dark screens.`,
    rationale:
      `Videri's is_black_screen flag is true for ${n} device(s) that presence says we cannot ` +
      `reach (${claims.map(labelOf).slice(0, 5).join(", ")}${n > 5 ? ", …" : ""}). A panel that ` +
      `does not answer cannot be asked what it is showing, so each of these claims is ` +
      `UNVERIFIABLE — we can neither confirm nor refute it. Nothing here says those screens ` +
      `are black, and nothing here says they are fine; both are unknown. This is a defect in ` +
      `the claim, not ${n} new faults: every one of these devices is already covered by its own ` +
      `offline alert (which supersedes black-screen), so it must not be counted again as screen ` +
      `breakage. What is worth acting on is the data itself — a live screen condition is still ` +
      `being asserted for panels nothing has reached, which is the shape of a latched value ` +
      `rather than one re-derived at read time. Window: the current correlation snapshot, ` +
      `${window}. Claims on REACHABLE devices are excluded — those we do check, one by one ` +
      `(screen-verify.ts) — as is the silent-panel ('unanswered') case, which this engine does ` +
      `not receive.`,
  });
}

/**
 * A coarse, human span for the rationale. Deliberately local and tiny: the
 * correlation engine stays a self-contained pure module rather than importing the
 * alerting layer's formatter just to print two numbers.
 */
function describeSpan(ms: number): string {
  const hours = Math.max(0, ms) / 3_600_000;
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} h`;
  return `${Math.round(hours / 24)} days`;
}
