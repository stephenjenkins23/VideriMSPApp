/**
 * The FleetBundle — the exact data any AI surface is given about the fleet.
 *
 * Extracted as its own type for one reason: **testability**. The brief takes a
 * bundle, not a database connection, so an eval fixture is a plain object and the
 * AI QA suite runs with no Postgres and no live API. Coupling the prompt to a
 * live query would make the AI layer effectively untestable.
 *
 * Beyond raw status, the bundle carries an `intelligence` block: compact,
 * pre-computed output from the three intelligence engines (self-heal
 * remediation, cross-fleet correlation, scheduled proof-of-play). The brief
 * REASONS OVER these — "firmware 3.3.8 is failing 34 points above baseline across
 * 22 devices" is a far more useful lead than "231 devices are behind". The block
 * is optional so eval fixtures that predate it (and any status-only caller) still
 * type-check; when present, the brief is told to prefer it.
 */

import type { FleetContext, FleetOverview, FirmwareDistribution, DeviceSummary, ChangeSince } from "./context.js";
import type { ReadQueries } from "../api/queries.js";
import {
  recommendationsFor,
  summarize,
  type DeviceView,
  type RemediationSummary,
  type Recommendation,
} from "../intelligence/remediation.js";
import { correlate, type Finding, type Note } from "../intelligence/correlation.js";
import { BASIS as POP_BASIS } from "../intelligence/proof-of-play.js";
import {
  attentionSignals,
  correlationSignals,
  describeSignals,
  remediationSignals,
  siteNameIndex,
  type PlanSignal,
  type SignalDescriptor,
} from "./signals.js";

/** Top self-heal recommendations plus the counts by kind/severity. */
export interface RemediationSignal {
  summary: RemediationSummary;
  /** The highest-leverage recommendations, already ranked; capped for token cost. */
  top: Array<{
    /** The ref an item cites to have THIS device set resolved for it (signals.ts). */
    ref: string;
    deviceLabel: string;
    category: Recommendation["category"];
    severity: Recommendation["severity"];
    kind: Recommendation["kind"];
    symptom: string;
    action: string;
    confidence: number;
  }>;
}

/** Correlated findings (firmware cohorts, venue/temporal clusters, co-occurrence) + honest notes. */
export interface CorrelationSignal {
  devicesConsidered: number;
  findings: Array<{
    /**
     * The ref an item cites to have this finding's device set resolved for it.
     *
     * The ids themselves are deliberately absent: a finding can carry 39 uuids,
     * which would cost more input tokens than the rest of the payload and buy
     * nothing, because the join happens in code afterwards (signals.ts).
     */
    ref: string;
    kind: Finding["kind"];
    severity: Finding["severity"];
    confidence: number;
    /** How many devices this pattern implicates — the "× N devices" behind a cohort. */
    affectedCount: number;
    summary: string;
    rationale: string;
  }>;
  /** Why a correlation could NOT be drawn (degenerate/absent data) — never a signal. */
  notes: Note[];
}

/**
 * Proof-of-play in the brief.
 *
 * The live POP report fans out one publisher call per device (per-canvas events),
 * which is exactly the slow/expensive work the batch brief must avoid. So we do
 * NOT compute it here; we carry its governing honesty caveat and a pointer to the
 * live endpoint instead. `available:false` is the honest-null of this surface —
 * the brief must say POP was not assessed, never imply a clean POP run.
 */
export interface ProofOfPlaySignal {
  available: false;
  basis: string;
  note: string;
}

export interface FleetIntelligence {
  remediation: RemediationSignal;
  correlation: CorrelationSignal;
  proofOfPlay: ProofOfPlaySignal;
}

export interface FleetBundle {
  overview: FleetOverview;
  firmware: FirmwareDistribution;
  attention: DeviceSummary[];
  changes: ChangeSince;
  /** Pre-computed engine output for the brief to reason over. Optional: absent = status-only. */
  intelligence?: FleetIntelligence;
  /**
   * Every signal a brief item may cite, with the ref to quote — but NOT the ids.
   *
   * The brief's `needsAttention[].device` is FREE TEXT, so the client used to
   * resolve it by NAME, and 13 names on this tenant are shared by 30 devices:
   * "open the broken device" opened a healthy twin. An item now cites a ref and
   * we join the id (signals.ts). Optional so status-only callers and older eval
   * fixtures still type-check.
   */
  signals?: SignalDescriptor[];
}

/** How many ranked recommendations to carry. Enough to lead on; bounded for cost. */
const TOP_RECOMMENDATIONS = 8;

/**
 * Fold the three intelligence engines over the shared per-device view into a
 * compact, JSON-stable summary. Pure — no I/O, so it is unit-testable with a
 * plain `DeviceView[]` and adds nothing to the brief's single Claude call.
 *
 * Remediation and correlation both run purely over `devices`. Proof-of-play is
 * deliberately NOT run here: it needs live per-device publisher reads, so it is
 * represented by its honesty caveat and left to the live endpoint (see the type).
 */
export function summarizeIntelligence(devices: DeviceView[]): FleetIntelligence {
  return foldIntelligence(devices).intelligence;
}

/**
 * What `summarizeIntelligence` folds, PLUS the device sets behind each signal.
 *
 * One fold, two products, because `correlate()` reads the wall clock for its
 * temporal rule: calling it twice — once for the payload, once for the id
 * catalog — could produce two different sets of clusters, and then the refs the
 * model cited would not be the refs we resolve against.
 */
export interface IntelligenceFold {
  /** Goes to the model. Carries refs and counts, never device ids. */
  intelligence: FleetIntelligence;
  /**
   * Stays in code: the ref → device-ids catalog the generated items are resolved
   * against. Kept out of `intelligence` precisely so it never reaches the prompt.
   */
  signals: PlanSignal[];
}

export function foldIntelligence(devices: DeviceView[]): IntelligenceFold {
  const recs = recommendationsFor(devices);
  const correlation = correlate(devices);
  const top = recs.slice(0, TOP_RECOMMENDATIONS);

  const intelligence: FleetIntelligence = {
    remediation: {
      summary: summarize(recs),
      top: top.map((r) => ({
        ref: `remediation/rec::${r.id}`,
        deviceLabel: r.deviceLabel,
        category: r.category,
        severity: r.severity,
        kind: r.kind,
        symptom: r.symptom,
        action: r.action,
        confidence: r.confidence,
      })),
    },
    correlation: {
      devicesConsidered: correlation.devicesConsidered,
      findings: correlation.findings.map((f) => ({
        ref: `correlation/${f.id}`,
        kind: f.kind,
        severity: f.severity,
        confidence: f.confidence,
        affectedCount: f.affectedDeviceIds.length,
        summary: f.summary,
        rationale: f.rationale,
      })),
      notes: correlation.notes,
    },
    proofOfPlay: {
      available: false,
      basis: POP_BASIS,
      note:
        "Proof-of-play was NOT assessed in this brief: it requires a live per-device " +
        "publisher fan-out (one call per canvas), which the batch brief deliberately " +
        "avoids to stay cheap. It is served fresh at GET /api/proof-of-play. Do not " +
        "imply POP is clean — it was simply not measured here.",
    },
  };

  return {
    intelligence,
    signals: [
      ...correlationSignals(correlation.findings, siteNameIndex(devices)),
      // Buckets over EVERY recommendation; individual refs only for the ones the
      // model was actually shown, so the citable enum stays the size of the
      // payload rather than the size of the fleet.
      ...remediationSignals(recs, top),
    ],
  };
}

export async function assembleBundle(
  fleet: FleetContext,
  queries: ReadQueries,
  windowHours = 24,
): Promise<{ bundle: FleetBundle; signals: PlanSignal[] }> {
  const [overview, firmware, attention, changes, devices] = await Promise.all([
    fleet.overview(),
    fleet.firmwareDistribution(),
    fleet.devicesNeedingAttention(25),
    fleet.changesSince(windowHours),
    queries.remediationDevices(),
  ]);
  const fold = foldIntelligence(devices);
  // One ref per device the attention list was built from, plus every engine
  // signal. The bundle carries the DESCRIPTORS (refs and counts); the ids stay
  // beside it, in code, so 250 uuids never reach the prompt.
  const signals = [...attentionSignals(attention), ...fold.signals];
  return {
    bundle: {
      overview,
      firmware,
      attention,
      changes,
      intelligence: fold.intelligence,
      signals: describeSignals(signals),
    },
    signals,
  };
}
