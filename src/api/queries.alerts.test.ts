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
import { ReadQueries, alertOrderBy, alertAgePredicate, likeContains, NO_RULE_ID } from "./queries.js";
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

/**
 * Remove `LEFT JOIN LATERAL ( ... ) alias ON TRUE` decorations.
 *
 * Epic 8.2 added two of them to the LIST query — the active suppression covering
 * each alert, and the note count — and both carry their own WHERE, which sits
 * BEFORE the outer WHERE in the statement. Without stripping them, `whereClause`
 * below finds the LATERAL's WHERE instead of the query's own and every predicate
 * test evaluates the wrong clause.
 *
 * Stripping is only safe because `ON TRUE` cannot eliminate a row: a lateral
 * joined on TRUE decorates the result and never filters it. That is asserted
 * rather than assumed, so the day someone moves a real filter into a lateral this
 * fake refuses instead of quietly ignoring it.
 */
function stripLateralJoins(sql: string): string {
  let out = sql;
  for (;;) {
    const at = out.search(/LEFT JOIN LATERAL\s*\(/i);
    if (at < 0) return out;
    let depth = 0;
    let end = -1;
    for (let i = out.indexOf("(", at); i < out.length; i += 1) {
      if (out[i] === "(") depth += 1;
      else if (out[i] === ")") {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    assert.ok(end > 0, "unbalanced parentheses in a LATERAL join");
    const after = out.slice(end + 1);
    const on = /^\s*(?:[a-z_]+\s+)?ON\s+TRUE/i.exec(after);
    assert.ok(
      on,
      "a LEFT JOIN LATERAL in the alert query must be `ON TRUE` — anything else can " +
        "eliminate rows, and this fake would then be evaluating a different query " +
        "than Postgres. Teach the fake before trusting the result.",
    );
    out = out.slice(0, at) + " " + after.slice(on[0].length);
  }
}

/** The WHERE clause only, with ORDER BY / LIMIT trimmed off. */
function whereClause(sql: string): string {
  const one = flat(stripLateralJoins(sql));
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
  // ── the triage-queue filters (Epic 8.5) ────────────────────────────────────
  // Modelled by EVALUATING them, not by matching their text. A fake that only
  // pattern-matched would pass whether the search escaped its wildcards, whether
  // the age window used `<` or `<=`, and whether the device-name reach was
  // correlated or broken — which is the whole question being asked here.

  const search = new RegExp(
    `^\\(a\\.title ILIKE \\$(\\d+) ESCAPE '\\\\' OR a\\.device_id ILIKE \\$\\1 ESCAPE '\\\\' ` +
      `OR a\\.rule_id ILIKE \\$\\1 ESCAPE '\\\\' OR a\\.severity ILIKE \\$\\1 ESCAPE '\\\\' ` +
      `OR EXISTS \\(SELECT 1 FROM devices ([a-z_]+) WHERE \\2\\.id = a\\.device_id ` +
      `AND \\(\\2\\.name ILIKE \\$\\1 ESCAPE '\\\\' OR \\2\\.location ILIKE \\$\\1 ESCAPE '\\\\'\\)\\)\\)$`,
    "i",
  ).exec(c);
  if (search) {
    const pattern = params[Number(search[1]) - 1] as string;
    assert.equal(typeof pattern, "string", "the search term must be bound, never interpolated");
    return (a, devices) => {
      const d = devices.find((row) => row.id === a.device_id);
      return [
        a.title, a.device_id, a.rule_id, a.severity,
        // Only reachable through the correlated subquery, so an alert whose
        // device row has not landed cannot match on these two.
        ...(d ? [d.name, d.location] : []),
      ].some((field) => field != null && ilike(String(field), pattern));
    };
  }
  const rule = /^a\.rule_id = \$(\d+)$/i.exec(c);
  if (rule) {
    const want = params[Number(rule[1]) - 1];
    return (a) => a.rule_id === want;
  }
  if (/^\(a\.rule_id IS NULL OR a\.rule_id = ''\)$/i.test(c)) {
    return (a) => a.rule_id === null || a.rule_id === "";
  }
  const age = /^a\.opened_at (>|<=) \$(\d+)::timestamptz - interval '(\d+) (hour|hours|day|days)'$/i
    .exec(c);
  if (age) {
    const now = params[Number(age[2]) - 1];
    assert.ok(now instanceof Date,
      "the age window must be measured against a BOUND clock, so the COUNT and the " +
      "LIST cannot read `now()` a microsecond apart and disagree on a boundary row");
    const unit = /^hour/i.test(age[4]!) ? 3_600_000 : 86_400_000;
    const edge = now.getTime() - Number(age[3]) * unit;
    return age[1] === ">"
      ? (a) => a.opened_at.getTime() > edge
      : (a) => a.opened_at.getTime() <= edge;
  }

  throw new Error(
    `fakePostgres does not know the predicate \`${c}\` — if a filter was ` +
      `rewritten, teach this fake before trusting the result`,
  );
}

/**
 * `ILIKE pattern ESCAPE '\'`, as Postgres applies it.
 *
 * Written out so the fake can be WRONG about escaping: `%` and `_` are wildcards
 * unless escaped, and the console searches with `String.includes` where both are
 * ordinary characters. A fake that treated the pattern as a plain substring
 * could not tell a correctly escaped filter from an unescaped one.
 */
function ilike(value: string, pattern: string): boolean {
  let regex = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next !== undefined) { regex += next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); i += 1; continue; }
    }
    if (ch === "%") { regex += ".*"; continue; }
    if (ch === "_") { regex += "."; continue; }
    regex += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${regex}$`, "i").test(value);
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
        // Read from the OUTER statement: the suppression lateral carries its own
        // `LIMIT 1` (narrowest covering record) and matching that instead would
        // silently paginate every page down to one row.
        const outer = stripLateralJoins(sql);
        const limit = Number(/LIMIT (\d+)/i.exec(outer)?.[1] ?? 50);
        const offset = Number(/OFFSET (\d+)/i.exec(outer)?.[1] ?? 0);
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

test("DECIDED: an empty deviceIds array matches NOTHING, not everything", async () => {
  // This test previously pinned the opposite (an empty array dropped the filter),
  // flagged as an open design question rather than a bug. It is now decided the
  // other way: a filter whose entire job is to NARROW must not fail open. The
  // dormant drilldown builds its query from rollup.drilldown.deviceIds, so an
  // empty list rendering every open alert is the wrong direction to fail in.
  const fake = fakePostgres({
    alerts: [alert({ id: "a", device_id: "d1" })],
    devices: [device("d1")],
  });
  const result = await new ReadQueries(fake.pool).alerts({ ...base, deviceIds: [] });
  assert.ok(/ANY\(/i.test(whereClause(fake.countSql().sql)), "the predicate must still be applied");
  assert.equal(result.totalItems, 0, "an explicit filter matching nothing returns nothing");
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

/**
 * The minimum repository `/api/alerts` needs.
 *
 * Epic 8.2 made the list band-aware: it resolves the suppressed band from the
 * PURE classifier and passes the resulting alert ids to the query, rather than
 * re-encoding the critical/high safety valve as a second SQL predicate. So the
 * route now reads the open-alert facts and the suppression records. Empty here —
 * these tests are about the `deviceIds` parsing contract, and an empty
 * suppression set is the case where the band adds no predicate at all, which is
 * exactly what keeps these assertions about `deviceIds` alone.
 */
const stubRepo = () =>
  ({
    async openAlertFacts() { return []; },
    async listSuppressions() { return []; },
  }) as unknown as Repository;

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

test("DECIDED: a deviceIds list of nothing but separators matches nothing, and does not error", async () => {
  const { status, fake } = await inject(encodeURI("deviceIds=, ,,"));
  assert.equal(status, 200, "garbage separators are not a client error");
  // An empty array IS still bound, so the predicate is present and matches
  // nothing — the request is explicitly filtered, not unfiltered.
  const bound = fake.countSql().values.find((v) => Array.isArray(v));
  assert.deepEqual(bound, [], "an empty id array must be bound, not dropped");
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

// ─── the triage queue moved server-side (Epic 8.5) ───────────────────────────
//
// The console filtered the queue in the browser: `apiAll` walked every page and
// `alertBands()` applied search, rule, age, severity and sort to the array. That
// is correct only while every page fits — the walk caps at 2,000 rows, which the
// alert collection reaches at roughly 1,600 devices, and past the cap the client
// filters a TRUNCATED set while still reporting a total.
//
// Moving it into SQL puts every one of those predicates into the pair of
// statements that must agree, so each test below asserts the same three things:
// the predicate is legal in the COUNT as well as the LIST, the two receive the
// identical WHERE and parameters, and the rows it returns are the rows the
// console would have kept.

const NOW = new Date("2026-09-16T12:00:00Z");
const opened = (iso: string) => ({ opened_at: new Date(iso), last_fired_at: new Date(iso) });

/** Both statements, asserted to be the same filter before anything else. */
function assertStatementsAgree(fake: Fake): void {
  const count = fake.countSql();
  const list = fake.listSql();
  assert.equal(whereClause(count.sql), whereClause(list.sql),
    "the COUNT and the LIST must carry the identical WHERE, or a count can disagree with its own list");
  assert.deepEqual(count.values, list.values, "and the identical parameters");
  assert.ok(!/\bd\./.test(whereClause(count.sql)),
    "no filter may reference the LIST query's devices alias — it does not exist in the COUNT");
  assert.ok(!/JOIN devices/i.test(flat(count.sql)), "the COUNT query must stay join-free");
}

// ─── q: free-text search ─────────────────────────────────────────────────────

test("search is one bound parameter, legal in both statements", async () => {
  const fake = fakePostgres();
  await new ReadQueries(fake.pool).alerts({ ...base, q: "lobby" });
  assertStatementsAgree(fake);
  assert.deepEqual(fake.countSql().values, ["%lobby%"]);
  // Device name and location are reached by a CORRELATED subquery, which is the
  // only form legal in the join-free COUNT.
  assert.ok(/EXISTS \(SELECT 1 FROM devices [a-z_]+ WHERE/i.test(whereClause(fake.countSql().sql)));
});

test("search matches the fields the console searches, and the count agrees with the list", async () => {
  // The console's haystack: device name, device id, title, rule id, severity,
  // location. One alert per field, each matched by a term that hits only it.
  const alerts = [
    alert({ id: "by-title", device_id: "d-title", title: "Screen is black" }),
    alert({ id: "by-device-id", device_id: "zebra-77" }),
    alert({ id: "by-rule", device_id: "d-rule", rule_id: "showing-logo" }),
    alert({ id: "by-severity", device_id: "d-sev", severity: "critical" }),
    alert({ id: "by-name", device_id: "d-name" }),
    alert({ id: "by-location", device_id: "d-loc" }),
    alert({ id: "no-match", device_id: "d-none" }),
  ];
  const devices: DeviceRow[] = [
    { id: "d-title", name: "A", location: "B", retired_at: null },
    { id: "zebra-77", name: "A", location: "B", retired_at: null },
    { id: "d-rule", name: "A", location: "B", retired_at: null },
    { id: "d-sev", name: "A", location: "B", retired_at: null },
    { id: "d-name", name: "Reception Canvas", location: "B", retired_at: null },
    { id: "d-loc", name: "A", location: "Gustavsberg", retired_at: null },
    { id: "d-none", name: "A", location: "B", retired_at: null },
  ];
  const cases: Array<[string, string]> = [
    ["black", "by-title"],
    ["zebra", "by-device-id"],
    ["showing-logo", "by-rule"],
    ["critical", "by-severity"],
    ["reception", "by-name"],
    ["gustavsberg", "by-location"],
  ];
  for (const [term, expected] of cases) {
    const fake = fakePostgres({ alerts, devices });
    const result = await new ReadQueries(fake.pool).alerts({ ...base, q: term });
    assert.deepEqual(result.items.map((i) => i["id"]), [expected], `q=${term}`);
    assert.equal(result.totalItems, 1, `q=${term}: the COUNT must see the same one row`);
    assertStatementsAgree(fake);
  }
});

test("search is case-insensitive, matching the console's lowercased includes", async () => {
  const fake = fakePostgres({
    alerts: [alert({ id: "a", device_id: "d1", title: "Screen is BLACK" })],
    devices: [device("d1")],
  });
  const result = await new ReadQueries(fake.pool).alerts({ ...base, q: "black" });
  assert.equal(result.totalItems, 1);
});

test("search does NOT reach the evidence blob", async () => {
  // Ported deliberately: the console excludes evidence because matching free
  // text inside it makes a search for "logo" return rows whose rule is not
  // showing-logo. A server filter that widened the haystack would return rows
  // the client would have hidden.
  const fake = fakePostgres({
    alerts: [alert({ id: "a", device_id: "d1", title: "Offline", evidence: { note: "logo" } })],
    devices: [device("d1")],
  });
  const result = await new ReadQueries(fake.pool).alerts({ ...base, q: "logo" });
  assert.equal(result.totalItems, 0);
  assert.deepEqual(result.items, []);
});

test("a `%` or `_` in the search term is a LITERAL character, not a wildcard", async () => {
  // `devices()` binds `%${search}%` unescaped, so "50%" there matches every row.
  // The console searches with String.includes, where both are ordinary
  // characters, so the alert queue escapes them. Without this, one keystroke of
  // punctuation silently returns the entire queue as if it had matched.
  const fake = fakePostgres({
    alerts: [
      alert({ id: "pct", device_id: "d1", title: "Storage at 95% full" }),
      alert({ id: "plain", device_id: "d1", rule_id: "other", title: "Offline for 4h" }),
    ],
    devices: [device("d1")],
  });
  const wild = await new ReadQueries(fake.pool).alerts({ ...base, q: "%" });
  assert.deepEqual(wild.items.map((i) => i["id"]), ["pct"],
    "a bare % must match the row containing a literal percent sign — not every row");
  assert.equal(wild.totalItems, 1, "and the count must not swell to the whole queue either");

  const fake2 = fakePostgres({
    alerts: [
      alert({ id: "under", device_id: "d1", title: "a_b" }),
      alert({ id: "any", device_id: "d1", rule_id: "other", title: "axb" }),
    ],
    devices: [device("d1")],
  });
  const under = await new ReadQueries(fake2.pool).alerts({ ...base, q: "a_b" });
  assert.deepEqual(under.items.map((i) => i["id"]), ["under"],
    "`_` must match an underscore, not any character");
});

test("likeContains escapes the escape character itself, first", () => {
  assert.equal(likeContains("plain"), "%plain%");
  assert.equal(likeContains("50%"), "%50\\%%");
  assert.equal(likeContains("a_b"), "%a\\_b%");
  // A backslash the user typed must survive as a backslash, not become the
  // escape for the character after it.
  assert.equal(likeContains("a\\b"), "%a\\\\b%");
  assert.equal(likeContains("\\%"), "%\\\\\\%%");
});

test("a search term carrying SQL is data, never syntax", async () => {
  const hostile = "'); DROP TABLE alerts; --";
  const fake = fakePostgres();
  await new ReadQueries(fake.pool).alerts({ ...base, q: hostile });
  for (const captured of [fake.countSql(), fake.listSql()]) {
    assert.ok(!captured.sql.includes("DROP TABLE"), "the term must never reach the statement text");
    assert.deepEqual(captured.values, [`%${hostile}%`]);
  }
});

test("an alert whose device row has not landed is still searchable by its own columns", async () => {
  // The orphan case, again: the correlated subquery cannot match a missing
  // device, but the alert's own title must still be findable. Hiding it would be
  // the search deciding an alert does not exist.
  const fake = fakePostgres({
    alerts: [alert({ id: "orphan", device_id: "unknown-1", title: "Screen is black" })],
    devices: [],
  });
  assert.equal((await new ReadQueries(fake.pool).alerts({ ...base, q: "black" })).totalItems, 1);
  assert.equal((await new ReadQueries(fake.pool).alerts({ ...base, q: "canvas" })).totalItems, 0);
});

// ─── rule ────────────────────────────────────────────────────────────────────

test("the rule filter is an equality on a column of the table both statements share", async () => {
  const fake = fakePostgres({
    alerts: [
      alert({ id: "match", device_id: "d1", rule_id: "offline-4h" }),
      alert({ id: "other", device_id: "d1", rule_id: "firmware-behind" }),
    ],
    devices: [device("d1")],
  });
  const result = await new ReadQueries(fake.pool).alerts({ ...base, rule: "offline-4h" });
  assert.deepEqual(result.items.map((i) => i["id"]), ["match"]);
  assert.equal(result.totalItems, 1);
  assertStatementsAgree(fake);
  assert.deepEqual(fake.countSql().values, ["offline-4h"]);
});

test("the console's `(no rule id)` bucket selects rows with no rule id, not a rule named that", async () => {
  // The console labels a missing rule id `(no rule id)` and sends the LABEL back
  // as the filter. Matched literally it would search for a rule so named and
  // return an empty queue for an option the UI says has rows behind it.
  const fake = fakePostgres({
    alerts: [
      alert({ id: "blank", device_id: "d1", rule_id: "" }),
      alert({ id: "named", device_id: "d1", rule_id: NO_RULE_ID }),
      alert({ id: "real", device_id: "d1", rule_id: "offline-4h" }),
    ],
    devices: [device("d1")],
  });
  const result = await new ReadQueries(fake.pool).alerts({ ...base, rule: NO_RULE_ID });
  assert.deepEqual(result.items.map((i) => i["id"]), ["blank"]);
  assert.equal(result.totalItems, 1);
  // No parameter is bound: the predicate is pure SQL about nullness.
  assert.deepEqual(fake.countSql().values, []);
  assertStatementsAgree(fake);
});

// ─── age ─────────────────────────────────────────────────────────────────────

test("every age window is measured against ONE bound clock, shared by count and list", async () => {
  // Two statements on two connections. Reading `now()` in each lets an alert on
  // the boundary land in one and not the other, and a count that disagrees with
  // its own list is the bug this file exists to catch.
  const fake = fakePostgres();
  await new ReadQueries(fake.pool).alerts({ ...base, age: "24h", now: NOW });
  assertStatementsAgree(fake);
  assert.deepEqual(fake.countSql().values, [NOW]);
  assert.ok(/\$1::timestamptz/.test(whereClause(fake.countSql().sql)),
    "the clock must be a bound parameter, not now()");
  assert.ok(!/\bnow\(\)/i.test(whereClause(fake.countSql().sql)));
});

test("the age windows keep the console's cumulative semantics", async () => {
  const alerts = [
    alert({ id: "future", device_id: "d1", rule_id: "r0", ...opened("2026-09-16T13:00:00Z") }),
    alert({ id: "min-30", device_id: "d1", rule_id: "r1", ...opened("2026-09-16T11:30:00Z") }),
    alert({ id: "hr-6", device_id: "d1", rule_id: "r2", ...opened("2026-09-16T06:00:00Z") }),
    alert({ id: "day-3", device_id: "d1", rule_id: "r3", ...opened("2026-09-13T12:00:00Z") }),
    alert({ id: "day-10", device_id: "d1", rule_id: "r4", ...opened("2026-09-06T12:00:00Z") }),
    alert({ id: "day-60", device_id: "d1", rule_id: "r5", ...opened("2026-07-18T12:00:00Z") }),
  ];
  const expected: Record<string, string[]> = {
    all: ["future", "min-30", "hr-6", "day-3", "day-10", "day-60"],
    // A clock-skewed future timestamp satisfies the "within" windows in the
    // console too (now - t is negative, which is < the window). A reading, not
    // a reason to hide a row.
    "1h": ["future", "min-30"],
    "24h": ["future", "min-30", "hr-6"],
    "7d": ["future", "min-30", "hr-6", "day-3"],
    o7d: ["day-10", "day-60"],
    o30d: ["day-60"],
  };
  for (const [window, ids] of Object.entries(expected)) {
    const fake = fakePostgres({ alerts, devices: [device("d1")] });
    const result = await new ReadQueries(fake.pool).alerts({
      ...base, age: window as "all", now: NOW,
    });
    assert.deepEqual(result.items.map((i) => i["id"]).sort(), [...ids].sort(), `age=${window}`);
    assert.equal(result.totalItems, ids.length, `age=${window}: the COUNT must agree`);
  }
  // `7d` and `o7d` are complements over the same set — no alert in both, none in
  // neither. The dormant band's sum invariant, applied to the age chips.
  assert.equal(
    expected["7d"]!.length + expected["o7d"]!.length, expected["all"]!.length,
    "the 7-day pair must partition the queue exactly",
  );
});

test("age=all adds no predicate and binds no clock", async () => {
  const fake = fakePostgres();
  await new ReadQueries(fake.pool).alerts({ ...base, age: "all" });
  assert.deepEqual(fake.countSql().values, [], "an unfiltered window must not bind a parameter");
  assert.ok(!/interval/i.test(whereClause(fake.countSql().sql)));
});

test("alertAgePredicate: `all` is the absence of a filter, never a predicate that drops rows", () => {
  assert.equal(alertAgePredicate("all", "$1::timestamptz"), null);
  assert.equal(alertAgePredicate("1h", "$1::timestamptz"),
    "a.opened_at > $1::timestamptz - interval '1 hour'");
  assert.equal(alertAgePredicate("o30d", "$1::timestamptz"),
    "a.opened_at <= $1::timestamptz - interval '30 days'");
});

// ─── composition: the whole queue at once ────────────────────────────────────

test("search, rule, age, severity and state compose, and the count counts exactly them", async () => {
  const alerts = [
    alert({ id: "keep", device_id: "d-keep", rule_id: "offline-4h", severity: "critical",
            title: "Lobby screen offline", ...opened("2026-09-14T12:00:00Z") }),
    alert({ id: "wrong-sev", device_id: "d-keep", rule_id: "offline-4h", severity: "info",
            title: "Lobby screen offline", ...opened("2026-09-14T12:00:00Z") }),
    alert({ id: "wrong-rule", device_id: "d-keep", rule_id: "firmware-behind", severity: "critical",
            title: "Lobby screen behind", ...opened("2026-09-14T12:00:00Z") }),
    alert({ id: "wrong-age", device_id: "d-keep", rule_id: "offline-4h", severity: "critical",
            title: "Lobby screen offline", ...opened("2026-07-01T12:00:00Z") }),
    alert({ id: "wrong-text", device_id: "d-keep", rule_id: "offline-4h", severity: "critical",
            title: "Kitchen screen offline", ...opened("2026-09-14T12:00:00Z") }),
    alert({ id: "resolved", device_id: "d-keep", rule_id: "offline-4h", severity: "critical",
            title: "Lobby screen offline", ...opened("2026-09-14T12:00:00Z"),
            resolved_at: new Date("2026-09-15T12:00:00Z") }),
  ];
  const fake = fakePostgres({
    alerts,
    devices: [{ id: "d-keep", name: "Store 12", location: "Barcelona", retired_at: null }],
  });
  const result = await new ReadQueries(fake.pool).alerts({
    ...base, q: "lobby", rule: "offline-4h", age: "7d", severity: "critical", now: NOW,
  });
  assert.deepEqual(result.items.map((i) => i["id"]), ["keep"]);
  assert.equal(result.totalItems, 1, "the count must be of the filtered set, not of the queue");
  assertStatementsAgree(fake);
  // Every dimension is bound in order, and the same values reach both statements.
  assert.deepEqual(fake.countSql().values, ["critical", "%lobby%", "offline-4h", NOW]);
});

test("limit=0 returns the filtered TOTAL and no rows — the same statement, page thrown away", async () => {
  const alerts = [
    alert({ id: "a", device_id: "d1", rule_id: "offline-4h" }),
    alert({ id: "b", device_id: "d1", rule_id: "offline-4h", severity: "info" }),
    alert({ id: "c", device_id: "d1", rule_id: "firmware-behind" }),
  ];
  const listed = await new ReadQueries(
    fakePostgres({ alerts, devices: [device("d1")] }).pool,
  ).alerts({ ...base, rule: "offline-4h" });
  const fake = fakePostgres({ alerts, devices: [device("d1")] });
  const counted = await new ReadQueries(fake.pool).alerts({ ...base, limit: 0, rule: "offline-4h" });

  assert.equal(listed.totalItems, 2);
  assert.equal(counted.totalItems, listed.totalItems, "the count-only total must equal the list's");
  assert.deepEqual(counted.items, [], "and carry no rows");
  assert.ok(/LIMIT 0 OFFSET 0/.test(flat(fake.listSql().sql)));
});

// ─── sort ────────────────────────────────────────────────────────────────────

test("alertOrderBy: every order is total, ending in a.id", () => {
  // LIMIT/OFFSET over a non-total order can return one row on two pages and drop
  // another entirely — and the console pages 200 rows at a time, so every tie is
  // a chance to lose an alert.
  for (const sort of ["sev", "recent", "oldest", "device", "rule"] as const) {
    assert.ok(alertOrderBy(sort).endsWith("a.id"), `${sort} must break ties on the primary key`);
  }
});

test("alertOrderBy: the default is the order this endpoint has always returned", () => {
  assert.equal(
    alertOrderBy("sev"),
    "CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, " +
      "a.opened_at DESC, a.id",
  );
});

test("alertOrderBy: only `device` reaches for the join, and only a sort may", async () => {
  // A sort may use the LIST query's `d` alias because the COUNT has no ORDER BY
  // at all — the constraint that binds every WHERE predicate does not bind this.
  assert.ok(/\bd\.name\b/.test(alertOrderBy("device")));
  for (const sort of ["sev", "recent", "oldest", "rule"] as const) {
    assert.ok(!/\bd\./.test(alertOrderBy(sort)), `${sort} must not depend on the join`);
  }
  const fake = fakePostgres();
  await new ReadQueries(fake.pool).alerts({ ...base, sort: "device" });
  assert.ok(/ORDER BY lower\(COALESCE\(NULLIF\(d\.name/.test(flat(fake.listSql().sql)));
  assert.ok(!/ORDER BY/i.test(flat(fake.countSql().sql)),
    "the COUNT must not sort — it has nothing to sort and no alias to sort by");
});

test("the sort reaches the statement, and an unspecified sort changes nothing", async () => {
  const fake = fakePostgres();
  await new ReadQueries(fake.pool).alerts({ ...base, sort: "oldest" });
  assert.ok(/ORDER BY a\.opened_at ASC, a\.id/.test(flat(fake.listSql().sql)));

  const plain = fakePostgres();
  await new ReadQueries(plain.pool).alerts(base);
  assert.ok(/ORDER BY CASE a\.severity/.test(flat(plain.listSql().sql)));
});
