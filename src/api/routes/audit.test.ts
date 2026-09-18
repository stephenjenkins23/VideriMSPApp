/**
 * `GET /api/audit` tests — `node --test dist/api/routes/audit.test.js`
 *
 * This endpoint is the answer to "what did we change on this screen last week,
 * and who asked for it?", so the properties worth guarding are the ones where a
 * wrong answer still LOOKS like an answer:
 *
 *   - a filter that is silently dropped returns the whole log and reads as "we
 *     did all of this to your device";
 *   - a filter that silently matches nothing returns `[]` and reads as "we never
 *     touched it". Hence the closed outcome vocabulary is validated, not passed
 *     through, and an empty page says WHICH kind of empty it is;
 *   - a window that includes both endpoints double-counts a row when two
 *     adjacent windows are read back to back, so the window is half-open;
 *   - a page count derived from the page rather than the match under-reports.
 *
 * The pure helpers (`resolveActor`, `auditOutcomeForBrightness`) are asserted
 * directly. No database: the repository is a stub that captures its filters.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { DeviceActionFilters, DeviceActionRow, Repository } from "../../db/repository.js";
import { buildServer } from "../server.js";
import {
  AUDIT_ACTION_GROUPS, AUDIT_SEARCH_FIELDS, auditOutcomeForBrightness,
  describePreviousValue, resolveActor,
} from "./audit.js";
import { PREVIOUS_VALUE_BASES } from "../../db/repository.js";
import type { BrightnessState } from "../../videri/brightness.js";

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

const ROW: DeviceActionRow = {
  id: 7,
  action: "brightness_write",
  verb: "set_brightness",
  deviceId: "1000152",
  deviceName: "Center Spark 5",
  requestedValue: "70%",
  observedValue: "39%",
  /* The preflight reading, normalised to the requested value's unit. Raw 100 is
     still in `detail` — that is what you quote at the vendor — and 39% is what
     makes the row say "39% → 70%" instead of "100 → 70%". */
  previousValue: "39%",
  params: { arg: "set_brightness:=179" },
  detail: {
    mode: "verify", state: "unconfirmed_rolled_back", originalRaw: 100,
    previousValueBasis: "preflight_read",
  },
  outcome: "rolled_back",
  actor: "api:stephen",
  actorIp: "10.0.0.4",
  startedAt: new Date("2026-09-02T10:00:00.000Z"),
  finishedAt: new Date("2026-09-02T10:00:04.000Z"),
  durationMs: 4000,
  error: "The device reported raw 100, not the requested 179. It was restored to raw 100.",
};

interface RepoStub {
  repo: Repository;
  filters: DeviceActionFilters[];
  sizeCalls: number;
}

function stubRepo(opts: {
  items?: DeviceActionRow[];
  totalItems?: number;
  logSize?: number;
  oldestAt?: Date | null;
  newestAt?: Date | null;
} = {}): RepoStub {
  const filters: DeviceActionFilters[] = [];
  const stub = { sizeCalls: 0 };
  const items = opts.items ?? [ROW];
  const repo = {
    async listDeviceActions(f: DeviceActionFilters) {
      filters.push(f);
      return {
        items,
        totalItems: opts.totalItems ?? items.length,
        oldestAt: opts.oldestAt ?? (items[0]?.startedAt ?? null),
        newestAt: opts.newestAt ?? (items[0]?.startedAt ?? null),
      };
    },
    async deviceActionLogSize() {
      stub.sizeCalls += 1;
      return opts.logSize ?? 0;
    },
  } as unknown as Repository;
  return {
    repo, filters,
    get sizeCalls() { return stub.sizeCalls; },
  } as RepoStub;
}

const build = (repo: Repository) =>
  buildServer({ pool: stubPool(), repo, auth: { token: TOKEN, allowAnonymous: false } });

interface AuditBody {
  data?: {
    actions: Array<Record<string, unknown>>;
    oldestActionAt: string | null;
    newestActionAt: string | null;
    emptyReason: string | null;
    retention: { retainDays: number; enforced: boolean; note: string };
    searchScope: { query: string | null; fields: string[]; note: string };
    actionScope: {
      action: string | null;
      group: string | null;
      actions: string[] | null;
      groups: Record<string, string[]>;
      note: string;
    };
  };
  meta?: {
    freshness: { state: string };
    page?: { page: number; limit: number; totalItems: number; totalPages: number };
  };
  error?: string;
  message?: string;
}

const get = async (repo: Repository, query = "") => {
  const app = await build(repo);
  const res = await app.inject({ method: "GET", url: `/api/audit${query}`, headers: auth });
  return { statusCode: res.statusCode, body: res.json() as AuditBody };
};

// ─── the envelope ────────────────────────────────────────────────────────────

test("the response carries the standard envelope: data, freshness and a page block", async () => {
  const { repo } = stubRepo({ totalItems: 130 });
  const { statusCode, body } = await get(repo, "?limit=50");

  assert.equal(statusCode, 200);
  assert.ok(body.meta!.freshness, "an audit answer carries freshness like every other endpoint");
  assert.deepEqual(body.meta!.page, { page: 1, limit: 50, totalItems: 130, totalPages: 3 });
  // Page counts come from the MATCH, not from the rows on this page.
  assert.equal(body.data!.actions.length, 1);
});

test("a row serialises with its requested AND observed value, its actor and its error", async () => {
  const { repo } = stubRepo();
  const { body } = await get(repo);
  const row = body.data!.actions[0]!;

  assert.equal(row["outcome"], "rolled_back");
  assert.equal(row["requestedValue"], "70%");
  assert.equal(row["observedValue"], "39%");
  assert.equal(row["actor"], "api:stephen");
  assert.equal(row["deviceName"], "Center Spark 5");
  assert.equal(row["startedAt"], "2026-09-02T10:00:00.000Z");
  assert.equal(row["finishedAt"], "2026-09-02T10:00:04.000Z");
  assert.match(row["error"] as string, /restored to raw 100/);
  // The span of the match, so a caller on page 1 knows how far back it reaches.
  assert.equal(body.data!.newestActionAt, "2026-09-02T10:00:00.000Z");
});

test("the retention state is stated in the response, so absence can be read correctly", async () => {
  const { repo } = stubRepo();
  const { body } = await get(repo);
  assert.equal(body.data!.retention.retainDays, 730);
  // Nothing prunes this table today; saying otherwise would let a reader excuse
  // a missing row as "it aged out".
  assert.equal(body.data!.retention.enforced, false);
  assert.match(body.data!.retention.note, /nothing has aged out/);
});

// ─── filters ────────────────────────────────────────────────────────────────

test("every filter reaches the query — device, actor, outcome, action and window", async () => {
  const stub = stubRepo();
  const { statusCode } = await get(
    stub.repo,
    "?deviceId=1000152&actor=api:stephen&outcome=rolled_back,failed&action=brightness_write" +
      "&since=2026-09-01T00:00:00.000Z&until=2026-09-03T00:00:00.000Z&page=2&limit=10",
  );
  assert.equal(statusCode, 200);

  const f = stub.filters[0]!;
  assert.equal(f.deviceId, "1000152");
  assert.equal(f.actor, "api:stephen");
  assert.deepEqual(f.outcome, ["rolled_back", "failed"]);
  assert.equal(f.action, "brightness_write");
  assert.equal(f.since!.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(f.until!.toISOString(), "2026-09-03T00:00:00.000Z");
  assert.equal(f.page, 2);
  assert.equal(f.limit, 10);
});

test("an unfiltered call filters nothing — no accidental default window", async () => {
  const stub = stubRepo();
  await get(stub.repo);
  const f = stub.filters[0]!;
  for (const key of ["deviceId", "actor", "outcome", "action", "since", "until"] as const) {
    assert.equal(f[key], undefined, `${key} must not be defaulted`);
  }
  assert.equal(f.page, 1);
  assert.equal(f.limit, 50);
});

test("an unknown outcome is a 400 naming the valid set, never a silent empty result", async () => {
  const stub = stubRepo();
  const { statusCode, body } = await get(stub.repo, "?outcome=rolledback");
  assert.equal(statusCode, 400);
  assert.match(body.message!, /unknown outcome\(s\) rolledback/);
  assert.match(body.message!, /rolled_back/);
  assert.equal(stub.filters.length, 0, "a bad filter must not reach the query at all");
});

test("a window whose end precedes its start is a 400, not an empty log", async () => {
  const stub = stubRepo();
  const { statusCode, body } = await get(
    stub.repo, "?since=2026-09-03T00:00:00.000Z&until=2026-09-01T00:00:00.000Z",
  );
  assert.equal(statusCode, 400);
  assert.match(body.message!, /half-open/);
  assert.equal(stub.filters.length, 0);
});

test("limit is capped, so no caller can ask for the whole log in one page", async () => {
  const stub = stubRepo();
  const { statusCode } = await get(stub.repo, "?limit=5000");
  assert.equal(statusCode, 400);
});

// ─── pagination ─────────────────────────────────────────────────────────────

test("pagination offsets by page and reports total pages from the match", async () => {
  const stub = stubRepo({ totalItems: 21 });
  const { body } = await get(stub.repo, "?page=3&limit=10");
  assert.equal(stub.filters[0]!.page, 3);
  assert.deepEqual(body.meta!.page, { page: 3, limit: 10, totalItems: 21, totalPages: 3 });
});

test("an empty match still reports at least one page rather than zero", async () => {
  const stub = stubRepo({ items: [], totalItems: 0 });
  const { body } = await get(stub.repo);
  assert.equal(body.meta!.page!.totalPages, 1);
  assert.equal(body.meta!.page!.totalItems, 0);
});

// ─── an empty log says WHICH empty it is ────────────────────────────────────

test("an entirely empty log says so, and says nothing was inferred or backfilled", async () => {
  const stub = stubRepo({ items: [], totalItems: 0, logSize: 0 });
  const { statusCode, body } = await get(stub.repo);

  assert.equal(statusCode, 200, "an empty audit log is a correct answer, not an error");
  assert.deepEqual(body.data!.actions, []);
  assert.match(body.data!.emptyReason!, /No device action has been logged yet/);
  assert.equal(body.data!.oldestActionAt, null);
  assert.equal(body.data!.newestActionAt, null);
});

test("a filter that matched nothing is distinguished from a log that holds nothing", async () => {
  const stub = stubRepo({ items: [], totalItems: 0, logSize: 412 });
  const { body } = await get(stub.repo, "?deviceId=1000999");
  assert.match(body.data!.emptyReason!, /No logged action matches these filters/);
});

test("a page past the end says so rather than implying the log is empty", async () => {
  const stub = stubRepo({ items: [], totalItems: 12, logSize: 412 });
  const { body } = await get(stub.repo, "?page=9&limit=10");
  assert.match(body.data!.emptyReason!, /past the end of 12 matching action/);
});

test("emptyReason is null when there are rows, and the extra count is not run", async () => {
  const stub = stubRepo();
  const { body } = await get(stub.repo);
  assert.equal(body.data!.emptyReason, null);
  assert.equal(stub.sizeCalls, 0, "the whole-log count runs only when a page is empty");
});

// ─── from → to: the half of the pair that is allowed to be missing ──────────

const view = (previousValue: string | null, detail: Record<string, unknown> = {}) =>
  describePreviousValue({ previousValue, detail });

test("a recorded previous value comes back as a value, in the requested value's unit", async () => {
  const { body } = await get(stubRepo().repo);
  const row = body.data!.actions[0]!;
  const previous = row["previousValue"] as Record<string, unknown>;

  // The sentence this log exists to produce: 39% → 70%, both percentages. The
  // old audit view could only show "100 → 70%", from detail.originalRaw.
  assert.equal(previous["value"], "39%");
  assert.equal(previous["known"], true);
  assert.equal(previous["source"], "recorded");
  assert.equal(previous["basis"], "preflight_read");
  assert.equal(previous["reason"], null, "there is nothing to explain when we know");
  assert.equal(row["requestedValue"], "70%", "the same unit, so from→to is readable");
  // The raw number stays in `detail` — it is what you quote at the vendor.
  assert.equal((row["detail"] as Record<string, unknown>)["originalRaw"], 100);
});

test("an unreadable preflight reads as unknown WITH the reason, never as 0", () => {
  const v = view(null, { previousValueBasis: "preflight_unreadable" });
  assert.equal(v.value, null);
  assert.equal(v.known, false);
  assert.equal(v.source, null);
  assert.equal(v.basis, "preflight_unreadable");
  assert.match(v.reason!, /would not report its brightness/);
  // The specific lie this guards: 0 on the brightness scale is a display-off
  // screen, so a 0 here claims we found the panel dark.
  assert.notEqual(v.value as unknown, 0);
  assert.notEqual(v.value as unknown, "0%");
  assert.match(v.reason!, /not 0/);
});

test("every basis in the vocabulary has its own sentence, and no two read the same", () => {
  // A shared "unknown" string across the bases would collapse "we could not read
  // it", "we never read it" and "we refused to act" into one answer — three
  // different facts about whether the screen was touched.
  const reasons = PREVIOUS_VALUE_BASES.map((basis) => {
    const v = view(null, { previousValueBasis: basis });
    assert.equal(v.known, false, basis);
    assert.equal(typeof v.reason, "string", basis);
    assert.ok(v.reason!.length > 40, `${basis} needs a real sentence, not a label`);
    return v.reason!;
  });
  assert.equal(new Set(reasons).size, PREVIOUS_VALUE_BASES.length);
  // And each is about the right thing.
  assert.match(view(null, { previousValueBasis: "not_read" }).reason!, /does not read the device's prior state/);
  assert.match(view(null, { previousValueBasis: "not_attempted" }).reason!, /refused before touching the device/);
  // `preflight_read` with no value is arithmetically impossible and is reported
  // as OUR bug rather than as a fact about the device.
  assert.match(view(null, { previousValueBasis: "preflight_read" }).reason!, /bug in the writer/);
});

test("a row written before the column says it was never recorded, not that nothing changed", () => {
  const v = view(null, { mode: "verify" });
  assert.equal(v.known, false);
  assert.equal(v.basis, null, "no basis is exactly what a pre-011 row looks like");
  assert.match(v.reason!, /written before VFI recorded a normalised before-value/);
  assert.match(v.reason!, /has deliberately not been backfilled/);
  // Not "no change", which is a real outcome in this log's vocabulary.
  assert.doesNotMatch(v.reason!, /no change/i);
});

test("a pre-column brightness row is converted from its own raw reading, and labelled", () => {
  // The fact is IN the row: `detail.originalRaw` on the device's 0-255 scale.
  // Converting it at read time is the same conversion the writer applies to
  // observedRaw — a unit change on a recorded value, not an inference — and it
  // is labelled so nobody mistakes it for a value we stored.
  const v = view(null, { mode: "verify", originalRaw: 100 });
  assert.equal(v.value, "39%");
  assert.equal(v.known, true);
  assert.equal(v.source, "derived_from_raw");
  assert.equal(v.reason, null);
  assert.match(v.note!, /Converted at read time from the raw 100/);
  assert.match(v.note!, /The stored row is unchanged/);
});

test("the column always wins over the raw reading, and a stated basis is never overridden", () => {
  // Both present: the normalised column is what the writer meant.
  const recorded = view("39%", { originalRaw: 100, previousValueBasis: "preflight_read" });
  assert.equal(recorded.source, "recorded");
  assert.equal(recorded.value, "39%");
  // A basis that says we could not read it must NOT be second-guessed by a raw
  // number left in detail — that combination is a writer bug, and guessing past
  // it would invent a reading the device never gave us.
  const contradictory = view(null, { originalRaw: 100, previousValueBasis: "preflight_unreadable" });
  assert.equal(contradictory.known, false);
  assert.equal(contradictory.value, null);
});

test("an unrecognised basis string is treated as no basis, not passed through", () => {
  // The vocabulary is closed. A drifted spelling must not reach the UI as if it
  // were a known reason.
  const v = view(null, { previousValueBasis: "preflight-read" });
  assert.equal(v.basis, null);
  assert.match(v.reason!, /written before VFI recorded a normalised before-value/);
});

test("known is false if and ONLY if there is a reason to print", () => {
  const cases: Array<[string | null, Record<string, unknown>]> = [
    ["39%", { previousValueBasis: "preflight_read" }],
    [null, { previousValueBasis: "preflight_unreadable" }],
    [null, { previousValueBasis: "not_read" }],
    [null, {}],
    [null, { originalRaw: 250 }],
  ];
  for (const [value, detail] of cases) {
    const v = view(value, detail);
    assert.equal(v.known, v.reason === null, JSON.stringify(detail));
    assert.equal(v.known, v.value !== null, JSON.stringify(detail));
  }
});

// ─── free text: "what happened to the canvas in the Denver lobby" ───────────

test("q reaches the query as an escaped, wildcard-wrapped pattern", async () => {
  const stub = stubRepo();
  const { statusCode } = await get(stub.repo, "?q=Denver%20lobby");
  assert.equal(statusCode, 200);
  assert.equal(stub.filters[0]!.search, "%Denver lobby%");
});

test("a caller's own % is matched literally, so a search cannot silently widen", async () => {
  const stub = stubRepo();
  await get(stub.repo, "?q=100%25");
  assert.equal(stub.filters[0]!.search, "%100\\%%");
});

test("a blank q is refused rather than ignored", async () => {
  // Silently dropping it returns the whole log under a heading that says it was
  // searched — the same class of bug as a filter that never reaches the SQL.
  const stub = stubRepo();
  const { statusCode, body } = await get(stub.repo, "?q=%20%20");
  assert.equal(statusCode, 400);
  assert.match(body.message!, /blank search is not a filter/);
  assert.equal(stub.filters.length, 0);
});

test("the response states what the search covered, so an empty result is readable", async () => {
  const stub = stubRepo({ items: [], totalItems: 0, logSize: 412 });
  const { body } = await get(stub.repo, "?q=Denver");
  assert.equal(body.data!.searchScope.query, "Denver");
  assert.deepEqual(body.data!.searchScope.fields, [...AUDIT_SEARCH_FIELDS]);
  assert.deepEqual(
    [...AUDIT_SEARCH_FIELDS],
    ["deviceId", "deviceName", "groupName", "location", "actor"],
    "the claim the note makes, pinned",
  );
  assert.match(body.data!.searchScope.note, /does NOT search the action, the verb, the error prose/);
  // An empty search result is still "your filter matched none", not "nothing happened".
  assert.match(body.data!.emptyReason!, /No logged action matches these filters/);
});

test("with no q the scope is still reported, with a null query", async () => {
  const { body } = await get(stubRepo().repo);
  assert.equal(body.data!.searchScope.query, null);
  assert.deepEqual(body.data!.searchScope.fields, [...AUDIT_SEARCH_FIELDS]);
});

// ─── one brightness history, not two ───────────────────────────────────────

test("actionGroup=brightness expands to BOTH writers of brightness", async () => {
  const stub = stubRepo();
  const { statusCode } = await get(stub.repo, "?deviceId=1000152&actionGroup=brightness");
  assert.equal(statusCode, 200);
  assert.deepEqual(stub.filters[0]!.actions, ["brightness_write", "bulk_brightness_write"]);
  assert.equal(stub.filters[0]!.action, undefined, "the group replaces `action`, it does not add to it");
  assert.equal(stub.filters[0]!.deviceId, "1000152");
});

test("the group is exactly the two action strings the writers use — no more, no fewer", async () => {
  // The union this closes: `brightness_write` from the single-device slider and
  // `bulk_brightness_write` from a batch push (see commands.ts). A third
  // brightness writer must be added HERE, or "every brightness change" silently
  // stops meaning that.
  assert.deepEqual([...AUDIT_ACTION_GROUPS["brightness"]!], [
    "brightness_write", "bulk_brightness_write",
  ]);
  assert.deepEqual(Object.keys(AUDIT_ACTION_GROUPS), ["brightness"]);
});

test("the expansion is echoed, so a reader sees which actions were included", async () => {
  const { body } = await get(stubRepo().repo, "?actionGroup=brightness");
  assert.equal(body.data!.actionScope.group, "brightness");
  assert.deepEqual(body.data!.actionScope.actions, ["brightness_write", "bulk_brightness_write"]);
  assert.match(body.data!.actionScope.note, /silently omits the other/);
});

test("an unknown group is a 400 naming the vocabulary, never a silent empty result", async () => {
  const stub = stubRepo();
  const { statusCode, body } = await get(stub.repo, "?actionGroup=brigthness");
  assert.equal(statusCode, 400);
  assert.match(body.message!, /unknown actionGroup brigthness/);
  assert.match(body.message!, /Valid: brightness/);
  assert.equal(stub.filters.length, 0, "a bad filter must not reach the query at all");
});

test("action and actionGroup cannot be combined — ANDing them is not the union", async () => {
  const stub = stubRepo();
  const { statusCode, body } = await get(
    stub.repo, "?action=brightness_write&actionGroup=brightness",
  );
  assert.equal(statusCode, 400);
  assert.match(body.message!, /narrows to the overlap rather than the union/);
  assert.equal(stub.filters.length, 0);
});

test("action alone still means exactly one writer", async () => {
  const stub = stubRepo();
  await get(stub.repo, "?action=bulk_brightness_write");
  assert.equal(stub.filters[0]!.action, "bulk_brightness_write");
  assert.equal(stub.filters[0]!.actions, undefined);
});

// ─── auth ───────────────────────────────────────────────────────────────────

test("the audit log is not readable without a token", async () => {
  const app = await build(stubRepo().repo);
  const res = await app.inject({ method: "GET", url: "/api/audit" });
  assert.equal(res.statusCode, 401);
});

test("the endpoint is read-only — POST is not routed", async () => {
  const app = await build(stubRepo().repo);
  const res = await app.inject({ method: "POST", url: "/api/audit", headers: auth, payload: {} });
  assert.equal(res.statusCode, 404);
});

// ─── the pure helpers ───────────────────────────────────────────────────────

test("every brightness state maps to exactly one audit outcome", async () => {
  const states: BrightnessState[] = [
    "preflight_blocked", "no_change", "verified",
    "unconfirmed_rolled_back", "unconfirmed_rollback_failed", "write_rejected",
  ];
  assert.deepEqual(
    states.map(auditOutcomeForBrightness),
    // preflight_blocked is `refused` (we declined; the panel was untouched) and
    // write_rejected is `failed` (we wrote; the device said no). Collapsing the
    // two would make "everything that failed" unanswerable.
    ["refused", "no_change", "verified", "rolled_back", "rollback_failed", "failed"],
  );
});

test("the actor is what we actually know, never an invented identity", async () => {
  assert.equal(
    resolveActor({ actorHeader: "stephen", authorization: "Bearer x", allowAnonymous: false }),
    "api:stephen",
  );
  assert.equal(resolveActor({ authorization: "Bearer x", allowAnonymous: false }), "api:token");
  // Anonymous only when the server really was started without auth.
  assert.equal(resolveActor({ allowAnonymous: true }), "api:anonymous");
  assert.equal(resolveActor({ allowAnonymous: false }), "api:token");
  // Whitespace is not an identity.
  assert.equal(resolveActor({ actorHeader: "   ", allowAnonymous: true }), "api:anonymous");
  // And an actor is an index key, not a place to put a kilobyte.
  assert.equal(resolveActor({ actorHeader: "x".repeat(400), allowAnonymous: true }).length, 124);
});
