/**
 * Intent demotion in the remediation engine — US-8.2.7.
 *   `node --test dist/intelligence/remediation.intent.test.js`
 *
 * THE BUG THIS CLOSES
 * The live auto-safe queue had two items and one of them was a HIGH-severity
 * brightness restore at 0.9 confidence on `SparkBridge (EoL)` — a one-click
 * device write onto an asset whose own name says End of Life.
 *
 * THE PROPERTY, precisely
 * Intent DEMOTES and never DROPS. The recommendation survives at its original
 * severity and confidence, moves from `auto-safe` to `manual`, and gains the
 * reason in its rationale. That asymmetry is the entire justification for using a
 * name heuristic here: a false positive costs an operator one extra click,
 * whereas the same heuristic used to suppress would cost them a dark screen.
 *
 * `remediation.test.ts` already pins every rule's positive case and null-safety.
 * This file only covers the intent layer, and it covers the ways it could go
 * wrong rather than the way it goes right.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recommendationsFor,
  summarize,
  type DeviceView,
  type Recommendation,
} from "./remediation.js";
import type { RecordedIntent } from "./device-intent.js";

/**
 * A device whose backlight is off INSIDE its own ON window — the one symptom the
 * verified brightness write addresses, and therefore the only rule that produces
 * an `auto-safe` display recommendation. 12:00 EDT is inside 0900–0500.
 */
const IN_WINDOW = new Date("2026-08-31T16:00:00Z");

const darkInsideWindow = (over: Partial<DeviceView> = {}): DeviceView => ({
  id: "dev-1",
  name: "Lobby North",
  status: "online",
  lastOnlineTime: "2026-08-31T12:00:00Z",
  city: "New York",
  groupId: null,
  site: null,
  firmwareCurrent: "7.0",
  firmwareBehind: false,
  screen: { isBlackScreen: false, showingLogo: false, nowPlayingId: "content-1" },
  telemetry: null,
  drift: [],
  brightnessRaw: 128,
  currentBrightnessRaw: 0,
  displayOn: false,
  brightnessScheduleEnabled: true,
  autoBrightnessEnabled: false,
  turnOnTime: "0900",
  turnOffTime: "0500",
  timezone: "America/New_York",
  ...over,
});

const autoSafe = (recs: Recommendation[]): Recommendation[] => recs.filter((r) => r.kind === "auto-safe");

// ─── the baseline: without intent this IS a one-click ────────────────────────

test("an ordinary device still gets its auto-safe brightness restore", () => {
  // The control. If this ever stops being auto-safe, the tests below would pass
  // for the wrong reason.
  const recs = recommendationsFor([darkInsideWindow()], IN_WINDOW);
  assert.equal(autoSafe(recs).length, 1);
  assert.equal(autoSafe(recs)[0]?.action, "Restore brightness");
  assert.equal(recs[0]?.intent, undefined);
  assert.equal(recs[0]?.demotedByIntent, undefined);
});

// ─── the case that started it ────────────────────────────────────────────────

test("`SparkBridge (EoL)` is never offered as a one-click, and says why", () => {
  const recs = recommendationsFor(
    [darkInsideWindow({ id: "eol-1", name: "SparkBridge (EoL)" })], IN_WINDOW,
  );

  // NOT DROPPED. The finding stands — a dark screen is a dark screen.
  assert.equal(recs.length, 1);
  assert.equal(recs[0]?.action, "Restore brightness");
  // Demoted, and only demoted.
  assert.equal(recs[0]?.kind, "manual");
  assert.equal(recs[0]?.demotedByIntent, true);
  // Severity and confidence are UNTOUCHED: the fault is exactly as serious as it
  // was, and only our willingness to one-click it has changed.
  assert.equal(recs[0]?.severity, "high");
  assert.equal(recs[0]?.confidence, 0.9);
  // The reason is in the rationale, in words, on the item itself.
  assert.match(recs[0]!.rationale, /NOT offered as a one-click/);
  assert.match(recs[0]!.rationale, /End of Life/);
  // And it is visibly a heuristic rather than a fact.
  assert.match(recs[0]!.rationale, /Inferred from the device NAME/);
  assert.match(recs[0]!.rationale, /heuristic/);
  // The signal itself is on the payload, so the UI can badge it and offer an
  // override rather than only rendering prose.
  assert.equal(recs[0]?.intent?.kind, "eol");
  assert.equal(recs[0]?.intent?.source, "device-name");
  assert.equal(recs[0]?.intent?.strength, "strong");
  assert.equal(recs[0]?.intent?.matchedText, "EoL");
});

test("the auto-safe queue is empty once the only candidate carries intent", () => {
  const recs = recommendationsFor(
    [
      darkInsideWindow({ id: "eol-1", name: "SparkBridge (EoL)" }),
      darkInsideWindow({ id: "lab-1", name: "Lab TCL" }),
    ],
    IN_WINDOW,
  );
  assert.equal(autoSafe(recs).length, 0);
  // ...and nothing was lost in the process.
  assert.equal(recs.length, 2);
});

test("a WEAK name match demotes too — otherwise `Lab TCL` stays a one-click", () => {
  const recs = recommendationsFor(
    [darkInsideWindow({ id: "lab-1", name: "Lab TCL" })], IN_WINDOW,
  );
  assert.equal(recs[0]?.kind, "manual");
  assert.equal(recs[0]?.demotedByIntent, true);
  assert.equal(recs[0]?.intent?.strength, "weak");
  // The shakiness is reported, not hidden: a weak match is a prompt to check.
  assert.match(recs[0]!.rationale, /prompt to check rather than a fact/);
});

// ─── a false positive costs one click, and nothing else ──────────────────────

test("the honest false positive is demoted, not dropped, and is overridable", () => {
  // `Repairs Desk Menu Board` is a production screen in a phone-repair shop and
  // we are WRONG about it. The blast radius must be exactly one lost one-click.
  const device = darkInsideWindow({ id: "fp-1", name: "Repairs Desk Menu Board" });

  const wrong = recommendationsFor([device], IN_WINDOW);
  assert.equal(wrong.length, 1, "the finding must survive being wrong about the device");
  assert.equal(wrong[0]?.kind, "manual");
  assert.equal(wrong[0]?.severity, "high", "severity must not be softened by a guess");

  // And the operator can say so, once, and be believed thereafter.
  const corrected = recommendationsFor([device], IN_WINDOW, {
    recordedIntent: new Map<string, RecordedIntent>([
      ["fp-1", {
        kind: "none",
        reason: "production screen at a phone-repair retailer; the name is the shop",
        by: "api:sam",
        at: "2026-09-01T09:00:00.000Z",
      }],
    ]),
  });
  assert.equal(corrected[0]?.kind, "auto-safe");
  assert.equal(corrected[0]?.intent, undefined);
  assert.equal(corrected[0]?.demotedByIntent, undefined);
});

// ─── a real suppression outranks inferred intent ─────────────────────────────

test("a RECORDED intent outranks the name and is attributed, not hedged", () => {
  const recs = recommendationsFor(
    // The name says nothing; the operator has recorded that it is a lab unit.
    [darkInsideWindow({ id: "d1", name: "Lobby North" })],
    IN_WINDOW,
    {
      recordedIntent: new Map<string, RecordedIntent>([
        ["d1", {
          kind: "lab",
          reason: "moved into the hardware lab on 2026-08-30",
          by: "api:sam",
          at: "2026-08-30T09:00:00.000Z",
        }],
      ]),
    },
  );
  assert.equal(recs[0]?.kind, "manual");
  assert.equal(recs[0]?.demotedByIntent, true);
  assert.equal(recs[0]?.intent?.source, "operator");
  // An operator's decision must NOT be dressed up as an inference.
  assert.match(recs[0]!.rationale, /Recorded by api:sam/);
  assert.doesNotMatch(recs[0]!.rationale, /Inferred from the device NAME/);
});

test("a recorded intent CONTRADICTING the name wins — both directions", () => {
  const eolName = darkInsideWindow({ id: "d1", name: "SparkBridge (EoL)" });

  // `none` beats a screaming name: back to auto-safe.
  const rescued = recommendationsFor([eolName], IN_WINDOW, {
    recordedIntent: new Map<string, RecordedIntent>([
      ["d1", { kind: "none", reason: "returned to service; name to be corrected", by: "api:sam", at: "2026-09-01T00:00:00.000Z" }],
    ]),
  });
  assert.equal(rescued[0]?.kind, "auto-safe");

  // A different recorded kind replaces the inferred one rather than merging.
  const reclassified = recommendationsFor([eolName], IN_WINDOW, {
    recordedIntent: new Map<string, RecordedIntent>([
      ["d1", { kind: "repair", reason: "away at the depot for a panel swap", by: "api:sam", at: "2026-09-01T00:00:00.000Z" }],
    ]),
  });
  assert.equal(reclassified[0]?.intent?.kind, "repair");
  assert.equal(reclassified[0]?.intent?.source, "operator");
});

// ─── the invariant, held for every rule ──────────────────────────────────────

test("NO rule can produce an auto-safe item on an intent-carrying device", () => {
  // Enforced as a post-pass over every recommendation rather than inside each
  // branch, so a rule added next month inherits it. This test is the guard on
  // that: it drives a device that fires the display rule AND the brightness
  // compliance rule, and asserts the invariant across all of them.
  const device = darkInsideWindow({
    id: "eol-1",
    name: "Spark 4 (EoL)",
    drift: [
      { kind: "value", label: "brightness", field: "brightness" },
      { kind: "value", label: "Nightly reboot enabled", field: "reboot_enabled" },
    ],
    firmwareBehind: true,
    telemetry: {
      observedAt: "2026-08-31T12:00:00Z",
      cpuPercent: 95, ramUsedPercent: 95, storageUsedPercent: 95,
      rssiDbm: -85, ntpOffsetMs: 5000,
    },
  });
  const recs = recommendationsFor([device], IN_WINDOW);
  assert.ok(recs.length >= 3, "expected several rules to fire on this device");
  for (const rec of recs) {
    assert.notEqual(rec.kind, "auto-safe", `${rec.id} escaped the demotion`);
    // Every one of them carries the signal, so no item is silently unexplained.
    assert.equal(rec.intent?.kind, "eol");
  }
});

test("an already-manual recommendation is annotated but not marked as demoted", () => {
  // "Manual because we hold no verified write for it" and "manual because the
  // name says End of Life" are different facts, and only one is overridable.
  const recs = recommendationsFor(
    [darkInsideWindow({
      id: "eol-1", name: "Spark 4 (EoL)",
      // Not a brightness drift, so this rule is manual on its own merits.
      drift: [{ kind: "value", label: "Nightly reboot enabled", field: "reboot_enabled" }],
      currentBrightnessRaw: 200, displayOn: true,
    })],
    IN_WINDOW,
  );
  const compliance = recs.find((r) => r.category === "compliance");
  assert.equal(compliance?.kind, "manual");
  assert.equal(compliance?.demotedByIntent, false);
  assert.equal(compliance?.intent?.kind, "eol");
  // Still told, because "why is this EoL unit in my list at all" is a fair
  // question and the answer belongs on the item.
  assert.match(compliance!.rationale, /Context: this device looks like it is End of Life/);
});

test("a device with no intent is untouched even when a neighbour has one", () => {
  const recs = recommendationsFor(
    [
      darkInsideWindow({ id: "eol-1", name: "SparkBridge (EoL)" }),
      darkInsideWindow({ id: "prod-1", name: "Lobby North" }),
    ],
    IN_WINDOW,
  );
  const prod = recs.find((r) => r.deviceIds[0] === "prod-1");
  assert.equal(prod?.kind, "auto-safe");
  assert.equal(prod?.intent, undefined);
});

// ─── the summary must let a reviewer check the claim ─────────────────────────

test("the summary counts the demotions, so the effect is checkable not claimed", () => {
  const recs = recommendationsFor(
    [
      darkInsideWindow({ id: "eol-1", name: "SparkBridge (EoL)" }), // strong name
      darkInsideWindow({ id: "lab-1", name: "Lab TCL" }), // weak name
      darkInsideWindow({ id: "rec-1", name: "Lobby South" }), // recorded
      darkInsideWindow({ id: "prod-1", name: "Lobby North" }), // clean
    ],
    IN_WINDOW,
    {
      recordedIntent: new Map<string, RecordedIntent>([
        ["rec-1", { kind: "lab", reason: "moved into the hardware lab", by: "api:sam", at: "2026-08-30T09:00:00.000Z" }],
      ]),
    },
  );
  const summary = summarize(recs);

  assert.equal(summary.total, 4);
  assert.equal(summary.byKind["auto-safe"], 1);
  assert.equal(summary.byKind.manual, 3);
  assert.equal(summary.intent.onIntentDevices, 3);
  assert.equal(summary.intent.demotedFromAutoSafe, 3);
  // The split that matters for review: two rest on a name, one on a decision.
  assert.equal(summary.intent.fromNameHeuristic, 2);
  assert.equal(summary.intent.fromWeakNameMatch, 1);
  assert.deepEqual(summary.intent.byKind, { eol: 1, lab: 2 });
});

test("the summary reports zeros honestly when nothing carries intent", () => {
  const summary = summarize(recommendationsFor([darkInsideWindow()], IN_WINDOW));
  // Real zeros: we looked and found none. Not absent fields.
  assert.equal(summary.intent.onIntentDevices, 0);
  assert.equal(summary.intent.demotedFromAutoSafe, 0);
  assert.deepEqual(summary.intent.byKind, {});
  assert.equal(summary.byKind["auto-safe"], 1);
});

test("ranking is unchanged by demotion — position is not a punishment", () => {
  // An EoL device with a genuine dark screen must still outrank a low-severity
  // note on a healthy one. Demotion changes what we will click, not what matters.
  const recs = recommendationsFor(
    [
      darkInsideWindow({ id: "eol-1", name: "SparkBridge (EoL)" }),
      darkInsideWindow({
        id: "prod-1", name: "Lobby North",
        currentBrightnessRaw: 200, displayOn: true,
        drift: [{ kind: "value", label: "Nightly reboot enabled", field: "reboot_enabled" }],
      }),
    ],
    IN_WINDOW,
  );
  assert.equal(recs[0]?.deviceIds[0], "eol-1");
  assert.equal(recs[0]?.severity, "high");
});
