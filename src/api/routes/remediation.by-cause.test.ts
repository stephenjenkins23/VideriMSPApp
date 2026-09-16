/**
 * `GET /api/remediation?since&previous` —
 * `node --test dist/api/routes/remediation.by-cause.test.js`
 *
 * The fold from a churn report into `summary.byCause` is asserted purely in
 * `intelligence/remediation.by-cause.test.ts`, and the cause ladder in
 * `intelligence/churn.test.ts`. What only the edge can get wrong, and what this
 * file guards, is the handling of a baseline that arrives on a query string:
 *
 *   - the QUEUE IS NEVER WITHHELD. Every baseline problem — no `since`, an
 *     unparseable one, no `previous`, too many ids, a query we could not parse,
 *     even a failure to read our own collection — is answered 200 with the full
 *     recommendation list and an explained null in `summary.byCause`. A 400 here
 *     would take an operator's work list away over an optional annotation;
 *   - no baseline problem is ever answered with a map of zeros;
 *   - an over-long baseline is REFUSED, not truncated, because a trimmed
 *     baseline reports departures that never happened;
 *   - an explicitly EMPTY `previous=` is a legitimate baseline ("I looked and the
 *     queue was empty"), so presence decides, not length.
 *
 * No database: the pool is a stub that answers the freshness query and the
 * observed-bucket query, and returns no rows for everything else, so the fleet
 * reads as empty. That is the shape needed to assert the baseline paths without
 * asserting anything about devices.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { Repository } from "../../db/repository.js";
import { buildServer } from "../server.js";

const TOKEN = "test-token-at-least-16-chars";
const auth = { authorization: `Bearer ${TOKEN}` };

/** A watermark an hour back: inside the 30-day ceiling and not in the future. */
const HOUR_AGO = () => new Date(Date.now() - 3600_000).toISOString();

type Collection = "watched" | "blind" | "unreadable";

const stubPool = (collection: Collection = "watched"): Pool =>
  ({
    async query(sql: string) {
      if (sql.includes("MAX(observed_at)")) {
        return { rows: [{ newest: new Date(Date.now() - 60_000) }], rowCount: 1 };
      }
      if (sql.includes("time_bucket") && sql.includes("DISTINCT")) {
        if (collection === "unreadable") throw new Error("connection terminated unexpectedly");
        if (collection === "blind") return { rows: [], rowCount: 0 };
        // One bucket per five minutes for the last two hours, so an hour-old
        // watermark yields a fully-observed window.
        const rows: Array<{ bucket: Date }> = [];
        for (let i = 0; i < 24; i += 1) rows.push({ bucket: new Date(Date.now() - i * 300_000) });
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  }) as unknown as Pool;

const stubRepo = (): Repository =>
  ({
    async listSuppressions() {
      return [];
    },
    async pollerRunHistory() {
      return [];
    },
  }) as unknown as Repository;

interface Body {
  data: {
    recommendations: unknown[];
    devicesConsidered: number;
    summary: {
      total: number;
      byCause: {
        available: boolean;
        value: Record<string, number> | null;
        problem: string | null;
        reason?: string;
        howToGet?: string;
        kind?: string;
        movement?: { from: number; to: number; net: number };
        baseline?: { observedAt: string; attestedBy: string; count: number };
        window?: { clearsGates: boolean };
        figure?: {
          value: Record<string, number>;
          basis: string;
          coverage: {
            measured: number;
            inScope: number;
            unit: string;
            share: number | null;
            note: string;
          };
        };
        headline?: string;
      };
    };
  };
  meta: { freshness: unknown };
}

const get = async (query = "", collection: Collection = "watched") => {
  const app = await buildServer({
    pool: stubPool(collection),
    repo: stubRepo(),
    auth: { token: TOKEN, allowAnonymous: false },
  });
  const response = await app.inject({
    method: "GET",
    url: `/api/remediation${query}`,
    headers: auth,
  });
  await app.close();
  return { statusCode: response.statusCode, body: response.json() as Body };
};

// ─── the default GET ─────────────────────────────────────────────────────────

test("a bare GET reports byCause as a no-baseline null and complains about nothing", async () => {
  const { statusCode, body } = await get();

  assert.equal(statusCode, 200);
  const block = body.data.summary.byCause;
  assert.equal(block.available, false);
  assert.equal(block.value, null);
  assert.equal(block.problem, "no-baseline");
  // A caller who asked for no diff must not be told off about a parameter they
  // never sent.
  assert.match(block.reason ?? "", /carried no baseline/);
  assert.match(block.howToGet ?? "", /since=/);
  assert.ok(body.meta.freshness, "a recommendation is never presented as live");
});

// ─── a usable baseline ───────────────────────────────────────────────────────

test("a usable baseline fills in the tally, the movement and the window it was measured under", async () => {
  const since = HOUR_AGO();
  const { statusCode, body } = await get(
    `?since=${encodeURIComponent(since)}&previous=${encodeURIComponent("dev-1::display-off")}`,
  );

  assert.equal(statusCode, 200);
  const block = body.data.summary.byCause;
  assert.equal(block.available, true);
  assert.equal(block.problem, null);
  assert.equal(block.kind, "auto-safe", "the default set is the one GAP-7 is about");
  assert.deepEqual(block.movement, { from: 1, to: 0, net: -1 });
  // The stub fleet is empty, so the device is not in the active-fleet query at
  // all — which is `device-retired`, not "fixed" and not "unreachable".
  assert.equal(block.value?.["device-retired"], 1);
  assert.equal(block.value?.applied, 0);
  assert.equal(block.baseline?.attestedBy, "caller", "it is the caller's read, labelled as such");
  assert.equal(block.baseline?.observedAt, since);
  assert.equal(block.window?.clearsGates, true);
});

test("the tally travels with its basis and coverage — no bare number on the wire", async () => {
  // The route-level half of the invariant the engine test pins: what the HTTP
  // payload carries, not only what the fold returns. Added when a deliberate
  // mutation of the shared `Figure<T>` (src/intelligence/figure.ts) was caught by
  // every other consumer of it and not by this file, which asserted `value` and
  // `movement` but never the coverage that is what makes `value` claimable.
  const { body } = await get(
    `?since=${encodeURIComponent(HOUR_AGO())}&previous=${encodeURIComponent("dev-1::display-off")}`,
  );
  const figure = body.data.summary.byCause.figure;
  assert.ok(figure, "an available tally is served with the figure it was read off");
  assert.ok(figure.basis.length > 20, "the basis is a sentence, not a label");
  assert.ok(figure.coverage, "the denominator travels with the number");
  assert.equal(figure.coverage.unit, "recommendations");
  assert.equal(typeof figure.coverage.measured, "number");
  assert.equal(typeof figure.coverage.inScope, "number");
  assert.ok(figure.coverage.note.length > 20, "and it says in words what it was measured over");
  // The convenient shallow read is the figure's own value, never a recount
  // beside it — the two cannot drift apart.
  assert.deepEqual(body.data.summary.byCause.value, figure.value);
});

test("an explicitly empty previous= is a baseline, not a missing one", async () => {
  const { body } = await get(`?since=${encodeURIComponent(HOUR_AGO())}&previous=`);
  const block = body.data.summary.byCause;
  assert.equal(block.available, true, "'I looked and the queue was empty' is a real read");
  assert.equal(block.movement?.from, 0);
});

test("the recommendation list is still the full list — asking about churn filters nothing", async () => {
  const { body } = await get(
    `?since=${encodeURIComponent(HOUR_AGO())}&previous=x::y&churnKind=manual`,
  );
  assert.equal(body.data.summary.byCause.kind, "manual");
  assert.equal(body.data.summary.total, body.data.recommendations.length);
  assert.equal(body.data.devicesConsidered, 0, "an empty list reads as 'nothing to do' with this");
});

// ─── every refusal keeps the queue and explains itself ───────────────────────

test("`previous` without `since` is an explained null, not a 400 and not zeros", async () => {
  const { statusCode, body } = await get("?previous=dev-1::display-off");

  assert.equal(statusCode, 200, "the work list is not withheld over an optional annotation");
  const block = body.data.summary.byCause;
  assert.equal(block.value, null);
  assert.equal(block.problem, "unusable-baseline");
  assert.match(block.reason ?? "", /without `since`/);
  assert.match(block.reason ?? "", /a guessed one would invent both/);
});

test("`since` without `previous` says why no snapshot can stand in for it", async () => {
  const { statusCode, body } = await get(`?since=${encodeURIComponent(HOUR_AGO())}`);

  assert.equal(statusCode, 200);
  const block = body.data.summary.byCause;
  assert.equal(block.value, null);
  assert.equal(block.problem, "unusable-baseline");
  assert.match(block.reason ?? "", /persist no/);
  assert.match(block.reason ?? "", /send the ids you held/);
});

test("an unparseable watermark is refused rather than defaulted, and the queue survives it", async () => {
  const { statusCode, body } = await get("?since=this%20morning&previous=dev-1::display-off");

  assert.equal(statusCode, 200);
  assert.equal(body.data.summary.byCause.value, null);
  assert.equal(body.data.summary.byCause.problem, "unusable-baseline");
  assert.match(body.data.summary.byCause.reason ?? "", /ISO-8601/);
  assert.ok(Array.isArray(body.data.recommendations));
});

test("a watermark in the future is refused, because 'since a moment that has not happened' has no answer", async () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  const { body } = await get(`?since=${encodeURIComponent(future)}&previous=dev-1::display-off`);
  assert.equal(body.data.summary.byCause.problem, "unusable-baseline");
  assert.match(body.data.summary.byCause.reason ?? "", /ahead of our observation instant/);
});

test("a baseline past the id cap is refused rather than trimmed, and points at the POST", async () => {
  const previous = Array.from({ length: 121 }, (_, i) => `d${i}::x`).join(",");
  const { statusCode, body } = await get(
    `?since=${encodeURIComponent(HOUR_AGO())}&previous=${encodeURIComponent(previous)}`,
  );

  assert.equal(statusCode, 200);
  assert.equal(body.data.summary.byCause.value, null);
  assert.match(body.data.summary.byCause.reason ?? "", /121 ids, past the 120/);
  assert.match(body.data.summary.byCause.reason ?? "", /Refused rather than trimmed/);
  assert.match(body.data.summary.byCause.reason ?? "", /\/api\/trends\/churn/);
});

test("an unparseable churn parameter names itself and leaves the list alone", async () => {
  const { statusCode, body } = await get(
    `?since=${encodeURIComponent(HOUR_AGO())}&previous=x::y&churnKind=everything`,
  );

  assert.equal(statusCode, 200);
  assert.equal(body.data.summary.byCause.problem, "unusable-baseline");
  assert.match(body.data.summary.byCause.reason ?? "", /churnKind/);
  assert.match(body.data.summary.byCause.reason ?? "", /list in this response is unaffected/);
});

// ─── our own collection is part of the answer ────────────────────────────────

test("a window we watched not at all yields null with the collector's reason, never zeros", async () => {
  const { body } = await get(
    `?since=${encodeURIComponent(HOUR_AGO())}&previous=dev-1::display-off`,
    "blind",
  );

  const block = body.data.summary.byCause;
  assert.equal(block.value, null, "zeros would turn our own blind spot into 'nothing happened'");
  assert.equal(block.problem, "unobserved-window");
  assert.match(block.reason ?? "", /No device reported at all between the two reads/);
  assert.match(block.reason ?? "", /gap in OUR collection, not a quiet fleet/);
});

test("a failure to read our own coverage is a null about US, not a fact about the fleet", async () => {
  const { statusCode, body } = await get(
    `?since=${encodeURIComponent(HOUR_AGO())}&previous=dev-1::display-off`,
    "unreadable",
  );

  assert.equal(statusCode, 200, "the queue is served even when the annotation cannot be");
  const block = body.data.summary.byCause;
  assert.equal(block.value, null);
  assert.equal(block.problem, "window-unreadable");
  assert.match(block.reason ?? "", /connection terminated unexpectedly/);
  assert.match(block.reason ?? "", /fault on our side, not a fact about your fleet/);
});
