/**
 * The incident model — pure, no I/O (Epic 8.8).
 *
 * WHY IT EXISTS. 1,235 alert transitions in 9.8 days on a 251-device estate. An
 * operator cannot work a queue that re-raises the same real-world condition, and
 * calling those transitions 1,235 problems overstates the estate's condition by a
 * wide margin. This module collapses the transitions into INCIDENTS: one row per
 * (scope, rule) with an occurrence count, a device roster, and a flap
 * classification.
 *
 * ⚠️ THE OBVIOUS KEY IS THE WRONG KEY, and the corpus is what says so. Keying on
 * (device, rule) — the epic's first sketch — gives 631 rows from 1,235: it
 * recovers 49% and misses the dominant structure entirely. Measured on the local
 * `vfi` DB (2026-09-16, all 1,235 rows):
 *
 *   raw transitions                      1,235
 *   re-open within 6h ⇒ same incident    1,028   (16.8% — worthless alone)
 *   (device, rule)                         631   (49%)
 *   (group, rule, 30-min bucket)           624   (bucketing adds ~nothing)
 *   (group, rule) — what this module does  207   (83%)
 *
 * And the reason: **54.6% of the queue is CO-FIRING.** 640 of the 1,172 rows on
 * grouped devices fall inside 131 windows where ≥3 devices in the same group
 * fired the same rule within 30 minutes. More than half the queue is not 640
 * independent problems; it is 131 site-level events. Time bucketing fails
 * because the dominant re-open gap is 6–24h (303 re-opens against 90 under an
 * hour): the same site condition recurs on DIFFERENT DAYS, so any "same incident
 * within N hours" window closes and re-opens with every recurrence. What is
 * needed is a persistent identity with an occurrence count, which is what an
 * incident is here.
 *
 * SINGLE-DEVICE INCIDENTS ARE THE DEGENERATE CASE — a roster of one, not a
 * second type. Exactly one device in the fleet has the flapping profile the
 * original design was written from (`Center Spark 5` / `black-screen`: 81 rows,
 * opens in all 24 hours of the day, mean time-open 18.3 min), and it comes out of
 * this model as one incident with a roster of one and an `oscillating` flap
 * classification.
 *
 * INVARIANTS, each of which has broken in this codebase before:
 *
 *   - **No transition is ever lost.** Collapsing is a VIEW over the append-only
 *     `alerts` rows. Every transition handed in lands in exactly one incident AND
 *     in exactly one of that incident's occurrence windows, so the whole history
 *     is reachable from the row that replaced it. `reconciliation` states that as
 *     a number the caller can assert on — an incident that hid an occurrence
 *     would be worse than the noisy queue it replaces.
 *
 *   - **Count the thing you filter.** Every count on an incident is computed from
 *     the transitions that incident actually holds, and those are the transitions
 *     the caller handed in after filtering. Nothing here re-derives a population.
 *
 *   - **Honest nulls, and honest AXIS LABELS.** A mean time-open with nothing
 *     resolved to average is `null` plus the reason, never 0. A transition whose
 *     device sits in no group cannot be attributed to a site or a group, so it
 *     becomes its own single-device incident labelled `unattributed` with the
 *     reason — never dropped, and never silently folded into a neighbour. And the
 *     scope on every incident says which axis it ACTUALLY grouped by: presenting
 *     leaf-group grouping as site grouping is exactly the misrepresentation
 *     docs/14 exists to prevent.
 *
 * RELATIONSHIP TO `correlation.ts`. That engine answers a different question —
 * "which devices are failing RIGHT NOW, clustered by site" — over `DeviceView`s
 * of present state, with no access to alert history; it cannot key a persistent
 * incident over 1,235 historical rows. What is shared, deliberately, is
 * everything that would otherwise drift: the SAME site dimension (resolved
 * upstream by `videri/services/group-hierarchy.resolveSite` via
 * `api/queries.deviceSite`, and arriving here already resolved so this module
 * stays pure — the same discipline as `DeviceView.site`), the SAME 30-minute
 * window (its `TEMPORAL_CLUSTER_WINDOW_MS`) and the SAME 3-device floor for "the
 * site, not the device" (its `MIN_VENUE_CLUSTER` / `MIN_TEMPORAL_CLUSTER`). The
 * route additionally cross-links live correlation findings onto the incidents
 * whose rosters they touch, so the two surfaces can never describe the same site
 * differently.
 *
 * ⚠️ CO-FIRING IS A CLAIM ABOUT THE ESTATE, SO IT NEEDS PROVENANCE (BUG-10).
 * When our collector comes back from an outage, the alerting lane reads presence
 * for the whole fleet in one pass and opens an alert for every device that is
 * ALREADY down. Every one of those rows gets an `opened_at` inside the same
 * second — the instant WE NOTICED, not the instant anything failed — and the
 * co-firing rule then reads that burst as one correlated site condition.
 * Measured on this corpus: 19 `offline-4h` criticals opened within two seconds
 * of the 2026-08-26 14:06:57 resume from a 23.6 h outage, of which `Montreal
 * Office` (6 devices) and `Wes' Office` (3) cleared the threshold and were
 * presented as site events. An operator reading "Montreal Office — 6 devices
 * offline together" dispatches someone to Montreal; the truth is "our collector
 * came back and found 6 devices already down, separately, at unknown times".
 *
 * The alerts are NOT false — those devices were genuinely offline — so nothing is
 * dropped or hidden. Only the CO-FIRING claim is withdrawn: a window's co-firing
 * test is made on the devices whose opens can date a FAILURE, i.e. those that did
 * not land in the first evaluation pass after a collector resume
 * (`collectorResumes`, from `alerting/pipeline-health.correlateOutages` and the
 * observation timeline). A window that loses the claim is reported as
 * `noticedTogether` with the resume that explains it, and its transitions stay
 * in the window, on the roster and in the drilldown.
 *
 * This is deliberately a PROVENANCE test and not a timing one. Widening the
 * 3-device / 30-minute threshold would not help — 101 of 130 correlated outage
 * windows have only two member lanes, and the threshold is what the Leedy
 * example needs — and suppressing every window that merely OVERLAPS a resume
 * would trade this false positive for a false negative: a site that genuinely
 * goes dark ten minutes after a resume opens its alerts ten minutes after the
 * resume, outside the first pass, and is still reported. The question asked is
 * "could this open time date a failure", never "is this open time near a resume".
 */

import type { Severity } from "../domain/types.js";

/**
 * How wide a co-firing window is, and how many devices make one.
 *
 * 30 minutes and 3 devices are `correlation.ts`'s numbers, on purpose: that
 * engine already calls 3 co-sited devices inside 30 minutes one upstream event
 * rather than independent faults, and two different definitions of "together" in
 * one product would just be a bug waiting. The measurement that produced the
 * 54.6% / 131-event finding used these same two values.
 *
 * FIXED half-hour buckets, not a greedy scan from each transition. Two reasons:
 * the published measurement is bucketed (so this module reproduces it exactly
 * rather than approximately), and a bucket is re-derivable by anyone with SQL and
 * the table — a greedy clustering depends on scan order and cannot be checked by
 * hand. The known cost is boundary-splitting: two devices firing a minute apart
 * across a bucket edge land in different windows, so `coFiring` is a LOWER bound
 * on co-firing and `total` an upper bound on distinct recurrences. Stated in the
 * payload rather than hidden.
 */
export const OCCURRENCE_WINDOW_MS = 30 * 60 * 1000;
export const MIN_CO_FIRING_DEVICES = 3;

/**
 * How long after a collector resume an alert can still be the FIRST PASS's work.
 *
 * One `alerting` lane interval — 420 s of `metrics` plus the 30 s offset the
 * registry declares — because that lane is what opens, refreshes and resolves
 * every alert: whatever it finds on its first run back gets that run's clock,
 * and a second run cannot have happened yet. Held here as a default so the pure
 * module needs no registry import; the route passes the registry's own number so
 * it follows `POLL_METRICS_INTERVAL_MS` instead of drifting from it.
 *
 * Deliberately NOT wider. A site that genuinely fails after the first pass back
 * opens its alerts after the first pass back, and must still be reported.
 */
export const RESUME_FIRST_PASS_SECONDS = 450;

/**
 * Tolerance for opens that land just BEFORE the resume instant we hold.
 *
 * A resume is stamped by whichever lane we can observe first, and the lane that
 * writes the alert is not always that lane: at the 14:06:57 resume the alerting
 * lane wrote its rows 244 ms before `fleet_snapshots` recorded the cycle. 120 s
 * is `PIPELINE_HEALTH_DEFAULTS.outageClusterSeconds`, the measured spread within
 * which the lanes of one daemon stop and restart, so it is the same tolerance
 * the outage correlation itself is built on. It cannot admit a genuine event
 * either: the seconds before a resume are, by definition, seconds we were blind.
 */
export const RESUME_CLOCK_SKEW_SECONDS = 120;

/**
 * How blind is blind enough to withdraw a correlation claim.
 *
 * A resume only destroys the evidence if the alert-opening lane unambiguously
 * MISSED passes across it; three of its intervals is the same bar
 * `PIPELINE_HEALTH_DEFAULTS.outageSilenceMultiplier` sets before it will call a
 * lane silent at all, and using a different one here would mean two definitions
 * of silence in one product.
 *
 * MEASURED, and the Leedy example is why. Its first co-firing occurrence
 * (2026-08-27 21:46:05, five `Leedy_Home_Spark*` screens on
 * `screen-off-during-schedule`) lands 0.1 s after a correlated outage of
 * `snapshot` and `status` that had lasted 1,064 s — under three alerting
 * intervals, and not including the `alerting` or `metrics` lanes that produce
 * this rule at all. Treating that as blindness withdrew a REAL site condition
 * and took the epic's headline example from 14 co-firing occurrences to 13. A
 * short hole in other lanes does not stop an open time dating a failure.
 */
export const RESUME_MIN_BLIND_PASSES = 3;

/**
 * One moment we regained sight of the estate.
 *
 * Supplied by the caller (`api/routes/incidents.ts`) so this module stays pure.
 * `source` matters more than it looks: a correlated outage is positive evidence
 * of a bounded blind window, while the start of the observation history is the
 * absence of evidence — unbounded blindness — and `blindSeconds` is then null
 * WITH a reason rather than a fabricated 0.
 */
export interface CollectorResume {
  /** When collection resumed — `PipelineOutage.endedAt`, or the timeline start. */
  resumedAt: string;
  /**
   * How long we were blind before it. Null when that cannot be known, and
   * `blindReason` then says why — never 0, which would read as "no outage".
   */
  blindSeconds: number | null;
  blindReason: string | null;
  /** Lanes that stopped and came back together. Empty when not lane-attributed. */
  lanes: string[];
  /**
   * `correlated-outage` — ≥2 lanes silent together then back (`correlateOutages`).
   * `observation-gap`   — the whole observation timeline went quiet; the only
   *                       evidence available in an era where a single lane was
   *                       observable, which correlation cannot see.
   * `observation-start` — the earliest observation we hold. Nothing before it is
   *                       known at all.
   */
  source: "correlated-outage" | "observation-gap" | "observation-start";
}

/**
 * What our own collector's blindness does to this window's open times.
 *
 * Attached to ANY window that contains first-pass transitions: one that lost
 * its co-firing claim, one that KEPT it on the strength of its other devices
 * (an operator deciding whether to dispatch needs to see that part of the burst
 * is our own blindness even when the rest is real), and one that never reached
 * `MIN_CO_FIRING_DEVICES` and so never made a claim at all — the open times of
 * a one-device window still date our noticing, which is worth saying, and is
 * not a withdrawal (BUG-12).
 */
export interface OccurrenceProvenance {
  /** The resume whose first evaluation pass these opens landed in. */
  resumedAt: string;
  source: CollectorResume["source"];
  blindSeconds: number | null;
  blindReason: string | null;
  lanes: string[];
  firstPassSeconds: number;
  /** Transitions in this window opened by that first pass. */
  transitions: number;
  /** Devices whose ONLY opens in this window came from that first pass. */
  devices: number;
  /** Plain words: what was noticed, and what cannot be concluded from it. */
  note: string;
}

/**
 * Flap classification (the `Center Spark 5` behaviour).
 *
 * A condition that clears in under an hour and comes back at least twice a day is
 * oscillation — a sensor or a player flapping — and dispatching a technician to
 * it is wasted. A condition that stays open for hours is sustained, however often
 * it recurs: the Leedy site incident recurs 9.5 times a day and holds open a mean
 * of 248 minutes, and that is an outage pattern, not a flap.
 *
 * Both tests must pass, and there must be enough transitions for a rate to mean
 * anything (3 — the same floor `correlation.ts` uses before it will assert a
 * pattern at all). Below that, or with nothing resolved to measure an open
 * duration from, the answer is `indeterminate` WITH a reason — never a default
 * guess of "sustained", which reads as a conclusion.
 */
export const OSCILLATION_MEAN_OPEN_MAX_MINUTES = 60;
export const OSCILLATION_MIN_OPENS_PER_DAY = 2;
export const MIN_TRANSITIONS_FOR_FLAP = 3;

/**
 * The shortest observed span that can carry a daily rate.
 *
 * 81 opens over 8 days is 10/day and means something. Three opens over four
 * minutes is 1,080/day and means nothing but "we watched for four minutes", so
 * the rate is null with the span stated instead of an arithmetically-true number
 * that would misinform.
 */
const MIN_SPAN_FOR_RATE_MS = 60 * 60 * 1000;

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, info: 3 };
const RANKED_SEVERITIES: Severity[] = ["critical", "high", "medium", "info"];

// ── input ───────────────────────────────────────────────────────────────────

/**
 * The site projection, structurally as `api/queries.deviceSite()` returns it.
 *
 * Declared here rather than imported so this module keeps ZERO dependencies on
 * the API layer and stays trivially unit-testable; `DeviceSite` is assignable to
 * it. The invariant it carries is relied on below: whenever `name` is null there
 * IS a `reason`, so an incident always has something true to print.
 */
export interface ResolvedSite {
  id: string | null;
  name: string | null;
  resolved: boolean;
  reason: string | null;
}

/** One append-only `alerts` row, as the incident view reads it. */
export interface AlertTransition {
  /** `alerts.id`. The transition's identity, and how it stays reachable. */
  id: string;
  deviceId: string;
  deviceName: string | null;
  /** `devices.group_id` — the join key into the group tree. NEVER group_name. */
  groupId: string | null;
  /** Display text only. Device 1000015 has a populated id and an EMPTY name. */
  groupName: string | null;
  ruleId: string;
  severity: Severity;
  title: string;
  openedAt: string;
  lastFiredAt: string;
  resolvedAt: string | null;
  acknowledgedAt: string | null;
  /**
   * The device's site, resolved UPSTREAM (`api/queries.deviceSite`, which walks
   * `group-hierarchy.resolveSite`). Pre-resolved for the same reason
   * `DeviceView.site` is: the tree comes from `rpm /v1/groups` over the network,
   * and this module must not do I/O. `resolved: false` plus a reason is the
   * honest "there is no site here", and this module then falls back rather than
   * inventing one.
   */
  site: ResolvedSite;
}

// ── output ──────────────────────────────────────────────────────────────────

/**
 * Which axis an incident was ACTUALLY grouped on.
 *
 * `site`   — the depth-1 group ancestor. What the product shows, and the axis
 *            the design wants.
 * `group`  — the device's LEAF group. The fallback when the group tree could not
 *            be read (no tenant credential ⇒ no `rpm /v1/groups`). There are 94
 *            groups against 10 depth-1 sites on this tenant, so this axis
 *            UNDER-collapses: an incident count taken on it is an upper bound.
 * `device` — one device, because the transition could not be attributed to either
 *            of the above. Reported as unattributed, never dropped.
 */
export type IncidentAxis = "site" | "group" | "device";

export interface IncidentScope {
  axis: IncidentAxis;
  /** Site uuid, leaf group id, or device id, per `axis`. */
  id: string;
  /** What to print. Null only when the platform supplies no name. */
  label: string | null;
  /**
   * True only when `axis === "site"` — i.e. we grouped on the axis the design
   * asks for. False says "this is a fallback", and `reason` says which and why.
   */
  siteResolved: boolean;
  /** Why this is not a site scope, or why the label is missing. */
  reason: string | null;
}

export interface IncidentRosterEntry {
  deviceId: string;
  deviceName: string | null;
  /** This device's share of the incident's transitions. Never a fabricated 0. */
  transitionCount: number;
  openTransitions: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** One 30-minute window in which this incident fired. */
export interface IncidentOccurrence {
  windowStart: string;
  windowEnd: string;
  deviceCount: number;
  deviceIds: string[];
  /** Every `alerts.id` in this window. The windows PARTITION the incident. */
  transitionIds: string[];
  /**
   * ≥ MIN_CO_FIRING_DEVICES devices whose opens can date a FAILURE ⇒ the site
   * fired, not a device. Equal to `deviceCount >= MIN_CO_FIRING_DEVICES` unless
   * provenance withdrew the claim — see `failedTogetherDeviceCount`.
   */
  coFiring: boolean;
  /**
   * Devices in this window with at least one open OUTSIDE the first pass after a
   * collector resume — the devices the co-firing test is actually made on.
   * Equals `deviceCount` when no resume touched this window, and when provenance
   * was not checked at all.
   */
  failedTogetherDeviceCount: number;
  /** Transitions here opened by the first pass after a resume. 0 when none. */
  noticedTogetherTransitions: number;
  /**
   * True when ≥ MIN_CO_FIRING_DEVICES devices fired but the co-firing claim was
   * WITHDRAWN: they were noticed together, not shown to have failed together.
   * The transitions are untouched — they are still listed here, on the roster
   * and in the drilldown.
   */
  noticedTogether: boolean;
  /** The resume that explains the burst, or null when none touched this window. */
  provenance: OccurrenceProvenance | null;
}

export interface IncidentOccurrences {
  /**
   * Every window in which this incident fired — the honest "how many times did
   * this recur".
   */
  total: number;
  /**
   * Windows carrying the site signature (≥3 devices together). This is the figure
   * the epic quotes as the Leedy incident's "14 occurrences"; `total` there is 21.
   * Both are published because reporting only the co-firing count would hide 7
   * real recurrences, and reporting only the total would lose the finding.
   */
  coFiring: number;
  /**
   * Windows where ≥3 devices fired but the co-firing claim was withdrawn because
   * the burst is the first pass after a collector resume — noticed together, not
   * failed together (BUG-10). Published separately rather than folded into
   * `isolated`, because "fewer than 3 devices fired" and "3 or more fired and we
   * cannot date any of them" are different facts.
   */
  noticedTogether: number;
  /** `total - coFiring - noticedTogether`. Windows where fewer than 3 devices fired. */
  isolated: number;
  /**
   * Transitions inside co-firing windows, inside withdrawn ones, and outside
   * both. The three sum to `transitionCount` — no transition changes bucket
   * without leaving the one it came from.
   */
  transitionsCoFiring: number;
  transitionsNoticedTogether: number;
  transitionsIsolated: number;
  windowMinutes: number;
  minCoFiringDevices: number;
  /** Says exactly what was counted, so no reader has to infer it. */
  basis: string;
  windows: IncidentOccurrence[];
}

export type FlapClassification = "oscillating" | "sustained" | "indeterminate";

export interface IncidentFlap {
  classification: FlapClassification;
  /**
   * Mean minutes from open to resolve, over RESOLVED transitions only. Null when
   * none resolved — an open transition has no duration yet, and measuring it
   * against `now` would report a still-running condition as a finished one.
   */
  meanOpenMinutes: number | null;
  resolvedTransitions: number;
  openTransitions: number;
  /**
   * Opens per day over the observed span. Null when the span is too short to
   * carry a rate at all.
   *
   * The denominator is `firstSeenAt` → `lastSeenAt`, i.e. first open to last
   * EVIDENCE (`last_fired_at`), which for a still-open transition can be well
   * after its open. That deliberately makes the rate CONSERVATIVE: a longer
   * denominator can only understate how often the condition recurs, and the
   * direction of that error is the safe one — it can never invent a flap that
   * is not there, which would send a technician to the wrong kind of work.
   */
  opensPerDay: number | null;
  observedSpanHours: number | null;
  /**
   * How many of the 24 hours of the day this incident has opened in. 24 is the
   * fingerprint of a device oscillating against no schedule at all; a handful is
   * the fingerprint of a scheduled condition.
   */
  distinctHoursOfDay: number;
  /** Always populated. States the basis of the classification, or why there is none. */
  reason: string;
}

export interface Incident {
  /** Deterministic across polls: same scope + rule ⇒ same id. */
  id: string;
  scope: IncidentScope;
  ruleId: string;
  /** The most recent transition's title — what the condition is called today. */
  title: string;
  /** The worst severity observed across the incident's transitions. */
  severity: Severity;
  severityCounts: Record<Severity, number>;
  /** Open if ANY transition is still unresolved. */
  state: "open" | "resolved";
  transitionCount: number;
  openTransitions: number;
  resolvedTransitions: number;
  acknowledgedTransitions: number;
  firstSeenAt: string;
  lastSeenAt: string;
  deviceCount: number;
  roster: IncidentRosterEntry[];
  occurrences: IncidentOccurrences;
  flap: IncidentFlap;
  /**
   * The exact filter that lists this incident's underlying rows on
   * `/api/alerts`, so a technician can expand to the transitions without having
   * to reproduce the grouping rule. Learned from the dormant band: a client that
   * re-derived a band from device ids got it wrong.
   */
  drilldown: { ruleId: string; deviceIds: string[] };
}

export interface IncidentGrouping {
  /** The axis MOST of the incidents were grouped on. Per-incident truth is on `scope`. */
  axis: IncidentAxis;
  /** Human label for `axis`, for a UI that must not mislabel its own column. */
  axisLabel: string;
  incidentsByAxis: Record<IncidentAxis, number>;
  transitionsByAxis: Record<IncidentAxis, number>;
  /** Did ANY transition resolve to a real depth-1 site? */
  siteAxisAvailable: boolean;
  /** Why the axis is what it is, and what it does to the numbers. */
  reason: string;
}

export interface IncidentQueue {
  incidents: Incident[];
  grouping: IncidentGrouping;
  totals: {
    incidents: number;
    transitions: number;
    openIncidents: number;
    openTransitions: number;
    /** Transitions that could not be attributed to a site or group. */
    unattributedTransitions: number;
    /** 1 - incidents/transitions, as a percentage. 0 when there is nothing to collapse. */
    collapsePercent: number | null;
    coFiringEvents: number;
    coFiringTransitions: number;
    /** Co-firing share of EVERY transition in this queue. Null when empty. */
    coFiringSharePercent: number | null;
    /**
     * Co-firing share of the ATTRIBUTED transitions only — those on a device we
     * could place in a group or at a site. This is the denominator the epic's
     * 54.6% finding uses (640 of 1,172), and it is published separately because
     * an unattributed transition can never be co-firing: counting it in the
     * denominator understates the share among rows that could have co-fired.
     */
    coFiringShareOfAttributedPercent: number | null;
    /**
     * Windows (and their transitions) that carried the ≥3-device signature and
     * had the co-firing claim withdrawn on provenance. They are NOT in
     * `coFiringEvents`; they are still in `transitions`.
     */
    noticedTogetherEvents: number;
    noticedTogetherTransitions: number;
  };
  /**
   * Whether the co-firing claims on this page were provenance-checked at all.
   *
   * `checked: false` is an honest "we did not look", not a clean bill of health:
   * without the collector's own outage history every ≥3-device window is
   * presented on its device count alone, which is how BUG-10 shipped.
   */
  provenance: {
    checked: boolean;
    /** Why it could not be checked, or null when it was. */
    reason: string | null;
    resumes: number;
    firstPassSeconds: number;
    suppressedEvents: number;
    suppressedTransitions: number;
    note: string;
  };
  /**
   * The no-lost-transition proof, as numbers a caller can assert on.
   * `balanced` is false only if this module has a bug; the field exists so that
   * bug is visible in the response instead of silently deleting an occurrence.
   */
  reconciliation: {
    transitionsIn: number;
    transitionsInIncidents: number;
    transitionsInOccurrenceWindows: number;
    distinctTransitionIds: number;
    balanced: boolean;
    note: string;
  };
}

export interface BuildIncidentsOptions {
  /**
   * Why the group tree is missing or partial, when it is — passed straight
   * through from the hierarchy read so the grouping axis explains itself with the
   * same sentence the rest of the API uses.
   */
  hierarchyReason?: string | null;
  /**
   * Moments the collector regained sight, so a burst of opens that is really our
   * own resume cannot be presented as a correlated site condition (BUG-10).
   *
   * Undefined or null means NOT CHECKED — the queue then behaves exactly as it
   * did before this option existed and says so in `provenance.checked`, because
   * silently treating "no resumes supplied" as "no resumes happened" is the same
   * fabrication the honest-nulls rule exists to stop.
   */
  collectorResumes?: readonly CollectorResume[] | null;
  /** One lane interval. Defaults to `RESUME_FIRST_PASS_SECONDS`. */
  resumeFirstPassSeconds?: number;
  /** Why no resumes were supplied, when they could not be read. */
  resumeReason?: string | null;
}

// ── scope resolution (pure) ─────────────────────────────────────────────────

/**
 * The axis this transition can honestly be grouped on, best first.
 *
 * site → leaf group → the device alone. Each fallback carries WHY it fell back,
 * because "no site" has four distinguishable causes (no credential, no group on
 * the device, a group absent from the tree we read, a group that IS the root) and
 * a technician acts differently on each. Collapsing them into one blank cell is
 * the failure the site projection exists to fix.
 */
export function scopeFor(transition: {
  deviceId: string;
  deviceName: string | null;
  groupId: string | null;
  groupName: string | null;
  site: ResolvedSite;
}): IncidentScope {
  const { site } = transition;
  if (site.resolved && site.id) {
    return {
      axis: "site",
      id: site.id,
      label: site.name,
      siteResolved: true,
      // A resolved site CAN be nameless; the projection's reason says so.
      reason: site.reason,
    };
  }
  const groupId = transition.groupId?.trim();
  if (groupId) {
    const groupName = transition.groupName?.trim();
    return {
      axis: "group",
      id: groupId,
      label: groupName ? groupName : null,
      siteResolved: false,
      reason:
        `Grouped by the device's LEAF group${groupName ? ` ("${groupName}")` : ""}, not by ` +
        `site: ${site.reason ?? "no site could be resolved for this device."} Leaf groups are ` +
        `finer than sites, so this incident may be one of several that a site-level view ` +
        `would show as one.`,
    };
  }
  return {
    axis: "device",
    id: transition.deviceId,
    label: transition.deviceName,
    siteResolved: false,
    reason:
      `Unattributed: this device is in no group, so its alerts cannot be placed at a site ` +
      `or a group. It is reported as a single-device incident rather than dropped or ` +
      `folded into another site's roster.`,
  };
}

/**
 * The incident identity for one transition — deterministic, and the SAME
 * function the queue keys on.
 *
 * Exported because a caller that wants "the transitions behind these incidents"
 * must be able to ask that question with this module's own answer rather than
 * reproducing the rule. The dormant band's lesson: a client that re-derived a
 * grouping got it wrong, and the divergence was silent.
 */
export function incidentIdFor(transition: {
  deviceId: string;
  deviceName: string | null;
  groupId: string | null;
  groupName: string | null;
  ruleId: string;
  site: ResolvedSite;
}): string {
  const scope = scopeFor(transition);
  return `incident::${scope.axis}:${scope.id}::${transition.ruleId}`;
}

// ── the engine ──────────────────────────────────────────────────────────────

const ms = (iso: string): number => new Date(iso).getTime();
const iso = (at: number): string => new Date(at).toISOString();

/** Window index for a transition's OPEN time. Fixed buckets — see the constant. */
const windowIndexOf = (openedAtMs: number): number =>
  Math.floor(openedAtMs / OCCURRENCE_WINDOW_MS);

/**
 * Was this open time produced by the first evaluation pass after a resume?
 *
 * Returns the resume that explains it, or null when the open can date a failure.
 * The test is on the TRANSITION's own open time, never on the window it falls
 * in: a fixed 30-minute bucket can start up to half an hour before a resume, so
 * testing the bucket would suppress a genuine site event that merely shares a
 * bucket with one — the false negative this fix must not trade for.
 *
 * Exported for direct unit testing, and so a caller can ask the question with
 * this module's own answer rather than reproducing the rule.
 */
export function resumeForOpen(
  openedAt: string | number,
  resumes: readonly CollectorResume[],
  firstPassSeconds: number = RESUME_FIRST_PASS_SECONDS,
): CollectorResume | null {
  const at = typeof openedAt === "number" ? openedAt : ms(openedAt);
  const after = firstPassSeconds * 1000;
  const before = RESUME_CLOCK_SKEW_SECONDS * 1000;
  const minBlind = firstPassSeconds * RESUME_MIN_BLIND_PASSES;
  let best: CollectorResume | null = null;
  let bestAt = 0;
  for (const resume of resumes) {
    // A known-short outage is not blindness: the lane that opens alerts cannot
    // be shown to have missed a pass across it, so its open times still date
    // failures. An UNKNOWN blind length (null) is admitted — that is the
    // unbounded case, not the harmless one.
    if (resume.blindSeconds !== null && resume.blindSeconds < minBlind) continue;
    const resumedAt = ms(resume.resumedAt);
    if (at < resumedAt - before || at > resumedAt + after) continue;
    // The latest qualifying resume wins: first passes can only overlap when the
    // collector restarted twice inside one interval, and the nearer restart is
    // the one whose pass actually wrote the row.
    if (best === null || resumedAt > bestAt) {
      best = resume;
      bestAt = resumedAt;
    }
  }
  return best;
}

/**
 * Collapse transitions into incidents.
 *
 * `transitions` is whatever the caller filtered to, and every count in the result
 * is computed from exactly that set — the count and the roster can never describe
 * different populations, because there is only one population.
 */
export function buildIncidentQueue(
  transitions: readonly AlertTransition[],
  options: BuildIncidentsOptions = {},
): IncidentQueue {
  const resumes = options.collectorResumes ?? null;
  const firstPassSeconds = options.resumeFirstPassSeconds ?? RESUME_FIRST_PASS_SECONDS;
  // Memoised because a resume burst is thousands of rows sharing a handful of
  // open instants, and the lookup is a scan over every resume.
  const resumeCache = new Map<number, CollectorResume | null>();
  const resumeAt = (openedAtMs: number): CollectorResume | null => {
    if (resumes === null) return null;
    const hit = resumeCache.get(openedAtMs);
    if (hit !== undefined) return hit;
    const found = resumeForOpen(openedAtMs, resumes, firstPassSeconds);
    resumeCache.set(openedAtMs, found);
    return found;
  };

  const byKey = new Map<string, AlertTransition[]>();
  const scopes = new Map<string, IncidentScope>();

  for (const transition of transitions) {
    const scope = scopeFor(transition);
    const key = incidentIdFor(transition);
    scopes.set(key, scope);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(transition);
    else byKey.set(key, [transition]);
  }

  const incidents: Incident[] = [];
  for (const [key, rows] of byKey) {
    // Non-null by construction: the key was set in the same pass as the rows.
    incidents.push(
      assembleIncident(key, scopes.get(key)!, rows, {
        resumeAt,
        provenanceChecked: resumes !== null,
        firstPassSeconds,
      }),
    );
  }

  incidents.sort(compareIncidents);

  const incidentsByAxis: Record<IncidentAxis, number> = { site: 0, group: 0, device: 0 };
  const transitionsByAxis: Record<IncidentAxis, number> = { site: 0, group: 0, device: 0 };
  let transitionsInIncidents = 0;
  let transitionsInWindows = 0;
  let openIncidents = 0;
  let openTransitions = 0;
  let coFiringEvents = 0;
  let coFiringTransitions = 0;
  let noticedTogetherEvents = 0;
  let noticedTogetherTransitions = 0;
  const seenTransitionIds = new Set<string>();

  for (const incident of incidents) {
    incidentsByAxis[incident.scope.axis] += 1;
    transitionsByAxis[incident.scope.axis] += incident.transitionCount;
    transitionsInIncidents += incident.transitionCount;
    openTransitions += incident.openTransitions;
    if (incident.state === "open") openIncidents += 1;
    coFiringEvents += incident.occurrences.coFiring;
    coFiringTransitions += incident.occurrences.transitionsCoFiring;
    noticedTogetherEvents += incident.occurrences.noticedTogether;
    noticedTogetherTransitions += incident.occurrences.transitionsNoticedTogether;
    for (const window of incident.occurrences.windows) {
      transitionsInWindows += window.transitionIds.length;
      for (const id of window.transitionIds) seenTransitionIds.add(id);
    }
  }

  const transitionsIn = transitions.length;
  const attributed = transitionsByAxis.site + transitionsByAxis.group;
  const grouping = describeGrouping(
    incidentsByAxis,
    transitionsByAxis,
    incidents,
    options.hierarchyReason ?? null,
  );

  return {
    incidents,
    grouping,
    totals: {
      incidents: incidents.length,
      transitions: transitionsIn,
      openIncidents,
      openTransitions,
      unattributedTransitions: transitionsByAxis.device,
      collapsePercent:
        transitionsIn === 0
          ? null
          : round1(100 * (1 - incidents.length / transitionsIn)),
      coFiringEvents,
      coFiringTransitions,
      coFiringSharePercent:
        transitionsIn === 0 ? null : round1((100 * coFiringTransitions) / transitionsIn),
      coFiringShareOfAttributedPercent:
        attributed === 0 ? null : round1((100 * coFiringTransitions) / attributed),
      noticedTogetherEvents,
      noticedTogetherTransitions,
    },
    provenance: {
      checked: resumes !== null,
      reason:
        resumes !== null
          ? null
          : (options.resumeReason ??
            "Collector resume history was not supplied, so no co-firing window on this page " +
              "has been provenance-checked. A burst of alerts opened by the first evaluation " +
              "pass after one of our own outages is indistinguishable here from a site that " +
              "failed together."),
      resumes: resumes?.length ?? 0,
      firstPassSeconds,
      suppressedEvents: noticedTogetherEvents,
      suppressedTransitions: noticedTogetherTransitions,
      note:
        resumes === null
          ? "Every window with " +
            `${MIN_CO_FIRING_DEVICES} or more devices is presented on its device count alone.`
          : `${noticedTogetherEvents} window(s) covering ${noticedTogetherTransitions} ` +
            `transition(s) carried ${MIN_CO_FIRING_DEVICES} or more devices but opened inside ` +
            `the first ${firstPassSeconds}s after one of ${resumes.length} collector resume(s), ` +
            `so they are reported as NOTICED together rather than FAILED together. The alerts ` +
            `are unchanged and every transition is still listed on its window, its roster and ` +
            `its drilldown — only the correlation claim is withdrawn.`,
    },
    reconciliation: {
      transitionsIn,
      transitionsInIncidents,
      transitionsInOccurrenceWindows: transitionsInWindows,
      distinctTransitionIds: seenTransitionIds.size,
      balanced:
        transitionsIn === transitionsInIncidents &&
        transitionsIn === transitionsInWindows &&
        transitionsIn === seenTransitionIds.size,
      note:
        "Every transition handed in lands in exactly one incident and in exactly one of " +
        "that incident's occurrence windows, so all four counts are the same number. " +
        "Collapsing is a view over the append-only alerts rows; nothing is deleted and " +
        "nothing is hidden. If these disagree, trust the transitions, not the incidents.",
    },
  };
}

function assembleIncident(
  /** The incident id, from `incidentIdFor` — the map key and the row's identity. */
  key: string,
  scope: IncidentScope,
  rows: readonly AlertTransition[],
  provenance: {
    /** The resume whose first pass produced this open, or null. */
    resumeAt: (openedAtMs: number) => CollectorResume | null;
    /** False when no resume history was supplied — "not checked", not "clean". */
    provenanceChecked: boolean;
    firstPassSeconds: number;
  },
): Incident {
  // Oldest first, so first/last-seen and the window partition are both stable
  // regardless of the order the caller's SQL returned.
  const sorted = [...rows].sort((a, b) => ms(a.openedAt) - ms(b.openedAt) || cmp(a.id, b.id));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;

  const severityCounts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, info: 0 };
  let openTransitions = 0;
  let acknowledged = 0;
  let firstSeenMs = ms(first.openedAt);
  let lastSeenMs = firstSeenMs;
  const hoursOfDay = new Set<number>();
  let resolvedDurationMs = 0;
  let resolvedCount = 0;

  const rosterByDevice = new Map<string, IncidentRosterEntry>();
  const windows = new Map<number, IncidentOccurrence>();
  /**
   * Per window, which devices' opens can date a failure and which are only our
   * own resume noticing them. Kept alongside the window rather than inside it
   * because sets do not serialise; the window carries the counts.
   */
  const tallies = new Map<
    number,
    {
      failedTogether: Set<string>;
      noticed: Set<string>;
      noticedTransitions: number;
      resume: CollectorResume | null;
    }
  >();
  // Latest title wins: a rule's wording can change, and the newest row is what
  // the condition is called now.
  let latestTitle = first.title;
  let latestTitleAt = ms(first.lastFiredAt);

  for (const row of sorted) {
    const openedMs = ms(row.openedAt);
    // `last_fired_at` is the most recent evidence for a row and is never older
    // than `opened_at`, so the incident's last-seen is the max over both.
    const seenMs = Math.max(openedMs, ms(row.lastFiredAt));
    firstSeenMs = Math.min(firstSeenMs, openedMs);
    lastSeenMs = Math.max(lastSeenMs, seenMs);
    if (seenMs >= latestTitleAt) {
      latestTitleAt = seenMs;
      latestTitle = row.title;
    }
    severityCounts[row.severity] += 1;
    if (row.resolvedAt === null) openTransitions += 1;
    else {
      resolvedCount += 1;
      resolvedDurationMs += Math.max(0, ms(row.resolvedAt) - openedMs);
    }
    if (row.acknowledgedAt !== null) acknowledged += 1;
    hoursOfDay.add(new Date(openedMs).getUTCHours());

    const entry = rosterByDevice.get(row.deviceId);
    if (entry) {
      entry.transitionCount += 1;
      if (row.resolvedAt === null) entry.openTransitions += 1;
      if (openedMs < ms(entry.firstSeenAt)) entry.firstSeenAt = iso(openedMs);
      if (seenMs > ms(entry.lastSeenAt)) entry.lastSeenAt = iso(seenMs);
      // A device can be renamed between polls; the newest non-null name wins.
      if (row.deviceName !== null) entry.deviceName = row.deviceName;
    } else {
      rosterByDevice.set(row.deviceId, {
        deviceId: row.deviceId,
        deviceName: row.deviceName,
        transitionCount: 1,
        openTransitions: row.resolvedAt === null ? 1 : 0,
        firstSeenAt: iso(openedMs),
        lastSeenAt: iso(seenMs),
      });
    }

    const index = windowIndexOf(openedMs);
    const window = windows.get(index);
    if (window) {
      window.transitionIds.push(row.id);
      if (!window.deviceIds.includes(row.deviceId)) window.deviceIds.push(row.deviceId);
    } else {
      windows.set(index, {
        windowStart: iso(index * OCCURRENCE_WINDOW_MS),
        windowEnd: iso((index + 1) * OCCURRENCE_WINDOW_MS),
        deviceCount: 0,
        deviceIds: [row.deviceId],
        transitionIds: [row.id],
        coFiring: false,
        failedTogetherDeviceCount: 0,
        noticedTogetherTransitions: 0,
        noticedTogether: false,
        provenance: null,
      });
    }

    // Provenance, per TRANSITION. A device with one first-pass open and one
    // later open in the same window still counts as having failed: the later
    // open dates a failure, and only the burst row is unattributable.
    let tally = tallies.get(index);
    if (!tally) {
      tally = {
        failedTogether: new Set(),
        noticed: new Set(),
        noticedTransitions: 0,
        resume: null,
      };
      tallies.set(index, tally);
    }
    const resume = provenance.resumeAt(openedMs);
    if (resume === null) tally.failedTogether.add(row.deviceId);
    else {
      tally.noticed.add(row.deviceId);
      tally.noticedTransitions += 1;
      if (tally.resume === null || ms(resume.resumedAt) > ms(tally.resume.resumedAt)) {
        tally.resume = resume;
      }
    }
  }

  const orderedWindows = [...windows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, window]) => {
      // Non-null by construction: the tally is written in the same pass.
      const tally = tallies.get(index)!;
      window.deviceCount = window.deviceIds.length;
      window.failedTogetherDeviceCount = tally.failedTogether.size;
      window.noticedTogetherTransitions = tally.noticedTransitions;
      // THE co-firing test, on the devices whose opens can date a failure. With
      // no resume history supplied nothing is first-pass, so this is identical
      // to the device count and the behaviour is unchanged.
      window.coFiring = window.failedTogetherDeviceCount >= MIN_CO_FIRING_DEVICES;
      window.noticedTogether =
        !window.coFiring && window.deviceCount >= MIN_CO_FIRING_DEVICES && tally.resume !== null;
      window.provenance =
        tally.resume === null
          ? null
          : describeWindowProvenance(
              tally.resume,
              provenance.firstPassSeconds,
              tally.noticedTransitions,
              [...tally.noticed].filter((id) => !tally.failedTogether.has(id)).length,
              window.deviceCount,
              // Read off the two booleans the payload already publishes rather
              // than re-deciding it here: the sentence and the badge a reader
              // sees beside it then cannot disagree (BUG-12 was that sentence
              // disagreeing with `noticedTogether: false`).
              window.coFiring ? "kept" : window.noticedTogether ? "withdrawn" : "never-made",
            );
      return window;
    });

  let coFiringWindows = 0;
  let transitionsCoFiring = 0;
  let noticedTogetherWindows = 0;
  let transitionsNoticedTogether = 0;
  for (const window of orderedWindows) {
    if (window.coFiring) {
      coFiringWindows += 1;
      transitionsCoFiring += window.transitionIds.length;
    } else if (window.noticedTogether) {
      noticedTogetherWindows += 1;
      transitionsNoticedTogether += window.transitionIds.length;
    }
  }

  const roster = [...rosterByDevice.values()].sort(
    (a, b) => b.transitionCount - a.transitionCount || cmp(a.deviceId, b.deviceId),
  );

  const spanMs = lastSeenMs - firstSeenMs;
  const flap = classifyFlap({
    transitionCount: sorted.length,
    openTransitions,
    resolvedCount,
    resolvedDurationMs,
    spanMs,
    distinctHoursOfDay: hoursOfDay.size,
  });

  const worst = RANKED_SEVERITIES.find((s) => severityCounts[s] > 0) ?? last.severity;

  return {
    id: key,
    scope,
    ruleId: last.ruleId,
    title: latestTitle,
    severity: worst,
    severityCounts,
    state: openTransitions > 0 ? "open" : "resolved",
    transitionCount: sorted.length,
    openTransitions,
    resolvedTransitions: resolvedCount,
    acknowledgedTransitions: acknowledged,
    firstSeenAt: iso(firstSeenMs),
    lastSeenAt: iso(lastSeenMs),
    deviceCount: roster.length,
    roster,
    occurrences: {
      total: orderedWindows.length,
      coFiring: coFiringWindows,
      noticedTogether: noticedTogetherWindows,
      isolated: orderedWindows.length - coFiringWindows - noticedTogetherWindows,
      transitionsCoFiring,
      transitionsNoticedTogether,
      transitionsIsolated: sorted.length - transitionsCoFiring - transitionsNoticedTogether,
      windowMinutes: OCCURRENCE_WINDOW_MS / 60_000,
      minCoFiringDevices: MIN_CO_FIRING_DEVICES,
      basis:
        `An occurrence is one fixed ${OCCURRENCE_WINDOW_MS / 60_000}-minute window in which ` +
        `this incident opened at least once; ${coFiringWindows} of ${orderedWindows.length} ` +
        `carried ${MIN_CO_FIRING_DEVICES} or more devices firing together, the signature of a ` +
        `site-level cause. Windows are fixed clock buckets, so two devices firing either side ` +
        `of a boundary count as two windows: co-firing is a lower bound.` +
        (noticedTogetherWindows === 0
          ? ""
          : ` A further ${noticedTogetherWindows} window(s) carried ${MIN_CO_FIRING_DEVICES} ` +
            `or more devices but opened in the first pass after a collector resume, so they ` +
            `are counted as NOTICED together, not failed together — the alerts stand, the ` +
            `correlation does not.`),
      windows: orderedWindows,
    },
    flap,
    drilldown: { ruleId: last.ruleId, deviceIds: roster.map((r) => r.deviceId) },
  };
}

/**
 * Say, in words an operator can act on, what the resume does to this window.
 *
 * THREE sentences, because there are three different situations, and the third
 * one is BUG-12: a window that LOST the claim (everything in it is our
 * noticing), a window that KEPT it (part of the burst is ours, the rest still
 * failed together), and a window that never had one to lose because fewer than
 * `MIN_CO_FIRING_DEVICES` devices fired in it at all. Reporting the second as
 * suppressed would hide a real site event; reporting any of them with no note
 * would let an operator read our blind spot as estate evidence — and reporting
 * the THIRD as a withdrawal, which a binary branch on `keptClaim` did for 139
 * of this corpus's 617 windows, retracts a claim nobody made. A one-device
 * window was being told its site correlation had been retracted, which teaches
 * the reader that the provenance text is unreliable and costs more than the
 * silence it replaced.
 */
function describeWindowProvenance(
  resume: CollectorResume,
  firstPassSeconds: number,
  transitions: number,
  noticedOnlyDevices: number,
  deviceCount: number,
  claim: "kept" | "withdrawn" | "never-made",
): OccurrenceProvenance {
  const blind =
    resume.blindSeconds === null
      ? `for an unknown length of time (${resume.blindReason ?? "no earlier observation"})`
      : `for ${round1(resume.blindSeconds / 3600)}h`;
  return {
    resumedAt: resume.resumedAt,
    source: resume.source,
    blindSeconds: resume.blindSeconds,
    blindReason: resume.blindReason,
    lanes: resume.lanes,
    firstPassSeconds,
    transitions,
    devices: noticedOnlyDevices,
    note:
      claim === "kept"
        ? `${transitions} of this window's transitions opened in the first ${firstPassSeconds}s ` +
          `after collection resumed at ${resume.resumedAt}, having been blind ${blind}, so those ` +
          `open times date OUR NOTICING. The window still co-fires on the ` +
          `${deviceCount - noticedOnlyDevices} device(s) that fired outside that pass.`
        : claim === "withdrawn"
          ? `Noticed together, NOT failed together. All ${deviceCount} device(s) here opened in ` +
            `the first ${firstPassSeconds}s after collection resumed at ${resume.resumedAt}, ` +
            `having been blind ${blind} — so we found them already down, at unknown and probably ` +
            `different times, rather than watching them fail together. The alerts are real and ` +
            `still listed; the co-firing claim is withdrawn because nothing here can date a ` +
            `failure. Dispatching to a site on this evidence would be dispatching on our own ` +
            `outage.`
          : `First pass after a resume, and no co-firing claim was made here either way: only ` +
            `${deviceCount} device(s) fired in this window, under the ` +
            `${MIN_CO_FIRING_DEVICES} the site signature needs. What the resume changes is the ` +
            `TIMING — ${transitions} of this window's transitions opened in the first ` +
            `${firstPassSeconds}s after collection resumed at ${resume.resumedAt}, having been ` +
            `blind ${blind}, so those open times date OUR NOTICING and not a failure. The ` +
            `alerts are real and still listed; read the open times as "found already down", ` +
            `not "went down then".`,
  };
}

/**
 * Sustained vs oscillating — pure arithmetic over one incident's own transitions.
 *
 * Exported for direct unit testing: this is the one derivation an operator will
 * act on without opening the row (a flapping sensor is a different work item from
 * an outage), so it is tested at its boundaries rather than only through the
 * queue.
 */
export function classifyFlap(input: {
  transitionCount: number;
  openTransitions: number;
  resolvedCount: number;
  resolvedDurationMs: number;
  spanMs: number;
  distinctHoursOfDay: number;
}): IncidentFlap {
  const meanOpenMinutes =
    input.resolvedCount > 0
      ? round1(input.resolvedDurationMs / input.resolvedCount / 60_000)
      : null;
  const spanHours = input.spanMs > 0 ? round1(input.spanMs / 3_600_000) : null;
  const opensPerDay =
    input.spanMs >= MIN_SPAN_FOR_RATE_MS
      ? round1((input.transitionCount * 86_400_000) / input.spanMs)
      : null;

  const base = {
    meanOpenMinutes,
    resolvedTransitions: input.resolvedCount,
    openTransitions: input.openTransitions,
    opensPerDay,
    observedSpanHours: spanHours,
    distinctHoursOfDay: input.distinctHoursOfDay,
  };

  if (input.transitionCount < MIN_TRANSITIONS_FOR_FLAP) {
    return {
      ...base,
      classification: "indeterminate",
      reason:
        `${input.transitionCount} transition(s) — fewer than the ${MIN_TRANSITIONS_FOR_FLAP} ` +
        `needed before a repeat rate means anything. Not classified rather than guessed.`,
    };
  }
  if (meanOpenMinutes === null) {
    return {
      ...base,
      classification: "indeterminate",
      reason:
        `All ${input.transitionCount} transitions are still open, so there is no closed ` +
        `duration to average. Mean time-open is null, not zero: measuring an open ` +
        `condition against now would report something still running as finished.`,
    };
  }
  if (opensPerDay === null) {
    return {
      ...base,
      classification: "indeterminate",
      reason:
        `Observed over ${spanHours ?? 0}h — too short a span to state a daily rate, so ` +
        `oscillation cannot be distinguished from one bad hour.`,
    };
  }
  if (
    meanOpenMinutes < OSCILLATION_MEAN_OPEN_MAX_MINUTES &&
    opensPerDay >= OSCILLATION_MIN_OPENS_PER_DAY
  ) {
    return {
      ...base,
      classification: "oscillating",
      reason:
        `Opens ${opensPerDay}×/day and clears in a mean of ${meanOpenMinutes} min (under ` +
        `${OSCILLATION_MEAN_OPEN_MAX_MINUTES}), across ${input.distinctHoursOfDay} of the 24 ` +
        `hours of the day. That is a condition flapping, not one an engineer can be ` +
        `dispatched to — treat it as a sensor or player fault on the device.`,
    };
  }
  return {
    ...base,
    classification: "sustained",
    reason:
      meanOpenMinutes >= OSCILLATION_MEAN_OPEN_MAX_MINUTES
        ? `Holds open a mean of ${meanOpenMinutes} min (at or over ` +
          `${OSCILLATION_MEAN_OPEN_MAX_MINUTES}) each time, over ${opensPerDay}×/day. ` +
          `However often it recurs, each occurrence is long enough to be a real outage ` +
          `rather than a flap.`
        : `Recurs only ${opensPerDay}×/day (under ${OSCILLATION_MIN_OPENS_PER_DAY}), so it is ` +
          `not oscillating even though each occurrence clears in ${meanOpenMinutes} min.`,
  };
}

/**
 * Name the axis honestly.
 *
 * The dominant axis is whichever grouped the most incidents, and the reason
 * states what that does to the count. Presenting leaf-group grouping as site
 * grouping would misrepresent the collapse by a factor this tenant can measure
 * (94 groups against 10 depth-1 sites), which is precisely the class of error the
 * site projection was written to prevent.
 */
function describeGrouping(
  incidentsByAxis: Record<IncidentAxis, number>,
  transitionsByAxis: Record<IncidentAxis, number>,
  incidents: readonly Incident[],
  hierarchyReason: string | null,
): IncidentGrouping {
  const siteAxisAvailable = incidentsByAxis.site > 0;
  const axis: IncidentAxis = siteAxisAvailable
    ? "site"
    : incidentsByAxis.group > 0
      ? "group"
      : "device";
  const axisLabel =
    axis === "site"
      ? "site (the depth-1 ancestor of the device's group)"
      : axis === "group"
        ? "leaf group (devices.group_id) — NOT site"
        : "single device (nothing could be attributed to a group or site)";

  const unattributed = incidentsByAxis.device;
  const parts: string[] = [];
  if (axis === "site") {
    parts.push(
      `Incidents are keyed on (site, rule). Site is the depth-1 ancestor of the device's ` +
        `group in the Videri group tree, joined on group_id.`,
    );
  } else if (axis === "group") {
    parts.push(
      `Incidents are keyed on (LEAF GROUP, rule), not on (site, rule). The group tree that ` +
        `turns a leaf group into a site is read live from rpm /v1/groups and was not ` +
        `available, so no device could be rolled up to its site.` +
        (hierarchyReason ? ` ${hierarchyReason}` : "") +
        ` Leaf groups are finer than sites — on this tenant 94 groups against 10 depth-1 ` +
        `sites — so this UNDER-collapses: the incident count here is an UPPER BOUND, and a ` +
        `site-level view would show fewer, larger incidents.`,
    );
  } else {
    parts.push(
      `No transition could be attributed to a site or a group, so every incident here is a ` +
        `single device.` + (hierarchyReason ? ` ${hierarchyReason}` : ""),
    );
  }
  if (unattributed > 0 && axis !== "device") {
    parts.push(
      `${unattributed} incident(s) covering ${transitionsByAxis.device} transition(s) are ` +
        `UNATTRIBUTED — their devices are in no group at all, so they are reported as ` +
        `single-device incidents rather than dropped or folded into a neighbouring roster.`,
    );
  }
  const singletons = incidents.filter((i) => i.deviceCount === 1).length;
  if (incidents.length > 0) {
    parts.push(
      `${singletons} of ${incidents.length} incident(s) have a roster of one — the degenerate ` +
        `case of the same structure, not a different kind of row.`,
    );
  }

  return {
    axis,
    axisLabel,
    incidentsByAxis,
    transitionsByAxis,
    siteAxisAvailable,
    reason: parts.join(" "),
  };
}

/**
 * Queue order: work first.
 *
 * Open before resolved (an operator's queue is about what is still wrong), then
 * severity, then blast radius (devices), then how often it has recurred, then the
 * most recent — with an id tiebreak so the order is stable across identical rows
 * and across polls. Stability matters: an unstable sort makes pagination drop and
 * duplicate rows.
 */
function compareIncidents(a: Incident, b: Incident): number {
  if (a.state !== b.state) return a.state === "open" ? -1 : 1;
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  if (a.deviceCount !== b.deviceCount) return b.deviceCount - a.deviceCount;
  if (a.transitionCount !== b.transitionCount) return b.transitionCount - a.transitionCount;
  const byRecency = ms(b.lastSeenAt) - ms(a.lastSeenAt);
  if (byRecency !== 0) return byRecency;
  return cmp(a.id, b.id);
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const round1 = (n: number): number => Math.round(n * 10) / 10;
