/**
 * `GET /api/reports/estate` and `/api/reports/sites` route contract —
 * `node --test dist/api/routes/reports.http.test.js`
 *
 * The report BODY is asserted in reports.test.ts, purely. What is left, and what
 * this file guards, is the contract at the edge — the places where a report can
 * be produced for the wrong thing and still look right:
 *
 *   - a report served without a scope would be the fleet-wide blob we already
 *     have (GAP-11), so `scope=site` with no `siteId` is refused rather than
 *     quietly widened;
 *   - a `siteId` handed alongside `scope=fleet` would produce a fleet report with
 *     a customer's name on it. Refused;
 *   - `format=csv` cannot carry a nested document, so it must name a section
 *     rather than silently pick one;
 *   - a closed window is refused (`from >= to`) and the ceiling is enforced;
 *   - with no credentials the site axis is unreadable: the endpoint must still
 *     serve 200 and SAY the hierarchy could not be read, because a 500 here
 *     looks like an outage and an empty 200 looks like a customer with no screens.
 *
 * No database: the pool is a stub that answers the freshness query and returns
 * no rows for everything else, so the fleet reads as empty. That is exactly the
 * shape needed to assert the honest-empty and disclosure paths.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { Repository } from "../../db/repository.js";
import { buildServer } from "../server.js";
import { CSV_SECTIONS } from "./reports.js";

const TOKEN = "test-token-at-least-16-chars";
const auth = { authorization: `Bearer ${TOKEN}` };

const stubPool = (): Pool =>
  ({
    async query(sql: string) {
      if (sql.includes("MAX(observed_at)")) {
        return { rows: [{ newest: new Date(Date.now() - 60_000) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  }) as unknown as Pool;

const stubRepo = (): Repository =>
  ({
    async listDeviceActions() {
      return { items: [], totalItems: 0, oldestAt: null, newestAt: null };
    },
    async deviceActionLogSize() {
      return 0;
    },
    async pollerRunHistory() {
      return [];
    },
    async screenshotTargets() {
      return [];
    },
  }) as unknown as Repository;

const get = async (query: string) => {
  const app = await buildServer({
    pool: stubPool(),
    repo: stubRepo(),
    auth: { token: TOKEN, allowAnonymous: false },
  });
  const response = await app.inject({ method: "GET", url: `/api/reports/estate${query}`, headers: auth });
  await app.close();
  return response;
};

test("a report with no scope is refused rather than silently served fleet-wide", async () => {
  const response = await get("");
  assert.equal(response.statusCode, 400);
  const body = response.json() as { message: string };
  assert.match(body.message, /`siteId` is required for scope=site/);
  assert.match(body.message, /\/api\/reports\/sites/, "the error tells the caller where the ids are");
  assert.match(body.message, /scope=unplaced/, "and that the site-less screens are reportable");
});

test("a siteId alongside a non-site scope is refused, not ignored", async () => {
  for (const scope of ["fleet", "unplaced"]) {
    const response = await get(`?scope=${scope}&siteId=site-aaa`);
    assert.equal(response.statusCode, 400, scope);
    assert.match((response.json() as { message: string }).message, /meaningless with scope=/);
  }
});

test("format=csv must name a section, and the error lists them", async () => {
  const response = await get("?scope=fleet&format=csv");
  assert.equal(response.statusCode, 400);
  const body = response.json() as { message: string };
  assert.match(body.message, /`section` is required for format=csv/);
  for (const section of CSV_SECTIONS) assert.match(body.message, new RegExp(section));
});

test("a closed or inverted window is refused", async () => {
  const same = await get("?scope=fleet&from=2026-09-01T00:00:00Z&to=2026-09-01T00:00:00Z");
  assert.equal(same.statusCode, 400);
  assert.match((same.json() as { message: string }).message, /half-open \[from, to\)/);
  const inverted = await get("?scope=fleet&from=2026-09-02T00:00:00Z&to=2026-09-01T00:00:00Z");
  assert.equal(inverted.statusCode, 400);
});

test("an over-long window is refused with the reason, not silently clamped", async () => {
  const response = await get("?scope=fleet&from=2025-01-01T00:00:00Z&to=2026-01-01T00:00:00Z");
  assert.equal(response.statusCode, 400);
  assert.match((response.json() as { message: string }).message, /may not exceed 92 days/);
});

test("an unknown section is refused by the schema", async () => {
  const response = await get("?scope=fleet&format=csv&section=everything");
  assert.equal(response.statusCode, 400);
});

test("with no credentials the site axis is unreadable, and the report SAYS so at 200", async () => {
  const response = await get("?scope=site&siteId=site-aaa");
  assert.equal(response.statusCode, 200, "an unreadable hierarchy is not an outage");
  const body = response.json() as {
    data: {
      scope: { hierarchy: { available: boolean; reason: string; groupsMatched: number } };
      estate: { screens: { value: number } };
      limitations: string[];
    };
  };
  assert.equal(body.data.scope.hierarchy.available, false);
  assert.match(body.data.scope.hierarchy.reason, /No Videri credentials are configured/);
  assert.equal(body.data.scope.hierarchy.groupsMatched, 0, "failed closed: no group matched");
  assert.equal(body.data.estate.screens.value, 0);
  assert.ok(
    body.data.limitations.some((l) => /group hierarchy could not be read/.test(l)),
    "an empty report must not read as a customer with no screens",
  );
  assert.ok(body.data.limitations.some((l) => /empty by construction/.test(l)));
});

test("the JSON report rides in the standard envelope with freshness", async () => {
  const response = await get("?scope=fleet");
  assert.equal(response.statusCode, 200);
  const body = response.json() as { data: { reportType: string }; meta: { freshness: unknown } };
  assert.equal(body.data.reportType, "estate");
  assert.ok(body.meta.freshness, "a report is a snapshot and carries its own age");
});

test("CSV comes back as a downloadable text/csv attachment naming the scope and window", async () => {
  const response = await get(
    "?scope=fleet&format=csv&section=devices&from=2026-08-28T00:00:00Z&to=2026-09-04T00:00:00Z",
  );
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] as string, /^text\/csv; charset=utf-8/);
  const disposition = response.headers["content-disposition"] as string;
  assert.match(disposition, /^attachment; filename="vfi-estate-/);
  assert.match(disposition, /devices-2026-08-28-to-2026-09-04\.csv"$/);
  assert.match(response.body, /^# Videri Fleet Intelligence/);
  assert.match(response.body, /# An empty cell means the value could not be read/);
  assert.ok(response.body.includes("device_id,name,location,site,"));
});

test("preamble=false serves the bare table for machine consumers", async () => {
  const response = await get("?scope=fleet&format=csv&section=alerts&preamble=false");
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.startsWith("alert_id,"), true);
});

test("every window default is stated in the payload, so nothing is implied", async () => {
  const response = await get("?scope=fleet");
  const body = response.json() as {
    data: { window: { from: string; to: string; hours: number; halfOpen: boolean; statement: string } };
  };
  assert.equal(body.data.window.halfOpen, true);
  assert.equal(Math.round(body.data.window.hours), 168, "the default window is a rolling week");
  assert.match(body.data.window.statement, /NOT including/);
});

test("/api/reports/sites lists the unplaced cohort as a first-class scope", async () => {
  const app = await buildServer({
    pool: stubPool(),
    repo: stubRepo(),
    auth: { token: TOKEN, allowAnonymous: false },
  });
  const response = await app.inject({ method: "GET", url: "/api/reports/sites", headers: auth });
  await app.close();
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    data: {
      scopes: Array<{ kind: string; siteId: string | null; label: string; reportUrl: string }>;
      totals: { screens: number; unplaced: number; sites: number };
    };
  };
  const unplaced = body.data.scopes.find((s) => s.kind === "unplaced");
  assert.ok(unplaced, "the site-less screens are always offered, even when there are none");
  assert.equal(unplaced!.siteId, null, "never given a fabricated site id");
  assert.equal(unplaced!.reportUrl, "/api/reports/estate?scope=unplaced");
  assert.equal(body.data.totals.unplaced, 0);
});

test("the report endpoints are behind the same auth as everything else", async () => {
  const app = await buildServer({
    pool: stubPool(),
    repo: stubRepo(),
    auth: { token: TOKEN, allowAnonymous: false },
  });
  for (const url of ["/api/reports/sites", "/api/reports/estate?scope=fleet"]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 401, url);
  }
  await app.close();
});
