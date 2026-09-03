/**
 * `limit=0` — the count without the rows — `node --test dist/api/routes/devices.count.test.js`
 *
 * WHAT THIS PINS. The console pages 200 rows at a time and stops at 2,000. It
 * discloses that truncation now, but the CAUSE was that a nav badge needs a
 * TOTAL and the only way to get one was to walk every page. `limit=0` returns
 * `meta.page.totalItems` and no rows.
 *
 * The only property that really matters is that the count and the list AGREE for
 * the same query, so every filter test below asserts BOTH: `limit=0` against the
 * same filters served with rows, and the totals matched. That is asserted rather
 * than assumed because this codebase has already shipped the failure — the
 * alerts COUNT selects from `alerts` alone with no devices join, so an
 * alias-based predicate compiles in the list and raises `missing FROM-clause
 * entry` in the count, and that 500'd a live endpoint while stub tests passed.
 * The fake pool below resolves aliases the way Postgres does, so it throws the
 * same error rather than rubber-stamping the SQL.
 *
 * Nothing here touches a database, a device or the control plane.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { Repository } from "../../db/repository.js";
import type { VideriHttp } from "../../videri/http.js";
import { buildGroupIndex } from "../../videri/services/group-hierarchy.js";
import type { RawGroup } from "../../videri/services/aggregator.js";
import { buildServer } from "../server.js";

// ─── the tenant, shaped like the real one ────────────────────────────────────

const GROUPS: RawGroup[] = [
  { uuid: "g-root", displayName: "Videri Prod", parentUuid: null },
  { uuid: "g-sales", displayName: "Videri Sales", parentUuid: "g-root" },
  { uuid: "g-sales-2", displayName: "Videri Sales Floor 2", parentUuid: "g-sales" },
  { uuid: "g-nyc", displayName: "NYC Office", parentUuid: "g-root" },
];

interface Row {
  id: string;
  name: string | null;
  location: string | null;
  city: string | null;
  device_id: string | null;
  model_type: string | null;
  serial_no: string | null;
  device_class: string;
  group_id: string | null;
  group_name: string | null;
  account_name: string | null;
  tags: string[];
  presence: string | null;
  retired_at: Date | null;
}

const device = (over: Partial<Row> & { id: string }): Row => ({
  name: `Canvas ${over.id}`,
  location: null,
  city: "LONDON",
  device_id: over.id,
  model_type: "canvas-32",
  serial_no: `SN-${over.id}`,
  device_class: "canvas",
  group_id: null,
  group_name: null,
  account_name: "VIDERISALES",
  tags: [],
  presence: "online",
  retired_at: null,
  ...over,
});

/**
 * 24 live devices plus 3 retired ones. The retired rows exist so "the count
 * excludes retired devices exactly as the list does" is a real assertion rather
 * than a vacuous one — a list that includes them makes every total one too many.
 */
const FLEET: Row[] = [
  ...Array.from({ length: 9 }, (_, i) =>
    device({ id: `sales-${i}`, group_id: "g-sales", group_name: "Videri Sales", presence: i < 4 ? "offline" : "online" }),
  ),
  ...Array.from({ length: 5 }, (_, i) =>
    device({ id: `sales2-${i}`, group_id: "g-sales-2", group_name: "Videri Sales Floor 2", presence: "offline" }),
  ),
  ...Array.from({ length: 7 }, (_, i) =>
    device({ id: `nyc-${i}`, group_id: "g-nyc", group_name: "NYC Office", presence: "online" }),
  ),
  device({ id: "screen-1", group_id: "g-nyc", device_class: "screen", presence: "offline" }),
  device({ id: "no-group", presence: null }),
  device({ id: "orphan", group_id: "g-vanished" }),
  // Retired: upstream says they no longer exist.
  device({ id: "gone-1", group_id: "g-sales", retired_at: new Date("2026-07-01T00:00:00Z") }),
  device({ id: "gone-2", group_id: "g-nyc", retired_at: new Date("2026-07-01T00:00:00Z"), presence: "offline" }),
  device({ id: "gone-3", group_id: null, retired_at: new Date("2026-07-01T00:00:00Z") }),
];

const LIVE = FLEET.filter((d) => d.retired_at === null).length;

// ─── alias resolution, the way Postgres does it ──────────────────────────────
// Lifted deliberately from queries.devices-site.test.ts: the guard is the same
// guard, and weakening it here would let the exact bug it catches through.

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
    if (!/^(on|where|order|group|limit|left|inner|join|lateral)$/i.test(m[2]!)) found.push(m[2]!);
  }
  return found;
};

const referencedAliases = (text: string): string[] =>
  [...text.matchAll(/\b([a-z_]+)\.[a-z_]+/gi)].map((m) => m[1]!);

function assertAliasesResolve(sql: string): void {
  const { outer, groups } = stripSubexpressions(sql);
  const outerScope = new Set(declaredAliases(outer));
  const check = (text: string, scope: Set<string>) => {
    for (const ref of referencedAliases(text)) {
      if (!scope.has(ref)) throw new Error(`missing FROM-clause entry for table "${ref}"`);
    }
  };
  check(outer, outerScope);
  for (const group of groups) check(group, new Set([...outerScope, ...declaredAliases(group)]));
}

// ─── WHERE evaluation ────────────────────────────────────────────────────────

const flat = (s: string) => s.replace(/\s+/g, " ").trim();

function whereClause(sql: string): string {
  const one = flat(sql);
  let depth = 0;
  let start = -1;
  for (let i = 0; i < one.length; i++) {
    const ch = one[i]!;
    if (ch === "(") { depth += 1; continue; }
    if (ch === ")") { depth -= 1; continue; }
    if (depth !== 0) continue;
    if (start < 0) {
      if (/^WHERE /i.test(one.slice(i, i + 6))) { start = i + 6; i += 5; }
      continue;
    }
    if (/^ORDER BY /i.test(one.slice(i, i + 9)) || /^LIMIT /i.test(one.slice(i, i + 6))) {
      return one.slice(start, i).trim();
    }
  }
  return start < 0 ? "" : one.slice(start).trim();
}

function split(where: string, on: "AND" | "OR"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const token of where.split(new RegExp(`\\b(${on})\\b`, "i"))) {
    if (new RegExp(`^${on}$`, "i").test(token) && depth === 0) {
      parts.push(current); current = ""; continue;
    }
    for (const ch of token) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
    }
    current += token;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

type Predicate = (d: Row) => boolean;

const like = (value: string | null, pattern: unknown): boolean =>
  value !== null && value.toLowerCase().includes(String(pattern).slice(1, -1).toLowerCase());

function compile(conjunct: string, params: readonly unknown[]): Predicate {
  const c = conjunct.replace(/\s+/g, " ").trim();
  if (c.startsWith("(") && c.endsWith(")")) {
    const inner = split(c.slice(1, -1), "OR").map((part) => compile(part, params));
    return (d) => inner.some((p) => p(d));
  }
  if (/^d\.retired_at IS NULL$/i.test(c)) return (d) => d.retired_at === null;

  const derived = /^CASE .* END = \$(\d+)$/i.exec(c);
  if (derived) {
    const want = params[Number(derived[1]) - 1];
    return (d) =>
      (d.presence === null ? "unknown" : d.presence === "online" ? "online" : "offline") === want;
  }
  const ilike = /^d\.([a-z_]+) ILIKE \$(\d+)$/i.exec(c);
  if (ilike) {
    const column = ilike[1]! as keyof Row;
    return (d) => like((d[column] ?? null) as string | null, params[Number(ilike[2]) - 1]);
  }
  const many = /^d\.([a-z_]+) = ANY\(\$(\d+)::text\[\]\)$/i.exec(c);
  if (many) {
    const column = many[1]! as keyof Row;
    const want = params[Number(many[2]) - 1];
    assert.ok(Array.isArray(want), "a many-value filter must be bound as an array parameter");
    return (d) => (want as string[]).includes(d[column] as string);
  }
  const one = /^d\.([a-z_]+) = \$(\d+)$/i.exec(c);
  if (one) {
    const column = one[1]! as keyof Row;
    const want = params[Number(one[2]) - 1];
    return (d) => d[column] === want;
  }
  throw new Error(
    `fakePostgres does not know the predicate \`${c}\` — teach this fake before trusting the result`,
  );
}

interface Fake {
  pool: Pool;
  /** Every device statement issued, so we can prove which ones ran. */
  statements: () => Array<{ sql: string; values: unknown[] }>;
}

function fakePostgres(devices: Row[]): Fake {
  const captured: Array<{ sql: string; values: unknown[] }> = [];

  const select = (sql: string, values: unknown[]): Row[] => {
    assertAliasesResolve(sql);
    const predicates = split(whereClause(sql), "AND").map((c) => compile(c, values));
    return devices.filter((d) => predicates.every((p) => p(d)));
  };

  const pool = {
    async query(sql: string, values: unknown[] = []) {
      const isDeviceQuery = /FROM devices d\b/i.test(sql) && !/FROM devices rd\b/i.test(sql);
      if (isDeviceQuery) captured.push({ sql, values });
      if (isDeviceQuery && /COUNT\(\*\)::text AS count/i.test(sql)) {
        return { rows: [{ count: String(select(sql, values).length) }], rowCount: 1 };
      }
      if (isDeviceQuery) {
        // Matched as a PAIR: each lateral carries its own LIMIT 1, so taking the
        // first LIMIT in the statement would paginate the page to one row.
        const paging = /LIMIT (\d+) OFFSET (\d+)/i.exec(sql);
        const limit = Number(paging?.[1] ?? 50);
        const offset = Number(paging?.[2] ?? 0);
        // `LIMIT 0` is what makes this cheap for real: Postgres answers a Limit
        // node with a zero count without executing its child at all — no sort,
        // no lateral fan-out. The fake mirrors that by slicing to nothing.
        const rows = select(sql, values)
          .slice(offset, offset + limit)
          .map((d) => ({ ...d, status: d.presence === "online" ? "online" : "offline" }));
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("MAX(observed_at)")) return { rows: [{ newest: new Date() }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;

  return { pool, statements: () => captured };
}

// ─── the harness ─────────────────────────────────────────────────────────────

const TOKEN = "test-token-at-least-16-chars";
const auth = { authorization: `Bearer ${TOKEN}` };
const stubRepo = () => ({}) as unknown as Repository;

const stubVideri = (): VideriHttp =>
  ({
    async request(_service: string, path: string) {
      assert.equal(path, "/v1/groups");
      return { groups: GROUPS, meta: { total: GROUPS.length } };
    },
  }) as unknown as VideriHttp;

interface Response {
  status: number;
  data: Array<Record<string, unknown>>;
  page: { page: number; limit: number; totalItems: number; totalPages: number };
  meta: Record<string, unknown>;
  statements: Array<{ sql: string; values: unknown[] }>;
}

async function get(query: string, fleet: Row[] = FLEET): Promise<Response> {
  const fake = fakePostgres(fleet);
  const app = await buildServer({
    pool: fake.pool,
    repo: stubRepo(),
    auth: { token: TOKEN, allowAnonymous: false },
    videri: stubVideri(),
  });
  const res = await app.inject({ method: "GET", url: `/api/devices?${query}`, headers: auth });
  await app.close();
  const body = res.json();
  return {
    status: res.statusCode,
    data: body.data ?? [],
    page: body.meta?.page,
    meta: body.meta ?? {},
    statements: fake.statements(),
  };
}

/**
 * The assertion that carries this whole file: count-only and the same query WITH
 * rows must report the same total. Run over every filter combination below.
 */
async function assertCountMatchesList(query: string, expected: number): Promise<void> {
  const listed = await get(`${query}&limit=200`);
  const counted = await get(`${query}&limit=0`);

  assert.equal(listed.status, 200, `list 200 for ${query}`);
  assert.equal(counted.status, 200, `count 200 for ${query}`);
  assert.equal(listed.page.totalItems, expected, `list total for ${query}`);
  assert.equal(
    counted.page.totalItems,
    listed.page.totalItems,
    `count disagreed with the list for ${query}`,
  );
  // And the total is the real number of rows, not the page size — otherwise a
  // count that happened to match a short page would pass this.
  assert.equal(listed.data.length, expected, `rows served for ${query}`);
  assert.equal(counted.data.length, 0, `count-only must serve NO rows for ${query}`);
}

// ─── the fake earns its keep ─────────────────────────────────────────────────

test("the fake pool rejects an out-of-scope alias, so these tests can actually fail", () => {
  assert.throws(
    () => assertAliasesResolve(`SELECT COUNT(*)::text AS count FROM devices d WHERE dt.rssi_dbm IS NULL`),
    /missing FROM-clause entry for table "dt"/,
  );
});

// ─── the count itself ────────────────────────────────────────────────────────

test("limit=0 returns the total and no rows", async () => {
  const res = await get("limit=0");
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, []);
  assert.equal(res.page.totalItems, LIVE);
  assert.equal(res.page.limit, 0);
  assert.equal(res.page.totalPages, 0, "no pages to fetch at a page size of zero");
  // An empty `data` must not read as "nothing matched your filters".
  assert.equal(res.meta["countOnly"], true);
  assert.match(res.meta["countNote"] as string, /carries no rows by request/);
});

test("limit=0 is a COUNT, not a walk: the row half asks Postgres for LIMIT 0", async () => {
  const res = await get("limit=0");
  const count = res.statements.filter((s) => /COUNT\(\*\)::text AS count/i.test(s.sql));
  const rows = res.statements.filter((s) => !/COUNT\(\*\)::text AS count/i.test(s.sql));
  assert.equal(count.length, 1, "exactly one COUNT(*)");
  assert.equal(rows.length, 1);
  // A Limit node with a zero count returns end-of-scan without executing its
  // child, so there is no sort, no lateral fan-out and no heap access here.
  assert.match(flat(rows[0]!.sql), /LIMIT 0 OFFSET 0/);
  // Same WHERE and same params as the count — that is what makes them agree.
  assert.equal(whereClause(count[0]!.sql), whereClause(rows[0]!.sql));
  assert.deepEqual(count[0]!.values, rows[0]!.values);
});

test("a normal request is untouched: rows, real page maths, no countOnly marker", async () => {
  const res = await get("limit=5&page=2");
  assert.equal(res.data.length, 5);
  assert.equal(res.page.totalItems, LIVE);
  assert.equal(res.page.totalPages, Math.ceil(LIVE / 5));
  assert.equal(res.meta["countOnly"], undefined);
});

// ─── every filter the list honours, the count honours ────────────────────────

test("the count excludes RETIRED devices exactly as the list does", async () => {
  await assertCountMatchesList("", LIVE);
  const res = await get("limit=0");
  assert.equal(
    res.page.totalItems,
    FLEET.length - 3,
    "3 retired rows must be in neither the list nor the count",
  );
  // And with a filter that would otherwise select them.
  await assertCountMatchesList("siteIds=g-nyc", 8);
});

test("the count honours the SITE filter, including its descendant groups", async () => {
  // g-sales rolls up g-sales-2, so the site total is 9 + 5.
  await assertCountMatchesList("siteIds=g-sales", 14);
  await assertCountMatchesList("siteIds=g-nyc", 8);
  await assertCountMatchesList("siteIds=g-sales,g-nyc", 22);
  const res = await get("siteIds=g-sales&limit=0");
  assert.deepEqual(res.meta["sites"] && (res.meta["sites"] as Record<string, unknown>)["filter"], {
    siteIds: ["g-sales"],
    groupsMatched: 2,
  });
});

test("the count honours status, class, group and search", async () => {
  await assertCountMatchesList("status=offline", 10);
  await assertCountMatchesList("status=unknown", 1);
  await assertCountMatchesList("deviceClass=screen", 1);
  await assertCountMatchesList("groupId=g-nyc", 8);
  await assertCountMatchesList("search=nyc", 8);
});

test("the count honours a COMBINATION, which is where a second WHERE builder drifts", async () => {
  await assertCountMatchesList("siteIds=g-sales&status=offline", 9);
  await assertCountMatchesList("siteIds=g-sales&status=offline&deviceClass=canvas", 9);
  // Only the `screen` at NYC is offline; the one retired NYC device is offline
  // too and must not appear in either figure.
  await assertCountMatchesList("siteIds=g-nyc&status=offline", 1);
  await assertCountMatchesList("siteIds=g-nyc&deviceClass=screen&status=offline", 1);
});

test("a SITE-NAME search counts what it lists — the site axis is not in Postgres", async () => {
  // "Videri Sales" matches no device column on the NYC rows; it resolves through
  // the group tree to group ids, and the count has to apply that too.
  await assertCountMatchesList("search=Videri%20Sales", 14);
});

test("DECIDED: a count with an unhonourable site filter is 0, not the whole fleet", async () => {
  // Same fail-closed decision as the list's. A filter whose whole job is to
  // narrow must not fail open — and a badge reading 24 when the filter matched
  // nothing is undetectable to the caller.
  for (const query of ["siteIds=g-nope", encodeURI("siteIds=, ,,")]) {
    await assertCountMatchesList(query, 0);
  }
});

test("the count reports the same site-resolution meta as the list, so it is explainable", async () => {
  const counted = await get("limit=0");
  const sites = counted.meta["sites"] as Record<string, unknown>;
  assert.equal(sites["available"], true);
  assert.equal(sites["groupsRead"], GROUPS.length);
  assert.equal(typeof sites["hierarchyAgeSeconds"], "number", "a cached mapping still carries its age");
  // There is no page, so there are no per-page denominators to report. Null,
  // not 0/0/0 — which would read as "no device on this page has a site".
  assert.equal(sites["onPage"], null);
});

// ─── the raised ceiling ──────────────────────────────────────────────────────

test("the limit ceiling is 500, and over it is a 400 rather than a silent clamp", async () => {
  assert.equal((await get("limit=500")).status, 200);
  const over = await get("limit=501");
  assert.equal(over.status, 400, "a caller must learn its limit was refused, not guess");
  // Negative is still nonsense; only zero has a meaning.
  assert.equal((await get("limit=-1")).status, 400);
});

test("a 500-row page asks SQL for 500, so the ceiling is real and not decorative", async () => {
  const res = await get("limit=500");
  const rows = res.statements.filter((s) => !/COUNT\(\*\)::text AS count/i.test(s.sql));
  assert.match(flat(rows[0]!.sql), /LIMIT 500 OFFSET 0/);
});
