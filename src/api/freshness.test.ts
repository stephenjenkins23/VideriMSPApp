/**
 * Freshness unit tests — `node --test dist/api/freshness.test.js`
 *
 * Drives getFreshness() against a hand-stubbed Pool (no pg, no network) so the
 * state-banding thresholds, the "stale fact about a dormant poller" guard, and
 * the empty-feed warning can be pinned at the exact boundaries the API-level
 * tests only sample. Every test is named by the behavior it protects.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { getFreshness, envelope, type Freshness } from "./freshness.js";

interface PollerRow {
  poller: string;
  started_at: Date;
  duration_ms: number;
  batches_failed: number;
  telemetry_yield: number | null;
}

interface StubOpts {
  /** Age of the newest health sample, in seconds. null = no samples at all. */
  newestAgeSeconds?: number | null;
  pollerRows?: PollerRow[];
}

/** A Pool whose two queries getFreshness issues are answered from opts. */
function stubPool(opts: StubOpts = {}): Pool {
  const { newestAgeSeconds = 30, pollerRows = [] } = opts;
  return {
    async query(sql: string) {
      if (sql.includes("MAX(observed_at)")) {
        return {
          rows: [{
            newest: newestAgeSeconds === null ? null : new Date(Date.now() - newestAgeSeconds * 1000),
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM poller_runs")) {
        return { rows: pollerRows, rowCount: pollerRows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
}

const metricsRun = (over: Partial<PollerRow> = {}): PollerRow => ({
  poller: "metrics",
  started_at: new Date(Date.now() - 60_000),
  duration_ms: 4200,
  batches_failed: 0,
  telemetry_yield: 0.9,
  ...over,
});

// ─── state banding ────────────────────────────────────────────────────────────

test("a recent sample is fresh, with no staleness warning", async () => {
  const f = await getFreshness(stubPool({ newestAgeSeconds: 30 }));
  assert.equal(f.state, "fresh");
  assert.ok(f.ageSeconds !== null && f.ageSeconds >= 0);
  assert.ok(!f.warnings.some((w) => /old/.test(w)), "fresh data must not warn about age");
});

test("just past 5 minutes is lagging, not yet stale", async () => {
  const f = await getFreshness(stubPool({ newestAgeSeconds: 5 * 60 + 5 }));
  assert.equal(f.state, "lagging");
  assert.ok(f.warnings.some((w) => w.includes("minutes old")));
  assert.ok(!f.warnings.some((w) => w.includes("historical")), "lagging is not yet 'historical'");
});

test("a sample inside the 5-minute window is still fresh (a single missed tick is normal)", async () => {
  const f = await getFreshness(stubPool({ newestAgeSeconds: 5 * 60 - 1 }));
  assert.equal(f.state, "fresh");
});

test("past 20 minutes is stale and labelled historical", async () => {
  const f = await getFreshness(stubPool({ newestAgeSeconds: 20 * 60 + 5 }));
  assert.equal(f.state, "stale");
  assert.ok(
    f.warnings.some((w) => w.includes("historical")),
    "stale data must tell the operator to treat the page as historical",
  );
});

test("no samples at all is 'unknown', not 'fresh' and not an age of zero", async () => {
  const f = await getFreshness(stubPool({ newestAgeSeconds: null }));
  assert.equal(f.state, "unknown");
  assert.equal(f.newestSampleAt, null);
  assert.equal(f.ageSeconds, null, "unknown age is null, never 0");
  assert.ok(f.warnings.some((w) => w.includes("never")), "must say the poller never ran/succeeded");
});

// ─── the empty-bulk-feed warning ──────────────────────────────────────────────

test("a metrics poller with zero telemetry yield explains the empty feed and points to per-device reads", async () => {
  const f = await getFreshness(stubPool({ pollerRows: [metricsRun({ telemetry_yield: 0 })] }));
  const w = f.warnings.find((x) => x.includes("carries no hardware telemetry"));
  assert.ok(w, "a 0% yield must be explained, not left as silently empty tiles");
  assert.match(w!, /per-device on demand/, "and must point to the on-demand per-device read");
});

test("a healthy telemetry yield produces no empty-feed warning", async () => {
  const f = await getFreshness(stubPool({ pollerRows: [metricsRun({ telemetry_yield: 0.9 })] }));
  assert.ok(!f.warnings.some((w) => w.includes("carries no hardware telemetry")));
});

test("once the slow lane is collecting, the empty-tiles warning is replaced by a coverage-building note", async () => {
  // Batch metrics still carry nothing (yield 0), but a telemetry-slowlane poller
  // has run with a yield — so the honest message is "collected per-device by the
  // slow lane, building", not "tiles are empty".
  const f = await getFreshness(
    stubPool({
      pollerRows: [
        metricsRun({ telemetry_yield: 0 }),
        metricsRun({ poller: "telemetry-slowlane", telemetry_yield: 0.8 }),
      ],
    }),
  );
  assert.ok(
    !f.warnings.some((w) => w.includes("carries no hardware telemetry")),
    "the misleading empty-tiles message must not appear once the slow lane collects",
  );
  const w = f.warnings.find((x) => x.includes("collected per-device by the slow-lane"));
  assert.ok(w, "must explain that hardware telemetry is now collected per-device by the slow lane");
  assert.match(w!, /fabricated zero/, "and must keep the null-not-zero honesty");
});

test("a slow-lane poller that has never produced a yield does not suppress the empty-feed warning", async () => {
  // telemetry_yield null = it ran but recorded no yield (or never ran usefully),
  // so we must NOT claim coverage; the honest empty-feed message still applies.
  const f = await getFreshness(
    stubPool({
      pollerRows: [
        metricsRun({ telemetry_yield: 0 }),
        metricsRun({ poller: "telemetry-slowlane", telemetry_yield: null }),
      ],
    }),
  );
  assert.ok(
    f.warnings.some((w) => w.includes("carries no hardware telemetry")),
    "a slow lane with no recorded yield must not be treated as collecting",
  );
});

// ─── failed-batch warnings carry their age ────────────────────────────────────

test("a recent failed batch warns AND states how long ago the run was", async () => {
  const f = await getFreshness(stubPool({
    pollerRows: [metricsRun({ poller: "data-usage", batches_failed: 250, started_at: new Date(Date.now() - 90_000) })],
  }));
  const w = f.warnings.find((x) => x.includes("data-usage"));
  assert.ok(w, "a recent failure must surface");
  assert.match(w!, /just now|\d+ min ago/, "the warning must carry the run's age");
});

test("a failed batch on a run older than 24h is NOT warned as a current fault", async () => {
  // The dormant data-usage poller's one manual run kept resurfacing for days.
  const f = await getFreshness(stubPool({
    pollerRows: [metricsRun({
      poller: "data-usage", batches_failed: 250,
      started_at: new Date(Date.now() - 3 * 86_400_000),
    })],
  }));
  assert.ok(
    !f.warnings.some((w) => w.includes("data-usage")),
    "a 3-day-old failure must not present as a current fault",
  );
});

test("a poller run that succeeded produces no failed-batch warning", async () => {
  const f = await getFreshness(stubPool({ pollerRows: [metricsRun({ batches_failed: 0 })] }));
  assert.ok(!f.warnings.some((w) => w.includes("failed batch")));
});

test("per-poller rows are surfaced with their last run and yield", async () => {
  const f = await getFreshness(stubPool({ pollerRows: [metricsRun({ telemetry_yield: 0.42 })] }));
  const p = f.pollers.find((x) => x.poller === "metrics");
  assert.ok(p);
  assert.equal(p!.telemetryYield, 0.42);
  assert.equal(typeof p!.lastRunAt, "string");
  assert.equal(p!.batchesFailed, 0);
});

// ─── the envelope helper ──────────────────────────────────────────────────────

const dummyFreshness: Freshness = {
  newestSampleAt: null, ageSeconds: null, state: "unknown", pollers: [], warnings: [],
};

test("envelope wraps data and freshness, and omits the page block when not paginated", () => {
  const e = envelope({ hello: "world" }, dummyFreshness);
  assert.deepEqual(e.data, { hello: "world" });
  assert.equal(e.meta.freshness, dummyFreshness);
  assert.ok(!("page" in e.meta), "no page key on a non-paginated response");
});

test("envelope includes the page block verbatim when given one", () => {
  const page = { page: 2, limit: 50, totalItems: 137, totalPages: 3 };
  const e = envelope([1, 2, 3], dummyFreshness, page);
  assert.deepEqual(e.meta.page, page);
});
