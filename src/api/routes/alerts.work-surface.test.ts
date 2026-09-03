/**
 * Work-surface ENDPOINT tests — Epic 8.2.
 *   `node --test dist/api/routes/alerts.work-surface.test.js`
 *
 * `alerting/suppression.test.ts` pins the classifier and `db/suppression-repo.test.ts`
 * pins the SQL. This file covers what neither can: the WIRING, and the validation
 * that stops a bad suppression being recorded in the first place.
 *
 * The route is where the guarantees are either kept or quietly lost:
 *
 *   - a reason and an expiry are MANDATORY. A route that defaulted the expiry to
 *     "none" would turn the feature into the mute-forever button the schema went
 *     to some trouble to forbid;
 *   - the two contradictions must be refused with a sentence, not a constraint
 *     name: `neverExpires` together with `expiresInDays`, and
 *     `includeCriticalHigh` on a whole-device scope;
 *   - the response must state the ACTUAL effect ("4 suppressed, 1 critical kept
 *     in the queue"), because an operator who believes they silenced a critical
 *     they did not is worse off than one who never tried;
 *   - acknowledge / un-acknowledge / note must all append to the append-only log
 *     with attribution, and the release must be as visible as the claim;
 *   - a suppression must NOT change what `/api/alerts` returns by default. 69
 *     alerts vanishing from an un-updated client is precisely the silent
 *     suppression this epic exists to prevent.
 *
 * Everything runs through `app.inject()` against a stubbed pool and repository.
 * No database, no control plane, no device is contacted.
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
const S1 = "aaaaaaaa-1111-1111-1111-111111111111";
const NOW = Date.now();
const DAY = 86_400_000;

interface OpenAlert {
  id: string; deviceId: string; ruleId: string; severity: Severity; openedAt: Date;
}

interface Opts {
  openAlerts?: OpenAlert[];
  suppressions?: SuppressionRow[];
  /** Rows `queries.alerts` should return for the list/detail path. */
  alertRows?: Array<Record<string, unknown>>;
  deviceExists?: boolean;
  acknowledgeResult?: boolean;
  unacknowledgeResult?: boolean;
  revokeResult?: boolean;
  alertScope?: { deviceId: string; open: boolean } | null;
}

/** Captures what the app wrote, so attribution can be asserted rather than assumed. */
interface Written {
  events: Array<{ alertId: string; kind: string; body: string | null; actor: string }>;
  created: Array<Record<string, unknown>>;
  revoked: Array<{ id: string; by: string; reason: string | null }>;
}

/**
 * A pool that APPLIES the two alert-id predicates rather than returning canned
 * rows for any SQL.
 *
 * It has to. "A filter that resolves to nothing matches nothing" is the property
 * under test, and a stub that ignores the WHERE clause would pass whether the
 * filter failed closed, failed open, or was never written. Only the two
 * predicates this file exercises are modelled; `queries.alerts.test.ts` owns the
 * full alias-resolving fake for the rest.
 */
function stubPool(opts: Opts): Pool {
  const idArray = (values: unknown[]): string[] | null => {
    const found = values.find((v) => Array.isArray(v));
    return Array.isArray(found) ? (found as string[]) : null;
  };
  const matching = (sql: string, values: unknown[]) => {
    let rows = opts.alertRows ?? [];
    const ids = idArray(values);
    if (ids === null) return rows;
    if (sql.includes("NOT (a.id = ANY(")) rows = rows.filter((r) => !ids.includes(r["id"] as string));
    else if (sql.includes("a.id = ANY(")) rows = rows.filter((r) => ids.includes(r["id"] as string));
    return rows;
  };
  return {
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes("MAX(observed_at)")) {
        return { rows: [{ newest: new Date(NOW - 60_000) }], rowCount: 1 };
      }
      if (sql.includes("FROM poller_runs")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM devices WHERE id")) {
        return { rows: opts.deviceExists === false ? [] : [{ "?column?": 1 }], rowCount: 1 };
      }
      if (sql.includes("COUNT(*)::text AS count FROM alerts")) {
        return { rows: [{ count: String(matching(sql, values).length) }], rowCount: 1 };
      }
      if (sql.includes("FROM alerts a")) {
        const rows = matching(sql, values);
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
}

function stubRepo(opts: Opts): { repo: Repository; written: Written } {
  const written: Written = { events: [], created: [], revoked: [] };
  const repo = {
    async openAlertFacts() { return opts.openAlerts ?? []; },
    async listSuppressions() { return opts.suppressions ?? []; },
    async alertScope() {
      return opts.alertScope === undefined ? { deviceId: "d1", open: true } : opts.alertScope;
    },
    async acknowledgeAlert() { return opts.acknowledgeResult ?? true; },
    async unacknowledgeAlert() { return opts.unacknowledgeResult ?? true; },
    async openAlertIdsForScope() { return (opts.openAlerts ?? []).map((a) => a.id); },
    async createSuppression(input: Record<string, unknown>) {
      written.created.push(input);
      return { id: S1, supersededId: null };
    },
    async revokeSuppression(id: string, by: string, reason: string | null) {
      written.revoked.push({ id, by, reason });
      return opts.revokeResult ?? true;
    },
    async appendAlertEvent(e: { alertId: string; kind: string; body?: string | null; actor: string }) {
      written.events.push({ alertId: e.alertId, kind: e.kind, body: e.body ?? null, actor: e.actor });
      return written.events.length;
    },
    async alertEvents() {
      return written.events.map((e, i) => ({
        id: i + 1, kind: e.kind as "note", body: e.body, suppressionId: null,
        actor: e.actor, actorIp: null, createdAt: new Date(NOW),
      }));
    },
    async loadRuleDefinitions() { return []; },
  } as unknown as Repository;
  return { repo, written };
}

async function build(opts: Opts = {}) {
  const { repo, written } = stubRepo(opts);
  const server = await buildServer({
    pool: stubPool(opts),
    repo,
    auth: { token: TOKEN, allowAnonymous: false },
  });
  return { server, written };
}

const suppression = (over: Partial<SuppressionRow> = {}): SuppressionRow => ({
  id: S1,
  deviceId: "d1",
  ruleId: null,
  reason: "lab unit, expected to be dark",
  intent: "lab",
  includeCriticalHigh: false,
  createdBy: "api:sam",
  createdAt: new Date(NOW - DAY),
  expiresAt: new Date(NOW + 29 * DAY),
  neverExpires: false,
  revokedAt: null,
  revokedBy: null,
  revokedReason: null,
  ...over,
});

const alertRow = (over: Partial<Record<string, unknown>> = {}) => ({
  id: A1, device_id: "d1", device_name: "Lab TCL", location: null,
  rule_id: "firmware-behind", severity: "info", title: "Firmware behind",
  evidence: "x", opened_at: new Date(NOW - 10 * DAY), last_fired_at: new Date(NOW),
  acknowledged_at: null, acknowledged_by: null, resolved_at: null, videri_alert_uuid: null,
  note_count: "0", last_note_at: null, sup_id: null,
  ...over,
});

const openAlert = (over: Partial<OpenAlert> = {}): OpenAlert => ({
  id: A1, deviceId: "d1", ruleId: "firmware-behind", severity: "info",
  openedAt: new Date(NOW - 10 * DAY), ...over,
});

// ─── auth ────────────────────────────────────────────────────────────────────

test("every work-surface route is credentialled like the rest of the API", async () => {
  const { server } = await build();
  for (const [method, url] of [
    ["GET", "/api/alerts/suppressions"],
    ["POST", "/api/alerts/suppressions"],
    ["POST", `/api/alerts/suppressions/${S1}/revoke`],
    ["GET", `/api/alerts/${A1}`],
    ["POST", `/api/alerts/${A1}/unacknowledge`],
    ["POST", `/api/alerts/${A1}/notes`],
  ] as const) {
    const res = await server.inject({ method, url });
    assert.equal(res.statusCode, 401, `${method} ${url} must require a token`);
  }
});

// ─── GET /api/alerts/suppressions — the band ────────────────────────────────

test("the band reconciles, states its policy, and publishes its alert ids", async () => {
  const { server } = await build({
    openAlerts: [
      openAlert({ id: A1 }),
      openAlert({ id: A2, severity: "critical", ruleId: "black-screen" }),
    ],
    suppressions: [suppression()],
  });
  const body = (await server.inject({
    method: "GET", url: "/api/alerts/suppressions", headers: auth,
  })).json();

  const data = body.data;
  // The sum invariant, on the wire.
  assert.equal(data.totalOpen, 2);
  assert.equal(data.incidents.total + data.suppressed.total, data.totalOpen);
  // The critical was held back by a whole-device suppression, and said so.
  assert.deepEqual(data.suppressed.alertIds, [A1]);
  assert.deepEqual(data.suppressed.heldBackAlertIds, [A2]);
  // The policy travels with the payload so a client renders the rule rather than
  // hard-coding its own copy of it.
  assert.equal(data.policy.defaultExpiryDays, 30);
  assert.equal(data.policy.maxExpiryDays, 365);
  assert.deepEqual(data.policy.neverAbsorbedSeverities, ["critical", "high"]);
  assert.ok(data.policy.intentKinds.includes("none"));
  // Freshness, like every other endpoint: a banding computed from stale data is
  // a different claim from a live one.
  assert.ok(body.meta.freshness);
  assert.ok(Array.isArray(data.notes) && data.notes.length > 0);
});

// ─── POST /api/alerts/suppressions — validation ─────────────────────────────

test("a reason is mandatory, and a token gesture is not a reason", async () => {
  const { server } = await build();
  for (const reason of [undefined, "", "x", "lab", "  lab  "]) {
    const res = await server.inject({
      method: "POST", url: "/api/alerts/suppressions", headers: auth,
      payload: { deviceId: "d1", ...(reason === undefined ? {} : { reason }) },
    });
    assert.equal(res.statusCode, 400, `reason ${JSON.stringify(reason)} must be refused`);
    assert.match(res.json().message, /reason/);
  }
});

test("omitting the expiry gets 30 days, NOT forever", async () => {
  const { server, written } = await build();
  const res = await server.inject({
    method: "POST", url: "/api/alerts/suppressions", headers: auth,
    payload: { deviceId: "d1", reason: "lab unit, expected to be dark", by: "sam" },
  });
  assert.equal(res.statusCode, 201);
  const created = written.created[0]!;
  assert.equal(created["neverExpires"], false);
  // The whole point: an unset expiry can never become a permanent mute.
  const expiresAt = created["expiresAt"] as Date;
  assert.ok(expiresAt instanceof Date);
  const days = Math.round((expiresAt.getTime() - NOW) / DAY);
  assert.equal(days, 30);
  assert.equal(res.json().data.neverExpires, false);
});

test("a permanent suppression must be asked for in as many words", async () => {
  const { server, written } = await build();
  const res = await server.inject({
    method: "POST", url: "/api/alerts/suppressions", headers: auth,
    payload: {
      deviceId: "d1", reason: "asset physically scrapped in August", neverExpires: true,
      intent: "eol", by: "sam",
    },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(written.created[0]!["neverExpires"], true);
  assert.equal(written.created[0]!["expiresAt"], null);
  assert.equal(res.json().data.expiresAt, null);
});

test("neverExpires and expiresInDays contradict each other and are refused", async () => {
  const { server } = await build();
  const res = await server.inject({
    method: "POST", url: "/api/alerts/suppressions", headers: auth,
    payload: {
      deviceId: "d1", reason: "asset physically scrapped in August",
      neverExpires: true, expiresInDays: 30,
    },
  });
  assert.equal(res.statusCode, 400);
  // A sentence, not a constraint name.
  assert.match(res.json().message, /Pick one/);
});

test("a finite expiry is capped — a five-year mute is `forever` in disguise", async () => {
  const { server } = await build();
  for (const expiresInDays of [0, -1, 366, 5000]) {
    const res = await server.inject({
      method: "POST", url: "/api/alerts/suppressions", headers: auth,
      payload: { deviceId: "d1", reason: "lab unit, expected to be dark", expiresInDays },
    });
    assert.equal(res.statusCode, 400, `${expiresInDays} days must be refused`);
  }
  const ok = await server.inject({
    method: "POST", url: "/api/alerts/suppressions", headers: auth,
    payload: { deviceId: "d1", reason: "lab unit, expected to be dark", expiresInDays: 365 },
  });
  assert.equal(ok.statusCode, 201);
});

test("critical/high cannot be blanket-suppressed, and the refusal explains why", async () => {
  const { server } = await build();
  const res = await server.inject({
    method: "POST", url: "/api/alerts/suppressions", headers: auth,
    payload: {
      deviceId: "d1", reason: "lab unit, expected to be dark", includeCriticalHigh: true,
      // No ruleId — this is the blanket case.
    },
  });
  assert.equal(res.statusCode, 400);
  const message = res.json().message;
  assert.match(message, /requires a ruleId/);
  // The reasoning is in the error, because the person hitting it is the person
  // who needs to understand it.
  assert.match(message, /the device spoke/);
});

test("critical/high suppression IS allowed once the rule is named", async () => {
  const { server, written } = await build();
  const res = await server.inject({
    method: "POST", url: "/api/alerts/suppressions", headers: auth,
    payload: {
      deviceId: "d1", ruleId: "offline-30d", reason: "asset scrapped; the outage is permanent",
      includeCriticalHigh: true, intent: "eol", neverExpires: true,
    },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(written.created[0]!["includeCriticalHigh"], true);
  assert.equal(written.created[0]!["ruleId"], "offline-30d");
  assert.equal(res.json().data.scope, "rule");
});

test("an unknown intent value is refused rather than stored as free text", async () => {
  const { server } = await build();
  const res = await server.inject({
    method: "POST", url: "/api/alerts/suppressions", headers: auth,
    payload: { deviceId: "d1", reason: "lab unit, expected to be dark", intent: "probably-fine" },
  });
  assert.equal(res.statusCode, 400);
});

test("a suppression on an unknown device is refused — no orphan mutes", async () => {
  const { server } = await build({ deviceExists: false });
  const res = await server.inject({
    method: "POST", url: "/api/alerts/suppressions", headers: auth,
    payload: { deviceId: "ghost", reason: "lab unit, expected to be dark" },
  });
  assert.equal(res.statusCode, 404);
  assert.match(res.json().message, /No device/);
});

// ─── POST /api/alerts/suppressions — the honest effect report ───────────────

test("the response states the ACTUAL effect, including what was held back", async () => {
  // Two alerts on the device: one info (suppressible) and one critical (not, on a
  // whole-device scope). The operator must learn that at the moment they act.
  const { server, written } = await build({
    openAlerts: [openAlert({ id: A1 }), openAlert({ id: A2, severity: "critical" })],
    suppressions: [suppression()],
  });
  const res = await server.inject({
    method: "POST", url: "/api/alerts/suppressions", headers: auth,
    payload: { deviceId: "d1", reason: "lab unit, expected to be dark", intent: "lab", by: "sam" },
  });
  assert.equal(res.statusCode, 201);
  const data = res.json().data;
  assert.equal(data.alertsSuppressed, 1);
  assert.equal(data.alertsHeldBack, 1, "the critical must be reported as kept in the queue");
  assert.equal(data.bands.totalOpen, 2);
  assert.equal(data.bands.incidents + data.bands.suppressed, data.bands.totalOpen);

  // Every covered alert gains a lifecycle event, so a tech reading ONE alert can
  // see why it went quiet without knowing a fleet-level record exists.
  assert.equal(written.events.filter((e) => e.kind === "suppress").length, 2);
  assert.equal(written.events[0]?.actor, "api:sam");
  assert.match(written.events[0]!.body!, /lab unit/);
});

test("attribution falls back to the audit resolver when no `by` is given", async () => {
  const { server, written } = await build({ openAlerts: [openAlert()] });
  await server.inject({
    method: "POST", url: "/api/alerts/suppressions",
    headers: { ...auth, "x-vfi-actor": "jo" },
    payload: { deviceId: "d1", reason: "lab unit, expected to be dark" },
  });
  assert.equal(written.created[0]!["createdBy"], "api:jo");

  const plain = await build({ openAlerts: [openAlert()] });
  await plain.server.inject({
    method: "POST", url: "/api/alerts/suppressions", headers: auth,
    payload: { deviceId: "d1", reason: "lab unit, expected to be dark" },
  });
  // Never a fabricated identity: a caller holding the token and naming nobody is
  // recorded as exactly that.
  assert.equal(plain.written.created[0]!["createdBy"], "api:token");
});

// ─── revoke ──────────────────────────────────────────────────────────────────

test("revoking returns the alerts, counts them, and never deletes the record", async () => {
  const { server, written } = await build({
    openAlerts: [openAlert({ id: A1 }), openAlert({ id: A2 })],
    suppressions: [suppression()],
  });
  const res = await server.inject({
    method: "POST", url: `/api/alerts/suppressions/${S1}/revoke`, headers: auth,
    payload: { reason: "unit went back into production service", by: "jo" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.alertsReturned, 2);
  assert.equal(written.revoked[0]?.by, "api:jo");
  assert.match(written.revoked[0]!.reason!, /back into production service/);
  // The un-suppression is on each alert's own record too.
  assert.equal(written.events.filter((e) => e.kind === "unsuppress").length, 2);
});

test("a second revoke is a 409 that names the original revoker", async () => {
  const { server } = await build({
    suppressions: [suppression({
      revokedAt: new Date(NOW - DAY), revokedBy: "api:jo", revokedReason: "back in service",
    })],
    revokeResult: false,
  });
  const res = await server.inject({
    method: "POST", url: `/api/alerts/suppressions/${S1}/revoke`, headers: auth,
    payload: { by: "sam" },
  });
  assert.equal(res.statusCode, 409);
  // Who un-muted it FIRST, and why, is the fact the record exists to keep — a
  // second click must not overwrite it.
  assert.match(res.json().message, /api:jo/);
  assert.match(res.json().message, /kept as-is/);
});

test("revoking an unknown suppression is a 404, and a malformed id a 400", async () => {
  const { server } = await build({ suppressions: [] });
  assert.equal(
    (await server.inject({
      method: "POST", url: `/api/alerts/suppressions/${S1}/revoke`, headers: auth, payload: {},
    })).statusCode,
    404,
  );
  assert.equal(
    (await server.inject({
      method: "POST", url: "/api/alerts/suppressions/not-a-uuid/revoke", headers: auth, payload: {},
    })).statusCode,
    400,
  );
});

// ─── acknowledge / un-acknowledge / notes ───────────────────────────────────

test("acknowledging appends an attributed lifecycle event, and an optional note", async () => {
  const { server, written } = await build();
  const res = await server.inject({
    method: "POST", url: `/api/alerts/${A1}/acknowledge`, headers: auth,
    payload: { by: "sam", note: "on site Thursday" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.eventsAppended, 2);
  // An absolute timestamp, so the console can render "claimed 12 min ago" from a
  // clock rather than inventing a relative string server-side.
  assert.ok(Date.parse(res.json().data.acknowledgedAt) > 0);
  assert.deepEqual(written.events.map((e) => e.kind), ["acknowledge", "note"]);
  assert.equal(written.events[1]?.body, "on site Thursday");
  assert.ok(written.events.every((e) => e.actor === "api:sam"));
});

test("a duplicate acknowledge is a 409 that points at the release path", async () => {
  const { server } = await build({ acknowledgeResult: false });
  const res = await server.inject({
    method: "POST", url: `/api/alerts/${A1}/acknowledge`, headers: auth, payload: { by: "sam" },
  });
  assert.equal(res.statusCode, 409);
  // A tech who clicked the wrong row needs to be told how to hand it back.
  assert.match(res.json().message, /unacknowledge/);
});

test("un-acknowledging releases the alert and records WHO released it", async () => {
  const { server, written } = await build();
  const res = await server.inject({
    method: "POST", url: `/api/alerts/${A1}/unacknowledge`, headers: auth,
    payload: { by: "jo", reason: "claimed the wrong row" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.acknowledgedBy, null);
  assert.equal(res.json().data.releasedBy, "api:jo");
  // The release must be as visible as the claim was — an alert that quietly
  // became unowned is how a shared queue loses work.
  assert.deepEqual(written.events, [
    { alertId: A1, kind: "unacknowledge", body: "claimed the wrong row", actor: "api:jo" },
  ]);
});

test("releasing an unclaimed alert is a 409, not a silent success", async () => {
  const { server, written } = await build({ unacknowledgeResult: false });
  const res = await server.inject({
    method: "POST", url: `/api/alerts/${A1}/unacknowledge`, headers: auth, payload: {},
  });
  assert.equal(res.statusCode, 409);
  // And nothing was logged: the log must never claim an event that did not happen.
  assert.deepEqual(written.events, []);
});

test("notes are append-only: no edit and no delete route exists", async () => {
  const { server } = await build();
  for (const method of ["PATCH", "PUT", "DELETE"] as const) {
    const res = await server.inject({ method, url: `/api/alerts/${A1}/notes`, headers: auth });
    // An editable note destroys the audit value of the thing it records.
    assert.ok(res.statusCode === 404 || res.statusCode === 405, `${method} must not be routable`);
  }
});

test("a note is attributed, and a blank one is refused", async () => {
  const { server, written } = await build();
  const ok = await server.inject({
    method: "POST", url: `/api/alerts/${A1}/notes`, headers: auth,
    payload: { body: "found the PSU unplugged behind the panel", by: "sam" },
  });
  assert.equal(ok.statusCode, 201);
  assert.equal(written.events[0]?.kind, "note");
  assert.equal(written.events[0]?.actor, "api:sam");

  for (const body of [undefined, "", "   "]) {
    const res = await server.inject({
      method: "POST", url: `/api/alerts/${A1}/notes`, headers: auth,
      payload: body === undefined ? {} : { body },
    });
    assert.equal(res.statusCode, 400, "a blank note is not a note");
  }
});

test("a note on a RESOLVED alert is allowed on purpose", async () => {
  // "This came back twice, it is the switch not the panel" is written after the
  // fact, and refusing it would push the one durable piece of knowledge into a
  // chat message.
  const { server } = await build({ alertScope: { deviceId: "d1", open: false } });
  const res = await server.inject({
    method: "POST", url: `/api/alerts/${A1}/notes`, headers: auth,
    payload: { body: "third time this month; suspect the switch port" },
  });
  assert.equal(res.statusCode, 201);
});

test("a note on a non-existent alert is a 404, and a malformed id a 400", async () => {
  const { server } = await build({ alertScope: null });
  assert.equal(
    (await server.inject({
      method: "POST", url: `/api/alerts/${A1}/notes`, headers: auth, payload: { body: "hello there" },
    })).statusCode,
    404,
  );
  assert.equal(
    (await server.inject({
      method: "POST", url: "/api/alerts/nope/notes", headers: auth, payload: { body: "hello there" },
    })).statusCode,
    400,
  );
});

// ─── GET /api/alerts/:id — the drawer ───────────────────────────────────────

test("the detail view carries the full note history and the band verdict", async () => {
  const { server } = await build({
    alertRows: [alertRow()],
    openAlerts: [openAlert()],
    suppressions: [suppression()],
  });
  // Two notes first, so the history has something in it.
  for (const body of ["first finding", "second finding"]) {
    await server.inject({
      method: "POST", url: `/api/alerts/${A1}/notes`, headers: auth, payload: { body, by: "sam" },
    });
  }
  const body = (await server.inject({
    method: "GET", url: `/api/alerts/${A1}`, headers: auth,
  })).json();

  assert.equal(body.data.id, A1);
  assert.equal(body.data.noteCount, 2);
  assert.equal(body.data.events.length, 2);
  assert.equal(body.data.events[0].actor, "api:sam");
  assert.ok(Date.parse(body.data.events[0].createdAt) > 0);
  // The band verdict rides along, so the drawer and the row cannot disagree.
  assert.equal(body.data.suppressed, true);
  assert.equal(body.data.suppressionHeldBack, false);
  assert.ok(body.meta.freshness);
});

// ─── the list: nothing disappears by default ────────────────────────────────

test("a suppression does NOT change what /api/alerts returns by default", async () => {
  // The single most important regression guard in this file. If the default band
  // ever became `incident`, 69 alerts would vanish from every client that had not
  // been updated — the silent suppression this epic exists to prevent.
  const { server } = await build({
    alertRows: [alertRow()],
    openAlerts: [openAlert()],
    suppressions: [suppression()],
  });
  const body = (await server.inject({ method: "GET", url: "/api/alerts", headers: auth })).json();
  assert.equal(body.data.length, 1);
  assert.equal(body.meta.page.totalItems, 1);
  // ...but each row now says which band it is in, so an updated client can move
  // it out deliberately.
  assert.equal(body.data[0].suppressed, true);
  assert.equal(body.data[0].suppressionHeldBack, false);
});

test("a covering suppression plus a held-back critical is rendered as the tension it is", async () => {
  const { server } = await build({
    alertRows: [alertRow({ id: A2, severity: "critical", sup_id: S1, sup_rule_id: null,
      sup_reason: "lab unit, expected to be dark", sup_intent: "lab",
      sup_include_critical_high: false, sup_created_by: "api:sam",
      sup_created_at: new Date(NOW - DAY), sup_expires_at: new Date(NOW + 29 * DAY),
      sup_never_expires: false })],
    openAlerts: [openAlert({ id: A2, severity: "critical" })],
    suppressions: [suppression()],
  });
  const body = (await server.inject({ method: "GET", url: "/api/alerts", headers: auth })).json();
  const row = body.data[0];
  // A record covers it...
  assert.equal(row.suppression.id, S1);
  assert.equal(row.suppression.scope, "device");
  assert.match(row.suppression.reason, /lab unit/);
  // ...and it came through anyway. Both facts, on the same row, on purpose: this
  // is the one case where "I muted this, why am I still seeing it" has a good
  // answer.
  assert.equal(row.suppressed, false);
  assert.equal(row.suppressionHeldBack, true);
});

test("band=suppressed and band=incident are complements, and an empty band is empty", async () => {
  const opts: Opts = {
    alertRows: [alertRow()],
    openAlerts: [openAlert({ id: A1 }), openAlert({ id: A2, severity: "critical" })],
    suppressions: [suppression()],
  };
  const { server } = await build(opts);
  assert.equal(
    (await server.inject({ method: "GET", url: "/api/alerts?band=suppressed", headers: auth }))
      .statusCode,
    200,
  );
  assert.equal(
    (await server.inject({ method: "GET", url: "/api/alerts?band=incident", headers: auth }))
      .statusCode,
    200,
  );

  // With nothing suppressed, `band=suppressed` must return NOTHING — not the
  // whole queue. This filter fails closed; the exclusion fails open.
  const clean = await build({ alertRows: [alertRow()], openAlerts: [openAlert()], suppressions: [] });
  const res = (await clean.server.inject({
    method: "GET", url: "/api/alerts?band=suppressed", headers: auth,
  })).json();
  assert.equal(res.data.length, 0);
});

test("acknowledged alerts are filterable but never hidden by default", async () => {
  const { server } = await build({ alertRows: [alertRow()], openAlerts: [openAlert()] });
  for (const query of ["", "?acknowledged=all", "?acknowledged=yes", "?acknowledged=no"]) {
    const res = await server.inject({ method: "GET", url: `/api/alerts${query}`, headers: auth });
    assert.equal(res.statusCode, 200, `acknowledged filter ${query} must be accepted`);
  }
  assert.equal(
    (await server.inject({ method: "GET", url: "/api/alerts?acknowledged=maybe", headers: auth }))
      .statusCode,
    400,
  );
});

test("a garbled alertIds filter returns an empty page rather than the whole queue", async () => {
  const { server } = await build({ alertRows: [alertRow()], openAlerts: [openAlert()] });
  const res = await server.inject({
    method: "GET", url: "/api/alerts?alertIds=not-a-uuid,also-bad", headers: auth,
  });
  // Fails CLOSED. A filter whose job is to narrow must never widen when it is
  // misused, and non-uuid entries are dropped rather than 500ing the `uuid[]` cast.
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.length, 0);
});
