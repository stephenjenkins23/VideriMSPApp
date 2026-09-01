/**
 * Black-screen verdict tests — `node --test dist/intelligence/screen-verify.test.js`
 *
 * All four branches, and the null cases in each. The one that matters most is
 * `unanswered`: silence must never be scored as agreement (which would keep
 * shipping the unverified CRITICAL) or as disagreement (which would suppress a
 * real one).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyBlackScreenClaim } from "./screen-verify.js";

const PLATFORM_AT = "2026-09-01T13:30:00.000Z";
const DEVICE_AT = "2026-09-01T14:02:11.000Z";

const claimsBlack = { isBlackScreen: true, observedAt: PLATFORM_AT };

test("platform claims black and the panel agrees → confirmed", () => {
  const r = verifyBlackScreenClaim(claimsBlack, { isBlack: true, observedAt: DEVICE_AT });
  assert.equal(r.verdict, "confirmed");
  assert.match(r.detail, /is_black_screen=true at 2026-09-01T13:30:00\.000Z/);
  assert.match(r.detail, /is_blackscreen=true at 2026-09-01T14:02:11\.000Z/);
});

test("platform claims black and the panel says it is not → contradicted", () => {
  // The motivating case: device 1000152, platform true for 25+ minutes, panel
  // lit and serving a dashboard.
  const r = verifyBlackScreenClaim(claimsBlack, { isBlack: false, observedAt: DEVICE_AT });
  assert.equal(r.verdict, "contradicted");
  assert.match(r.detail, /but the panel itself answered is_blackscreen=false/);
  assert.match(r.detail, /at 2026-09-01T14:02:11\.000Z/);
});

test("platform claims black and the panel did not answer → unanswered", () => {
  const r = verifyBlackScreenClaim(claimsBlack, { isBlack: null, observedAt: DEVICE_AT });
  assert.equal(r.verdict, "unanswered");
  assert.match(r.detail, /did not answer is_blackscreen/);
  assert.match(r.detail, /neither confirmed nor refuted/);
  // Silence is not a reading in either direction.
  assert.doesNotMatch(r.detail, /is_blackscreen=(true|false)/);
});

test("platform does not claim black → no-claim", () => {
  const r = verifyBlackScreenClaim(
    { isBlackScreen: false, observedAt: PLATFORM_AT },
    { isBlack: false, observedAt: DEVICE_AT },
  );
  assert.equal(r.verdict, "no-claim");
  assert.match(r.detail, /does not report a black screen/);
  assert.match(r.detail, /no black-screen claim to verify/);
});

test("no readable platform sample is no-claim, not a claim of health", () => {
  const r = verifyBlackScreenClaim(
    { isBlackScreen: null, observedAt: null },
    { isBlack: null, observedAt: DEVICE_AT },
  );
  assert.equal(r.verdict, "no-claim");
  assert.match(r.detail, /no readable is_black_screen sample/);
  // Nothing was observed about the panel, so nothing is asserted about it.
  assert.doesNotMatch(r.detail, /is_blackscreen=/);
});

test("a claim with no recorded time says so instead of inventing one", () => {
  const r = verifyBlackScreenClaim(
    { isBlackScreen: true, observedAt: null },
    { isBlack: true, observedAt: null },
  );
  assert.equal(r.verdict, "confirmed");
  assert.match(r.detail, /at an unrecorded time/);
  assert.doesNotMatch(r.detail, /\d{4}-\d{2}-\d{2}/, "no fabricated timestamp");
});

test("the logo reading rides along only when the panel answered it", () => {
  const known = verifyBlackScreenClaim(claimsBlack, {
    isBlack: false, isShowingLogo: true, observedAt: DEVICE_AT,
  });
  assert.equal(known.verdict, "contradicted");
  assert.match(known.detail, /showing the logo rather than content/);

  const notLogo = verifyBlackScreenClaim(claimsBlack, {
    isBlack: false, isShowingLogo: false, observedAt: DEVICE_AT,
  });
  assert.match(notLogo.detail, /not showing the logo/);

  const silent = verifyBlackScreenClaim(claimsBlack, {
    isBlack: false, isShowingLogo: null, observedAt: DEVICE_AT,
  });
  assert.doesNotMatch(silent.detail, /logo/, "an unanswered verb produces no sentence");
});

test("the detail never restates the platform claim as fact", () => {
  // The failure mode this module exists to stop: "Screen is black" asserted
  // because the platform said so. Every mention must be attributed.
  for (const answer of [true, false, null]) {
    const r = verifyBlackScreenClaim(claimsBlack, { isBlack: answer, observedAt: DEVICE_AT });
    assert.match(r.detail, /^The platform reported is_black_screen=true/);
  }
});
