/**
 * Alert-list FILTER tests — `node --test dist/api/queries.alerts.test.js`
 *
 * `queries.alerts()` is the one read query that issues TWO statements which must
 * agree: a COUNT selecting from `alerts` alone, and a LIST that LEFT JOINs
 * `devices` for the name and location. Every filter has to be expressible in
 * both. A predicate written against the list's `d` alias compiles in the list and
 * raises `missing FROM-clause entry for table "d"` in the count — the exact
 * shape that once 500'd a live endpoint while stub tests passed, because a stub
 * that returns canned rows for any SQL cannot notice an unresolvable alias.
 *
 * So this file does not use that kind of stub. `fakePostgres` below:
 *
 *   1. RESOLVES ALIASES the way Postgres does — declared in the statement's own
 *      FROM/JOIN, or inherited by a correlated subquery — and throws the same
 *      error when a reference is out of scope;
 *   2. EVALUATES the WHERE clause against an in-memory alerts+devices model, so
 *      "a retired device's alerts appear in neither the list nor the count" is
 *      asserted as behaviour rather than as a string match;
 *   3. THROWS on any predicate shape it does not recognise, so the day someone
 *      rewrites a filter these tests fail loudly instead of quietly ignoring it.
 *
 * The 306-vs-304 disagreement between the list and the repository's own
 * invariant came from exactly this pair of statements disagreeing. Nothing here
 * touches a database, a device or the control plane.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { Repository } from "../db/repository.js";
import { ReadQueries } from "./queries.js";
import { buildServer } from "./server.js";

// ─── the model ───────────────────────────────────────────────────────────────

interface AlertRow {
  id: string;
  device_id: string;
  rule_id: string;
  severity: string;
  title: string;
  evidence: unknown;
  opened_at: Date;
  last_fired_at: Date;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
  resolved_at: Date | null;
  videri_alert_uuid: string | null;
}

interface DeviceRow {
  id: string;
  name: string | null;
  location: string | null;
  retired_at: Date | null;
}

const alert = (over: Partial<AlertRow> & { id: string; device_id: string }): AlertRow => ({
  rule_id: "offline-30d",
  severity: "medium",
  title: "Device dark",
  evidence: {},
  opened_at: new Date("2026-08-01T00:00:00Z"),
  last_fired_at: new Date("2026-09-01T00:00:00Z"),
  acknowledged_at: null,
  acknowledged_by: null,
  resolved_at: null,
  videri_alert_uuid: null,
  ...over,
});

const device = (id: string, retired_at: Date | null = null): DeviceRow => ({
  id, name: `Canvas ${id}`, location: "New York, NY", retired_at,
});

// ─── alias resolution, the way Postgres does it ──────────────────────────────

/** Replace every balanced (...) group with a space, leaving only the outer text. */
function stripSubexpressions(sql: string): { outer: string; groups: string[] } {
  const groups: string[] = [];
  let outer = "";
  let depth = 0;
  let current = "";
  for (const ch of sql) {
    if (ch === "(") {
      depth += 1;
      if (depth === 1) { current = ""; continue; }
    }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) { groups.push(current); outer += " "; continue; }
    }
    if (depth === 0) outer += ch;
    else current += ch;
  }
  return { outer, groups };
}

const declaredAliases = (text: string): string[] => {
  const found: string[] = [];
  for (const m of text.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)\s+([a-z_]+)\b/gi)) {
    if (!/^(on|where|order|group|limit|left|inner|join)$/i.test(m[2]!)) found.push(m[2]!);
  }
  return found;
};

const referencedAliases = (text: string): string[] =>
  [...text.matchAll(/\b([a-z_]+)\.[a-z_]+/gi)].map((m) => m[1]!);

/**
 * Raises what Postgres raises for an out-of-scope alias. Checked on the outer
 * statement and, with the outer scope inherited, on every subexpression — so a
 * correlated `NOT EXISTS` referring to `a.device_id` is legal, and a filter
 * referring to the LIST query's `d` from inside the COUNT query is not.
 */
function assertAliasesResolve(sql: string): void {
  const { outer, groups } = stripSubexpressions(sql);
  const outerScope = new Set(declaredAliases(outer));
  const check = (text: string, scope: Set<string>) => {
    for (const ref of referencedAliases(text)) {
      if (!scope.has(ref)) {
        throw new Error(`missing FROM-clause entry for table "${ref}"`);
      }
    }
  };
  check(outer, outerScope);
  for (const group of groups) {
    const scope = new Set([...outerScope, ...declaredAliases(group)]);
    check(group, scope);
  }
}

// ─── WHERE evaluation ────────────────────────────────────────────────────────

const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/** The WHERE clause only, with ORDER BY / LIMIT trimmed off. */
function whereClause(sql: string): string {
  const one = flat(sql);
  const at = one.indexOf("WHERE ");
  if (at < 0) return "";
  return one.slice(at + 6).replace(/\s+ORDER BY .*$/i, "").replace(/\s+LIMIT .*$/i, "").trim();
}

/** Split on AND at paren depth 0, so the NOT EXISTS body stays intact. */
function conjuncts(where: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  const tokens = where.split(/\b(AND)\b/i);
  for (const token of tokens) {
    if (/^AND$/i.test(token) && depth === 0) { parts.push(current); current = ""; continue; }
    for (const ch of token) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
    }
    current += token;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

type Predicate = (a: AlertRow, devices: readonly DeviceRow[]) => boolean;

const NOT_EXISTS_RETIRED =
  /^NOT EXISTS \( ?SELECT 1 FROM devices ([a-z_]+) WHERE \1\.id = a\.device_id AND \1\.retired_at IS NOT NULL ?\)$/i;

/** Compiles one conjunct, or throws if the shape is not one we know. */
function compile(conjunct: string, params: readonly unknown[]): Predicate {
  const c = conjunct.replace(/\s+/g, " ").trim();

  if (NOT_EXISTS_RETIRED.test(c)) {
    return (a, devices) =>
      !devices.some((d) => d.id === a.device_id && d.retired_at !== null);
  }
  if (/^a\.resolved_at IS NULL$/i.test(c)) return (a) => a.resolved_at === null;
  if (/^a\.resolved_at IS NOT NULL$/i.test(c)) return (a) => a.resolved_at !== null;

  const severity = /^a\.severity = \$(\d+)$/i.exec(c);
  if (severity) {
    const want = params[Number(severity[1]) - 1];
    return (a) => a.severity === want;
  }
  const many = /^a\.device_id = ANY\(\$(\d+)::text\[\]\)$/i.exec(c);
  if (many) {
    const want = params[Number(many[1]) - 1] as string[];
    assert.ok(Array.isArray(want), "the many-device filter must be bound as an array parameter");
    return (a) => want.includes(a.device_id);
  }
  const one = /^a\.device_id = \$(\d+)$/i.exec(c);
  if (one) {
    const want = params[Number(one[1]) - 1];
    return (a) => a.device_id === want;
  }
  throw new Error(
    `fakePostgres does not know the predicate \`${c}\` — if a filter was ` +
      `rewritten, teach this fake before trusting the result`,
  );
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2 };

interface Fake {
  pool: Pool;
  captured: Array<{ sql: string; values: unknown[] }>;
  countSql: () => { sql: string; values: unknown[] };
  listSql: () => { sql: string; values: unknown[] };
}

/**
 * A pool that behaves enough like Postgres to be wrong when the SQL is wrong.
 * Anything it is not asked about (freshness, other endpoints) answers empty.
 */
function fakePostgres(model: { alerts?: AlertRow[]; devices?: DeviceRow[] } = {}): Fake {
  const alerts = model.alerts ?? [];
  const devices = model.devices ?? [];
  const captured: Array<{ sql: string; values: unknown[] }> = [];

  const select = (sql: string, values: unknown[]): AlertRow[] => {
    assertAliasesResolve(sql);
    const where = whereClause(sql);
    const predicates = conjuncts(where).map((c) => compile(c, values));
    return alerts.filter((a) => predicates.every((p) => p(a, devices)));
  };

  const pool = {
    async query(sql: string, values: unknown[] = []) {
      captured.push({ sql, values });

      if (/FROM alerts a/i.test(sql) && /COUNT\(\*\)::text AS count/i.test(sql)) {
        const rows = [{ count: String(select(sql, values).length) }];
        return { rows, rowCount: 1 };
      }
      if (/FROM alerts a/i.test(sql)) {
        const limit = Number(/LIMIT (\d+)/i.exec(sql)?.[1] ?? 50);
        const offset = Number(/OFFSET (\d+)/i.exec(sql)?.[1] ?? 0);
        const rows = select(sql, values)
          .sort((x, y) =>
            (SEVERITY_RANK[x.severity] ?? 3) - (SEVERITY_RANK[y.severity] ?? 3) ||
            y.opened_at.getTime() - x.opened_at.getTime())
          .slice(offset, offset + limit)
          .map((a) => {
            const d = devices.find((row) => row.id === a.device_id);
            return { ...a, device_name: d?.name ?? null, location: d?.location ?? null };
          });
        return { rows, rowCount: rows.length };
      }
      // Freshness, for the route-level tests.
      if (sql.includes("MAX(observed_at)")) {
        return { rows: [{ newest: new Date() }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;

  const only = (predicate: (c: { sql: string }) => boolean, what: string) => () => {
    const hits = captured.filter(predicate);
    assert.equal(hits.length, 1, `expected exactly one ${what} statement, saw ${hits.length}`);
    return hits[0]!;
  };

  return {
    pool,
    captured,
    countSql: only(
      (c) => /FROM alerts a/i.test(c.sql) && /COUNT\(\*\)::text AS count/i.test(c.sql),
      "alert COUNT",
    ),
    listSql: only(
      (c) => /FROM alerts a/i.test(c.sql) && !/COUNT\(\*\)::text AS count/i.test(c.sql),
      "alert LIST",
    ),
  };
}

const base = { page: 1, limit: 50, state: "open" as const };

// ─── the fake earns its keep ─────────────────────────────────────────────────

test("the fake pool rejects an out-of-scope alias, so these tests can actually fail", () => {
  // Guard on the guard. If this stopped throwing, every assertion below would be
  // vacuous — a stub that accepts unresolvable SQL is how the live 500 shipped.
  assert.throws(
    () => assertAliasesResolve(
      `SELECT COUNT(*)::text AS count FROM alerts a WHERE d.retired_at IS NULL`,
    ),
    /missing FROM-clause entry for table "d"/,
  );
  // And the legal correlated form resolves.
  assertAliasesResolve(
    `SELECT COUNT(*)::text AS count FROM alerts a
      WHERE NOT EXISTS (SELECT 1 FROM devices rd
                         WHERE rd.id = a.device_id AND rd.retired_at IS NOT NULL)`,
  );
});

test("the fake pool rejects a predicate shape it has not been taught", () => {
  const fake = fakePostgres({ alerts: [alert({ id: "x", device_id: "d1" })] });
  assert.rejects(
    () => fake.pool.query(`SELECT COUNT(*)::text AS count FROM alerts a WHERE a.title LIKE 'x'`, []),
    /does not know the predicate/,
  );
});

// ─── the retired-device exclusion (both statements) ──────────────────────────

test("an alert on a RETIRED device appears in neither the list nor the count", async () => {
  // The live symptom of getting this wrong was a list reporting 306 open while
  // the repository's own invariant said 304.
  const fake = fakePostgres({
    alerts: [
      alert({ id: "live", device_id: "active-1" }),
      alert({ id: "gone", device_id: "retired-1" }),
    ],
    devices: [device("active-1"), device("retired-1", new Date("2026-07-01T00:00:00Z"))],
  });
  const result = await new ReadQueries(fake.pool).alerts(base);

  assert.equal(result.totalItems, 1, "the COUNT must exclude the retired device's alert");
  assert.deepEqual(result.items.map((i) => i["id"]), ["live"],
    "the LIST must exclude the retired device's alert");
});

test("the retired exclusion is a correlated NOT EXISTS, so it resolves in the COUNT query too", async () => {
  const fake = fakePostgres();
  await new ReadQueries(fake.pool).alerts(base);

  const count = flat(fake.countSql().sql);
  // The count selects from `alerts` alone: no devices join exists to alias.
  assert.ok(/FROM alerts a\b/.test(count));
  assert.ok(!/JOIN devices/i.test(count),
    "the COUNT query must stay join-free; that is why an alias-based filter breaks it");
  assert.ok(/NOT EXISTS \( ?SELECT 1 FROM devices/i.test(count));
  assert.ok(/retired_at IS NOT NULL/i.test(count));
  // And it is present in the list as well, or the two disagree.
  assert.ok(/NOT EXISTS \( ?SELECT 1 FROM devices/i.test(flat(fake.listSql().sql)));
});

test("a device with no row in `devices` at all is still listed — orphan, not retired", async () => {
  // NOT EXISTS on a retired row must not become "device must exist": an alert
  // whose device row has not landed yet is data we hold and must not hide.
  const fake = fakePostgres({
    alerts: [alert({ id: "orphan", device_id: "unknown-1" })],
    devices: [],
  });
  const result = await new ReadQueries(fake.pool).alerts(base);
  assert.equal(result.totalItems, 1);
  assert.deepEqual(result.items.map((i) => i["id"]), ["orphan"]);
});

// ─── deviceIds: the dormant-rollup drilldown ─────────────────────────────────

test("the deviceIds predicate is expressible in BOTH the list and the COUNT query", async () => {
  const fake = fakePostgres();
  await new ReadQueries(fake.pool).alerts({ ...base, deviceIds: ["d1", "d2"] });

  const count = fake.countSql();
  const list = fake.listSql();
  // Bound as one array parameter, not spliced into an IN list.
  assert.ok(/a\.device_id = ANY\(\$\d+::text\[\]\)/i.test(flat(count.sql)));
  assert.ok(/a\.device_id = ANY\(\$\d+::text\[\]\)/i.test(flat(list.sql)));
  // The predicate must be alias-free with respect to `devices`.
  assert.ok(!/\bd\./.test(whereClause(count.sql)),
    "no filter may reference the list query's devices alias");
  // Identical WHERE and identical params is what makes them agree by construction.
  assert.equal(whereClause(count.sql), whereClause(list.sql));
  assert.deepEqual(count.values, list.values);
});

test("the drilldown counts and lists the SAME alerts, and no others", async () => {
  const fake = fakePostgres({
    alerts: [
      alert({ id: "in-1", device_id: "dark-1" }),
      alert({ id: "in-2", device_id: "dark-2", severity: "info" }),
      alert({ id: "out-1", device_id: "live-9" }),
    ],
    devices: [device("dark-1"), device("dark-2"), device("live-9")],
  });
  const result = await new ReadQueries(fake.pool).alerts({
    ...base, deviceIds: ["dark-1", "dark-2"],
  });

  assert.equal(result.totalItems, 2);
  assert.deepEqual(result.items.map((i) => i["id"]).sort(), ["in-1", "in-2"]);
});

test("a retired device inside the drilldown list is still excluded from both", async () => {
  // The rollup's deviceIds come from the alert table, so a device retired since
  // the rollup was computed can appear in the drilldown. It must not resurface.
  const fake = fakePostgres({
    alerts: [
      alert({ id: "keep", device_id: "dark-1" }),
      alert({ id: "drop", device_id: "dark-2" }),
    ],
    devices: [device("dark-1"), device("dark-2", new Date("2026-08-01T00:00:00Z"))],
  });
  const result = await new ReadQueries(fake.pool).alerts({
    ...base, deviceIds: ["dark-1", "dark-2"],
  });
  assert.equal(result.totalItems, 1);
  assert.deepEqual(result.items.map((i) => i["id"]), ["keep"]);
});

test("deviceIds and severity compose: both statements carry both parameters in order", async () => {
  const fake = fakePostgres({
    alerts: [
      alert({ id: "crit", device_id: "d1", severity: "critical" }),
      alert({ id: "med", device_id: "d1", severity: "medium" }),
    ],
    devices: [device("d1")],
  });
  const result = await new ReadQueries(fake.pool).alerts({
    ...base, severity: "critical", deviceIds: ["d1", "d2"],
  });

  assert.equal(result.totalItems, 1);
  assert.deepEqual(result.items.map((i) => i["id"]), ["crit"]);
  assert.deepEqual(fake.countSql().values, ["critical", ["d1", "d2"]]);
  assert.deepEqual(fake.listSql().values, ["critical", ["d1", "d2"]]);
});

test("an empty deviceIds array adds no predicate rather than an always-false one", async () => {
  const fake = fakePostgres({
    alerts: [alert({ id: "a", device_id: "d1" })],
    devices: [device("d1")],
  });
  const result = await new ReadQueries(fake.pool).alerts({ ...base, deviceIds: [] });
  assert.ok(!/ANY\(/i.test(whereClause(fake.countSql().sql)));
  assert.equal(result.totalItems, 1);
});

test("deviceIds is parameterised, so an id carrying SQL is data and not syntax", async () => {
  const hostile = "d1'); DROP TABLE alerts; --";
  const fake = fakePostgres({ alerts: [], devices: [] });
  await new ReadQueries(fake.pool).alerts({ ...base, deviceIds: [hostile] });

  for (const captured of [fake.countSql(), fake.listSql()]) {
    assert.ok(!captured.sql.includes("DROP TABLE"), "the id must never reach the statement text");
    assert.deepEqual(captured.values, [[hostile]]);
  }
});

// ─── deviceIds: the route's parsing contract ─────────────────────────────────

const TOKEN = "test-token-at-least-16-chars";
const auth = { authorization: `Bearer ${TOKEN}` };

const stubRepo = () => ({}) as unknown as Repository;

/** Builds the real server over the fake pool and returns what the SQL received. */
async function inject(query: string): Promise<{
  status: number;
  body: Record<string, unknown>;
  fake: Fake;
}> {
  const fake = fakePostgres({ alerts: [], devices: [] });
  const app = await buildServer({
    pool: fake.pool,
    repo: stubRepo(),
    auth: { token: TOKEN, allowAnonymous: false },
  });
  const res = await app.inject({ method: "GET", url: `/api/alerts?${query}`, headers: auth });
  await app.close();
  return { status: res.statusCode, body: res.json(), fake };
}

const boundIds = (fake: Fake): string[] => {
  const values = fake.countSql().values;
  const array = values.find((v): v is string[] => Array.isArray(v));
  assert.ok(array, "expected an array parameter carrying the device ids");
  return array;
};

test("a comma-separated deviceIds list is split into bound ids", async () => {
  const { status, fake } = await inject("deviceIds=dark-1,dark-2,dark-3");
  assert.equal(status, 200);
  assert.deepEqual(boundIds(fake), ["dark-1", "dark-2", "dark-3"]);
});

test("whitespace around each id is trimmed — a copied list must still resolve", async () => {
  const { status, fake } = await inject(encodeURI("deviceIds= dark-1 , dark-2 ,dark-3 "));
  assert.equal(status, 200);
  assert.deepEqual(boundIds(fake), ["dark-1", "dark-2", "dark-3"]);
});

test("duplicate ids are de-duplicated, so an alert cannot be counted twice", async () => {
  const { status, fake } = await inject("deviceIds=dark-1,dark-2,dark-1,dark-2,dark-1");
  assert.equal(status, 200);
  assert.deepEqual(boundIds(fake), ["dark-1", "dark-2"]);
});

test("empty entries are dropped rather than binding an empty-string id", async () => {
  const { status, fake } = await inject(encodeURI("deviceIds=dark-1,,dark-2, ,,dark-3,"));
  assert.equal(status, 200);
  assert.deepEqual(boundIds(fake), ["dark-1", "dark-2", "dark-3"]);
});

test("a deviceIds list of nothing but separators drops the filter instead of erroring", async () => {
  const { status, fake } = await inject(encodeURI("deviceIds=, ,,"));
  assert.equal(status, 200);
  // No array parameter at all: the request is treated as unfiltered.
  assert.ok(!fake.countSql().values.some((v) => Array.isArray(v)));
});

test("the deviceIds list is CAPPED at 500 — truncated, never passed unbounded", async () => {
  const ids = Array.from({ length: 600 }, (_, i) => `d${i}`);
  const { status, fake } = await inject(`deviceIds=${ids.join(",")}`);
  assert.equal(status, 200);
  const bound = boundIds(fake);
  assert.equal(bound.length, 500, "a caller must not be able to smuggle an unbounded IN list");
  // Truncation keeps the FIRST 500 in order, so the cap is predictable.
  assert.deepEqual(bound.slice(0, 3), ["d0", "d1", "d2"]);
  assert.equal(bound.at(-1), "d499");
});

test("the cap applies to DISTINCT ids, so duplicates do not eat the budget", async () => {
  // 400 unique ids each sent twice: all 400 must survive, not 250 of them.
  const unique = Array.from({ length: 400 }, (_, i) => `d${i}`);
  const { status, fake } = await inject(`deviceIds=${[...unique, ...unique].join(",")}`);
  assert.equal(status, 200);
  assert.equal(boundIds(fake).length, 400);
});

test("an over-long deviceIds string is a 400, not a truncated silent success", async () => {
  const { status, body } = await inject(`deviceIds=${"x".repeat(4100)}`);
  assert.equal(status, 400);
  assert.equal(body["error"], "bad_request");
});

test("deviceIds rides in the same envelope and pagination as any other alert query", async () => {
  const { status, body } = await inject("deviceIds=dark-1&limit=10&page=2");
  assert.equal(status, 200);
  const meta = body["meta"] as { page: Record<string, number> };
  assert.equal(meta.page["page"], 2);
  assert.equal(meta.page["limit"], 10);
  assert.equal(meta.page["totalPages"], 1, "totalPages is never 0, or the UI renders no pages");
});
