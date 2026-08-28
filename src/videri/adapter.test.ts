/**
 * Adapter tests — `node --test dist/videri/adapter.test.js`
 *
 * The adapter is the only file allowed to touch Videri's untyped payloads, so it
 * is where malformed real-world data must be stopped.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { clampObservedAt, parseMetafields, cityFrom } from "./adapter.js";

// ─────────────────────────────────────────────────────────────────────────────
// Device clocks are not trustworthy
//
// Live finding: SparkQ+ "IST Q" (device 1029524) reported `2085-01-02` on
// 2026-08-25. Stored verbatim it became the permanently newest sample and made
// the fleet's telemetry-age statistic negative (~-58 years).
// ─────────────────────────────────────────────────────────────────────────────

test("a future-dated device timestamp falls back to ingest time", () => {
  const now = new Date("2026-08-25T18:00:00Z");
  const got = clampObservedAt("2085-01-02T04:35:13.588Z", now);
  assert.equal(got.getTime(), now.getTime());
});

test("normal clock drift is preserved, not rewritten", () => {
  const now = new Date("2026-08-25T18:00:00Z");
  const drifted = "2026-08-25T18:02:00.000Z"; // 2 min ahead, within tolerance
  assert.equal(clampObservedAt(drifted, now).toISOString(), drifted);
});

test("a past timestamp is always kept as reported", () => {
  const now = new Date("2026-08-25T18:00:00Z");
  const past = "2026-08-25T17:40:00.000Z";
  assert.equal(clampObservedAt(past, now).toISOString(), past);
});

test("missing or unparseable timestamps become ingest time, never NaN", () => {
  const now = new Date("2026-08-25T18:00:00Z");
  for (const bad of [null, undefined, "", "unavailable", "not-a-date"]) {
    const got = clampObservedAt(bad, now);
    assert.ok(!Number.isNaN(got.getTime()), `${String(bad)} produced an invalid Date`);
    assert.equal(got.getTime(), now.getTime());
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// Tenant-defined metafields — the only fleet-wide location source
//
// geo.coordinates reaches 35% of devices; metadata[] reaches 250 of 250 and
// carries CITY on every one. But the vocabulary belongs to the tenant, not to
// the platform, so nothing here may assume a key exists.
// ─────────────────────────────────────────────────────────────────────────────

const meta = (pairs: Array<[string, unknown]>) =>
  pairs.map(([metafieldName, value]) => ({ metafieldName, value }));

test("metafields flatten to a name/value map", () => {
  const got = parseMetafields(meta([["NAME", "NORWICH"], ["CITY", "LONDON"]]));
  assert.deepEqual(got, { NAME: "NORWICH", CITY: "LONDON" });
});

test("city is extracted case-insensitively", () => {
  // This tenant uses CITY. Another using "City" must not silently lose its
  // fleet geography, because the vocabulary is not a contract.
  assert.equal(cityFrom(meta([["CITY", "LONDON"]])), "LONDON");
  assert.equal(cityFrom(meta([["City", "Paris"]])), "Paris");
  assert.equal(cityFrom(meta([["city", "Berlin"]])), "Berlin");
});

test("a device with no city yields null, not a guess", () => {
  assert.equal(cityFrom(meta([["NAME", "Lobby"], ["Zone", "A"]])), null);
  assert.equal(cityFrom([]), null);
  assert.equal(cityFrom(null), null);
  assert.equal(cityFrom(undefined), null);
});

test("absent and sentinel values are dropped, never stored as text", () => {
  const got = parseMetafields(meta([
    ["A", null], ["B", ""], ["C", "unavailable"], ["D", "real"],
  ]));
  assert.deepEqual(got, { D: "real" });
  assert.equal(cityFrom(meta([["CITY", "unavailable"]])), null);
});

test("duplicate metafield names keep the first, not the last", () => {
  // Two CITY entries is a data-entry fault. Silently preferring the last would
  // make the choice invisible to whoever has to fix it.
  assert.deepEqual(parseMetafields(meta([["CITY", "LONDON"], ["CITY", "PARIS"]])),
    { CITY: "LONDON" });
});

test("malformed metadata never throws", () => {
  // The field is untyped in practice; a parser that throws takes the whole
  // device sync down with it.
  for (const bad of [null, undefined, "string", 42, {}, [null], [{}], [{ value: "x" }]]) {
    assert.doesNotThrow(() => parseMetafields(bad as never));
    assert.doesNotThrow(() => cityFrom(bad as never));
  }
  assert.deepEqual(parseMetafields([{ value: "no name" }] as never), {});
});

test("values are trimmed but not otherwise normalised", () => {
  // Normalising case here would fight the tenant's own vocabulary; the UI can
  // group case-insensitively without us rewriting their data.
  assert.equal(cityFrom(meta([["CITY", "  LONDON  "]])), "LONDON");
  assert.equal(cityFrom(meta([["CITY", "New York"]])), "New York");
});
