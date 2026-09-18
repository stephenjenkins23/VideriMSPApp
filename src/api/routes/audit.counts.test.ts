/**
 * `GET /api/audit/counts` — `node --test dist/api/routes/audit.counts.test.js`
 *
 * The audit UI shipped with numberless outcome pills because a tally over one
 * 50-row page is a page count wearing a log count's clothes. This endpoint is
 * the fix, so the tests are about the three ways a count can be worse than no
 * count at all:
 *
 *   1. **Counting something other than what you filtered.** The counts and the
 *      list must come from the same filter set — this has shipped broken three
 *      times in this codebase — so the WHERE clause here is asserted against the
 *      one `Repository.listDeviceActions` actually sends, character for
 *      character, with the same bind values in the same order. The two are
 *      separate code today (`repository.ts` is not this change's file to edit)
 *      and this is what keeps them from drifting.
 *
 *   2. **A zero that means something other than "none exist".** An outcome the
 *      caller's own filter excluded must be ABSENT, not 0; and `matched` must
 *      reconcile with both breakdowns, so a dropped group cannot hide.
 *
 *   3. **One kind of empty presented as the other.** `device_action_log` holds
 *      0 rows on this deployment — the write path is wired, nothing has ever
 *      been fired at this database — so "no action has ever been logged" is the
 *      answer an operator will actually see, and it must not read like "your
 *      filter matched nothing".
 *
 * No database: the fold is pure and the pool is a stub that captures SQL. The
 * grouped SQL itself was exercised by hand against a throwaway Postgres (see the
 * report) because the real `device_action_log` must never hold invented rows.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import {
  DEVICE_ACTION_OUTCOMES,
  Repository,
  auditSearchPattern,
  type DeviceActionFilters,
  type DeviceActionOutcome,
} from "../../db/repository.js";
import { buildServer } from "../server.js";
import {
  AUDIT_ACTION_GROUPS, AUDIT_SEARCH_FIELDS, auditFilterSql, foldAuditCounts,
  type AuditCountGroup,
} from "./audit.js";

const TOKEN = "test-token-at-least-16-chars";
const auth = { authorization: `Bearer ${TOKEN}` };

const AT = (iso: string) => new Date(iso);

const group = (over: Partial<AuditCountGroup> = {}): AuditCountGroup => ({
  outcome: "verified",
  action: "brightness_write",
  count: 1,
  oldest: AT("2026-09-02T10:00:00.000Z"),
  newest: AT("2026-09-02T10:00:00.000Z"),
  ...over,
});

// ─── the filter clause: the same match as the list, or the counts are a lie ──

test("with no filters the clause is empty and binds nothing", () => {
  const { clause, values } = auditFilterSql({});
  assert.equal(clause, "");
  assert.deepEqual(values, []);
});

test("the clause is character-for-character the one the list query sends", async () => {
  const filters: DeviceActionFilters = {
    deviceId: "1000152",
    actor: "api:stephen",
    outcome: ["failed", "rolled_back"],
    action: "brightness_write",
    // Every filter, including the two added after this endpoint shipped: a new
    // filter added to the list and not to the counts is exactly the drift this
    // test exists to catch, and it can only catch it if the filter is HERE.
    actions: ["brightness_write", "bulk_brightness_write"],
    search: auditSearchPattern("denver"),
    since: AT("2026-09-01T00:00:00.000Z"),
    until: AT("2026-09-08T00:00:00.000Z"),
    page: 1,
    limit: 50,
  };

  // Capture what the repository actually sends for the COUNT half of its query.
  const captured: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    async query(sql: string, values: unknown[]) {
      captured.push({ sql, values });
      return { rows: [{ n: "0", oldest: null, newest: null }], rowCount: 1 };
    },
  } as unknown as Pool;
  await new Repository(pool).listDeviceActions(filters);

  const listSql = captured[0]!.sql;
  const listClause = listSql.slice(listSql.indexOf("WHERE")).replace(/\s+/g, " ").trim();
  const mine = auditFilterSql(filters);

  assert.equal(mine.clause.replace(/\s+/g, " ").trim(), listClause);
  assert.deepEqual(mine.values, captured[0]!.values);
  // Guard against the test passing vacuously: if either side stopped emitting a
  // predicate the equality above would still hold, so pin the count.
  assert.equal(mine.values.length, 8, "eight filters were set; eight must be bound");
  assert.match(listClause, /ILIKE/, "the search predicate really is in the list query");
  assert.match(listClause, /l\.action = ANY/, "and so is the action-group predicate");
});

test("every filter key on DeviceActionFilters appears in the shared clause builder", () => {
  // The structural version of the test above: a filter added to the type and to
  // the repository but not to `auditFilterSql` produces counts that silently
  // ignore it while the list honours it.
  const set: DeviceActionFilters = {
    deviceId: "d", actor: "a", outcome: ["failed"], action: "x",
    actions: ["x", "y"], search: "%z%",
    since: AT("2026-09-01T00:00:00.000Z"), until: AT("2026-09-08T00:00:00.000Z"),
    page: 1, limit: 50,
  };
  const keys = Object.keys(set).filter((k) => k !== "page" && k !== "limit");
  const { values } = auditFilterSql(set);
  assert.equal(
    values.length,
    keys.length,
    `${keys.length} filters are set but only ${values.length} are bound: ${keys.join(", ")}`,
  );
});

test("the counts query joins devices, so a text search counts the rows the list lists", async () => {
  const { capture } = await get("?q=denver", [group({ count: 1 })], 1);
  const sql = (capture.sql[0] ?? "").replace(/\s+/g, " ").trim();
  // Unconditional and on the primary key: a LEFT JOIN on `devices.id` can
  // neither drop nor duplicate an audit row, so `matched` is unaffected when no
  // search was asked for.
  assert.match(sql, /FROM device_action_log l LEFT JOIN devices d ON d\.id = l\.device_id/);
  assert.match(sql, /d\.name ILIKE \$1/);
  assert.deepEqual(capture.values[0], ["%denver%"]);
});

test("an action group is counted as the union of its actions, and broken down per action", async () => {
  const { body, capture } = await get(
    "?actionGroup=brightness",
    [
      group({ outcome: "verified", action: "brightness_write", count: 5 }),
      group({ outcome: "verified", action: "bulk_brightness_write", count: 3 }),
    ],
    8,
  );
  assert.match(capture.sql[0] ?? "", /l\.action = ANY\(\$1::text\[\]\)/);
  assert.deepEqual(capture.values[0], [["brightness_write", "bulk_brightness_write"]]);
  assert.equal(body.data!.matched, 8, "the union, in one number");
  // Still broken down per ACTION, so the total is visibly the sum of its parts
  // rather than a number whose composition has to be taken on trust.
  assert.deepEqual(body.data!.byAction, [
    { action: "brightness_write", count: 5 },
    { action: "bulk_brightness_write", count: 3 },
  ]);
  assert.deepEqual(body.data!.actionScope.groups["brightness"], [
    "brightness_write", "bulk_brightness_write",
  ]);
});

test("the new filters are echoed, including the group's expansion and the raw query", async () => {
  const { body } = await get("?actionGroup=brightness&q=Denver", [group({ count: 1 })], 1);
  assert.equal(body.data!.filters["actionGroup"], "brightness");
  assert.deepEqual(body.data!.filters["actions"], [...AUDIT_ACTION_GROUPS["brightness"]!]);
  assert.equal(body.data!.filters["q"], "Denver", "the human's words, not the ILIKE pattern");
  assert.equal(body.data!.searchScope.query, "Denver");
  assert.deepEqual(body.data!.searchScope.fields, [...AUDIT_SEARCH_FIELDS]);
});

test("a search that matches nothing is counted as filtered-out, not as an empty log", async () => {
  const { body } = await get("?q=Denver", [], 40);
  assert.equal(body.data!.matched, 0);
  assert.match(body.data!.emptyReason ?? "", /No logged action matches these filters/);
  assert.match(body.data!.emptyReason ?? "", /holds 40 action\(s\)/);
});

test("action and actionGroup are refused together here too, exactly as on the list", async () => {
  const { statusCode, body } = await get("?action=brightness_write&actionGroup=brightness");
  assert.equal(statusCode, 400);
  assert.match(body.message ?? "", /narrows to the overlap rather than the union/);
});

test("an unknown group and a blank search are refused, never counted as zero", async () => {
  const bad = await get("?actionGroup=brigthness");
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body.message ?? "", /unknown actionGroup/);
  const blank = await get("?q=%20");
  assert.equal(blank.statusCode, 400);
  assert.match(blank.body.message ?? "", /blank search is not a filter/);
});

test("the window is half-open, so adjacent windows cannot double-count a row", () => {
  const { clause } = auditFilterSql({
    since: AT("2026-09-01T00:00:00.000Z"),
    until: AT("2026-09-08T00:00:00.000Z"),
  });
  assert.match(clause, /l\.started_at >= \$1/);
  assert.match(clause, /l\.started_at < \$2/);
  assert.doesNotMatch(clause, /started_at <=/);
});

// ─── the fold: matched reconciles with both breakdowns ───────────────────────

test("matched is the sum of the groups, and both breakdowns sum to it", () => {
  const counts = foldAuditCounts(
    [
      group({ outcome: "verified", action: "brightness_write", count: 4 }),
      group({ outcome: "failed", action: "brightness_write", count: 2 }),
      group({ outcome: "failed", action: "device_command", count: 1 }),
    ],
    { logSize: 12, outcomeScope: DEVICE_ACTION_OUTCOMES, filtered: true },
  );

  assert.equal(counts.matched, 7);
  assert.equal(
    Object.values(counts.byOutcome).reduce((a, b) => a + b, 0),
    counts.matched,
    "a dropped outcome group would hide behind `matched`",
  );
  assert.equal(
    counts.byAction.reduce((a, b) => a + b.count, 0),
    counts.matched,
    "both breakdowns describe the same rows, so both must reconcile",
  );
  assert.equal(counts.byOutcome.failed, 3, "one outcome spanning two actions is added, not lost");
  assert.deepEqual(counts.byAction, [
    { action: "brightness_write", count: 6 },
    { action: "device_command", count: 1 },
  ]);
  assert.equal(counts.logSize, 12, "the denominator: 7 of 12 is a different reading from 7 of 7");
});

test("the whole closed vocabulary is keyed when nothing narrowed it — a 0 there is a real 0", () => {
  const counts = foldAuditCounts([group({ count: 3 })], {
    logSize: 3,
    outcomeScope: DEVICE_ACTION_OUTCOMES,
    filtered: false,
  });
  assert.deepEqual(Object.keys(counts.byOutcome).sort(), [...DEVICE_ACTION_OUTCOMES].sort());
  assert.equal(counts.byOutcome.failed, 0, "we counted failures and there are none");
});

test("an outcome the caller filtered out is absent, never reported as zero", () => {
  const scope: DeviceActionOutcome[] = ["failed"];
  const counts = foldAuditCounts([group({ outcome: "failed", count: 2 })], {
    logSize: 40,
    outcomeScope: scope,
    filtered: true,
  });

  assert.deepEqual(Object.keys(counts.byOutcome), ["failed"]);
  assert.equal("verified" in counts.byOutcome, false, "0 here would mean 'we counted verified'");
  assert.equal(counts.matched, 2);
});

test("the span is the widest across the matched groups, and null rather than an epoch", () => {
  const counts = foldAuditCounts(
    [
      group({ oldest: AT("2026-09-02T10:00:00.000Z"), newest: AT("2026-09-02T11:00:00.000Z") }),
      group({
        action: "device_command",
        oldest: AT("2026-08-30T08:00:00.000Z"),
        newest: AT("2026-09-05T09:00:00.000Z"),
      }),
    ],
    { logSize: 2, outcomeScope: DEVICE_ACTION_OUTCOMES, filtered: false },
  );
  assert.equal(counts.oldestActionAt, "2026-08-30T08:00:00.000Z");
  assert.equal(counts.newestActionAt, "2026-09-05T09:00:00.000Z");

  const empty = foldAuditCounts([], {
    logSize: 0,
    outcomeScope: DEVICE_ACTION_OUTCOMES,
    filtered: false,
  });
  assert.equal(empty.oldestActionAt, null);
  assert.equal(empty.newestActionAt, null);
});

// ─── the two empties are different facts and must read differently ───────────

test("an empty log and a filter matching nothing do not read the same", () => {
  const neverLogged = foldAuditCounts([], {
    logSize: 0,
    outcomeScope: DEVICE_ACTION_OUTCOMES,
    filtered: false,
  });
  const filteredToZero = foldAuditCounts([], {
    logSize: 9,
    outcomeScope: DEVICE_ACTION_OUTCOMES,
    filtered: true,
  });

  assert.match(neverLogged.emptyReason ?? "", /No device action has been logged yet/);
  assert.match(neverLogged.emptyReason ?? "", /not that the counting failed/);
  assert.match(filteredToZero.emptyReason ?? "", /No logged action matches these filters/);
  assert.match(filteredToZero.emptyReason ?? "", /holds 9 action\(s\)/);
  assert.notEqual(neverLogged.emptyReason, filteredToZero.emptyReason);
});

test("a non-empty log counting zero on an UNFILTERED read is reported as our bug", () => {
  // Arithmetically impossible, which is exactly why it must not read as a fact
  // about the fleet if it ever happens.
  const counts = foldAuditCounts([], {
    logSize: 5,
    outcomeScope: DEVICE_ACTION_OUTCOMES,
    filtered: false,
  });
  assert.match(counts.emptyReason ?? "", /means this count is wrong/);
  assert.match(counts.emptyReason ?? "", /bug in \/api\/audit\/counts/);
});

test("emptyReason is null the moment something matched", () => {
  const counts = foldAuditCounts([group()], {
    logSize: 1,
    outcomeScope: DEVICE_ACTION_OUTCOMES,
    filtered: false,
  });
  assert.equal(counts.emptyReason, null);
});

// ─── the endpoint ────────────────────────────────────────────────────────────

interface CountsBody {
  data?: {
    matched: number;
    logSize: number;
    byOutcome: Record<string, number>;
    byAction: Array<{ action: string; count: number }>;
    oldestActionAt: string | null;
    newestActionAt: string | null;
    emptyReason: string | null;
    basis: string;
    countedAt: string;
    filters: Record<string, unknown>;
    outcomeScope: { counted: string[]; excludedByFilter: string[]; note: string };
    actionScope: { note: string; groups: Record<string, string[]> };
    searchScope: { query: string | null; fields: string[]; note: string };
    retention: { retainDays: number; enforced: boolean };
  };
  meta?: { freshness: { state: string }; page?: unknown };
  error?: string;
  message?: string;
}

interface Capture {
  sql: string[];
  values: unknown[][];
}

const stubPool = (groups: AuditCountGroup[], capture: Capture): Pool =>
  ({
    async query(sql: string, values: unknown[]) {
      if (sql.includes("MAX(observed_at)")) {
        return { rows: [{ newest: new Date(Date.now() - 60_000) }], rowCount: 1 };
      }
      if (sql.includes("GROUP BY l.outcome, l.action")) {
        capture.sql.push(sql);
        capture.values.push(values);
        return {
          rows: groups.map((g) => ({
            outcome: g.outcome,
            action: g.action,
            n: String(g.count),
            oldest: g.oldest,
            newest: g.newest,
          })),
          rowCount: groups.length,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  }) as unknown as Pool;

const get = async (query = "", groups: AuditCountGroup[] = [], logSize = 0) => {
  const capture: Capture = { sql: [], values: [] };
  const repo = {
    async deviceActionLogSize() {
      return logSize;
    },
    async pollerRunHistory() {
      return [];
    },
  } as unknown as Repository;
  const app = await buildServer({
    pool: stubPool(groups, capture),
    repo,
    auth: { token: TOKEN, allowAnonymous: false },
  });
  const response = await app.inject({
    method: "GET",
    url: `/api/audit/counts${query}`,
    headers: auth,
  });
  await app.close();
  return { statusCode: response.statusCode, body: response.json() as CountsBody, capture };
};

test("the counts carry the envelope, the basis and no page block", async () => {
  const { statusCode, body } = await get(
    "",
    [group({ outcome: "verified", count: 4 }), group({ outcome: "failed", count: 1 })],
    5,
  );

  assert.equal(statusCode, 200);
  assert.ok(body.meta!.freshness, "an audit answer carries freshness like every other endpoint");
  assert.equal(body.meta!.page, undefined, "counts describe a match, not a page");
  assert.equal(body.data!.matched, 5);
  assert.equal(body.data!.logSize, 5);
  assert.equal(body.data!.byOutcome.verified, 4);
  assert.equal(body.data!.byOutcome.failed, 1);
  assert.match(body.data!.basis, /not over a page of them/);
  assert.ok(body.data!.countedAt, "a count is stamped with when it was taken");
  assert.equal(body.data!.retention.enforced, false, "nothing has aged out of these numbers");
});

test("the filters reach the SQL and are echoed back, so the two endpoints can be checked", async () => {
  const { body, capture } = await get(
    "?deviceId=1000152&actor=api%3Astephen&outcome=failed,rolled_back&action=brightness_write",
    [group({ outcome: "failed", count: 2 })],
    40,
  );

  const sql = capture.sql[0] ?? "";
  assert.match(sql, /l\.device_id = \$1/);
  assert.match(sql, /l\.actor = \$2/);
  assert.match(sql, /l\.outcome = ANY\(\$3::text\[\]\)/);
  assert.match(sql, /l\.action = \$4/);
  assert.deepEqual(capture.values[0], [
    "1000152",
    "api:stephen",
    ["failed", "rolled_back"],
    "brightness_write",
  ]);
  assert.deepEqual(body.data!.filters, {
    deviceId: "1000152",
    actor: "api:stephen",
    outcome: ["failed", "rolled_back"],
    action: "brightness_write",
    // Absent filters echo as null rather than being omitted: a missing key is
    // ambiguous between "not sent" and "we dropped it".
    actionGroup: null,
    actions: null,
    q: null,
    since: null,
    until: null,
  });
});

test("an outcome filter narrows the breakdown and says which outcomes it stopped counting", async () => {
  const { body } = await get("?outcome=failed", [group({ outcome: "failed", count: 2 })], 40);

  assert.deepEqual(Object.keys(body.data!.byOutcome), ["failed"]);
  assert.deepEqual(body.data!.outcomeScope.counted, ["failed"]);
  assert.equal(body.data!.outcomeScope.excludedByFilter.length, DEVICE_ACTION_OUTCOMES.length - 1);
  assert.match(body.data!.outcomeScope.note, /absent from `byOutcome` rather than reported as 0/);
});

test("with no outcome filter every outcome in the vocabulary is counted", async () => {
  const { body } = await get("", [group({ count: 1 })], 1);
  assert.deepEqual(body.data!.outcomeScope.counted, [...DEVICE_ACTION_OUTCOMES]);
  assert.deepEqual(body.data!.outcomeScope.excludedByFilter, []);
  assert.match(body.data!.outcomeScope.note, /a 0 here means the matched log genuinely holds none/);
});

test("the open action vocabulary is stated, so a missing action is not read as zero", async () => {
  const { body } = await get("", [group({ count: 1 })], 1);
  assert.match(body.data!.actionScope.note, /open vocabulary/);
  assert.match(body.data!.actionScope.note, /cannot report a 0 for an action nothing enumerates/);
});

test("an empty log says it has never been written to, not that a filter missed", async () => {
  // The live shape: 0 rows, because no device write has ever been fired here.
  const { body } = await get("", [], 0);

  assert.equal(body.data!.matched, 0);
  assert.equal(body.data!.logSize, 0);
  assert.match(body.data!.emptyReason ?? "", /No device action has been logged yet/);
  assert.doesNotMatch(body.data!.emptyReason ?? "", /matches these filters/);
  // Every outcome is still keyed at 0: we did look, and the answer is genuinely
  // none. The reason above is what stops that being read as a measurement.
  assert.equal(Object.keys(body.data!.byOutcome).length, DEVICE_ACTION_OUTCOMES.length);
  assert.deepEqual(body.data!.byAction, []);
});

test("a filter that matches nothing over a non-empty log reads differently", async () => {
  const { body } = await get("?deviceId=1009999", [], 40);
  assert.equal(body.data!.matched, 0);
  assert.equal(body.data!.logSize, 40);
  assert.match(body.data!.emptyReason ?? "", /No logged action matches these filters/);
  assert.match(body.data!.emptyReason ?? "", /holds 40 action\(s\)/);
});

test("page controls are refused, because a count over a page is not a count of the log", async () => {
  for (const query of ["?limit=50", "?page=2", "?page=1&limit=10&deviceId=1000152"]) {
    const { statusCode, body } = await get(query);
    assert.equal(statusCode, 400, query);
    assert.match(body.message ?? "", /page count dressed as a log count/);
  }
});

test("an unknown outcome is refused with the vocabulary, never silently matching nothing", async () => {
  const { statusCode, body } = await get("?outcome=fialed");
  assert.equal(statusCode, 400);
  assert.match(body.message ?? "", /unknown outcome\(s\) fialed/);
  assert.match(body.message ?? "", /Valid: applied, verified/);
});

test("an inverted window is refused rather than counted as empty", async () => {
  const { statusCode, body } = await get(
    "?since=2026-09-08T00:00:00Z&until=2026-09-01T00:00:00Z",
  );
  assert.equal(statusCode, 400);
  assert.match(body.message ?? "", /half-open \[since, until\)/);
});
