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
import { auditOutcomeForBrightness, resolveActor } from "./audit.js";
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
  params: { arg: "set_brightness:=179" },
  detail: { mode: "verify", state: "unconfirmed_rolled_back", originalRaw: 100 },
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
