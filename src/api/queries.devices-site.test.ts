/**
 * The site axis on the device list — `node --test dist/api/queries.devices-site.test.js`
 *
 * `/api/devices` had none of the customer/site dimension the backend already
 * resolves: searching "NYC Office" returned 0 rows, the drawer said "Location not
 * reported" while the payload carried a groupName, and the top AI plan action
 * ("site-level fault at Videri Sales, 39 devices") shipped an empty deviceIds.
 * This file pins the projection that fixes it.
 *
 * Three things are asserted as BEHAVIOUR rather than string matching, because
 * each has already failed in production once somewhere in this codebase:
 *
 *   1. **The site filter must be legal in BOTH statements.** `queries.devices()`
 *      issues a COUNT and a LIST from DIFFERENT FROM clauses — the count omits
 *      the `device_telemetry` lateral — so a predicate written against a lateral
 *      alias compiles in one and raises `missing FROM-clause entry` in the other.
 *      `fakePostgres` below resolves aliases the way Postgres does and throws the
 *      same error, so a stub cannot rubber-stamp broken SQL.
 *   2. **Unresolved devices stay visible and labelled.** ~15 of 248 devices carry
 *      no group. They are never hidden and never bucketed into an "Other" that
 *      reads like a real place.
 *   3. **group_id is the join key, never group_name.** One device has a valid
 *      group_id and an EMPTY group_name; a name is not an identity in a tree
 *      where siblings may share a display name.
 *
 * Nothing here touches a database, a device or the control plane.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { Repository } from "../db/repository.js";
import type { VideriHttp } from "../videri/http.js";
import {
  ReadQueries,
  deviceSite,
  groupIdsForSites,
  sitesMatchingName,
  type DeviceListFilters,
  type SiteResolution,
} from "./queries.js";
import { buildGroupIndex } from "../videri/services/group-hierarchy.js";
import type { RawGroup } from "../videri/services/aggregator.js";
import { buildServer } from "./server.js";

// ─── the group tree, shaped like the real tenant ─────────────────────────────

/**
 * Root → depth-1 sites → deeper groups, plus the two awkward real cases: a
 * depth-1 group the platform gives no display name, and a device pointing at a
 * group that is not in the list we read.
 */
const GROUPS: RawGroup[] = [
  { uuid: "g-root", displayName: "Videri Prod", parentUuid: null },
  { uuid: "g-nyc", displayName: "NYC Office", parentUuid: "g-root" },
  { uuid: "g-nyc-2", displayName: "NYC Floor 2", parentUuid: "g-nyc" },
  { uuid: "g-nyc-2-a", displayName: "NYC Floor 2 East", parentUuid: "g-nyc-2" },
  { uuid: "g-sales", displayName: "Videri Sales", parentUuid: "g-root" },
  { uuid: "g-unnamed", displayName: "  ", parentUuid: "g-root" },
];

const INDEX = buildGroupIndex(GROUPS);
const READ: SiteResolution = { index: INDEX, reason: null };
const UNREAD: SiteResolution = {
  index: null,
  reason: "Group hierarchy could not be read (connect ECONNREFUSED).",
};

// ─── the device model ────────────────────────────────────────────────────────

interface DeviceRow {
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

const device = (over: Partial<DeviceRow> & { id: string }): DeviceRow => ({
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

/** The fleet used by most tests: one device per interesting site outcome. */
const FLEET: DeviceRow[] = [
  device({ id: "nyc-deep", group_id: "g-nyc-2-a", group_name: "NYC Floor 2 East" }),
  device({ id: "nyc-mid", group_id: "g-nyc-2", group_name: "NYC Floor 2" }),
  // Attached DIRECTLY to the depth-1 group: resolveSite of a site group is itself.
  device({ id: "nyc-direct", group_id: "g-nyc", group_name: "NYC Office" }),
  // Valid group id, EMPTY display name — the device that proves the join key.
  device({ id: "nyc-noname", group_id: "g-nyc-2", group_name: "" }),
  device({ id: "sales-1", group_id: "g-sales", group_name: "Videri Sales" }),
  device({ id: "unnamed-site", group_id: "g-unnamed", group_name: null }),
  device({ id: "no-group", group_id: null, group_name: null }),
  device({ id: "orphan-group", group_id: "g-vanished", group_name: "Deleted Group" }),
  device({ id: "at-root", group_id: "g-root", group_name: "Videri Prod" }),
];

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
    if (!/^(on|where|order|group|limit|left|inner|join|lateral)$/i.test(m[2]!)) found.push(m[2]!);
  }
  return found;
};

const referencedAliases = (text: string): string[] =>
  [...text.matchAll(/\b([a-z_]+)\.[a-z_]+/gi)].map((m) => m[1]!);

/**
 * Raises what Postgres raises for an out-of-scope alias, on the outer statement
 * and on every subexpression with the outer scope inherited — so a correlated
 * lateral referring to `d.id` is legal, and a filter referring to the LIST
 * query's `dt` from inside the COUNT query is not.
 */
function assertAliasesResolve(sql: string): void {
  const { outer, groups } = stripSubexpressions(sql);
  const outerScope = new Set(declaredAliases(outer));
  const check = (text: string, scope: Set<string>) => {
    for (const ref of referencedAliases(text)) {
      if (!scope.has(ref)) throw new Error(`missing FROM-clause entry for table "${ref}"`);
    }
  };
  check(outer, outerScope);
  for (const group of groups) {
    check(group, new Set([...outerScope, ...declaredAliases(group)]));
  }
}

// ─── WHERE evaluation ────────────────────────────────────────────────────────

const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The TOP-LEVEL WHERE clause only.
 *
 * Depth-aware, not `indexOf("WHERE ")`: the device query's laterals each carry
 * their own `WHERE device_id = d.id`, and taking the first match parses a
 * correlated subquery's filter as if it were the list's.
 */
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

/** Split on AND / OR at paren depth 0, keeping grouped sub-clauses intact. */
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

type Predicate = (d: DeviceRow) => boolean;

const like = (value: string | null, pattern: unknown): boolean => {
  if (value === null) return false;
  const p = String(pattern);
  assert.ok(p.startsWith("%") && p.endsWith("%"), "the text search binds a %term% pattern");
  return value.toLowerCase().includes(p.slice(1, -1).toLowerCase());
};

/** Compiles one conjunct, or throws if the shape is not one we know. */
function compile(conjunct: string, params: readonly unknown[]): Predicate {
  let c = conjunct.replace(/\s+/g, " ").trim();
  // A parenthesised group is the text search: OR of column matches.
  if (c.startsWith("(") && c.endsWith(")")) {
    const inner = split(c.slice(1, -1), "OR").map((part) => compile(part, params));
    return (d) => inner.some((p) => p(d));
  }
  if (/^d\.retired_at IS NULL$/i.test(c)) return (d) => d.retired_at === null;

  const derivedStatus = /^CASE .* END = \$(\d+)$/i.exec(c);
  if (derivedStatus) {
    const want = params[Number(derivedStatus[1]) - 1];
    return (d) => (d.presence === null ? "unknown" : d.presence === "online" ? "online" : "offline") === want;
  }

  const ilike = /^d\.([a-z_]+) ILIKE \$(\d+)$/i.exec(c);
  if (ilike) {
    const column = ilike[1]! as keyof DeviceRow;
    const pattern = params[Number(ilike[2]) - 1];
    return (d) => like((d[column] ?? null) as string | null, pattern);
  }

  const many = /^d\.([a-z_]+) = ANY\(\$(\d+)::text\[\]\)$/i.exec(c);
  if (many) {
    const column = many[1]! as keyof DeviceRow;
    const want = params[Number(many[2]) - 1];
    assert.ok(Array.isArray(want), "a many-value filter must be bound as an array parameter");
    return (d) => (want as string[]).includes(d[column] as string);
  }

  const one = /^d\.([a-z_]+) = \$(\d+)$/i.exec(c);
  if (one) {
    const column = one[1]! as keyof DeviceRow;
    const want = params[Number(one[2]) - 1];
    return (d) => d[column] === want;
  }
  throw new Error(
    `fakePostgres does not know the predicate \`${c}\` — if a filter was ` +
      `rewritten, teach this fake before trusting the result`,
  );
}

interface Fake {
  pool: Pool;
  countSql: () => { sql: string; values: unknown[] };
  listSql: () => { sql: string; values: unknown[] };
}

/** A pool that behaves enough like Postgres to be wrong when the SQL is wrong. */
function fakePostgres(devices: DeviceRow[] = []): Fake {
  const captured: Array<{ sql: string; values: unknown[] }> = [];

  const select = (sql: string, values: unknown[]): DeviceRow[] => {
    assertAliasesResolve(sql);
    const predicates = split(whereClause(sql), "AND").map((c) => compile(c, values));
    return devices.filter((d) => predicates.every((p) => p(d)));
  };

  const pool = {
    async query(sql: string, values: unknown[] = []) {
      captured.push({ sql, values });
      const isDeviceQuery = /FROM devices d\b/i.test(sql) && !/FROM devices rd\b/i.test(sql);
      if (isDeviceQuery && /COUNT\(\*\)::text AS count/i.test(sql)) {
        return { rows: [{ count: String(select(sql, values).length) }], rowCount: 1 };
      }
      if (isDeviceQuery) {
        // Matched as a PAIR: each lateral carries its own `LIMIT 1`, and taking
        // the first LIMIT in the statement paginates the page to one row.
        const paging = /LIMIT (\d+) OFFSET (\d+)/i.exec(sql);
        const limit = Number(paging?.[1] ?? 50);
        const offset = Number(paging?.[2] ?? 0);
        const rows = select(sql, values)
          .slice(offset, offset + limit)
          .map((d) => ({ ...d, status: d.presence === "online" ? "online" : "offline" }));
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("MAX(observed_at)")) return { rows: [{ newest: new Date() }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;

  const only = (predicate: (c: { sql: string }) => boolean, what: string) => () => {
    const hits = captured.filter(predicate);
    assert.equal(hits.length, 1, `expected exactly one ${what} statement, saw ${hits.length}`);
    return hits[0]!;
  };
  const isDevices = (sql: string) => /FROM devices d\b/i.test(sql);
  return {
    pool,
    countSql: only(
      (c) => isDevices(c.sql) && /COUNT\(\*\)::text AS count/i.test(c.sql), "device COUNT",
    ),
    listSql: only(
      (c) => isDevices(c.sql) && !/COUNT\(\*\)::text AS count/i.test(c.sql), "device LIST",
    ),
  };
}

const base: DeviceListFilters = {
  page: 1, limit: 50, sort: "last_seen", direction: "desc",
};

const byId = (items: Array<{ id: string }>) => items.map((i) => i.id).sort();

// ─── the fake earns its keep ─────────────────────────────────────────────────

test("the fake pool rejects an out-of-scope alias, so these tests can actually fail", () => {
  // Guard on the guard: a stub that accepts unresolvable SQL is how a live 500
  // ships while the suite stays green.
  assert.throws(
    () => assertAliasesResolve(
      `SELECT COUNT(*)::text AS count FROM devices d WHERE dt.rssi_dbm IS NULL`,
    ),
    /missing FROM-clause entry for table "dt"/,
  );
  assertAliasesResolve(
    `SELECT COUNT(*)::text AS count FROM devices d
       LEFT JOIN LATERAL (SELECT observed_at FROM health_samples
                           WHERE device_id = d.id LIMIT 1) hs ON TRUE
      WHERE d.group_id = ANY($1::text[])`,
  );
});

test("the fake pool rejects a predicate shape it has not been taught", async () => {
  const fake = fakePostgres([device({ id: "d1" })]);
  await assert.rejects(
    () => fake.pool.query(`SELECT COUNT(*)::text AS count FROM devices d WHERE d.city ~ 'x'`, []),
    /does not know the predicate/,
  );
});

// ─── the pure projection ─────────────────────────────────────────────────────

test("a grouped device resolves to its depth-1 site, however deep the group sits", () => {
  assert.deepEqual(deviceSite(READ, "g-nyc-2-a"),
    { id: "g-nyc", name: "NYC Office", resolved: true, reason: null });
  assert.deepEqual(deviceSite(READ, "g-nyc-2"),
    { id: "g-nyc", name: "NYC Office", resolved: true, reason: null });
  // A device attached directly to the site group resolves to that group itself.
  assert.deepEqual(deviceSite(READ, "g-nyc"),
    { id: "g-nyc", name: "NYC Office", resolved: true, reason: null });
});

test("an UNGROUPED device is not hidden and not bucketed — it is labelled unresolved", () => {
  const site = deviceSite(READ, null);
  assert.equal(site.resolved, false);
  assert.equal(site.id, null);
  assert.equal(site.name, null, "never an empty string dressed as a place name");
  assert.match(site.reason!, /no group/i);
  // The three unresolved causes stay DISTINGUISHABLE: a technician acts
  // differently on each, and one blank cell for all of them is the bug.
  assert.notEqual(deviceSite(READ, "g-vanished").reason, site.reason);
  assert.notEqual(deviceSite(READ, "g-root").reason, site.reason);
});

test("a group missing from the hierarchy reads as unresolvable, not as no site", () => {
  const site = deviceSite(READ, "g-vanished");
  assert.equal(site.resolved, false);
  assert.match(site.reason!, /not in the group hierarchy/i);
});

test("a device whose group IS the root has no site beneath it, and says so", () => {
  const site = deviceSite(READ, "g-root");
  assert.equal(site.resolved, false);
  assert.match(site.reason!, /top of the hierarchy/i);
});

test("a resolved site with no display name is resolved, named null, and explained", () => {
  const site = deviceSite(READ, "g-unnamed");
  assert.equal(site.resolved, true, "the site exists; only its label is missing");
  assert.equal(site.id, "g-unnamed");
  assert.equal(site.name, null, "a blank display name is null, never \"\"");
  assert.match(site.reason!, /no display name/i);
});

test("INVARIANT: whenever site.name is null there is a reason to print instead", () => {
  for (const groupId of [null, "", "g-root", "g-vanished", "g-unnamed", "g-nyc"]) {
    for (const hierarchy of [READ, UNREAD]) {
      const site = deviceSite(hierarchy, groupId);
      if (site.name === null) {
        assert.ok(site.reason && site.reason.length > 0,
          `no reason for groupId=${String(groupId)}`);
      }
      assert.notEqual(site.name, "", "an empty-string site name is never emitted");
    }
  }
});

test("an unreadable hierarchy yields site null WITH the read failure's reason", () => {
  const site = deviceSite(UNREAD, "g-nyc-2");
  assert.equal(site.resolved, false);
  assert.equal(site.id, null);
  assert.match(site.reason!, /could not be read/i);
});

test("groupIdsForSites collects every descendant AND the site group itself", () => {
  assert.deepEqual(groupIdsForSites(INDEX, ["g-nyc"]), ["g-nyc", "g-nyc-2", "g-nyc-2-a"]);
  assert.deepEqual(groupIdsForSites(INDEX, ["g-sales"]), ["g-sales"]);
  assert.deepEqual(groupIdsForSites(INDEX, ["g-nyc", "g-sales"]),
    ["g-nyc", "g-nyc-2", "g-nyc-2-a", "g-sales"]);
  // The root is not a site, and an unknown id resolves to nothing.
  assert.deepEqual(groupIdsForSites(INDEX, ["g-root"]), []);
  assert.deepEqual(groupIdsForSites(INDEX, ["g-nope"]), []);
});

test("sitesMatchingName matches a site name case-insensitively, by substring", () => {
  assert.deepEqual(sitesMatchingName(INDEX, "NYC Office"), ["g-nyc"]);
  assert.deepEqual(sitesMatchingName(INDEX, "nyc"), ["g-nyc"]);
  assert.deepEqual(sitesMatchingName(INDEX, "sales"), ["g-sales"]);
  // Deeper group names are not sites, and a nameless site can never match.
  assert.deepEqual(sitesMatchingName(INDEX, "Floor 2"), []);
  assert.deepEqual(sitesMatchingName(INDEX, "   "), []);
});

// ─── the projection on the list ──────────────────────────────────────────────

test("every row carries the customer/site axis: groupId, groupName, accountName, tags, site", async () => {
  const fake = fakePostgres([
    device({ id: "nyc-mid", group_id: "g-nyc-2", group_name: "NYC Floor 2", tags: ["lobby"] }),
  ]);
  const { items } = await new ReadQueries(fake.pool).devices(base, READ);
  const row = items[0]!;
  assert.equal(row.groupId, "g-nyc-2");
  assert.equal(row.groupName, "NYC Floor 2");
  assert.equal(row.accountName, "VIDERISALES");
  assert.deepEqual(row.tags, ["lobby"]);
  assert.deepEqual(row.site, { id: "g-nyc", name: "NYC Office", resolved: true, reason: null });
});

test("the JOIN KEY is group_id: a device with an EMPTY group_name still resolves", async () => {
  // Device 1000015 on the live tenant: populated group_id, empty group_name,
  // while the hierarchy names that group correctly. Joining on the name loses it.
  const fake = fakePostgres([device({ id: "nyc-noname", group_id: "g-nyc-2", group_name: "" })]);
  const { items } = await new ReadQueries(fake.pool).devices(base, READ);
  assert.equal(items[0]!.site.name, "NYC Office");
  assert.equal(items[0]!.groupName, "", "the display text is passed through verbatim");
});

test("group_name is NEVER used as a join or filter key in the SQL", async () => {
  const fake = fakePostgres(FLEET);
  await new ReadQueries(fake.pool).devices(
    { ...base, siteGroupIds: ["g-nyc"], search: "NYC Office", searchSiteGroupIds: ["g-nyc"] },
    READ,
  );
  for (const captured of [fake.countSql(), fake.listSql()]) {
    const where = whereClause(captured.sql);
    // group_name may appear as free-text search only; it may never be equated,
    // ANY-ed or joined — that is what "a name is not an identity" means in SQL.
    assert.ok(!/group_name\s*=/i.test(where), "group_name must never be an equality key");
    assert.ok(!/group_name = ANY/i.test(where), "group_name must never be a set key");
    assert.ok(!/JOIN\s+\w+\s+\w+\s+ON[^)]*group_name/i.test(captured.sql));
    assert.ok(/d\.group_id = ANY\(\$\d+::text\[\]\)/i.test(where),
      "the site filter joins on group_id");
  }
});

test("unresolved devices stay in the list beside resolved ones", async () => {
  const fake = fakePostgres(FLEET);
  const { items, totalItems } = await new ReadQueries(fake.pool).devices(base, READ);
  assert.equal(totalItems, FLEET.length, "no device is dropped for having no site");
  const unresolved = items.filter((d) => !d.site.resolved).map((d) => d.id).sort();
  assert.deepEqual(unresolved, ["at-root", "no-group", "orphan-group"]);
  // And none of them was invented into a place.
  for (const row of items) {
    assert.ok(row.site.name === null || row.site.name.trim().length > 0);
    assert.notEqual(row.site.name, "Other");
  }
});

// ─── the site filter: list AND count ─────────────────────────────────────────

test("the site predicate is expressible in BOTH the list and the COUNT query", async () => {
  const fake = fakePostgres();
  await new ReadQueries(fake.pool).devices({ ...base, siteGroupIds: ["g-nyc", "g-nyc-2"] }, READ);

  const count = fake.countSql();
  const list = fake.listSql();
  assert.ok(/d\.group_id = ANY\(\$\d+::text\[\]\)/i.test(flat(count.sql)));
  assert.ok(/d\.group_id = ANY\(\$\d+::text\[\]\)/i.test(flat(list.sql)));
  // The count omits the telemetry lateral, which is exactly why the predicate
  // must live on a `devices` column and not on a lateral alias.
  assert.ok(!/FROM device_telemetry/i.test(count.sql),
    "the COUNT query joins fewer laterals than the LIST — an alias predicate breaks it");
  assert.ok(/FROM device_telemetry/i.test(list.sql));
  // Identical WHERE and identical params is what makes the two agree by construction.
  assert.equal(whereClause(count.sql), whereClause(list.sql));
  assert.deepEqual(count.values, list.values);
});

test("the filter narrows the LIST and the TOTAL to the same devices", async () => {
  const fake = fakePostgres(FLEET);
  const { items, totalItems } = await new ReadQueries(fake.pool).devices(
    { ...base, siteGroupIds: groupIdsForSites(INDEX, ["g-nyc"]) },
    READ,
  );
  assert.deepEqual(byId(items), ["nyc-deep", "nyc-direct", "nyc-mid", "nyc-noname"]);
  assert.equal(totalItems, 4, "the COUNT must agree with the LIST, not with the whole fleet");
  for (const row of items) assert.equal(row.site.id, "g-nyc");
});

test("the filter agrees with the list even when the page is smaller than the total", async () => {
  const fake = fakePostgres(FLEET);
  const { items, totalItems } = await new ReadQueries(fake.pool).devices(
    { ...base, limit: 2, siteGroupIds: groupIdsForSites(INDEX, ["g-nyc"]) },
    READ,
  );
  assert.equal(items.length, 2, "the page is capped");
  assert.equal(totalItems, 4, "the total is not");
});

test("DECIDED: an empty site filter matches NOTHING, not everything", async () => {
  // Same call as `deviceIds` on /api/alerts: a filter whose whole job is to
  // narrow must not fail open. Consistency with that decision matters more than
  // either answer, and the failure mode of failing open — a site drilldown
  // rendering the entire fleet — is undetectable to the caller.
  const fake = fakePostgres(FLEET);
  const { items, totalItems } = await new ReadQueries(fake.pool).devices(
    { ...base, siteGroupIds: [] },
    READ,
  );
  assert.ok(/ANY\(/i.test(whereClause(fake.countSql().sql)), "the predicate must still be applied");
  assert.equal(totalItems, 0);
  assert.deepEqual(items, []);
});

test("the site filter is parameterised, so a hostile group id is data and not syntax", async () => {
  const hostile = "g-nyc'); DROP TABLE devices; --";
  const fake = fakePostgres();
  await new ReadQueries(fake.pool).devices({ ...base, siteGroupIds: [hostile] }, READ);
  for (const captured of [fake.countSql(), fake.listSql()]) {
    assert.ok(!captured.sql.includes("DROP TABLE"), "the id must never reach the statement text");
    assert.deepEqual(captured.values, [[hostile]]);
  }
});

test("the site filter composes with status and class, in both statements", async () => {
  const fake = fakePostgres([
    device({ id: "nyc-on", group_id: "g-nyc-2", presence: "online" }),
    device({ id: "nyc-off", group_id: "g-nyc-2", presence: "offline" }),
    device({ id: "sales-off", group_id: "g-sales", presence: "offline" }),
  ]);
  const { items, totalItems } = await new ReadQueries(fake.pool).devices(
    { ...base, status: "offline", deviceClass: "canvas", siteGroupIds: ["g-nyc-2"] },
    READ,
  );
  assert.deepEqual(byId(items), ["nyc-off"]);
  assert.equal(totalItems, 1);
  assert.deepEqual(fake.countSql().values, fake.listSql().values);
});

test("a retired device is excluded from a site filter's list and count", async () => {
  const fake = fakePostgres([
    device({ id: "live", group_id: "g-nyc-2" }),
    device({ id: "gone", group_id: "g-nyc-2", retired_at: new Date("2026-07-01T00:00:00Z") }),
  ]);
  const { items, totalItems } = await new ReadQueries(fake.pool).devices(
    { ...base, siteGroupIds: ["g-nyc-2"] },
    READ,
  );
  assert.deepEqual(byId(items), ["live"]);
  assert.equal(totalItems, 1);
});

// ─── search ──────────────────────────────────────────────────────────────────

test("searching a SITE NAME matches the devices at that site", async () => {
  // The headline symptom: "NYC Office" returned 0 rows.
  const fake = fakePostgres(FLEET);
  const { items, totalItems } = await new ReadQueries(fake.pool).devices(
    {
      ...base,
      search: "NYC Office",
      searchSiteGroupIds: groupIdsForSites(INDEX, sitesMatchingName(INDEX, "NYC Office")),
    },
    READ,
  );
  assert.deepEqual(byId(items), ["nyc-deep", "nyc-direct", "nyc-mid", "nyc-noname"]);
  assert.equal(totalItems, 4, "the COUNT must find them too, or page 2 vanishes");
});

// Ids deliberately free of "nyc": the search also covers device_id and
// serial_no, so an id carrying the term would make either result pass.
const TEXT_HIT = device({ id: "text-hit", name: "NYC lobby panel", group_id: "g-sales" });
const SITE_HIT = device({ id: "site-hit", name: "Panel 7", group_id: "g-nyc-2" });

test("the site-name search term is OR-ed in, so it never narrows the text search", async () => {
  const fake = fakePostgres([TEXT_HIT, SITE_HIT]);
  const { items } = await new ReadQueries(fake.pool).devices(
    { ...base, search: "NYC", searchSiteGroupIds: groupIdsForSites(INDEX, ["g-nyc"]) },
    READ,
  );
  assert.deepEqual(byId(items), ["site-hit", "text-hit"]);
});

test("search still works with no hierarchy: text columns match, site names cannot", async () => {
  // Search WIDENS, so it does not fail closed with the filter: the term still
  // finds what the text columns hold, and simply cannot reach a site name.
  const fake = fakePostgres([TEXT_HIT, SITE_HIT]);
  const { items } = await new ReadQueries(fake.pool).devices({ ...base, search: "NYC" }, UNREAD);
  assert.deepEqual(byId(items), ["text-hit"]);
});

test("the group and account display names are searchable text", async () => {
  const fake = fakePostgres([
    device({ id: "wes", group_id: "g-sales", group_name: "Wes' Office" }),
    device({ id: "other", group_id: "g-sales", group_name: "Techops" }),
  ]);
  const q = new ReadQueries(fake.pool);
  const { items } = await q.devices({ ...base, search: "Wes'" }, READ);
  assert.deepEqual(byId(items), ["wes"]);
});

// ─── the route ───────────────────────────────────────────────────────────────

const TOKEN = "test-token-at-least-16-chars";
const auth = { authorization: `Bearer ${TOKEN}` };
const stubRepo = () => ({}) as unknown as Repository;

/** A control plane that serves the group tree, or fails on demand. */
function stubVideri(mode: "ok" | "throw" = "ok"): { http: VideriHttp; calls: number } {
  const state = { calls: 0 };
  const http = {
    async request(_service: string, path: string) {
      state.calls += 1;
      if (mode === "throw") throw new Error("connect ECONNREFUSED 10.0.0.1:443");
      assert.equal(path, "/v1/groups", "the site axis reads groups and nothing else");
      return { groups: GROUPS, meta: { total: GROUPS.length } };
    },
  } as unknown as VideriHttp;
  return { get http() { return http; }, get calls() { return state.calls; } };
}

async function inject(query: string, mode: "ok" | "throw" | "none" = "ok"): Promise<{
  status: number;
  body: { data: Array<Record<string, unknown>>; meta: Record<string, unknown> };
  fake: Fake;
}> {
  const fake = fakePostgres(FLEET);
  const videri = mode === "none" ? undefined : stubVideri(mode).http;
  const app = await buildServer({
    pool: fake.pool,
    repo: stubRepo(),
    auth: { token: TOKEN, allowAnonymous: false },
    ...(videri ? { videri } : {}),
  });
  const res = await app.inject({ method: "GET", url: `/api/devices?${query}`, headers: auth });
  await app.close();
  return { status: res.statusCode, body: res.json(), fake };
}

const sitesMeta = (body: { meta: Record<string, unknown> }) =>
  body.meta["sites"] as Record<string, unknown>;

test("GET /api/devices projects the site axis and reports the mapping's age", async () => {
  const { status, body } = await inject("limit=200");
  assert.equal(status, 200);
  const rows = body.data as Array<{ id: string; site: Record<string, unknown> }>;
  assert.equal(rows.find((r) => r.id === "nyc-deep")!.site["name"], "NYC Office");

  const sites = sitesMeta(body);
  assert.equal(sites["available"], true);
  assert.equal(sites["groupsRead"], GROUPS.length);
  assert.equal(sites["truncated"], false);
  assert.equal(sites["reason"], null);
  // Freshness of the MAPPING, not of the telemetry: a 30-minute cache must never
  // be presented as live. Same field name as /api/correlation reports.
  assert.equal(typeof sites["hierarchyAgeSeconds"], "number");
  assert.deepEqual(sites["onPage"], { devices: 9, resolved: 6, unresolved: 3 });
});

test("GET /api/devices?siteIds=… filters, and the page total agrees with the rows", async () => {
  const { status, body, fake } = await inject("siteIds=g-nyc");
  assert.equal(status, 200);
  assert.deepEqual(byId(body.data as Array<{ id: string }>),
    ["nyc-deep", "nyc-direct", "nyc-mid", "nyc-noname"]);
  const page = body.meta["page"] as Record<string, number>;
  assert.equal(page["totalItems"], 4, "the COUNT query filtered too");
  assert.equal(page["totalPages"], 1);
  // The site id was expanded to its descendant group ids and bound as an array.
  assert.deepEqual(fake.countSql().values, [["g-nyc", "g-nyc-2", "g-nyc-2-a"]]);
  assert.deepEqual(fake.listSql().values, fake.countSql().values);
  assert.deepEqual(sitesMeta(body)["filter"], { siteIds: ["g-nyc"], groupsMatched: 3 });
});

test("a comma-separated siteIds list filters on several sites at once", async () => {
  const { status, body } = await inject("siteIds=g-nyc,g-sales");
  assert.equal(status, 200);
  assert.deepEqual(byId(body.data as Array<{ id: string }>),
    ["nyc-deep", "nyc-direct", "nyc-mid", "nyc-noname", "sales-1"]);
  assert.equal((body.meta["page"] as Record<string, number>)["totalItems"], 5);
});

test("DECIDED: an unknown or empty siteIds matches nothing, and is not a 500", async () => {
  for (const query of ["siteIds=g-nope", encodeURI("siteIds=, ,,")]) {
    const { status, body } = await inject(query);
    assert.equal(status, 200, `${query} is not a client error`);
    assert.deepEqual(body.data, [], "failing closed: an unhonourable filter returns nothing");
    assert.equal((body.meta["page"] as Record<string, number>)["totalItems"], 0);
    assert.equal((sitesMeta(body)["filter"] as { groupsMatched: number }).groupsMatched, 0,
      "meta says the filter matched no groups, so the empty list is explainable");
  }
});

test("searching a site name through the route finds the devices at that site", async () => {
  const { status, body } = await inject("search=NYC%20Office");
  assert.equal(status, 200);
  assert.deepEqual(byId(body.data as Array<{ id: string }>),
    ["nyc-deep", "nyc-direct", "nyc-mid", "nyc-noname"]);
  assert.equal((body.meta["page"] as Record<string, number>)["totalItems"], 4);
});

test("a FAILED hierarchy read is a 200 with null sites and a stated reason", async () => {
  const { status, body } = await inject("limit=200", "throw");
  assert.equal(status, 200, "an unreadable control plane must not 500 the device list");
  const rows = body.data as Array<{ id: string; site: Record<string, unknown> }>;
  assert.equal(rows.length, FLEET.length, "every device stays visible");
  for (const row of rows) {
    assert.equal(row.site["id"], null);
    assert.equal(row.site["name"], null, "null, never an empty string");
    assert.equal(row.site["resolved"], false);
    assert.match(row.site["reason"] as string, /could not be read/i);
  }
  const sites = sitesMeta(body);
  assert.equal(sites["available"], false, "false means unavailable, not empty");
  assert.match(sites["reason"] as string, /could not be read/i);
  assert.equal(sites["hierarchyAgeSeconds"], null, "no mapping, so no age to claim");
  assert.deepEqual(sites["onPage"], { devices: 9, resolved: 0, unresolved: 9 });
});

test("a site filter with no readable hierarchy fails closed and says why", async () => {
  const { status, body } = await inject("siteIds=g-nyc", "throw");
  assert.equal(status, 200);
  assert.deepEqual(body.data, [], "we cannot honour the filter, so we do not pretend we did");
  assert.equal((sitesMeta(body)["filter"] as { groupsMatched: number }).groupsMatched, 0);
  assert.match(sitesMeta(body)["reason"] as string, /could not be read/i);
});

test("with no credentials the site column is unavailable with a reason, not blank", async () => {
  const { status, body } = await inject("limit=200", "none");
  assert.equal(status, 200);
  const sites = sitesMeta(body);
  assert.equal(sites["available"], false);
  assert.match(sites["reason"] as string, /no videri credentials/i);
  const rows = body.data as Array<{ site: Record<string, unknown> }>;
  assert.match(rows[0]!.site["reason"] as string, /no videri credentials/i);
});

test("the group tree is read ONCE and cached across requests, not per row", async () => {
  const videri = stubVideri("ok");
  const fake = fakePostgres(FLEET);
  const app = await buildServer({
    pool: fake.pool, repo: stubRepo(),
    auth: { token: TOKEN, allowAnonymous: false }, videri: videri.http,
  });
  for (let i = 0; i < 3; i++) {
    const res = await app.inject({ method: "GET", url: "/api/devices", headers: auth });
    assert.equal(res.statusCode, 200);
  }
  await app.close();
  assert.equal(videri.calls, 1, "a dashboard poll must not re-walk the group tree per request");
});

test("GET /api/devices/:id carries the same site as the row — one source of truth", async () => {
  const fake = fakePostgres([
    device({ id: "nyc-mid", group_id: "g-nyc-2", group_name: "NYC Floor 2" }),
  ]);
  const app = await buildServer({
    pool: fake.pool, repo: stubRepo(),
    auth: { token: TOKEN, allowAnonymous: false }, videri: stubVideri("ok").http,
  });
  const res = await app.inject({ method: "GET", url: "/api/devices/nyc-mid", headers: auth });
  await app.close();
  assert.equal(res.statusCode, 200);
  const data = res.json().data as Record<string, unknown>;
  // The drawer said "Location not reported" while the payload already had a group.
  assert.deepEqual(data["site"], { id: "g-nyc", name: "NYC Office", resolved: true, reason: null });
  assert.equal(data["groupId"], "g-nyc-2");
  assert.equal(data["groupName"], "NYC Floor 2");
});

test("the siteIds list is capped, and an over-long one is a 400 not a truncated success", async () => {
  const many = Array.from({ length: 300 }, (_, i) => `g${i}`).join(",");
  const { status } = await inject(`siteIds=${many}`);
  assert.equal(status, 200);
  const over = await inject(`siteIds=${"x".repeat(4100)}`);
  assert.equal(over.status, 400);
});
