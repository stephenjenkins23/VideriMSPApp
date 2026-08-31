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

/** Top self-heal recommendations plus the counts by kind/severity. */
export interface RemediationSignal {
  summary: RemediationSummary;
  /** The highest-leverage recommendations, already ranked; capped for token cost. */
  top: Array<{
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
  const recs = recommendationsFor(devices);
  const correlation = correlate(devices);

  return {
    remediation: {
      summary: summarize(recs),
      top: recs.slice(0, TOP_RECOMMENDATIONS).map((r) => ({
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
}

export async function assembleBundle(
  fleet: FleetContext,
  queries: ReadQueries,
  windowHours = 24,
): Promise<FleetBundle> {
  const [overview, firmware, attention, changes, devices] = await Promise.all([
    fleet.overview(),
    fleet.firmwareDistribution(),
    fleet.devicesNeedingAttention(25),
    fleet.changesSince(windowHours),
    queries.remediationDevices(),
  ]);
  return { overview, firmware, attention, changes, intelligence: summarizeIntelligence(devices) };
}
