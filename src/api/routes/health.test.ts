/**
 * Self-observability ENDPOINT tests —
 *   `node --test dist/api/routes/health.test.js`
 *
 * `alerting/hygiene.test.ts` and `alerting/pipeline-health.test.ts` already pin
 * the two pure classifiers hard. This file covers the part they cannot: the
 * WIRING in `src/api/routes/health.ts`, which shipped with no tests at all.
 *
 * Three things can go wrong in a route that only assembles:
 *
 *   1. it forgets one of the aggregates the classifier needs, and the view is
 *      quietly built from a partial fleet (a `null` in `excludedRetiredAlerts`
 *      is honest; a zero would be a lie);
 *   2. it drops the freshness envelope, so a consumer renders a self-report with
 *      no way to tell how old the fleet data behind it is;
 *   3. a repository failure arrives as a 200 with a half-built body, or as a 500
 *      that leaks the SQL error — either is worse than an error the client can
 *      recognise.
 *
 * Everything runs through `app.inject()` against a stubbed pool and a stubbed
 * repository. No database, no control plane, no device is contacted — these two
 * endpoints are read-only reports about US, and the server is built without a
 * `videri` client to prove they need no control plane at all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { Repository } from "../../db/repository.js";
import { buildServer } from "../server.js";
import { EXPECTED_LANES, type PollerRunRow } from "../../alerting/pipeline-health.js";
import type { Severity } from "../../domain/types.js";

const TOKEN = "test-token-at-least-16-chars";
const auth = { authorization: `Bearer ${TOKEN}` };

/** The minimum pool the freshness envelope needs. Neither report reads pg directly. */
function stubPool(): Pool {
  return {
    async query(sql: string) {
      if (sql.includes("MAX(observed_at)")) {
        return { rows: [{ newest: new Date(Date.now() - 60_000) }], rowCount: 1 };
      }
      if (sql.includes("FROM poller_runs")) {
        return {
          rows: [{
            poller: "metrics",
            started_at: new Date(Date.now() - 60_000),
            duration_ms: 1000,
            batches_failed: 0,
            telemetry_yield: 0.9,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
}

interface OpenAlert {
  id: string;
  deviceId: string;
  ruleId: string;
  severity: Severity;
  openedAt: Date;
}

interface RepoStubOptions {
  openAlerts?: OpenAlert[];
  darkness?: Array<{ deviceId: string; lastOnlineTime: Date | null }>;
  activeDevices?: number;
  neverSeenDevices?: number;
  retiredAlertCount?: number;
  runs?: PollerRunRow[];
  /** Which repository method should reject, simulating an unreadable database. */
  failOn?: "openAlertFacts" | "estateDarkness" | "openAlertsOnRetiredDevices"
    | "pollerRunHistory" | "loadRuleDefinitions";
}

interface RepoStub {
  repo: Repository;
  /** Every repository method the route reached, in call order. */
  calls: string[];
}

function stubRepo(opts: RepoStubOptions = {}): RepoStub {
  const calls: string[] = [];
  const guard = (name: NonNullable<RepoStubOptions["failOn"]>) => {
    calls.push(name);
    if (opts.failOn === name) {
      // A message a leaky error handler would echo back to the client.
      throw new Error('relation "alerts" does not exist');
    }
  };
  const repo = {
    async loadRuleDefinitions() {
      guard("loadRuleDefinitions");
      return []; // empty table -> DEFAULT_RULES, exactly as the engine does
    },
    async openAlertFacts() {
      guard("openAlertFacts");
      return opts.openAlerts ?? [];
    },
    async estateDarkness() {
      guard("estateDarkness");
      return {
        activeDevices: opts.activeDevices ?? 0,
        neverSeenDevices: opts.neverSeenDevices ?? 0,
        devices: opts.darkness ?? [],
      };
    },
    async openAlertsOnRetiredDevices() {
      guard("openAlertsOnRetiredDevices");
      return opts.retiredAlertCount ?? 0;
    },
    async pollerRunHistory() {
      guard("pollerRunHistory");
      return opts.runs ?? [];
    },
  } as unknown as Repository;
  return { repo, calls };
}

/** No `videri`: both endpoints must work on a read-only deployment. */
const build = (opts: RepoStubOptions = {}) => {
  const { repo, calls } = stubRepo(opts);
  return {
    calls,
    app: buildServer({
      pool: stubPool(),
      repo,
      auth: { token: TOKEN, allowAnonymous: false },
    }),
  };
};

const DAY = 86_400_000;
const now = Date.now();

const run = (over: Partial<PollerRunRow> & { poller: string }): PollerRunRow => ({
  startedAt: new Date(now - 60_000),
  durationMs: 1000,
  devicesTargeted: 10,
  rowsWritten: 10,
  batchesOk: 1,
  batchesFailed: 0,
  telemetryYield: null,
  ...over,
});

/**
 * A fleet shaped like the live one: one live device with a genuine critical, one
 * device dark for seven months carrying its outage plus a stale firmware alert.
 */
const liveShapedFleet = (): RepoStubOptions => ({
  openAlerts: [
    { id: "a1", deviceId: "live-1", ruleId: "black-screen", severity: "critical", openedAt: new Date(now - 3_600_000) },
    { id: "a2", deviceId: "dark-1", ruleId: "offline-6mo", severity: "info", openedAt: new Date(now - 200 * DAY) },
    { id: "a3", deviceId: "dark-1", ruleId: "firmware-behind", severity: "info", openedAt: new Date(now - 150 * DAY) },
  ],
  darkness: [
    { deviceId: "live-1", lastOnlineTime: new Date(now - 60_000) },
    { deviceId: "dark-1", lastOnlineTime: new Date(now - 210 * DAY) },
  ],
  activeDevices: 2,
  neverSeenDevices: 0,
  retiredAlertCount: 7,
});

// ─── GET /api/alerts/hygiene ─────────────────────────────────────────────────

test("hygiene is credentialled like every other data endpoint", async () => {
  const { app } = build();
  const server = await app;
  const res = await server.inject({ method: "GET", url: "/api/alerts/hygiene" });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "unauthorized");
  await server.close();
});

test("hygiene answers in the standard envelope: data plus meta.freshness", async () => {
  const { app } = build(liveShapedFleet());
  const server = await app;
  const res = await server.inject({ method: "GET", url: "/api/alerts/hygiene", headers: auth });
  assert.equal(res.statusCode, 200);

  const body = res.json();
  // The envelope is the contract every consumer codes against.
  assert.deepEqual(Object.keys(body).sort(), ["data", "meta"]);
  assert.ok(body.meta.freshness, "a self-report still needs the fleet-data freshness envelope");
  assert.equal(body.meta.freshness.state, "fresh");
  assert.ok(Array.isArray(body.meta.freshness.warnings));
  // A report ABOUT the alert list is not itself a paginated collection.
  assert.equal(body.meta.page, undefined);

  const data = body.data;
  assert.equal(data.totalOpen, 3);
  assert.ok(data.incidents, "the incident band must be present");
  assert.ok(data.dormant, "the dormant band must be present — a suppression you cannot count is a bug");
  assert.ok(Array.isArray(data.chips) && data.chips.length > 0);
  assert.ok(Array.isArray(data.notes) && data.notes.length > 0, "notes say what was moved and why");
  await server.close();
});

test("the hygiene endpoint's chips still sum to the total after serialisation", async () => {
  // The invariant is proven on the pure classifier; this proves the ROUTE does
  // not reshape it on the way out (a partial `data` would break it silently).
  const { app } = build(liveShapedFleet());
  const server = await app;
  const body = (await server.inject({ method: "GET", url: "/api/alerts/hygiene", headers: auth })).json();

  const chipTotal = (body.data.chips as Array<{ count: number }>)
    .reduce((sum, c) => sum + c.count, 0);
  assert.equal(chipTotal, body.data.totalOpen);
  assert.equal(body.data.incidents.total + body.data.dormant.total, body.data.totalOpen);
  await server.close();
});

test("the route reads all three aggregates, so retired alerts are reconcilable and never a fake zero", async () => {
  // Forgetting `openAlertsOnRetiredDevices` would leave the view internally
  // consistent while disagreeing with a raw COUNT of the alerts table — that
  // disagreement was a real 306-vs-304 incident.
  const { app, calls } = build(liveShapedFleet());
  const server = await app;
  const body = (await server.inject({ method: "GET", url: "/api/alerts/hygiene", headers: auth })).json();

  assert.equal(body.data.excludedRetiredAlerts, 7);
  assert.equal(body.data.totalOpen + body.data.excludedRetiredAlerts, 10,
    "totalOpen plus the excluded retired alerts must equal a raw open-alert count");
  for (const method of ["openAlertFacts", "estateDarkness", "openAlertsOnRetiredDevices"]) {
    assert.ok(calls.includes(method), `the route must read ${method}`);
  }
  await server.close();
});

test("hygiene classifies from the rules in the DATABASE, not from a hardcoded id list", async () => {
  const { app, calls } = build(liveShapedFleet());
  const server = await app;
  const body = (await server.inject({ method: "GET", url: "/api/alerts/hygiene", headers: auth })).json();

  assert.ok(calls.includes("loadRuleDefinitions"),
    "tuning a rule must tune dormancy with it, so the rule set has to be read");
  // offline-6mo is dormant-classed, and the stale firmware alert on the same
  // dark device rolls up with the outage that explains it.
  assert.equal(body.data.dormant.total, 2);
  assert.deepEqual(body.data.dormant.deviceIds, ["dark-1"]);
  // The genuine critical on the live device is untouched.
  assert.equal(body.data.incidents.total, 1);
  assert.equal(body.data.incidents.bySeverity.critical, 1);
  await server.close();
});

test("the dormant rollup ships the drilldown the console needs to open it", async () => {
  const { app } = build(liveShapedFleet());
  const server = await app;
  const body = (await server.inject({ method: "GET", url: "/api/alerts/hygiene", headers: auth })).json();

  assert.ok(body.data.rollup, "a dormant cohort must produce its estate finding");
  assert.equal(body.data.rollup.drilldown.state, "open");
  assert.deepEqual(body.data.rollup.drilldown.deviceIds, ["dark-1"]);
  await server.close();
});

test("an empty alert table is an honest empty report, not a 500", async () => {
  const { app } = build({ activeDevices: 0 });
  const server = await app;
  const res = await server.inject({ method: "GET", url: "/api/alerts/hygiene", headers: auth });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.totalOpen, 0);
  assert.equal(data.rollup, null, "no dormant cohort means no estate finding, not an invented one");
  await server.close();
});

test("a repository failure on hygiene is a recognisable error, never a 200 with a half-built body", async () => {
  const { app } = build({ ...liveShapedFleet(), failOn: "openAlertFacts" });
  const server = await app;
  const res = await server.inject({ method: "GET", url: "/api/alerts/hygiene", headers: auth });

  assert.equal(res.statusCode, 500);
  const body = res.json();
  assert.equal(body.error, "internal_error");
  assert.equal(typeof body.message, "string");
  // A consumer must not receive a body it would render as "0 open alerts".
  assert.equal(body.data, undefined);
  assert.equal(body.meta, undefined);
  // And the SQL error must not leak the schema.
  assert.ok(!JSON.stringify(body).includes("does not exist"),
    "the error body must not echo the database error");
  await server.close();
});

test("hygiene fails loudly when the ESTATE aggregate is the unreadable one", async () => {
  // The estate read only feeds context (share, darkness buckets). Swallowing its
  // failure would publish a rollup whose estateShare silently became null while
  // everything else looked normal.
  const { app } = build({ ...liveShapedFleet(), failOn: "estateDarkness" });
  const server = await app;
  const res = await server.inject({ method: "GET", url: "/api/alerts/hygiene", headers: auth });
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error, "internal_error");
  await server.close();
});

// ─── GET /api/pipeline/health ────────────────────────────────────────────────

test("pipeline health is credentialled, and is not the unauthenticated /health probe", async () => {
  const { app } = build();
  const server = await app;
  assert.equal((await server.inject({ method: "GET", url: "/api/pipeline/health" })).statusCode, 401);
  // The container probe stays open; the self-report about our collector does not.
  assert.equal((await server.inject({ method: "GET", url: "/health" })).statusCode, 200);
  await server.close();
});

test("pipeline health answers in the standard envelope and is scoped to US, not the fleet", async () => {
  const { app } = build({
    runs: [run({ poller: "devices" }), run({ poller: "status" }), run({ poller: "metrics" })],
  });
  const server = await app;
  const res = await server.inject({ method: "GET", url: "/api/pipeline/health", headers: auth });
  assert.equal(res.statusCode, 200);

  const body = res.json();
  assert.deepEqual(Object.keys(body).sort(), ["data", "meta"]);
  assert.ok(body.meta.freshness);
  // The fixed scope is what stops a consumer rendering "our collector stalled"
  // as "the screen is broken".
  assert.equal(body.data.scope, "vfi-pipeline");
  assert.equal(typeof body.data.generatedAt, "string");
  assert.equal(typeof body.data.summary, "string");
  assert.equal(typeof body.data.deviceDataAtRisk, "boolean");
  assert.ok(Array.isArray(body.data.lanes));
  assert.ok(Array.isArray(body.data.findings));
  await server.close();
});

test("a poller that has never once run is reported as such, not as healthy silence", async () => {
  // The whole reason this endpoint exists: a poller that is up but polling
  // nothing looks identical to a healthy one from outside.
  const { app, calls } = build({ runs: [] });
  const server = await app;
  const body = (await server.inject({ method: "GET", url: "/api/pipeline/health", headers: auth })).json();

  assert.ok(calls.includes("pollerRunHistory"));
  const byLane = new Map<string, { status: string; lastRunAt: string | null; ageSeconds: number | null }>(
    (body.data.lanes as Array<{ lane: string; status: string; lastRunAt: string | null; ageSeconds: number | null }>)
      .map((l) => [l.lane, l]),
  );
  // Only the lanes with no opt-in flag are asserted: the route reads the real
  // process.env for the flagged ones, so their status is environment-dependent.
  for (const lane of EXPECTED_LANES.filter((l) => !l.optInEnv)) {
    const health = byLane.get(lane.lane);
    assert.ok(health, `${lane.lane} must appear in the roster even with no runs`);
    assert.equal(health.status, "never-ran", `${lane.lane} never ran and must say so`);
    // Honest nulls: no run means no timestamp and no age, never a zero age.
    assert.equal(health.lastRunAt, null);
    assert.equal(health.ageSeconds, null);
  }
  assert.notEqual(body.data.worstStatus, "healthy");
  await server.close();
});

test("a stalled lane surfaces a finding and flags device data at risk", async () => {
  // A 15-minute cadence with the last run 30 hours ago: measured, then missed.
  const cadenceMs = 15 * 60_000;
  const lastStart = now - 30 * 3_600_000;
  const { app } = build({
    runs: [0, 1, 2, 3].map((i) =>
      run({ poller: "devices", startedAt: new Date(lastStart - i * cadenceMs) }),
    ),
  });
  const server = await app;
  const body = (await server.inject({ method: "GET", url: "/api/pipeline/health", headers: auth })).json();

  const devices = (body.data.lanes as Array<{ lane: string; status: string }>)
    .find((l) => l.lane === "devices");
  assert.equal(devices?.status, "stalled");
  assert.equal(body.data.deviceDataAtRisk, true);
  assert.ok(body.data.findings.length > 0, "a stalled collector must produce a finding");
  for (const finding of body.data.findings as Array<Record<string, unknown>>) {
    assert.equal(finding["scope"], "vfi-pipeline",
      "every finding carries our scope so it cannot be read as a device fault");
  }
  await server.close();
});

test("freshness and the pipeline report are independently optional: one broken does not blank the other", async () => {
  // The report is built from the repository, freshness from the pool. A healthy
  // envelope must not imply a healthy pipeline, or vice versa.
  const { app } = build({ runs: [] });
  const server = await app;
  const body = (await server.inject({ method: "GET", url: "/api/pipeline/health", headers: auth })).json();
  assert.equal(body.meta.freshness.state, "fresh");
  assert.notEqual(body.data.worstStatus, "healthy");
  await server.close();
});

test("a repository failure on pipeline health is a recognisable error, not an empty lane roster", async () => {
  const { app } = build({ failOn: "pollerRunHistory" });
  const server = await app;
  const res = await server.inject({ method: "GET", url: "/api/pipeline/health", headers: auth });

  assert.equal(res.statusCode, 500);
  const body = res.json();
  assert.equal(body.error, "internal_error");
  assert.equal(body.data, undefined);
  // An empty `lanes` array would read as "no lanes are in trouble".
  assert.equal(body.lanes, undefined);
  assert.ok(!JSON.stringify(body).includes("does not exist"));
  await server.close();
});

test("both self-reports work on a deployment with no control plane at all", async () => {
  // Neither endpoint may need Videri credentials — they are about us.
  const { app } = build(liveShapedFleet());
  const server = await app;
  assert.equal((await server.inject({ method: "GET", url: "/api/alerts/hygiene", headers: auth })).statusCode, 200);
  assert.equal((await server.inject({ method: "GET", url: "/api/pipeline/health", headers: auth })).statusCode, 200);
  await server.close();
});
