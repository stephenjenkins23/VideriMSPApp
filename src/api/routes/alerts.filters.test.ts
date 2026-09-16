/**
 * `/api/alerts` — SERVER-SIDE FILTERING and CONDITIONAL GETs (Epic 8.5).
 *   `node --test dist/api/routes/alerts.filters.test.js`
 *
 * `queries.alerts.test.ts` owns the SQL: that each predicate is legal in the
 * COUNT as well as the LIST, that the two get the identical WHERE, and what each
 * one actually selects. This file owns the ROUTE, which is where the two
 * failures that motivated the epic would happen:
 *
 *   1. A FILTER THAT IS ACCEPTED AND NOT APPLIED. The console's idle state sends
 *      `rule=all`, `severity=all` and `q=`; read literally, the first two search
 *      for a rule and a severity named "all" and return an empty queue for
 *      "show me everything". And an unrecognised name — `serverity=critical` —
 *      used to be stripped by Zod and answered with the whole queue and a 200.
 *      A silently ignored parameter is this project's signature failure (the
 *      Videri `x-tenant_id` header), so the route refuses instead.
 *
 *   2. AN ETAG THAT DOES NOT VARY WITH THE REQUEST. A validator that ignored one
 *      filter would serve one filter's rows for another filter's request — a
 *      wrong answer no client can detect, strictly worse than no caching. So
 *      every parameter is asserted to move the tag.
 *
 * Plus the invariant that outranks both: a whole-device suppression NEVER
 * silences a critical, and no filter added here may hide a held-back one.
 *
 * Everything runs through `app.inject()` against a stub pool and repository. No
 * database, no control plane, no device.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { Repository, SuppressionRow } from "../../db/repository.js";
import { buildServer } from "../server.js";
import type { Severity } from "../../domain/types.js";

const TOKEN = "test-token-at-least-16-chars";
const auth = { authorization: `Bearer ${TOKEN}` };
const A1 = "11111111-1111-1111-1111-111111111111";
const A2 = "22222222-2222-2222-2222-222222222222";
const A3 = "33333333-3333-3333-3333-333333333333";

interface Row {
  id: string;
  device_id: string;
  device_name: string;
  location: string | null;
  rule_id: string;
  severity: string;
  title: string;
}

const row = (over: Partial<Row> & { id: string }): Row => ({
  device_id: "d1",
  device_name: "Reception Canvas",
  location: "Barcelona",
  rule_id: "offline-4h",
  severity: "medium",
  title: "Device dark",
  ...over,
});

/** The projection `queries.alerts()` reads, filled in around the interesting fields. */
const projected = (r: Row) => ({
  ...r,
  evidence: {},
  opened_at: new Date("2026-09-10T00:00:00Z"),
  last_fired_at: new Date("2026-09-14T00:00:00Z"),
  acknowledged_at: null,
  acknowledged_by: null,
  resolved_at: null,
  videri_alert_uuid: null,
  sup_id: null,
  note_count: "0",
  last_note_at: null,
});

interface Opts {
  rows?: Row[];
  suppressions?: SuppressionRow[];
  openAlerts?: Array<{
    id: string; deviceId: string; ruleId: string; severity: Severity; openedAt: Date;
  }>;
}

interface Captured { sql: string; values: unknown[] }

/**
 * The newest sample, fixed for the whole file.
 *
 * `newestSampleAt` is part of the validator on purpose — a new reading means a
 * new answer — so a per-request clock would change the ETag on every read and no
 * 304 could ever be asserted. Freshness's `ageSeconds` still moves between
 * requests, which is exactly the field the validator excludes.
 */
const NEWEST = new Date(Date.now() - 1000);

/**
 * A pool that APPLIES the filters it is given, and answers the COUNT from the
 * SAME function that builds the page.
 *
 * It has to answer both from one place: "the count is of the thing you filtered"
 * is the property under test at this level, and a stub that returned a canned
 * total would pass whether the route sent its filters to one statement, the
 * other, or neither.
 *
 * Only the dimensions this file exercises are modelled — severity, rule, the
 * search pattern and the two alert-id predicates. `queries.alerts.test.ts` owns
 * the alias-resolving fake that models the rest.
 */
function stubPool(opts: Opts): { pool: Pool; captured: Captured[] } {
  const rows = opts.rows ?? [];
  const captured: Captured[] = [];

  const matching = (sql: string, values: unknown[]): Row[] => {
    let out = rows;
    const ids = values.find((v): v is string[] => Array.isArray(v)) ?? null;
    if (ids) {
      if (sql.includes("NOT (a.id = ANY(")) out = out.filter((r) => !ids.includes(r.id));
      else if (sql.includes("a.id = ANY(")) out = out.filter((r) => ids.includes(r.id));
    }
    for (const value of values) {
      if (typeof value !== "string") continue;
      if (value.startsWith("%") && value.endsWith("%")) {
        const needle = value.slice(1, -1).toLowerCase();
        out = out.filter((r) =>
          [r.device_name, r.device_id, r.title, r.rule_id, r.severity, r.location]
            .some((f) => f != null && String(f).toLowerCase().includes(needle)));
        continue;
      }
      if (sql.includes("a.severity = $") && ["critical", "high", "medium", "info"].includes(value)) {
        out = out.filter((r) => r.severity === value);
        continue;
      }
      if (sql.includes("a.rule_id = $")) out = out.filter((r) => r.rule_id === value);
    }
    return out;
  };

  const pool = {
    async query(sql: string, values: unknown[] = []) {
      captured.push({ sql, values });
      if (sql.includes("MAX(observed_at)")) return { rows: [{ newest: NEWEST }], rowCount: 1 };
      if (sql.includes("FROM poller_runs")) return { rows: [], rowCount: 0 };
      if (sql.includes("COUNT(*)::text AS count FROM alerts")) {
        return { rows: [{ count: String(matching(sql, values).length) }], rowCount: 1 };
      }
      if (sql.includes("FROM alerts a")) {
        const limit = Number(/LIMIT (\d+) OFFSET (\d+)/.exec(sql)?.[1] ?? 50);
        const offset = Number(/LIMIT (\d+) OFFSET (\d+)/.exec(sql)?.[2] ?? 0);
        const page = matching(sql, values).slice(offset, offset + limit).map(projected);
        return { rows: page, rowCount: page.length };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, captured };
}

const stubRepo = (opts: Opts): Repository =>
  ({
    async openAlertFacts() { return opts.openAlerts ?? []; },
    async listSuppressions() { return opts.suppressions ?? []; },
    async alertEvents() { return []; },
  }) as unknown as Repository;

interface Answer {
  status: number;
  headers: Record<string, unknown>;
  body: string;
  json: () => Record<string, unknown>;
  captured: Captured[];
}

async function get(
  url: string,
  opts: Opts = {},
  headers: Record<string, string> = {},
): Promise<Answer> {
  const { pool, captured } = stubPool(opts);
  const app = await buildServer({
    pool, repo: stubRepo(opts), auth: { token: TOKEN, allowAnonymous: false },
  });
  const res = await app.inject({ method: "GET", url, headers: { ...auth, ...headers } });
  await app.close();
  return {
    status: res.statusCode,
    headers: res.headers as Record<string, unknown>,
    body: res.body,
    json: () => res.json() as Record<string, unknown>,
    captured,
  };
}

/** GET, then GET again quoting the first response's ETag, against ONE server. */
async function getTwice(url: string, opts: Opts = {}): Promise<[Answer, Answer]> {
  const { pool, captured } = stubPool(opts);
  const app = await buildServer({
    pool, repo: stubRepo(opts), auth: { token: TOKEN, allowAnonymous: false },
  });
  const one = await app.inject({ method: "GET", url, headers: auth });
  const two = await app.inject({
    method: "GET", url, headers: { ...auth, "if-none-match": String(one.headers["etag"]) },
  });
  await app.close();
  const wrap = (res: typeof one): Answer => ({
    status: res.statusCode,
    headers: res.headers as Record<string, unknown>,
    body: res.body,
    json: () => res.json() as Record<string, unknown>,
    captured,
  });
  return [wrap(one), wrap(two)];
}

const ids = (answer: Answer): string[] =>
  (answer.json()["data"] as Array<{ id: string }>).map((a) => a.id);

const total = (answer: Answer): number =>
  ((answer.json()["meta"] as { page: { totalItems: number } }).page.totalItems);

/** The bound parameters of the COUNT statement, which must equal the LIST's. */
function filterParams(captured: Captured[]): unknown[] {
  const count = captured.filter((c) => c.sql.includes("COUNT(*)::text AS count FROM alerts"));
  const list = captured.filter(
    (c) => c.sql.includes("FROM alerts a") && !c.sql.includes("COUNT(*)::text AS count"));
  assert.equal(count.length, 1, "expected exactly one alert COUNT");
  assert.equal(list.length, 1, "expected exactly one alert LIST");
  assert.deepEqual(count[0]!.values, list[0]!.values,
    "the count must be computed from the same parameters as the list");
  return count[0]!.values;
}

// ─── each filter dimension reaches the SQL ───────────────────────────────────

const QUEUE: Row[] = [
  row({ id: A1, severity: "critical", rule_id: "offline-4h", title: "Lobby screen offline" }),
  row({ id: A2, severity: "info", rule_id: "firmware-behind", title: "Firmware behind",
        device_name: "Kitchen Canvas", location: "London" }),
  row({ id: A3, severity: "medium", rule_id: "offline-4h", title: "Store screen offline",
        device_name: "Store 12", location: null }),
];

test("severity narrows the queue, and the total is of the narrowed set", async () => {
  const res = await get("/api/alerts?severity=critical", { rows: QUEUE });
  assert.equal(res.status, 200);
  assert.deepEqual(ids(res), [A1]);
  assert.equal(total(res), 1, "the count must not report the unfiltered queue");
  assert.deepEqual(filterParams(res.captured), ["critical"]);
});

test("the rule filter reaches the statement as a bound parameter", async () => {
  const res = await get("/api/alerts?rule=firmware-behind", { rows: QUEUE });
  assert.deepEqual(ids(res), [A2]);
  assert.equal(total(res), 1);
  assert.deepEqual(filterParams(res.captured), ["firmware-behind"]);
});

test("search reaches the statement as one LIKE pattern, and matches device and location too", async () => {
  const byTitle = await get("/api/alerts?q=lobby", { rows: QUEUE });
  assert.deepEqual(ids(byTitle), [A1]);
  assert.deepEqual(filterParams(byTitle.captured), ["%lobby%"]);

  const byDevice = await get("/api/alerts?q=kitchen", { rows: QUEUE });
  assert.deepEqual(ids(byDevice), [A2]);

  const byLocation = await get("/api/alerts?q=london", { rows: QUEUE });
  assert.deepEqual(ids(byLocation), [A2]);
  assert.equal(total(byLocation), 1);
});

test("the age window reaches the statement as a bound clock, not now()", async () => {
  const res = await get("/api/alerts?age=24h", { rows: QUEUE });
  assert.equal(res.status, 200);
  const params = filterParams(res.captured);
  assert.equal(params.length, 1);
  assert.ok(params[0] instanceof Date, "the window must be measured against a bound instant");
});

test("the sort reaches the ORDER BY, and only the LIST has one", async () => {
  const res = await get("/api/alerts?sort=device", { rows: QUEUE });
  assert.equal(res.status, 200);
  // `AS count`, not `COUNT(*)::text` — the LIST carries a `COUNT(*)::text AS
  // note_count` lateral of its own, and matching the shorter string finds
  // nothing at all.
  const list = res.captured.find(
    (c) => c.sql.includes("FROM alerts a") && !c.sql.includes("COUNT(*)::text AS count"))!;
  assert.ok(list, "expected an alert LIST statement");
  assert.match(list.sql, /ORDER BY lower\(COALESCE\(NULLIF\(d\.name/);
});

test("every filter composes in one request, and all of them are bound", async () => {
  const res = await get(
    "/api/alerts?q=offline&rule=offline-4h&age=o7d&severity=critical&sort=recent&state=open",
    { rows: QUEUE },
  );
  assert.equal(res.status, 200);
  assert.deepEqual(ids(res), [A1]);
  assert.equal(total(res), 1);
  const params = filterParams(res.captured);
  assert.deepEqual(params.slice(0, 3), ["critical", "%offline%", "offline-4h"]);
  assert.ok(params[3] instanceof Date);
});

// ─── the console's "no filter" values must mean no filter ────────────────────

test("severity=all, rule=all and an empty q mean UNFILTERED, not a search for \"all\"", async () => {
  // These are the values the console's own controls hold when nothing is
  // chosen. Read literally they return an empty queue for "show me everything",
  // which looks exactly like a healthy fleet.
  const res = await get("/api/alerts?severity=all&rule=all&q=&age=all&sort=sev", { rows: QUEUE });
  assert.equal(res.status, 200);
  assert.equal(ids(res).length, 3, "all three alerts must still be listed");
  assert.equal(total(res), 3);
  assert.deepEqual(filterParams(res.captured), [],
    "no parameter may be bound for a filter that was not asked for");
});

test("a whitespace-only search is not a filter", async () => {
  const res = await get("/api/alerts?q=%20%20", { rows: QUEUE });
  assert.equal(res.status, 200);
  assert.equal(total(res), 3);
  assert.deepEqual(filterParams(res.captured), []);
});

test("an unparseable filter VALUE is a 400 naming the parameter", async () => {
  for (const bad of ["age=fortnight", "sort=alphabetical", "severity=urgent", "band=quiet"]) {
    const res = await get(`/api/alerts?${bad}`, { rows: QUEUE });
    assert.equal(res.status, 400, bad);
    assert.equal(res.json()["error"], "bad_request", bad);
    assert.match(String(res.json()["message"]), new RegExp(bad.split("=")[0]!), bad);
  }
});

// ─── an unknown parameter is refused, never ignored ─────────────────────────

test("an unrecognised query parameter is a 400 that names it and lists what IS accepted", async () => {
  const res = await get("/api/alerts?serverity=critical", { rows: QUEUE });
  assert.equal(res.status, 400);
  assert.equal(res.json()["error"], "unknown_parameter");
  assert.deepEqual(res.json()["unknown"], ["serverity"]);
  assert.ok((res.json()["accepted"] as string[]).includes("severity"));
  // And nothing was queried: a refused request must not also be a served one.
  assert.equal(res.captured.filter((c) => c.sql.includes("FROM alerts a")).length, 0);
});

test("the accepted list is read off the schema, so it cannot drift from it", async () => {
  const res = await get("/api/alerts?nonsense=1", { rows: QUEUE });
  const accepted = res.json()["accepted"] as string[];
  for (const name of ["page", "limit", "severity", "state", "deviceId", "deviceIds", "alertIds",
                      "band", "acknowledged", "q", "rule", "age", "sort"]) {
    assert.ok(accepted.includes(name), `${name} must be listed as accepted`);
  }
});

test("every parameter this endpoint already served is still accepted", async () => {
  // The contract these filters were added to, unchanged. A 400 here would break
  // the dormant drilldown, the suppressed band and the console's own paging.
  const urls = [
    "/api/alerts",
    "/api/alerts?page=1&limit=10",
    "/api/alerts?severity=high&state=all&acknowledged=no",
    "/api/alerts?deviceId=d1",
    "/api/alerts?deviceIds=d1,d2",
    `/api/alerts?alertIds=${A1},${A2}`,
    "/api/alerts?band=incident",
    "/api/alerts?band=suppressed",
  ];
  for (const url of urls) {
    assert.equal((await get(url, { rows: QUEUE })).status, 200, url);
  }
});

// ─── the count is of the thing you filter ───────────────────────────────────

test("limit=0 reports the FILTERED total, carries no rows, and says so", async () => {
  const res = await get("/api/alerts?q=offline&limit=0", { rows: QUEUE });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json()["data"], []);
  const meta = res.json()["meta"] as Record<string, unknown>;
  assert.equal(meta["countOnly"], true, "an empty data array must never read as 'nothing matched'");
  assert.match(String(meta["countNote"]), /limit=0/);
  const page = meta["page"] as Record<string, number>;
  assert.equal(page["totalItems"], 2, "two of the three alerts match q=offline");
  assert.equal(page["totalPages"], 0, "at a page size of zero there are no pages");
});

test("the count-only total equals the total the same filters list — every dimension", async () => {
  // The "count the thing you filter" bug has shipped three times in this
  // codebase. Asserted per dimension rather than once, because it only takes one
  // filter reaching one of the two statements.
  for (const filter of ["", "severity=critical", "rule=offline-4h", "q=offline", "q=zzz",
                        "severity=info&rule=firmware-behind", "band=incident"]) {
    const listed = await get(`/api/alerts?${filter}`, { rows: QUEUE });
    const counted = await get(`/api/alerts?${filter}&limit=0`, { rows: QUEUE });
    assert.equal(total(counted), total(listed), `${filter}: count and list must agree`);
    assert.equal(ids(listed).length, total(listed),
      `${filter}: this page holds every match, so the total must equal the rows`);
  }
});

test("a normal request is untouched: rows, real page maths, no countOnly marker", async () => {
  const res = await get("/api/alerts?limit=10", { rows: QUEUE });
  const meta = res.json()["meta"] as Record<string, unknown>;
  assert.equal(meta["countOnly"], undefined);
  assert.equal(meta["countNote"], undefined);
  assert.deepEqual((meta["page"] as Record<string, number>),
    { page: 1, limit: 10, totalItems: 3, totalPages: 1 });
});

// ─── the safety valve outranks every filter ─────────────────────────────────

const HELD_BACK: Opts = {
  rows: [
    row({ id: A1, severity: "critical", title: "Screen is black" }),
    row({ id: A2, severity: "info", title: "Firmware behind" }),
  ],
  openAlerts: [
    { id: A1, deviceId: "d1", ruleId: "black-screen", severity: "critical",
      openedAt: new Date("2026-09-10T00:00:00Z") },
    { id: A2, deviceId: "d1", ruleId: "firmware-behind", severity: "info",
      openedAt: new Date("2026-09-10T00:00:00Z") },
  ],
  suppressions: [
    {
      id: "aaaaaaaa-1111-1111-1111-111111111111",
      deviceId: "d1", ruleId: null, reason: "This unit lives in the lab", intent: "lab",
      includeCriticalHigh: false, createdBy: "api:test",
      createdAt: new Date("2026-09-01T00:00:00Z"),
      expiresAt: new Date("2026-12-01T00:00:00Z"), neverExpires: false,
      revokedAt: null, revokedBy: null, revokedReason: null,
    },
  ],
};

test("a held-back critical survives band=incident PLUS a severity filter", async () => {
  // A whole-device suppression never silences a critical. The new filters must
  // narrow WITHIN the incident band, never re-band it — a filter that dropped
  // this row would defeat the safety valve while looking like a search result.
  const res = await get("/api/alerts?band=incident&severity=critical", HELD_BACK);
  assert.equal(res.status, 200);
  assert.deepEqual(ids(res), [A1]);
  const held = (res.json()["data"] as Array<Record<string, unknown>>)[0]!;
  assert.equal(held["suppressionHeldBack"], true, "and it is still labelled as held back");
  assert.equal(held["suppressed"], false);
});

test("a held-back critical survives a search that matches it", async () => {
  const res = await get("/api/alerts?band=incident&q=black", HELD_BACK);
  assert.deepEqual(ids(res), [A1]);
  assert.equal(total(res), 1);
});

test("band=suppressed and a filter INTERSECT — neither one quietly wins", async () => {
  // The suppressed band holds only the info alert, so asking it for criticals is
  // legitimately empty. The failure being pinned is the other direction: a
  // filter that replaced the band would return the critical.
  const crit = await get("/api/alerts?band=suppressed&severity=critical", HELD_BACK);
  assert.deepEqual(ids(crit), []);
  assert.equal(total(crit), 0);

  const info = await get("/api/alerts?band=suppressed&severity=info", HELD_BACK);
  assert.deepEqual(ids(info), [A2]);
});

// ─── conditional GETs ───────────────────────────────────────────────────────

test("a read carries a weak ETag and a revalidate-first cache directive", async () => {
  const res = await get("/api/alerts?q=offline", { rows: QUEUE });
  assert.match(String(res.headers["etag"]), /^W\/"[0-9a-f]{32}"$/);
  assert.equal(res.headers["cache-control"], "private, no-cache");
});

test("a repeat poll quoting the ETag is a 304 with NO body", async () => {
  const [first, second] = await getTwice("/api/alerts?q=offline", { rows: QUEUE });
  assert.equal(first.status, 200);
  assert.equal(second.status, 304);
  assert.equal(second.body, "", "a 304 must carry no body — that is the point of it");
  assert.equal(second.headers["etag"], first.headers["etag"]);
});

test("a 304 still states how old the data is", async () => {
  // A body-less response cannot restate `meta.freshness`, and a client rendering
  // the age it cached would drift into presenting old data as current. So the
  // age rides in headers on BOTH answers.
  const [first, second] = await getTwice("/api/alerts", { rows: QUEUE });
  for (const res of [first, second]) {
    assert.ok(res.headers["x-vfi-data-age-seconds"] !== undefined, "age must be on both");
    assert.equal(res.headers["x-vfi-data-freshness"], "fresh");
  }
});

test("a stale ETag is served the body, not a 304", async () => {
  const res = await get("/api/alerts", { rows: QUEUE }, { "if-none-match": 'W/"deadbeef"' });
  assert.equal(res.status, 200);
  assert.equal((res.json()["data"] as unknown[]).length, 3);
});

test("the ETag is compared weakly, so a client that dropped the W/ prefix still revalidates", async () => {
  const first = await get("/api/alerts", { rows: QUEUE });
  const bare = String(first.headers["etag"]).replace(/^W\//, "");
  const second = await get("/api/alerts", { rows: QUEUE }, { "if-none-match": bare });
  assert.equal(second.status, 304);
});

test("If-None-Match: * revalidates too", async () => {
  const res = await get("/api/alerts", { rows: QUEUE }, { "if-none-match": "*" });
  assert.equal(res.status, 304);
});

test("a 304 is NOT served to a client quoting one of several tags it does not hold", async () => {
  const res = await get("/api/alerts", { rows: QUEUE },
    { "if-none-match": 'W/"aaaa", W/"bbbb"' });
  assert.equal(res.status, 200);
});

test("THE ETAG VARIES WITH EVERY PARAMETER THAT VARIES THE RESPONSE", async () => {
  // The failure this pins: a validator that ignored one filter would answer 304
  // to a request for a DIFFERENT filter, and the client would render the
  // previous filter's rows believing they are the new ones. Worse than no
  // caching, and invisible.
  const requests = [
    "/api/alerts",
    "/api/alerts?severity=critical",
    "/api/alerts?severity=info",
    "/api/alerts?state=all",
    "/api/alerts?state=resolved",
    "/api/alerts?acknowledged=yes",
    "/api/alerts?acknowledged=no",
    "/api/alerts?band=incident",
    "/api/alerts?band=suppressed",
    "/api/alerts?q=offline",
    "/api/alerts?q=firmware",
    "/api/alerts?rule=offline-4h",
    "/api/alerts?rule=firmware-behind",
    "/api/alerts?age=1h",
    "/api/alerts?age=24h",
    "/api/alerts?age=o7d",
    "/api/alerts?sort=recent",
    "/api/alerts?sort=oldest",
    "/api/alerts?sort=device",
    "/api/alerts?sort=rule",
    "/api/alerts?limit=1",
    "/api/alerts?limit=1&page=2",
    "/api/alerts?limit=0",
    "/api/alerts?deviceId=d1",
    "/api/alerts?deviceIds=d1,d2",
    `/api/alerts?alertIds=${A1}`,
  ];
  const seen = new Map<string, string>();
  for (const url of requests) {
    const res = await get(url, { rows: QUEUE });
    assert.equal(res.status, 200, url);
    const etag = String(res.headers["etag"]);
    const clash = seen.get(etag);
    assert.equal(clash, undefined,
      `${url} shares an ETag with ${clash} — one of them would be served the other's body`);
    seen.set(etag, url);
  }
  assert.equal(seen.size, requests.length);
});

test("two spellings of the SAME request share an ETag — otherwise the cache never hits", async () => {
  // Defaults are filled in before the tag is computed, so the console's explicit
  // idle state and a bare request are one entry rather than two.
  const bare = await get("/api/alerts", { rows: QUEUE });
  const spelled = await get(
    "/api/alerts?page=1&limit=50&state=open&band=all&acknowledged=all&age=all&sort=sev&severity=all&rule=all&q=",
    { rows: QUEUE },
  );
  assert.equal(spelled.headers["etag"], bare.headers["etag"]);
});

test("the ETag follows the DATA as well as the request", async () => {
  const before = await get("/api/alerts", { rows: QUEUE });
  const after = await get("/api/alerts", { rows: [...QUEUE.slice(1)] });
  assert.notEqual(after.headers["etag"], before.headers["etag"],
    "a queue that lost an alert must not revalidate as unchanged");
});

// ─── the other read routes ──────────────────────────────────────────────────

test("the rules, suppressions and detail reads all revalidate", async () => {
  for (const url of ["/api/alerts/rules", "/api/alerts/suppressions", `/api/alerts/${A1}`]) {
    const [first, second] = await getTwice(url, { rows: QUEUE });
    assert.equal(first.status, 200, url);
    assert.match(String(first.headers["etag"]), /^W\/"[0-9a-f]{32}"$/, url);
    assert.equal(second.status, 304, url);
    assert.equal(second.body, "", url);
  }
});

test("two different alert drawers do not share one ETag", async () => {
  const one = await get(`/api/alerts/${A1}`, { rows: QUEUE });
  const two = await get(`/api/alerts/${A2}`, { rows: QUEUE });
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  assert.notEqual(one.headers["etag"], two.headers["etag"]);
});

test("the list and the rules read do not share an ETag when both are empty", async () => {
  // Two routes, two empty bodies, one validator would mean a client
  // revalidating one is told its copy of the OTHER is current. The route is part
  // of the tag for exactly this.
  const list = await get("/api/alerts", { rows: [] });
  const rules = await get("/api/alerts/rules", { rows: [] });
  assert.notEqual(list.headers["etag"], rules.headers["etag"]);
});

test("the detail route still 404s and 400s rather than revalidating", async () => {
  assert.equal((await get("/api/alerts/not-a-uuid", { rows: QUEUE })).status, 400);
  const missing = await get(`/api/alerts/${A3}`, { rows: [] });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers["etag"], undefined, "an error must not carry a validator");
});
