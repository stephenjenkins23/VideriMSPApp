/**
 * Conditional-GET primitives — `node --test dist/api/etag.test.js`
 *
 * `routes/alerts.filters.test.ts` asserts the wiring (a 304 with no body, a tag
 * that moves with every filter). This file pins the three decisions underneath
 * it, because each one is a silent wrong answer if it is wrong:
 *
 *   - `ageSeconds` is the ONLY thing excluded from the validator. Exclude less
 *     and no 304 is ever possible; exclude more and a client can sit on a cached
 *     body whose freshness CLAIM has expired, which is stale data presented as
 *     current;
 *   - the digest is canonical, so two responses that differ only in key order
 *     share a tag and two that differ in a VALUE never do;
 *   - `If-None-Match` is compared WEAKLY, per RFC 9110 §8.8.3.2.
 *
 * Pure functions only. No server, no pool, no clock.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { etagFor, ifNoneMatchSatisfied, stableStringify } from "./etag.js";
import type { Freshness } from "./freshness.js";

const freshness = (over: Partial<Freshness> = {}): Freshness => ({
  newestSampleAt: "2026-09-16T11:59:00.000Z",
  ageSeconds: 60,
  state: "fresh",
  pollers: [
    { poller: "metrics", lastRunAt: "2026-09-16T11:58:00.000Z", lastDurationMs: 900,
      batchesFailed: 0, telemetryYield: 0 },
  ],
  warnings: [],
  ...over,
});

const envelope = (data: unknown, over: Partial<Freshness> = {}) => ({
  data,
  meta: { freshness: freshness(over), page: { page: 1, limit: 50, totalItems: 1, totalPages: 1 } },
});

const key = { route: "GET /api/alerts", params: { band: "all" } };

// ─── canonicalisation ────────────────────────────────────────────────────────

test("key order does not change the digest, but a value does", () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  assert.notEqual(stableStringify({ a: 1, b: 2 }), stableStringify({ a: 1, b: 3 }));
  // Nested, since a response is nested.
  assert.equal(
    stableStringify({ x: { p: 1, q: [1, { m: 1, n: 2 }] } }),
    stableStringify({ x: { q: [1, { n: 2, m: 1 }] , p: 1 } }),
  );
});

test("array ORDER is significant — a re-sorted page is a different answer", () => {
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
});

test("an omitted key and an explicit undefined are the same response", () => {
  // Zod fills an unsupplied optional filter with undefined, and JSON.stringify
  // drops it. Treating the two differently would give one answer two tags and a
  // cache that never hits.
  assert.equal(stableStringify({ a: 1, q: undefined }), stableStringify({ a: 1 }));
  // But not in an array, where JSON.stringify writes null.
  assert.equal(stableStringify([undefined]), "[null]");
});

test("null, 0, false and \"\" are all distinguishable — honest nulls stay honest", () => {
  const digests = [null, 0, false, "", "0", "null"].map((v) => stableStringify({ v }));
  assert.equal(new Set(digests).size, digests.length,
    "a null that could not be read must never share a digest with a zero");
});

// ─── what the validator covers ───────────────────────────────────────────────

test("ageSeconds alone does NOT change the validator", () => {
  // The one field that is a pure function of the clock. If it counted, every
  // read would produce a new tag and the 304 path would be dead code.
  assert.equal(
    etagFor(key, envelope([{ id: "a" }], { ageSeconds: 60 })),
    etagFor(key, envelope([{ id: "a" }], { ageSeconds: 61.5 })),
  );
});

test("every OTHER freshness field does change it", () => {
  const base = etagFor(key, envelope([{ id: "a" }]));
  const variants: Array<[string, Partial<Freshness>]> = [
    // A new sample is new data, even if this page's rows happen to be identical.
    ["newestSampleAt", { newestSampleAt: "2026-09-16T12:05:00.000Z" }],
    // fresh → lagging → stale is the claim the UI renders. A client must not sit
    // on a cached body that says "fresh" once it no longer is.
    ["state", { state: "lagging" }],
    // The warnings quote the age in whole minutes, so the minute rolling over on
    // a stale-data warning re-issues the body with the corrected sentence.
    ["warnings", { warnings: ["Newest reading is 21 minutes old."] }],
    ["poller run time", { pollers: [{ poller: "metrics", lastRunAt: "2026-09-16T12:00:00.000Z",
                                      lastDurationMs: 900, batchesFailed: 0, telemetryYield: 0 }] }],
    ["failed batches", { pollers: [{ poller: "metrics", lastRunAt: "2026-09-16T11:58:00.000Z",
                                     lastDurationMs: 900, batchesFailed: 3, telemetryYield: 0 }] }],
  ];
  for (const [what, over] of variants) {
    assert.notEqual(etagFor(key, envelope([{ id: "a" }], over)), base,
      `${what} must move the validator`);
  }
});

test("the data changes it, down to one field of one row", () => {
  const base = etagFor(key, envelope([{ id: "a", severity: "critical" }]));
  assert.notEqual(etagFor(key, envelope([{ id: "a", severity: "high" }])), base);
  assert.notEqual(etagFor(key, envelope([])), base);
  assert.notEqual(etagFor(key, envelope([{ id: "a", severity: "critical" }, { id: "b" }])), base);
});

test("the page block changes it — page 2 of the same filter is not page 1", () => {
  const one = envelope([{ id: "a" }]);
  const two = { ...one, meta: { ...one.meta, page: { ...one.meta.page, page: 2 } } };
  assert.notEqual(etagFor(key, two), etagFor(key, one));
});

test("the request parameters change it even when the body is identical", () => {
  // Two filters that both match nothing return the same empty body. Without the
  // params in the seed they would share a tag, and a client switching between
  // them would be told its copy is current — which it is, by accident, today and
  // not tomorrow.
  const empty = envelope([]);
  const a = etagFor({ route: "GET /api/alerts", params: { q: "lobby" } }, empty);
  const b = etagFor({ route: "GET /api/alerts", params: { q: "kitchen" } }, empty);
  assert.notEqual(a, b);
});

test("the route changes it, so two empty collections are not interchangeable", () => {
  const empty = envelope([]);
  assert.notEqual(
    etagFor({ route: "GET /api/alerts" }, empty),
    etagFor({ route: "GET /api/alerts/rules" }, empty),
  );
});

test("a payload that is not an envelope is still hashed whole", () => {
  // Defensive: the seed strips one known path and must not depend on finding it.
  assert.notEqual(etagFor(key, { anything: 1 }), etagFor(key, { anything: 2 }));
  assert.equal(etagFor(key, null), etagFor(key, null));
});

test("the tag is a weak validator of fixed width", () => {
  assert.match(etagFor(key, envelope([])), /^W\/"[0-9a-f]{32}"$/);
});

// ─── If-None-Match ───────────────────────────────────────────────────────────

test("weak comparison: the W/ prefix is ignored on both sides", () => {
  const tag = 'W/"abc123"';
  assert.ok(ifNoneMatchSatisfied(tag, tag));
  assert.ok(ifNoneMatchSatisfied('"abc123"', tag));
  assert.ok(ifNoneMatchSatisfied('w/"abc123"', tag));
  assert.ok(ifNoneMatchSatisfied(' W/"abc123" ', tag));
});

test("a list is matched member by member, and `*` matches anything", () => {
  const tag = 'W/"abc123"';
  assert.ok(ifNoneMatchSatisfied('W/"zzz", W/"abc123"', tag));
  assert.ok(ifNoneMatchSatisfied("*", tag));
  assert.ok(ifNoneMatchSatisfied(["W/\"zzz\"", "W/\"abc123\""], tag));
});

test("anything else is NOT a match — the body is served", () => {
  const tag = 'W/"abc123"';
  assert.equal(ifNoneMatchSatisfied(undefined, tag), false);
  assert.equal(ifNoneMatchSatisfied("", tag), false);
  assert.equal(ifNoneMatchSatisfied('W/"abc124"', tag), false);
  // A near-miss must not match: quotes are part of the token.
  assert.equal(ifNoneMatchSatisfied("abc123", tag), false);
  assert.equal(ifNoneMatchSatisfied('W/"abc12"', tag), false);
});
