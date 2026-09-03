/**
 * Device-intent heuristic tests — `node --test dist/intelligence/device-intent.test.js`
 *
 * This module reads a free-text field a customer typed and draws a conclusion
 * about their asset from it. That is a heuristic, and the only thing that makes
 * it admissible is that it can only ever DEMOTE — so these tests are mostly
 * about the ways it could be wrong:
 *
 *   - SUBSTRING matching. `eol` is inside `Seoul`, `test` is inside `Latest` and
 *     `Contest`, `lab` is inside `Label` and `Labrador`, and `QA` is inside this
 *     fleet's real `QAreception05-sq-16`. Every one of those is asserted as a
 *     non-match, because a substring match would flag a whole city's screens.
 *   - OVER-CREDITING. A bracketed annotation is a deliberate act; a bare word
 *     among others may be a coincidence. Promoting the second to `strong` would
 *     make the shakiest inferences look like the surest.
 *   - the PRECEDENCE rule, which is what makes "a real suppression always
 *     outranks inferred intent" true rather than aspirational — including the
 *     `none` override, the case an operator needs when we are wrong about a
 *     production screen.
 *
 * Every name marked LIVE below is a real active device name on the fleet as of
 * 2026-09-03, so a rule change that breaks the actual data fails here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INFERABLE_INTENT_KINDS,
  RECORDABLE_INTENT_KINDS,
  inferDeviceIntent,
  resolveIntent,
} from "./device-intent.js";

// ─── the strong cases: a deliberate annotation ───────────────────────────────

test("a bracketed annotation is a STRONG match — the case that started this epic", () => {
  // LIVE. This device was offered a HIGH brightness restore at 0.9 confidence.
  const intent = inferDeviceIntent("SparkBridge (EoL)");
  assert.equal(intent?.kind, "eol");
  assert.equal(intent?.strength, "strong");
  assert.equal(intent?.source, "device-name");
  assert.equal(intent?.matchedText, "EoL");
  // The rationale must say it is an inference, every time, without exception.
  assert.match(intent!.rationale, /Inferred from the device NAME/);
  assert.match(intent!.rationale, /heuristic/);
});

test("square and curly brackets count too, and a non-token bracket does not", () => {
  assert.equal(inferDeviceIntent("SparkQ [RMA]")?.kind, "repair"); // LIVE
  assert.equal(inferDeviceIntent("SparkQ [RMA]")?.strength, "strong");
  // LIVE, and it must stay null: `Marc` is a person, not a purpose.
  assert.equal(inferDeviceIntent("Portable Spark2 [Marc]"), null);
  assert.equal(inferDeviceIntent("SparkBridge+ {Marc}"), null);
});

test("a name that IS the intent is strong; filler words do not dilute it", () => {
  assert.equal(inferDeviceIntent("Test")?.strength, "strong"); // LIVE
  assert.equal(inferDeviceIntent("Not Product")?.strength, "strong"); // LIVE
  // LIVE. "Unit" carries no identity, so this is still a whole-name statement.
  const travel = inferDeviceIntent("Travel Case Unit");
  assert.equal(travel?.kind, "demo-unit");
  assert.equal(travel?.strength, "strong");
  // Digits are not identity either.
  assert.equal(inferDeviceIntent("Test Device 2")?.strength, "strong");
});

test("the internal-account form is structural, so it is always strong", () => {
  const intent = inferDeviceIntent("stephen.jenkins@videri.com-6"); // LIVE
  assert.equal(intent?.kind, "internal-account");
  assert.equal(intent?.strength, "strong");
  // LIVE — prefixed variants must match on the suffix, not the whole string.
  assert.equal(
    inferDeviceIntent("Montreal Office-hugues.oliver@videri.com-1")?.kind,
    "internal-account",
  );
});

test("a PARTNER's account-form device is deliberately NOT ours", () => {
  // LIVE. `hunter@screenfeed.com-1` follows the same shape but belongs to a
  // partner on this tenant. Generalising the pattern to any `<email>-<n>` would
  // demote recommendations on somebody's real screen — the direction of error
  // that actually costs a customer money.
  assert.equal(inferDeviceIntent("hunter@screenfeed.com-1"), null);
});

// ─── the weak cases: a bare word, which may be a coincidence ─────────────────

test("a bare token among other words is WEAK, not strong", () => {
  for (const name of [
    "Lab TCL", // LIVE
    "Harbor Unit Repair 1", // LIVE
    "Lowes 3D Test", // LIVE
    "Bridge Test", // LIVE
    "Upgrade test", // LIVE
    "Spark2-proto", // LIVE
    "Spark2-EVT-office", // LIVE
  ]) {
    const intent = inferDeviceIntent(name);
    assert.ok(intent, `expected a match for ${name}`);
    assert.equal(intent.strength, "weak", `${name} should be weak`);
    // Weakness must be SAID, not merely recorded in a field.
    assert.match(intent.rationale, /prompt to check rather than a fact/);
  }
});

test("a weak match still produces a signal — demotion must not depend on strength", () => {
  // If weak matches returned null, `Lab TCL`, `Test` and `Harbor Unit Repair 1`
  // would all still be offered as one-click writes, which defeats the epic. The
  // strength is what the surface REPORTS, never a gate on whether we act.
  assert.notEqual(inferDeviceIntent("Lab TCL"), null);
});

// ─── the false positives. The whole reason this file exists. ─────────────────

test("SUBSTRING matches are refused — `Seoul` is not End of Life", () => {
  // The single most expensive possible bug in this module: `eol` sits inside
  // `Seoul`, so a substring matcher would demote every screen in a Korean office.
  assert.equal(inferDeviceIntent("Seoul Office Spark 4"), null);
  assert.equal(inferDeviceIntent("Seoul"), null);
});

test("SUBSTRING matches are refused — `test` inside a longer word", () => {
  for (const name of ["Latest Arrivals Screen", "Contest Kiosk", "Protest Wall", "Testa Center"]) {
    assert.equal(inferDeviceIntent(name), null, `${name} must not match`);
  }
});

test("SUBSTRING matches are refused — `lab` inside a longer word", () => {
  for (const name of ["Label Printer Display", "Labrador Retail Window", "Laboratoire 3"]) {
    assert.equal(inferDeviceIntent(name), null, `${name} must not match`);
  }
});

test("SUBSTRING matches are refused — a real fleet name that contains `QA`", () => {
  // LIVE. `QAreception05-sq-16` is a reception screen. `\bQA\b` does not match it
  // and must not start to.
  assert.equal(inferDeviceIntent("QAreception05-sq-16"), null);
});

test("the honest false positive: a production screen whose name says `Repair`", () => {
  // We ARE wrong about this one, and the design accounts for it rather than
  // pretending otherwise. `Repairs Desk Menu Board` is a perfectly good name for
  // a production screen in a phone-repair shop.
  const intent = inferDeviceIntent("Repairs Desk Menu Board");
  assert.equal(intent?.kind, "repair");
  // Two mitigations must both hold: it is WEAK, and the rationale says a
  // production screen can legitimately be named this.
  assert.equal(intent?.strength, "weak");
  assert.match(intent!.rationale, /a production screen can legitimately be named this/);
  // And the operator has a way out — see the `none` override test below.
});

test("nothing at all is the answer for an ordinary name, and for an empty one", () => {
  for (const name of ["Lobby North", "Spark 5", "Montreal Kitchen Left", "V4_1_Left_Pivot"]) {
    assert.equal(inferDeviceIntent(name), null, `${name} must not match`);
  }
  // A device with no name is not a device with no purpose — it is a device we
  // know nothing about, and `null` is the honest answer to both.
  assert.equal(inferDeviceIntent(null), null);
  assert.equal(inferDeviceIntent(undefined), null);
  assert.equal(inferDeviceIntent("   "), null);
});

// ─── precedence ──────────────────────────────────────────────────────────────

test("a strong match beats a weak one regardless of which kind is graver", () => {
  // `Lab` (bare, weak) vs `(EoL)` (bracketed, strong). EoL is also the graver
  // kind, so flip it: put the graver kind in the WEAK position.
  const intent = inferDeviceIntent("EoL candidate Sparkbridge (Lab)");
  assert.equal(intent?.kind, "lab");
  assert.equal(intent?.strength, "strong");
  // Nothing is lost — the other reading is published, not discarded.
  assert.deepEqual(intent?.alsoMatched, ["eol"]);
});

test("among equal strengths the more consequential kind wins, and the rest are published", () => {
  const intent = inferDeviceIntent("QA Lab - V2?"); // LIVE
  assert.equal(intent?.kind, "lab"); // lab outranks test
  assert.equal(intent?.strength, "weak");
  assert.deepEqual(intent?.alsoMatched, ["test"]);
  // The winner never appears in its own `alsoMatched`.
  assert.ok(!intent!.alsoMatched.includes("lab"));
});

test("the same name always yields the same verdict — stable across polls", () => {
  const a = inferDeviceIntent("Lab NEWISH Sparkbridge (EoL)");
  const b = inferDeviceIntent("Lab NEWISH Sparkbridge (EoL)");
  assert.deepEqual(a, b);
});

// ─── a REAL suppression outranks the heuristic (the required property) ───────

test("a recorded intent outranks the name, and is attributed rather than hedged", () => {
  const intent = resolveIntent("Lobby North", {
    kind: "lab",
    reason: "moved into the hardware lab on 2026-08-30",
    by: "api:sam",
    at: "2026-08-30T09:00:00.000Z",
  });
  assert.equal(intent?.kind, "lab");
  assert.equal(intent?.source, "operator");
  assert.equal(intent?.strength, "strong");
  // The distinguishing property: an operator's decision is NOT presented as an
  // inference, and it names them.
  assert.match(intent!.rationale, /Recorded by api:sam/);
  assert.doesNotMatch(intent!.rationale, /Inferred from the device NAME/);
});

test("a recorded intent of `none` beats even a screaming name — the override", () => {
  // This is the escape hatch for the honest false positive above. An operator
  // who has looked at the device and confirmed it is production must be able to
  // stop us demoting it, permanently, and be believed.
  assert.equal(
    resolveIntent("Repairs Desk Menu Board", {
      kind: "none",
      reason: "production screen at a phone-repair retailer; the name is the shop",
      by: "api:sam",
      at: "2026-09-01T09:00:00.000Z",
    }),
    null,
  );
  assert.equal(
    resolveIntent("SparkBridge (EoL)", {
      kind: "none",
      reason: "brought back into service; the suffix is stale and will be renamed",
      by: "api:sam",
      at: "2026-09-01T09:00:00.000Z",
    }),
    null,
  );
});

test("no recorded intent falls back to the name, and is not read as `none`", () => {
  // Absent must mean "nobody has recorded anything", never "this is production".
  assert.equal(resolveIntent("SparkBridge (EoL)", null)?.kind, "eol");
  assert.equal(resolveIntent("SparkBridge (EoL)", undefined)?.kind, "eol");
});

// ─── the vocabularies ────────────────────────────────────────────────────────

test("`none` can be recorded but can never be inferred", () => {
  // Inferring `none` would mean claiming a device is production because its name
  // is unremarkable, which we have no basis for.
  assert.ok(!INFERABLE_INTENT_KINDS.includes("none"));
  assert.ok(RECORDABLE_INTENT_KINDS.includes("none"));
  for (const kind of INFERABLE_INTENT_KINDS) {
    assert.ok(RECORDABLE_INTENT_KINDS.includes(kind), `${kind} must be recordable`);
  }
});

test("every inferable kind is actually reachable from some name", () => {
  // A vocabulary entry no name can produce is dead code pretending to be a
  // feature, and it would make the intent facet in the UI show an option that
  // never appears.
  const samples: Record<string, string> = {
    eol: "Spark 4 (EoL)",
    "not-product": "Not Product",
    repair: "Spark 4 (Repair)",
    prototype: "Spark2-proto",
    lab: "Lab TCL",
    test: "Bridge Test",
    "demo-unit": "Travel Case Unit",
    "internal-account": "someone@videri.com-1",
  };
  for (const kind of INFERABLE_INTENT_KINDS) {
    const sample = samples[kind];
    assert.ok(sample, `no sample name for ${kind}`);
    assert.equal(inferDeviceIntent(sample)?.kind, kind, `${sample} should infer ${kind}`);
  }
});
