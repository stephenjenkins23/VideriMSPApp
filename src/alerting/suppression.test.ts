/**
 * Suppression classifier tests — `node --test dist/alerting/suppression.test.js`
 *
 * A suppression feature is the single most dangerous thing in a monitoring
 * product, because "make this stop appearing" is its job and "make this stop
 * appearing WITHOUT telling anyone" is the failure. The dormant band already
 * broke the sum invariant once by filtering rows out of the list without taking
 * them out of the counts, leaving an operator staring at chips that added up to
 * more alerts than the list contained.
 *
 * So the properties asserted here are the ones that keep it honest:
 *
 *   1. NOTHING DISAPPEARS. Every open alert lands in exactly one band, the bands
 *      sum to the grand total, and the suppressed band publishes its ALERT ids so
 *      the drilldown cannot drift (`bandsSumToTotal`).
 *   2. CRITICAL AND HIGH are not blanket-suppressible. A whole-device record can
 *      never absorb them, whatever flags it carries; a rule-scoped one can, and
 *      only explicitly.
 *   3. EXPIRY IS REAL, at the boundary. Half-open: active while `now <
 *      expiresAt`, lapsed exactly at it. A suppression that silently outlives its
 *      expiry is how monitoring rots.
 *   4. UN-SUPPRESSION RETURNS THE ALERTS, at their normal rank, and the return is
 *      counted rather than promised.
 *   5. A RECORDED INTENT is read only from a whole-device record, so snoozing one
 *      drift on a production screen cannot be mistaken for "this is a lab unit".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Severity } from "../domain/types.js";
import type { OpenAlertFact } from "./hygiene.js";
import {
  DEFAULT_EXPIRY_DAYS,
  MAX_EXPIRY_DAYS,
  MIN_REASON_LENGTH,
  NEVER_ABSORBED,
  bandsSumToTotal,
  classifySuppressed,
  matchSuppression,
  recordedIntentByDevice,
  suppressionStatus,
  type SuppressionRecord,
} from "./suppression.js";

const NOW = new Date("2026-09-03T12:00:00Z");
const DAY = 86_400_000;

const alert = (
  over: Partial<OpenAlertFact> & { id: string; deviceId: string },
): OpenAlertFact => ({
  ruleId: "firmware-behind",
  severity: "info" as Severity,
  openedAt: new Date(NOW.getTime() - 10 * DAY),
  ...over,
});

/** A well-formed, in-force, whole-device suppression. */
const suppression = (over: Partial<SuppressionRecord> & { id: string; deviceId: string }): SuppressionRecord => ({
  ruleId: null,
  reason: "lab unit, expected to be dark",
  intent: null,
  includeCriticalHigh: false,
  createdBy: "api:sam",
  createdAt: new Date(NOW.getTime() - DAY),
  expiresAt: new Date(NOW.getTime() + 29 * DAY),
  neverExpires: false,
  revokedAt: null,
  revokedBy: null,
  revokedReason: null,
  ...over,
});

// ─── the policy constants ────────────────────────────────────────────────────

test("the defaults are finite, capped, and demand a real reason", () => {
  // 30 days, matching the offline-30d dormancy horizon so a suppression that has
  // outlived its reason resurfaces on the cadence the estate is already reviewed on.
  assert.equal(DEFAULT_EXPIRY_DAYS, 30);
  // A cap is what stops "forever" arriving in disguise as a five-year expiry.
  assert.equal(MAX_EXPIRY_DAYS, 365);
  assert.ok(MIN_REASON_LENGTH >= 8, "a reason short enough to be `lab` is not a reason");
  assert.ok(DEFAULT_EXPIRY_DAYS < MAX_EXPIRY_DAYS);
});

test("the never-absorbed set is exactly the one hygiene.ts uses", () => {
  // These two sets are duplicated on purpose (one per module, same name) so the
  // duplication is grep-able. If they ever diverge, one of the two safety valves
  // has silently stopped working.
  assert.deepEqual([...NEVER_ABSORBED].sort(), ["critical", "high"]);
});

// ─── expiry, at the boundary ─────────────────────────────────────────────────

test("expiry is half-open: active while now < expiresAt, lapsed AT it", () => {
  const at = new Date(NOW.getTime() + 1000);
  const record = suppression({ id: "s1", deviceId: "d1", expiresAt: at });

  // One millisecond before: in force.
  assert.equal(suppressionStatus(record, new Date(at.getTime() - 1)).active, true);
  // Exactly at the boundary: lapsed. Chosen so two consecutive suppressions
  // cannot both cover the same instant — the same half-open convention the audit
  // window uses.
  const atBoundary = suppressionStatus(record, at);
  assert.equal(atBoundary.active, false);
  assert.equal(atBoundary.lapsed, "expired");
  // One millisecond after: still lapsed, and the countdown has gone negative
  // rather than being clamped to zero. A clamped zero would read as "expires now"
  // forever.
  const after = suppressionStatus(record, new Date(at.getTime() + 1));
  assert.equal(after.active, false);
  assert.ok(after.secondsUntilExpiry !== null && after.secondsUntilExpiry < 0);
});

test("a deliberate no-expiry record never lapses, and reports no countdown", () => {
  const record = suppression({
    id: "s1", deviceId: "d1", expiresAt: null, neverExpires: true,
    reason: "asset physically decommissioned and scrapped",
  });
  const status = suppressionStatus(record, new Date(NOW.getTime() + 5000 * DAY));
  assert.equal(status.active, true);
  // `null`, not a huge number: "does not expire" is a different fact from
  // "expires in 4,000 years", and an honest null says which.
  assert.equal(status.secondsUntilExpiry, null);
});

test("revocation beats expiry in the report — the operator's act, not the clock", () => {
  const record = suppression({
    id: "s1", deviceId: "d1",
    expiresAt: new Date(NOW.getTime() - DAY), // also expired
    revokedAt: new Date(NOW.getTime() - 2 * DAY),
    revokedBy: "api:jo",
  });
  const status = suppressionStatus(record, NOW);
  assert.equal(status.active, false);
  assert.equal(status.lapsed, "revoked");
});

// ─── the sum invariant: nothing disappears ───────────────────────────────────

test("a suppressed alert is still counted, still discoverable, never deleted", () => {
  const alerts = [
    alert({ id: "a1", deviceId: "lab-1" }),
    alert({ id: "a2", deviceId: "lab-1", ruleId: "offline-30d", severity: "medium" }),
    alert({ id: "a3", deviceId: "prod-1", severity: "medium" }),
  ];
  const view = classifySuppressed(
    alerts, [suppression({ id: "s1", deviceId: "lab-1" })], { now: NOW },
  );

  // The grand total is untouched: suppression is a banding, not a deletion.
  assert.equal(view.totalOpen, 3);
  assert.equal(view.suppressed.total, 2);
  assert.equal(view.incidents.total, 1);
  // The bands sum, and the chips sum. This is the invariant the dormant band
  // broke once, and it is asserted rather than described.
  assert.ok(bandsSumToTotal(view));

  // Discoverable: the ALERT ids are published, so the drilldown is exact.
  assert.deepEqual(view.suppressed.alertIds, ["a1", "a2"]);
  assert.deepEqual(view.suppressed.deviceIds, ["lab-1"]);
  // Per-severity counts survive banding, so the suppressed band can be graded.
  assert.equal(view.suppressed.bySeverity.info, 1);
  assert.equal(view.suppressed.bySeverity.medium, 1);
  // And the notes SAY it, in words, unprompted.
  assert.ok(view.notes.some((n) => /remain OPEN/.test(n) && /counted in the suppressed chip/.test(n)));
  assert.ok(view.notes.some((n) => /Nothing\s+was resolved, hidden or deleted/.test(n)));
});

test("the chip count and the band membership can never drift apart", () => {
  const alerts = Array.from({ length: 25 }, (_, i) =>
    alert({ id: `a${i}`, deviceId: i % 5 === 0 ? "lab-1" : `prod-${i}` }),
  );
  const view = classifySuppressed(
    alerts, [suppression({ id: "s1", deviceId: "lab-1" })], { now: NOW },
  );
  assert.ok(bandsSumToTotal(view));
  // `bandsSumToTotal` asserts this too; stated separately because it is the
  // property a paginating client actually depends on.
  assert.equal(view.suppressed.alertIds.length, view.suppressed.total);
  assert.equal(
    view.chips.find((c) => c.key === "suppressed")?.count,
    view.suppressed.total,
  );
  assert.equal(view.chips.find((c) => c.key === "incident")?.inDefaultList, true);
  assert.equal(view.chips.find((c) => c.key === "suppressed")?.inDefaultList, false);
});

test("an unrecognised severity is counted as info rather than dropped", () => {
  // Dropping it would break the sum silently, which is worse than mis-binning it.
  const view = classifySuppressed(
    [alert({ id: "a1", deviceId: "lab-1", severity: "urgent" as Severity })],
    [suppression({ id: "s1", deviceId: "lab-1" })],
    { now: NOW },
  );
  assert.ok(bandsSumToTotal(view));
  assert.equal(view.suppressed.bySeverity.info, 1);
});

// ─── critical and high are not blanket-suppressible ──────────────────────────

test("a WHOLE-DEVICE suppression can never absorb critical or high", () => {
  const alerts = [
    alert({ id: "a1", deviceId: "lab-1", ruleId: "black-screen", severity: "critical" }),
    alert({ id: "a2", deviceId: "lab-1", ruleId: "offline-30d", severity: "high" }),
    alert({ id: "a3", deviceId: "lab-1", severity: "medium" }),
    alert({ id: "a4", deviceId: "lab-1", severity: "info" }),
  ];
  const view = classifySuppressed(
    alerts, [suppression({ id: "s1", deviceId: "lab-1" })], { now: NOW },
  );

  // Only the medium and the info moved.
  assert.deepEqual(view.suppressed.alertIds, ["a3", "a4"]);
  assert.equal(view.incidents.bySeverity.critical, 1);
  assert.equal(view.incidents.bySeverity.high, 1);
  // The held-back decision is AUDITABLE, not just described in prose.
  assert.deepEqual(view.suppressed.heldBackAlertIds, ["a1", "a2"]);
  assert.ok(view.notes.some((n) => /deliberately KEPT in the/.test(n) && /the device spoke/.test(n)));
  assert.ok(bandsSumToTotal(view));
});

test("`includeCriticalHigh` cannot rescue a whole-device suppression", () => {
  // The database CHECK forbids the combination outright; the classifier must
  // agree, so a row that somehow existed could not take effect either. Defence
  // in depth, because this is the one rule that must not be circumventable.
  const record = suppression({ id: "s1", deviceId: "lab-1", ruleId: null, includeCriticalHigh: true });
  const match = matchSuppression(
    { deviceId: "lab-1", ruleId: "black-screen", severity: "critical" }, [record],
  );
  assert.equal(match.by, null);
  assert.equal(match.refused.length, 1);
  assert.match(match.refused[0]!.because, /whole-device suppression can never absorb/);
});

test("a RULE-SCOPED suppression absorbs a critical only when asked explicitly", () => {
  const critical = { deviceId: "lab-1", ruleId: "offline-30d", severity: "critical" as Severity };

  const withoutFlag = suppression({ id: "s1", deviceId: "lab-1", ruleId: "offline-30d" });
  assert.equal(matchSuppression(critical, [withoutFlag]).by, null);
  assert.match(
    matchSuppression(critical, [withoutFlag]).refused[0]!.because,
    /did not set includeCriticalHigh/,
  );

  const withFlag = suppression({
    id: "s2", deviceId: "lab-1", ruleId: "offline-30d", includeCriticalHigh: true,
    reason: "asset scrapped; the outage critical is expected and permanent",
  });
  assert.equal(matchSuppression(critical, [withFlag]).by?.id, "s2");
});

test("every critical-absorbing record is NAMED in the notes — legal but never quiet", () => {
  const view = classifySuppressed(
    [alert({ id: "a1", deviceId: "lab-1", ruleId: "offline-30d", severity: "critical" })],
    [suppression({
      id: "s1", deviceId: "lab-1", ruleId: "offline-30d", includeCriticalHigh: true,
      reason: "asset scrapped; the outage critical is expected and permanent",
    })],
    { now: NOW },
  );
  assert.equal(view.suppressed.total, 1);
  const note = view.notes.find((n) => /permitted to absorb CRITICAL or HIGH/.test(n));
  assert.ok(note, "a critical-absorbing suppression must be announced");
  assert.match(note!, /s1 \(lab-1 \/ offline-30d\)/);
});

test("a rule-scoped suppression does not spill onto the device's other rules", () => {
  const alerts = [
    alert({ id: "a1", deviceId: "prod-1", ruleId: "brightness-drift", severity: "medium" }),
    alert({ id: "a2", deviceId: "prod-1", ruleId: "offline-30d", severity: "medium" }),
  ];
  const view = classifySuppressed(
    alerts,
    [suppression({
      id: "s1", deviceId: "prod-1", ruleId: "brightness-drift",
      reason: "dimmed deliberately for the night-time window",
    })],
    { now: NOW },
  );
  // The whole reason the narrow scope exists: silencing a deliberate drift must
  // not also silence the screen going offline.
  assert.deepEqual(view.suppressed.alertIds, ["a1"]);
  assert.deepEqual(view.incidents.total, 1);
});

// ─── precedence ──────────────────────────────────────────────────────────────

test("the NARROWER record wins, so the operator reads the most specific reason", () => {
  const device = suppression({ id: "s-device", deviceId: "d1", reason: "unit lives in the lab" });
  const rule = suppression({
    id: "s-rule", deviceId: "d1", ruleId: "firmware-behind",
    reason: "firmware pinned for a customer certification",
  });
  const match = matchSuppression(
    { deviceId: "d1", ruleId: "firmware-behind", severity: "info" }, [device, rule],
  );
  assert.equal(match.by?.id, "s-rule");
  assert.match(match.by!.reason, /pinned for a customer certification/);
});

test("among equally specific records the most recent decision wins", () => {
  const old = suppression({
    id: "s-old", deviceId: "d1", ruleId: "firmware-behind",
    createdAt: new Date(NOW.getTime() - 10 * DAY), reason: "older conclusion, superseded",
  });
  const recent = suppression({
    id: "s-new", deviceId: "d1", ruleId: "firmware-behind",
    createdAt: new Date(NOW.getTime() - DAY), reason: "current conclusion about this alert",
  });
  const match = matchSuppression(
    { deviceId: "d1", ruleId: "firmware-behind", severity: "info" }, [old, recent],
  );
  assert.equal(match.by?.id, "s-new");
});

test("a lapsed record suppresses nothing, and a revoked one suppresses nothing", () => {
  const expired = suppression({
    id: "s-exp", deviceId: "d1", expiresAt: new Date(NOW.getTime() - DAY),
  });
  const revoked = suppression({
    id: "s-rev", deviceId: "d2", revokedAt: new Date(NOW.getTime() - DAY), revokedBy: "api:jo",
  });
  const view = classifySuppressed(
    [alert({ id: "a1", deviceId: "d1" }), alert({ id: "a2", deviceId: "d2" })],
    [expired, revoked],
    { now: NOW },
  );
  assert.equal(view.suppressed.total, 0);
  assert.equal(view.incidents.total, 2);
  assert.ok(bandsSumToTotal(view));
});

// ─── un-suppression and re-escalation ────────────────────────────────────────

test("un-suppression returns the alerts, and the return is COUNTED not promised", () => {
  const alerts = [
    alert({ id: "a1", deviceId: "lab-1" }),
    alert({ id: "a2", deviceId: "lab-1", severity: "medium" }),
  ];
  const inForce = suppression({ id: "s1", deviceId: "lab-1" });

  const before = classifySuppressed(alerts, [inForce], { now: NOW });
  assert.equal(before.suppressed.total, 2);
  assert.equal(before.lapsed.length, 0);

  // Revocation is an UPDATE of three columns, never a delete — the record stays.
  const after = classifySuppressed(
    alerts,
    [{ ...inForce, revokedAt: NOW, revokedBy: "api:jo", revokedReason: "unit went back into service" }],
    { now: NOW },
  );
  assert.equal(after.suppressed.total, 0);
  assert.equal(after.incidents.total, 2);
  // The record is still there, reported as lapsed, with the count of what
  // returned. "4 alerts are back because your mute came off" is the sentence.
  assert.equal(after.lapsed.length, 1);
  assert.equal(after.lapsed[0]?.suppressionId, "s1");
  assert.equal(after.lapsed[0]?.lapsedBecause, "revoked");
  assert.equal(after.lapsed[0]?.returnedAlertCount, 2);
  assert.ok(after.notes.some((n) => /back in the/.test(n) && /never a reason to stop looking/.test(n)));
});

test("an EXPIRED record reports its returned alerts too, and says it expired", () => {
  const view = classifySuppressed(
    [alert({ id: "a1", deviceId: "lab-1" })],
    [suppression({ id: "s1", deviceId: "lab-1", expiresAt: new Date(NOW.getTime() - 1) })],
    { now: NOW },
  );
  assert.equal(view.lapsed[0]?.lapsedBecause, "expired");
  assert.equal(view.lapsed[0]?.returnedAlertCount, 1);
  assert.ok(view.notes.some((n) => /1 expired/.test(n)));
});

// ─── inert records ───────────────────────────────────────────────────────────

test("a record in force but suppressing nothing stays visible", () => {
  // This is the answer to "I muted this, why am I seeing it" when the answer is
  // that the alert is a different one — and it is also the signal that a mute is
  // ready to be revoked.
  const view = classifySuppressed(
    [alert({ id: "a1", deviceId: "other" })],
    [suppression({ id: "s1", deviceId: "lab-1" })],
    { now: NOW },
  );
  assert.equal(view.inertRecords, 1);
  assert.equal(view.suppressed.byRecord.length, 1);
  assert.equal(view.suppressed.byRecord[0]?.alertCount, 0);
  assert.ok(view.notes.some((n) => /suppressing nothing/.test(n)));
});

test("with no suppressions at all the view says so and changes nothing", () => {
  const view = classifySuppressed([alert({ id: "a1", deviceId: "d1" })], [], { now: NOW });
  assert.equal(view.incidents.total, 1);
  assert.equal(view.suppressed.total, 0);
  assert.ok(bandsSumToTotal(view));
  assert.ok(view.notes.some((n) => /No suppression is in force/.test(n)));
  assert.ok(view.notes.some((n) => /requires a reason and an expiry/.test(n)));
});

// ─── the `none` override, in the banding layer ───────────────────────────────

test("an intent of `none` suppresses nothing — it only overrides the name heuristic", () => {
  const view = classifySuppressed(
    [alert({ id: "a1", deviceId: "prod-1", severity: "medium" })],
    [suppression({
      id: "s1", deviceId: "prod-1", intent: "none",
      reason: "production screen at a phone-repair retailer; the name is the shop",
    })],
    { now: NOW },
  );
  assert.equal(view.suppressed.total, 0);
  assert.equal(view.incidents.total, 1);
  // And it is NOT reported as a held-back alert: nothing was ever asked to
  // suppress it, so calling it "held back" would invent a refusal.
  assert.deepEqual(view.suppressed.heldBackAlertIds, []);
});

// ─── recorded intent, for the remediation engine ─────────────────────────────

test("recorded intent comes only from WHOLE-DEVICE records", () => {
  const records = [
    suppression({ id: "s1", deviceId: "lab-1", intent: "lab", reason: "unit lives in the hardware lab" }),
    // Rule-scoped: "this ALERT is expected" is not "this DEVICE is a lab unit",
    // and reading it as one would demote recommendations on a production screen
    // because somebody snoozed a single drift on it.
    suppression({
      id: "s2", deviceId: "prod-1", ruleId: "brightness-drift", intent: "lab",
      reason: "dimmed deliberately for the night-time window",
    }),
  ];
  const map = recordedIntentByDevice(records, NOW);
  assert.equal(map.get("lab-1")?.kind, "lab");
  assert.equal(map.has("prod-1"), false);
  // Attribution rides along, so the engine can name the decider instead of
  // hedging.
  assert.equal(map.get("lab-1")?.by, "api:sam");
  assert.match(map.get("lab-1")!.reason, /hardware lab/);
});

test("recorded intent ignores lapsed records and takes the newest decision", () => {
  const records = [
    suppression({
      id: "s-old", deviceId: "d1", intent: "eol",
      createdAt: new Date(NOW.getTime() - 30 * DAY), reason: "thought this was end of life",
    }),
    suppression({
      id: "s-new", deviceId: "d1", intent: "none",
      createdAt: new Date(NOW.getTime() - DAY), reason: "checked it; back in production service",
    }),
    suppression({
      id: "s-gone", deviceId: "d2", intent: "eol",
      expiresAt: new Date(NOW.getTime() - DAY), reason: "expired conclusion about d2",
    }),
  ];
  const map = recordedIntentByDevice(records, NOW);
  // An operator who records `none` today after `eol` last month has changed
  // their mind, and the newer decision is the decision.
  assert.equal(map.get("d1")?.kind, "none");
  assert.equal(map.has("d2"), false);
});

test("a suppression with no intent makes no claim about the asset", () => {
  // A plain snooze ("expected this week") must not be read as a purpose, or every
  // snooze would start demoting recommendations.
  const map = recordedIntentByDevice(
    [suppression({ id: "s1", deviceId: "d1", intent: null })], NOW,
  );
  assert.equal(map.size, 0);
});
