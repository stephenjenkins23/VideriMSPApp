/**
 * `GET /api/incidents` — the route.
 *   `node --test dist/api/routes/incidents.test.js`
 *
 * `intelligence/incidents.test.ts` owns the collapse itself (the Leedy example,
 * `Center Spark 5`, the no-lost-transition partition). This file owns the three
 * things that can only go wrong at the route:
 *
 *   1. **A COUNT TAKEN FROM A WIDER SET THAN THE LIST BENEATH IT.** This bug has
 *      shipped here three times. The route selects whole incidents and then
 *      REBUILDS the queue from only those incidents' transitions, so `totals`,
 *      `grouping` and `reconciliation` are always computed over exactly the rows
 *      on the page. Asserted by filtering and then re-adding the numbers.
 *
 *   2. **A FILTER THAT SILENTLY RESHAPES A ROW.** `deviceId` must select the
 *      incidents a screen is CAUGHT UP IN and leave their five-device roster
 *      intact — narrowing the roster to the one device asked about would turn a
 *      site event back into a device fault, which is the whole error this epic
 *      corrects.
 *
 *   3. **AN AXIS PRESENTED AS SOMETHING IT IS NOT.** With no credential there is
 *      no group tree, so the grouping is leaf-group and the payload must say so.
 *      Labelling it "site" would overstate the collapse — 94 groups against 10
 *      sites on this tenant.
 *
 * Plus the house contracts: unknown parameters are a 400 (an ignored filter is
 * indistinguishable from one that matched everything), `limit=0` is a count, and
 * the ETag varies with every parameter.
 *
 * Everything runs through `app.inject()` against a stub pool. No database, no
 * control plane, no device.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { Repository } from "../../db/repository.js";
import { buildServer } from "../server.js";

const TOKEN = "test-token-at-least-16-chars";
const auth = { authorization: `Bearer ${TOKEN}` };

/** Fixed, so the ETag can settle — see the note in alerts.filters.test.ts. */
const NEWEST = new Date(Date.now() - 1000);

interface Row {
  id: string;
  device_id: string;
  device_name: string | null;
  group_id: string | null;
  group_name: string | null;
  rule_id: string;
  severity: string;
  title: string;
  opened_at: Date;
  last_fired_at: Date;
  resolved_at: Date | null;
  acknowledged_at: Date | null;
  /** Modelled by the stub only, to exercise the retirement exclusion. */
  retired?: boolean;
}

let seq = 0;
const row = (over: Partial<Row> = {}): Row => {
  seq += 1;
  const opened = over.opened_at ?? new Date("2026-08-27T21:31:00.000Z");
  return {
    id: `a-${String(seq).padStart(3, "0")}`,
    device_id: "1000921",
    device_name: "Leedy_Home_Spark3 Portrait",
    group_id: "grp-jay",
    group_name: "Jay",
    rule_id: "screen-off-during-schedule",
    severity: "medium",
    title: "Screen off during schedule",
    opened_at: opened,
    last_fired_at: opened,
    resolved_at: new Date(opened.getTime() + 4 * 3_600_000),
    acknowledged_at: null,
    ...over,
  };
};

/** Five screens in one group firing together in one 30-minute window. */
const coFiring = (openedAt: string, devices: string[], over: Partial<Row> = {}): Row[] =>
  devices.map((deviceId, i) =>
    row({
      device_id: deviceId,
      device_name: `dev ${deviceId}`,
      opened_at: new Date(Date.parse(openedAt) + i * 60_000),
      last_fired_at: new Date(Date.parse(openedAt) + i * 60_000),
      ...over,
    }),
  );

interface Captured { sql: string; values: unknown[] }

/**
 * A pool that APPLIES the predicates it is handed, and answers the retirement
 * count from the SAME row set that feeds the list.
 *
 * It must come from one place: "the count is of the thing you filtered" is the
 * property under test, and a stub with a canned total would pass whether the
 * route pushed its filters to one statement, the other, or neither.
 */
function stubPool(
  rows: Row[],
  /**
   * The collector's observation timeline, as the route's own query returns it:
   * one row per blind window (`prev` → `at`) plus one `prev: null` row carrying
   * the earliest observation we hold. Empty by default, which is how every test
   * written before BUG-10 keeps exercising the unchecked path.
   */
  timeline: Array<{ prev: Date | null; at: Date }> = [],
): { pool: Pool; captured: Captured[] } {
  const captured: Captured[] = [];
  const matching = (values: unknown[]): Row[] => {
    let out = rows;
    for (const value of values) {
      if (typeof value === "string") out = out.filter((r) => r.rule_id === value);
      if (typeof value === "number") {
        const cutoff = Date.now() - value * 86_400_000;
        out = out.filter((r) => r.opened_at.getTime() >= cutoff);
      }
    }
    return out;
  };

  const pool = {
    async query(sql: string, values: unknown[] = []) {
      captured.push({ sql, values });
      if (sql.includes("MAX(observed_at)")) return { rows: [{ newest: NEWEST }], rowCount: 1 };
      // Checked BEFORE the bare poller_runs probe: the resume query reads that
      // table too, inside a CTE.
      if (sql.includes("lag(at) OVER")) return { rows: timeline, rowCount: timeline.length };
      if (sql.includes("FROM poller_runs")) return { rows: [], rowCount: 0 };
      if (sql.includes("COUNT(*) FILTER (")) {
        const all = matching(values);
        return {
          rows: [{
            excluded: String(all.filter((r) => r.retired).length),
            total: String(all.length),
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM alerts a")) {
        // The route's NOT EXISTS retirement predicate, modelled.
        const out = matching(values)
          .filter((r) => !r.retired)
          .sort((a, b) => a.opened_at.getTime() - b.opened_at.getTime());
        return { rows: out, rowCount: out.length };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, captured };
}

const stubRepo = (): Repository => ({}) as unknown as Repository;

interface Answer {
  status: number;
  headers: Record<string, unknown>;
  json: () => Record<string, unknown>;
  data: () => Record<string, unknown>;
  captured: Captured[];
}

async function get(
  url: string,
  rows: Row[] = [],
  headers: Record<string, string> = {},
  over: { timeline?: Array<{ prev: Date | null; at: Date }>; repo?: Repository } = {},
): Promise<Answer> {
  const { pool, captured } = stubPool(rows, over.timeline ?? []);
  const app = await buildServer({
    pool, repo: over.repo ?? stubRepo(), auth: { token: TOKEN, allowAnonymous: false },
  });
  const res = await app.inject({ method: "GET", url, headers: { ...auth, ...headers } });
  await app.close();
  return {
    status: res.statusCode,
    headers: res.headers as Record<string, unknown>,
    json: () => res.json() as Record<string, unknown>,
    data: () => (res.json() as { data: Record<string, unknown> }).data,
    captured,
  };
}

/** The Leedy shape at route level: 2 co-firing windows + 1 isolated open row. */
const corpus = (): Row[] => [
  ...coFiring("2026-08-27T21:30:00.000Z", ["d1", "d2", "d3", "d4", "d5"]),
  ...coFiring("2026-08-28T21:30:00.000Z", ["d1", "d2", "d3"]),
  row({
    device_id: "d1",
    device_name: "dev d1",
    opened_at: new Date("2026-08-29T09:00:00.000Z"),
    last_fired_at: new Date("2026-08-29T09:00:00.000Z"),
    resolved_at: null,
  }),
  // A different rule on the same group — a second incident.
  row({
    device_id: "d9",
    device_name: "Center Spark 5",
    group_id: "grp-front",
    group_name: "Front Sitting Area",
    rule_id: "black-screen",
    severity: "critical",
    opened_at: new Date("2026-08-29T10:00:00.000Z"),
    last_fired_at: new Date("2026-08-29T10:00:00.000Z"),
    resolved_at: null,
  }),
];

// ── the queue ───────────────────────────────────────────────────────────────

test("the queue collapses transitions into incidents and reconciles every row", async () => {
  const rows = corpus();
  const res = await get("/api/incidents", rows);
  assert.equal(res.status, 200);
  const data = res.data();

  const incidents = data["incidents"] as Array<Record<string, unknown>>;
  assert.equal(incidents.length, 2, "10 transitions, 2 incidents");
  const totals = data["totals"] as Record<string, number>;
  assert.equal(totals["transitions"], rows.length);
  assert.equal(totals["incidents"], 2);
  assert.equal(totals["coFiringEvents"], 2);

  const recon = data["reconciliation"] as Record<string, unknown>;
  assert.equal(recon["balanced"], true);
  assert.equal(recon["transitionsIn"], rows.length);
  assert.equal(recon["transitionsInOccurrenceWindows"], rows.length);

  // Pagination totals the incidents, not the transitions.
  const page = (res.json()["meta"] as Record<string, Record<string, number>>)["page"]!;
  assert.equal(page["totalItems"], 2);
});

test("the grouping axis is named leaf-group, never site, when there is no group tree", async () => {
  const data = (await get("/api/incidents", corpus())).data();
  const grouping = data["grouping"] as Record<string, unknown>;
  assert.equal(grouping["axis"], "group");
  assert.equal(grouping["siteAxisAvailable"], false);
  assert.match(String(grouping["axisLabel"]), /NOT site/);
  assert.match(String(grouping["reason"]), /UPPER BOUND/);
  // And no credentials is stated as the cause, not left blank.
  assert.match(String(grouping["reason"]), /No Videri credentials/);

  const incidents = data["incidents"] as Array<{ scope: Record<string, unknown> }>;
  for (const incident of incidents) {
    assert.equal(incident.scope["axis"], "group");
    assert.equal(incident.scope["siteResolved"], false);
  }
});

// ── count the thing you filter ──────────────────────────────────────────────

test("state=open narrows the list AND every total with it", async () => {
  const rows = corpus();
  const all = (await get("/api/incidents?state=all", rows)).data();
  const open = (await get("/api/incidents?state=open", rows)).data();

  const allTotals = all["totals"] as Record<string, number>;
  const openTotals = open["totals"] as Record<string, number>;
  assert.equal(allTotals["transitions"], 10);
  assert.equal(allTotals["incidents"], 2);

  // Both incidents have an open transition here, so open === all; the assertion
  // that matters is that the totals were RECOMPUTED, not carried over.
  const openIncidents = (open["incidents"] as Array<Record<string, unknown>>).length;
  assert.equal(openTotals["incidents"], openIncidents);
  assert.equal(
    openTotals["transitions"],
    (open["incidents"] as Array<{ transitionCount: number }>)
      .reduce((a, i) => a + i.transitionCount, 0),
    "the transition total must equal the sum over the listed incidents",
  );
  assert.equal((open["reconciliation"] as Record<string, unknown>)["balanced"], true);
});

test("severity selects whole incidents; the totals describe only those", async () => {
  const rows = corpus();
  const res = await get("/api/incidents?severity=critical", rows);
  const data = res.data();
  const incidents = data["incidents"] as Array<Record<string, unknown>>;
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]!["ruleId"], "black-screen");

  const totals = data["totals"] as Record<string, number>;
  assert.equal(totals["incidents"], 1);
  assert.equal(totals["transitions"], 1, "only the critical incident's own row is counted");
  const corpusBlock = data["corpus"] as Record<string, number>;
  // The wider window is still DISCLOSED, so the filtered total can never be
  // mistaken for the size of the corpus.
  assert.equal(corpusBlock["incidentsSelected"], 1);
  assert.equal(corpusBlock["incidentsInWindow"], 2);
  assert.equal(corpusBlock["transitionsRead"], rows.length);
  assert.equal((data["reconciliation"] as Record<string, unknown>)["balanced"], true);
});

test("deviceId selects the incidents a screen is caught up in, and keeps the WHOLE roster", async () => {
  const rows = corpus();
  const data = (await get("/api/incidents?deviceId=d5", rows)).data();
  const incidents = data["incidents"] as Array<{
    roster: Array<{ deviceId: string }>; transitionCount: number; deviceCount: number;
  }>;
  assert.equal(incidents.length, 1);
  // d5 fired ONCE, in the five-device window. The row must still show all five
  // devices and all nine transitions — narrowing it to d5's single row would
  // turn a site event back into a device fault.
  assert.equal(incidents[0]!.deviceCount, 5);
  assert.equal(incidents[0]!.transitionCount, 9);
  assert.ok(incidents[0]!.roster.some((r) => r.deviceId === "d5"));
  assert.equal((data["totals"] as Record<string, number>)["transitions"], 9);
  assert.equal((data["filters"] as Record<string, unknown>)["deviceId"], "d5");
});

test("rule is pushed into SQL, and the totals still come from the rows returned", async () => {
  const rows = corpus();
  const res = await get("/api/incidents?rule=black-screen", rows);
  const listQuery = res.captured.find((c) => c.sql.includes("a.rule_id = $"));
  assert.ok(listQuery, "the rule filter must reach SQL, not be applied after the fact");
  assert.deepEqual(listQuery!.values, ["black-screen"]);
  const data = res.data();
  assert.equal((data["incidents"] as unknown[]).length, 1);
  assert.equal((data["totals"] as Record<string, number>)["transitions"], 1);
  assert.equal((data["corpus"] as Record<string, number>)["transitionsRead"], 1);
});

test("sinceDays narrows the transitions and SAYS that every count is window-scoped", async () => {
  const recent = row({
    device_id: "d1",
    opened_at: new Date(Date.now() - 3_600_000),
    last_fired_at: new Date(Date.now() - 3_600_000),
    resolved_at: null,
  });
  const res = await get("/api/incidents?sinceDays=1", [...corpus(), recent]);
  const data = res.data();
  const corpusBlock = data["corpus"] as Record<string, unknown>;
  assert.equal(corpusBlock["windowDays"], 1);
  assert.match(String(corpusBlock["windowNote"]), /describes that window/);
  assert.equal((data["totals"] as Record<string, number>)["transitions"], 1);
  assert.match(String((data["filters"] as Record<string, unknown>)["note"]), /narrows every count/);
});

// ── retirement, disclosed rather than silent ────────────────────────────────

test("retired devices' transitions are excluded AND counted, so the corpus reconciles", async () => {
  const rows = [
    ...corpus(),
    row({ device_id: "gone", device_name: "Retired screen", retired: true }),
    row({ device_id: "gone", device_name: "Retired screen", retired: true }),
  ];
  const data = (await get("/api/incidents", rows)).data();
  const corpusBlock = data["corpus"] as Record<string, unknown>;
  assert.equal(corpusBlock["transitionsRead"], 10);
  assert.equal(corpusBlock["transitionsInWindow"], 12);
  assert.equal(corpusBlock["transitionsExcludedRetired"], 2);
  assert.match(String(corpusBlock["retirementNote"]), /remain in the alerts table/);
  // Read + excluded = what the table holds. Neither number is an estimate.
  assert.equal(
    Number(corpusBlock["transitionsRead"]) + Number(corpusBlock["transitionsExcludedRetired"]),
    Number(corpusBlock["transitionsInWindow"]),
  );
});

// ── house contracts ─────────────────────────────────────────────────────────

test("an unknown parameter is a 400, not a silently unfiltered queue", async () => {
  const res = await get("/api/incidents?serverity=critical", corpus());
  assert.equal(res.status, 400);
  const body = res.json();
  assert.equal(body["error"], "unknown_parameter");
  assert.deepEqual(body["unknown"], ["serverity"]);
  assert.ok((body["accepted"] as string[]).includes("severity"));
});

test("a bad parameter value is a 400 with the field named", async () => {
  const res = await get("/api/incidents?sinceDays=0", corpus());
  assert.equal(res.status, 400);
  assert.equal(res.json()["error"], "bad_request");
});

test("limit=0 is a count with no rows, and says so", async () => {
  const res = await get("/api/incidents?limit=0", corpus());
  const body = res.json();
  const meta = body["meta"] as Record<string, unknown>;
  assert.equal((meta["page"] as Record<string, number>)["totalItems"], 2);
  assert.equal(meta["countOnly"], true);
  assert.match(String(meta["countNote"]), /limit=0/);
  assert.deepEqual(res.data()["incidents"], [], "no rows by request");
  // The totals are still the real totals — an empty list here is not "nothing
  // matched", and the disclosure above is what distinguishes the two.
  assert.equal((res.data()["totals"] as Record<string, number>)["transitions"], 10);
});

test("the ETag varies with every filter, and an unchanged queue answers 304", async () => {
  const rows = corpus();
  const { pool } = stubPool(rows);
  const app = await buildServer({
    pool, repo: stubRepo(), auth: { token: TOKEN, allowAnonymous: false },
  });
  const first = await app.inject({ method: "GET", url: "/api/incidents", headers: auth });
  const etag = String(first.headers["etag"]);
  const again = await app.inject({
    method: "GET", url: "/api/incidents",
    headers: { ...auth, "if-none-match": etag },
  });
  assert.equal(again.statusCode, 304);

  const tags = new Set<string>();
  for (const url of [
    "/api/incidents",
    "/api/incidents?state=open",
    "/api/incidents?severity=critical",
    "/api/incidents?rule=black-screen",
    "/api/incidents?deviceId=d1",
    "/api/incidents?sinceDays=7",
    "/api/incidents?limit=1",
    "/api/incidents?page=2",
  ]) {
    const res = await app.inject({ method: "GET", url, headers: auth });
    tags.add(String(res.headers["etag"]));
  }
  assert.equal(tags.size, 8, "every parameter must move the validator");
  await app.close();
});

test("the correlation cross-link is off by default and says why, never empty-and-silent", async () => {
  const data = (await get("/api/incidents", corpus())).data();
  const correlation = data["correlation"] as Record<string, unknown>;
  assert.equal(correlation["available"], false);
  assert.match(String(correlation["reason"]), /correlate=true/);
  const incidents = data["incidents"] as Array<{ correlationFindings: unknown[] }>;
  for (const incident of incidents) assert.deepEqual(incident.correlationFindings, []);
});

test("every incident publishes the drilldown that lists its own transitions", async () => {
  const data = (await get("/api/incidents", corpus())).data();
  const incidents = data["incidents"] as Array<{
    ruleId: string;
    drilldown: { ruleId: string; deviceIds: string[] };
    roster: Array<{ deviceId: string }>;
    occurrences: { windows: Array<{ transitionIds: string[] }> };
    transitionCount: number;
  }>;
  for (const incident of incidents) {
    assert.equal(incident.drilldown.ruleId, incident.ruleId);
    assert.deepEqual(
      [...incident.drilldown.deviceIds].sort(),
      incident.roster.map((r) => r.deviceId).sort(),
    );
    const ids = incident.occurrences.windows.flatMap((w) => w.transitionIds);
    assert.equal(ids.length, incident.transitionCount);
    assert.equal(new Set(ids).size, ids.length);
  }
});

test("an empty corpus is an empty queue with honest nulls, not a zeroed dashboard", async () => {
  const data = (await get("/api/incidents", [])).data();
  assert.deepEqual(data["incidents"], []);
  const totals = data["totals"] as Record<string, unknown>;
  assert.equal(totals["transitions"], 0);
  assert.equal(totals["collapsePercent"], null);
  assert.equal(totals["coFiringSharePercent"], null);
});

// ── BUG-10: our own outage must not be published as the estate's ────────────

/** The 23.6 h blind window from the real corpus, as the timeline query returns it. */
const BLIND_23H = [
  { prev: new Date("2026-08-25T18:33:24.465Z"), at: new Date("2026-08-26T18:06:52.734Z") },
  // The `prev: null` row: the earliest observation either table still holds.
  { prev: null, at: new Date("2026-08-25T18:14:29.428Z") },
];

/** The `Montreal Office` burst: six screens, six criticals, inside 2.3 ms. */
const montreal = (): Row[] =>
  ["m1", "m2", "m3", "m4", "m5", "m6"].map((deviceId, i) =>
    row({
      device_id: deviceId,
      device_name: `dev ${deviceId}`,
      group_id: "grp-montreal",
      group_name: "Montreal Office",
      rule_id: "offline-4h",
      severity: "critical",
      title: "Offline for 4h",
      opened_at: new Date(Date.parse("2026-08-26T18:06:57.579Z") + i * 0.4),
      last_fired_at: new Date(Date.parse("2026-08-26T18:06:57.579Z") + i * 0.4),
      resolved_at: null,
    }),
  );

/**
 * A repository whose run history is empty but READABLE.
 *
 * That separates the two failure modes this route has to keep apart: a
 * collector with no correlated outages (provenance checked, nothing found) and
 * a collector whose history could not be read at all (provenance not checked).
 * `stubRepo()` is the second — an object with no methods, so the health read
 * throws.
 */
const readableRepo = (gaps: Record<string, Array<{ startedAt: Date; endedAt: Date; seconds: number }>> = {}): Repository =>
  ({
    async pollerRunHistory() {
      return [];
    },
    async laneObservations() {
      return Object.entries(gaps).map(([lane, laneGaps]) => ({
        lane,
        source: "poller_runs",
        count: 2,
        firstAt: laneGaps[0]?.startedAt ?? null,
        lastAt: laneGaps[laneGaps.length - 1]?.endedAt ?? null,
        medianGapSeconds: laneGaps[0]?.seconds ?? null,
        gaps: laneGaps,
        gapsTruncated: false,
      }));
    },
  }) as unknown as Repository;

test("BUG-10: a resume burst is served as noticed-together, not as a site event", async () => {
  const rows = montreal();
  const res = await get("/api/incidents", rows, {}, { timeline: BLIND_23H, repo: readableRepo() });
  assert.equal(res.status, 200);
  const data = res.data();

  const totals = data["totals"] as Record<string, number>;
  assert.equal(totals["coFiringEvents"], 0, "six devices, but nothing that dates a failure");
  assert.equal(totals["noticedTogetherEvents"], 1);
  assert.equal(totals["noticedTogetherTransitions"], 6);

  const provenance = data["provenance"] as Record<string, unknown>;
  assert.equal(provenance["checked"], true);
  assert.equal(provenance["reason"], null);
  assert.equal(provenance["suppressedEvents"], 1);
  assert.equal(provenance["firstPassSeconds"], 450);
  assert.equal(
    (provenance["resumesBySource"] as Record<string, number>)["observation-gap"],
    1,
    "correlateOutages cannot see a single-observable-lane outage; the timeline can",
  );
  assert.equal(provenance["coversFrom"], "2026-08-25T18:14:29.428Z");

  // The alerts are untouched: same rows, same roster, same drilldown, and the
  // reconciliation invariant the console blanks itself over still holds.
  const incident = (data["incidents"] as Array<Record<string, unknown>>)[0]!;
  assert.equal(incident["transitionCount"], 6);
  assert.equal((incident["roster"] as unknown[]).length, 6);
  const window = (incident["occurrences"] as { windows: Array<Record<string, unknown>> }).windows[0]!;
  assert.equal(window["coFiring"], false);
  assert.equal(window["noticedTogether"], true);
  assert.equal((window["transitionIds"] as unknown[]).length, 6);
  assert.match(
    (window["provenance"] as { note: string }).note,
    /Noticed together, NOT failed together/,
  );
  assert.equal((data["reconciliation"] as Record<string, unknown>)["balanced"], true);
});

test("BUG-10: correlateOutages is wired — a two-lane outage resume suppresses the burst", async () => {
  // Two lanes silent together across the same window, stopping inside the
  // 120 s cluster tolerance: that is `correlateOutages`'s definition of one
  // process outage, and its `endedAt` is the resume.
  const stopped = new Date("2026-08-26T16:00:00.000Z");
  const resumed = new Date("2026-08-26T18:06:52.734Z");
  const seconds = (resumed.getTime() - stopped.getTime()) / 1000;
  const res = await get("/api/incidents", montreal(), {}, {
    // No timeline rows at all, so the ONLY resume can come from correlation.
    timeline: [],
    repo: readableRepo({
      status: [{ startedAt: stopped, endedAt: resumed, seconds }],
      snapshot: [{ startedAt: stopped, endedAt: resumed, seconds }],
    }),
  });
  const data = res.data();
  const provenance = data["provenance"] as Record<string, unknown>;
  assert.equal(
    (provenance["resumesBySource"] as Record<string, number>)["correlated-outage"],
    1,
  );
  assert.equal((data["totals"] as Record<string, number>)["coFiringEvents"], 0);
  assert.equal((data["totals"] as Record<string, number>)["noticedTogetherEvents"], 1);
});

test("BUG-10: an unreadable resume history is FALSE with a reason, never a clean bill", async () => {
  // `stubRepo()` has no methods, so the health read throws — the same shape as
  // a database that will not answer.
  const data = (await get("/api/incidents", montreal())).data();
  const provenance = data["provenance"] as Record<string, unknown>;
  assert.equal(provenance["checked"], false);
  assert.notEqual(provenance["reason"], null);
  assert.match(provenance["reason"] as string, /could not be read/);
  assert.equal(provenance["suppressedEvents"], 0);
  // Behaviour is unchanged when we did not look — and the payload says we did
  // not, rather than presenting the burst as a verified site condition.
  assert.equal((data["totals"] as Record<string, number>)["coFiringEvents"], 1);
});

test("BUG-10: provenance counts describe the FILTERED set, like every other total", async () => {
  const rows = [
    ...montreal(),
    // A genuine co-firing site event on another rule, well clear of the resume.
    ...coFiring("2026-08-30T09:00:00.000Z", ["d1", "d2", "d3"]),
  ];
  const all = (await get("/api/incidents", rows, {}, { timeline: BLIND_23H, repo: readableRepo() })).data();
  assert.equal((all["totals"] as Record<string, number>)["coFiringEvents"], 1, "the real one");
  assert.equal((all["totals"] as Record<string, number>)["noticedTogetherEvents"], 1);
  assert.equal((all["provenance"] as Record<string, number>)["suppressedEvents"], 1);

  // Filtered to the burst's rule alone, the suppression count still describes
  // exactly the rows on the page — the queue is rebuilt, not re-read.
  const only = (await get("/api/incidents?rule=offline-4h", rows, {}, {
    timeline: BLIND_23H, repo: readableRepo(),
  })).data();
  assert.equal((only["totals"] as Record<string, number>)["coFiringEvents"], 0);
  assert.equal((only["totals"] as Record<string, number>)["noticedTogetherEvents"], 1);
  assert.equal((only["provenance"] as Record<string, number>)["suppressedEvents"], 1);
  assert.equal((only["totals"] as Record<string, number>)["transitions"], 6);
});
