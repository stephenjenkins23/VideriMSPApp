/**
 * `POST /api/trends/churn` route contract —
 * `node --test dist/api/routes/trends.churn.test.js`
 *
 * The churn BODY is asserted purely in `intelligence/churn.test.ts`. What is left,
 * and what this file guards, is the one thing only the edge can get wrong: the
 * watermark. A watermark that is defaulted, coerced, or silently treated as "the
 * beginning of time" turns this endpoint into a machine for reporting the whole
 * queue as new, which is the exact bug US-8.6.4 was written against. So:
 *
 *   - MISSING is answered 200 as a labelled first look with a NULL new-count —
 *     not an error, because a tech who has never looked has asked a fair
 *     question, and not a diff, because there is nothing to diff against;
 *   - every other malformed watermark is a 400 that names the problem and says
 *     what the watermark is measured against;
 *   - a watermark with no prior set is a 400, because no recommendation snapshot
 *     is stored and answering it would mean inventing the caller's baseline.
 *
 * No database: the pool is a stub that answers the freshness query and returns no
 * rows for everything else, so the fleet reads as empty. That is the shape needed
 * to assert the watermark paths without asserting anything about devices.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { Repository } from "../../db/repository.js";
import { buildServer } from "../server.js";

const TOKEN = "test-token-at-least-16-chars";
const auth = { authorization: `Bearer ${TOKEN}` };

const stubPool = (): Pool =>
  ({
    async query(sql: string) {
      if (sql.includes("MAX(observed_at)")) {
        return { rows: [{ newest: new Date(Date.now() - 60_000) }], rowCount: 1 };
      }
      // The churn window's observed buckets: one per five minutes for the last
      // two hours, so a recent watermark produces a fully-observed window.
      if (sql.includes("time_bucket") && sql.includes("DISTINCT")) {
        const rows: Array<{ bucket: Date }> = [];
        for (let i = 0; i < 24; i += 1) {
          rows.push({ bucket: new Date(Date.now() - i * 300_000) });
        }
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

const post = async (body: unknown) => {
  const app = await buildServer({
    pool: stubPool(),
    repo: stubRepo(),
    auth: { token: TOKEN, allowAnonymous: false },
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/trends/churn",
    headers: auth,
    payload: body as Record<string, unknown>,
  });
  await app.close();
  return response;
};

test("no watermark is a labelled first look with a null new-count, not an error and not a diff", async () => {
  const response = await post({});
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    data: { firstLook: boolean; newSince: null; newSinceReason: string; watermark: { problem: string } };
  };
  assert.equal(body.data.firstLook, true);
  assert.equal(body.data.newSince, null);
  assert.equal(body.data.watermark.problem, "missing");
  assert.match(body.data.newSinceReason, /null/);
});

test("an unparseable watermark is refused, and the error says what a watermark is", async () => {
  const response = await post({ since: "this morning", previous: [] });
  assert.equal(response.statusCode, 400);
  const body = response.json() as { problem: string; message: string; watermarkBasis: string };
  assert.equal(body.problem, "unparseable");
  assert.match(body.message, /ISO-8601/);
  assert.match(body.message, /would report the whole set as new/);
  assert.match(body.watermarkBasis, /absolute instant/);
});

test("a watermark in the future is refused rather than clamped to now", async () => {
  const response = await post({
    since: new Date(Date.now() + 3600_000).toISOString(),
    previous: [],
  });
  assert.equal(response.statusCode, 400);
  assert.equal((response.json() as { problem: string }).problem, "in-the-future");
});

test("a watermark past the age ceiling is refused, and the ceiling is published", async () => {
  const response = await post({
    since: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    previous: [],
  });
  assert.equal(response.statusCode, 400);
  const body = response.json() as { problem: string; maxAgeDays: number };
  assert.equal(body.problem, "older-than-ceiling");
  assert.equal(body.maxAgeDays, 30);
});

test("a watermark with no prior set is refused, because no snapshot of the set is stored", async () => {
  const response = await post({ since: new Date(Date.now() - 3600_000).toISOString() });
  assert.equal(response.statusCode, 400);
  const body = response.json() as { problem: string; message: string };
  assert.equal(body.problem, "no-prior-set");
  assert.match(body.message, /persist no/);
  assert.match(body.message, /send the ids you held/);
});

test("a usable watermark returns a diff that states its own window coverage and freshness", async () => {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const response = await post({ since, previous: [{ id: "dev-1::display-off", severity: "high" }] });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    data: {
      kind: string;
      reads: { previous: { attestedBy: string; count: number }; current: { attestedBy: string } };
      window: { clearsGates: boolean; observation: { collectorCoverage: number } };
      movement: { value: { from: number; to: number }; basis: string };
      byCause: { value: Record<string, number>; coverage: { inScope: number } };
      left: Array<{ cause: string | null }>;
      watermark: { supplied: string; resolved: string; basis: string };
      basis: string;
    };
    meta: { freshness: unknown };
  };
  assert.equal(body.data.kind, "auto-safe");
  // The caller's read is attested and labelled as such — we cannot verify it.
  assert.equal(body.data.reads.previous.attestedBy, "caller");
  assert.equal(body.data.reads.current.attestedBy, "self");
  assert.equal(body.data.reads.previous.count, 1);
  assert.equal(body.data.movement.value.from, 1);
  assert.equal(body.data.movement.value.to, 0, "the stub fleet is empty");
  assert.equal(body.data.byCause.coverage.inScope, body.data.left.length);
  assert.equal(body.data.left[0]?.cause, "device-retired", "no device, so nothing to look at");
  assert.equal(body.data.watermark.supplied, since);
  assert.ok(body.data.window.observation.collectorCoverage !== undefined);
  assert.match(body.data.basis, /diff, not the queue/);
  assert.ok(body.meta.freshness, "a churn figure is never presented as live");
});

test("a prior set larger than the cap is refused rather than truncated", async () => {
  // Minimal ids so the body stays under the server's 64 KB limit and the cap is
  // what refuses it, rather than the transport.
  const previous = Array.from({ length: 3001 }, (_, i) => ({ id: `d${i}::x` }));
  const response = await post({ since: new Date(Date.now() - 3600_000).toISOString(), previous });
  assert.equal(response.statusCode, 400);
  assert.match((response.json() as { message: string }).message, /previous/);
});
