/**
 * Read API tests — `node --test dist/api/api.test.js`
 *
 * Driven through `app.inject()`, so no port is bound and nothing is flaky. The
 * pool is a stub that pattern-matches SQL, which is enough to assert the
 * contract: auth, envelope shape, pagination, validation, and — most
 * importantly — that an unreadable metric arrives at the client as `null` and
 * never as zero.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { Repository } from "../db/repository.js";
import { buildServer } from "./server.js";
import { resolveAuth, tokenMatches, extractBearer } from "./auth.js";
import { decideCaptureThrottle } from "./routes/screenshots.js";

const TOKEN = "test-token-at-least-16-chars";

interface StubOptions {
  hasSnapshot?: boolean;
  newestSampleMinutesAgo?: number | null;
  metricsYield?: number | null;
  deviceRows?: Array<Record<string, unknown>>;
  deviceCount?: number;
  alertRows?: Array<Record<string, unknown>>;
  acknowledgeResult?: boolean;
  /** Adds a data-usage run with 250 failed batches, this many days ago. */
  dataUsageFailedDaysAgo?: number;
  /** When set, a fake Videri client whose sync_command replies come from this. */
  videriScript?: (arg: string) => { response_code: string; message?: string };
  /** A device row for the detail/command queries; enables device lookups. */
  device?: Record<string, unknown> | null;
  /** Rows returned by the remediation query (queries.remediationDevices). */
  remediationRows?: Array<Record<string, unknown>>;
  /** Rows returned by the bounded screen-state query (queries.popScreenState). */
  popScreenRows?: Array<Record<string, unknown>>;
  /** Total eligible devices for proof-of-play, if larger than the returned batch. */
  popEligibleTotal?: number;
  /** Per-canvas schedule for proof-of-play; throwing simulates an unreadable schedule. */
  popEvents?: (canvasId: string) => unknown;
}

function stubPool(opts: StubOptions = {}): Pool {
  const {
    hasSnapshot = true,
    newestSampleMinutesAgo = 1,
    metricsYield = 0.9,
    deviceRows = [],
    deviceCount = 0,
    alertRows = [],
  } = opts;

  return {
    async query(sql: string) {
      if (/^SELECT 1/.test(sql)) return { rows: [{ "?column?": 1 }], rowCount: 1 };

      if (sql.includes("MAX(observed_at)")) {
        return {
          rows: [{
            newest: newestSampleMinutesAgo === null
              ? null
              : new Date(Date.now() - newestSampleMinutesAgo * 60_000),
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("time_bucket")) {
        return {
          rows: [{
            bucket: new Date("2026-08-27T12:00:00Z"),
            samples: "31", presence_samples: "28", online_samples: "28",
            cpu_percent: null, ram_percent: null, temperature_c: null,
            wifi_signal_dbm: null, ntp_sync_percent: null, packet_loss_percent: null,
            playback_quality: "unavailable", ping_quality: "no",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM poller_runs")) {
        const rows: Array<Record<string, unknown>> = [{
          poller: "metrics",
          started_at: new Date(Date.now() - 60_000),
          duration_ms: 4200,
          batches_failed: 0,
          telemetry_yield: metricsYield,
        }];
        if (opts.dataUsageFailedDaysAgo !== undefined) {
          rows.push({
            poller: "data-usage",
            started_at: new Date(Date.now() - opts.dataUsageFailedDaysAgo * 86_400_000),
            duration_ms: 5661,
            batches_failed: 250,
            telemetry_yield: null,
          });
        }
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("FROM fleet_snapshots")) {
        return hasSnapshot
          ? {
              rows: [{
                computed_at: new Date(),
                snapshot: { totalDevices: 1247, telemetryCoverage: 0.61 },
              }],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 };
      }
      // Proof-of-play bounded screen-state (queries.popScreenState) — both its
      // count and rows queries carry the `hs.observed_at IS NOT NULL` eligibility
      // filter, which no other query uses. Must precede the generic device
      // count/list branches below, which would otherwise swallow them.
      if (sql.includes("hs.observed_at IS NOT NULL") && sql.includes("COUNT(*)::text AS count")) {
        return {
          rows: [{ count: String(opts.popEligibleTotal ?? opts.popScreenRows?.length ?? 0) }],
          rowCount: 1,
        };
      }
      if (sql.includes("hs.observed_at IS NOT NULL")) {
        const rows = opts.popScreenRows ?? [];
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("COUNT(*)::text AS count") && sql.includes("FROM devices")) {
        return { rows: [{ count: String(deviceCount) }], rowCount: 1 };
      }
      // Single-device detail lookup (queries.device) — MUST precede the generic
      // "FROM devices d" list branch below. Distinguished from the LIST query by
      // the detail-only ride-along columns (serial_no, vendor), which the list
      // query does not select.
      if (sql.includes("d.serial_no, d.vendor")) {
        // Prefer an explicit `device`; otherwise fall back to the first list row,
        // so tests that only set `deviceRows` still resolve a device on detail.
        if (opts.device !== undefined) {
          return opts.device ? { rows: [opts.device], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        return { rows: deviceRows.slice(0, 1), rowCount: Math.min(1, deviceRows.length) };
      }
      // Remediation assembly — distinguished by the brightness settings lateral,
      // which no other "FROM devices d" query selects. Must precede the generic
      // device-list branch below.
      if (sql.includes("st.settings ->> 'brightness'")) {
        const rows = opts.remediationRows ?? [];
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("FROM devices d")) {
        return { rows: deviceRows, rowCount: deviceRows.length };
      }
      if (sql.includes("COUNT(*)::text AS count") && sql.includes("FROM alerts")) {
        return { rows: [{ count: String(alertRows.length) }], rowCount: 1 };
      }
      if (sql.includes("FROM alerts a")) {
        return { rows: alertRows, rowCount: alertRows.length };
      }
      if (sql.includes("alert_rule_definitions")) {
        return {
          rows: [{
            id: "black-screen",
            definition: { kind: "state", severity: "critical", field: "is_black_screen" },
            enabled: true,
            updated_at: new Date(),
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM briefs")) return { rows: [], rowCount: 0 };
      // time_bucket must be checked BEFORE the FILTER branch: the device-health
      // query contains both `FROM health_samples` and `FILTER`, so matching on
      // FILTER first would hand it the availability row and it would 500.
      if (sql.includes("time_bucket")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM health_samples") && sql.includes("FILTER")) {
        return {
          rows: [{ total: "100", cpu_percent: "0", ram_percent: "0", temperature_c: "0",
                   wifi_signal_dbm: "0", ntp_sync_percent: "0", storage_percent: "0",
                   playback_quality: "95" }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
}

const stubRepo = (opts: StubOptions = {}): Repository =>
  ({
    async acknowledgeAlert() { return opts.acknowledgeResult ?? true; },
    // A device is addressable iff a device row was supplied.
    async commandTarget() {
      return opts.device
        ? { deviceId: "SER123", deviceJid: "d@x", playerId: "p1" }
        : null;
    },
    // Capturable iff a device row was supplied — mirrors the real method, which
    // returns null when the device has no JID (unroutable) or no serial (no CDN
    // key). The route turns that null into a 409.
    async evidenceCaptureTarget() {
      return opts.device
        ? { id: "d1", deviceId: "SER123", deviceJid: "d@x", playerId: "p1", serialNo: "SER123" }
        : null;
    },
    async markScreenshotRequested() { return 0; },
  }) as unknown as Repository;

/**
 * A fake Videri client. Routes the publisher per-canvas events read (Epic 3)
 * through `popEvents`, and sync_command through `videriScript`. Kept as one fake
 * so a test can exercise both control-plane paths at once.
 */
function fakeVideri(opts: StubOptions) {
  return {
    async request(
      _service: string,
      path: string,
      reqOpts?: { body?: { command_params?: { arg?: string } } },
    ) {
      const events = /\/canvases\/([^/]+)\/events\//.exec(path ?? "");
      if (events) {
        // Callers throw to simulate an unreadable schedule; propagate it.
        return opts.popEvents ? opts.popEvents(decodeURIComponent(events[1]!)) : [];
      }
      const arg = reqOpts?.body?.command_params?.arg ?? "";
      return opts.videriScript ? opts.videriScript(arg) : { response_code: "ok" };
    },
  } as unknown as import("../videri/http.js").VideriHttp;
}

const build = (opts: StubOptions = {}, allowAnonymous = false) =>
  buildServer({
    pool: stubPool(opts),
    repo: stubRepo(opts),
    auth: allowAnonymous ? { token: null, allowAnonymous: true } : { token: TOKEN, allowAnonymous: false },
    ...(opts.videriScript || opts.popEvents ? { videri: fakeVideri(opts) } : {}),
  });

const auth = { authorization: `Bearer ${TOKEN}` };

const deviceRow = (over: Record<string, unknown> = {}) => ({
  id: "canvas-1", name: "Lobby North", location: "New York, NY",
  device_class: "canvas", model_type: "V4", status: "online",
  last_online_time: new Date("2026-08-25T11:59:00Z"),
  firmware_current: "3.3.8", firmware_latest: "3.4.1",
  observed_at: new Date("2026-08-25T11:59:00Z"),
  presence: "online", is_screen_on: true, is_black_screen: false, showing_logo: false,
  cpu_percent: null, ram_percent: null, temperature_c: null, wifi_signal_dbm: null,
  critical: "0", high: "1", medium: "0", info: "1", total: "2",
  ...over,
});

// ─── auth ───────────────────────────────────────────────────────────────────

test("rejects a request with no token", async () => {
  const app = await build();
  const res = await app.inject({ method: "GET", url: "/api/devices" });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "unauthorized");
  await app.close();
});

test("rejects a wrong token", async () => {
  const app = await build();
  const res = await app.inject({
    method: "GET", url: "/api/devices",
    headers: { authorization: "Bearer wrong-token-also-long-enough" },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test("accepts a correct token", async () => {
  const app = await build({ deviceRows: [deviceRow()], deviceCount: 1 });
  const res = await app.inject({ method: "GET", url: "/api/devices", headers: auth });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test("liveness is reachable without auth, but data endpoints are not", async () => {
  const app = await build();
  // Container probes must not need a credential.
  assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/alerts" })).statusCode, 401);
  await app.close();
});

test("resolveAuth refuses to start without a usable token", () => {
  assert.throws(() => resolveAuth(undefined, false), /VFI_API_TOKEN/);
  assert.throws(() => resolveAuth("short", false), /at least 16/);
  // Anonymous must be explicit — never a fallback.
  assert.deepEqual(resolveAuth(undefined, true), { token: null, allowAnonymous: true });
});

test("token comparison handles length mismatch without throwing", () => {
  // timingSafeEqual throws on unequal lengths; a naive implementation would 500
  // on every short token instead of returning 401.
  assert.equal(tokenMatches("short", TOKEN), false);
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(extractBearer("Bearer abc"), "abc");
  assert.equal(extractBearer("bearer  abc  "), "abc");
  assert.equal(extractBearer(undefined), null);
  assert.equal(extractBearer("Basic abc"), null);
});

// ─── envelope and freshness ─────────────────────────────────────────────────

test("every response carries a freshness envelope", async () => {
  const app = await build({ deviceRows: [deviceRow()], deviceCount: 1 });
  const body = (await app.inject({ method: "GET", url: "/api/devices", headers: auth })).json();

  assert.ok(body.meta.freshness, "freshness is missing");
  assert.equal(body.meta.freshness.state, "fresh");
  assert.ok(typeof body.meta.freshness.ageSeconds === "number");
  await app.close();
});

test("stale data is labelled stale and warned about", async () => {
  const app = await build({ newestSampleMinutesAgo: 45, deviceRows: [], deviceCount: 0 });
  const body = (await app.inject({ method: "GET", url: "/api/devices", headers: auth })).json();

  assert.equal(body.meta.freshness.state, "stale");
  assert.ok(body.meta.freshness.warnings.some((w: string) => w.includes("historical")));
  await app.close();
});

test("zero telemetry yield produces an explicit warning, not silence", async () => {
  const app = await build({ metricsYield: 0, deviceRows: [], deviceCount: 0 });
  const body = (await app.inject({ method: "GET", url: "/api/devices", headers: auth })).json();

  // The UI must be able to say "the bulk feed carries no telemetry" — and point
  // to the per-device on-demand read — rather than showing a healthy-looking
  // fleet with silently empty metric tiles.
  assert.ok(
    body.meta.freshness.warnings.some(
      (w: string) => w.includes("carries no hardware telemetry") && w.includes("per-device on demand"),
    ),
    JSON.stringify(body.meta.freshness.warnings),
  );
  await app.close();
});

test("no data at all is reported as unknown freshness", async () => {
  const app = await build({ newestSampleMinutesAgo: null, deviceRows: [], deviceCount: 0 });
  const body = (await app.inject({ method: "GET", url: "/api/devices", headers: auth })).json();
  assert.equal(body.meta.freshness.state, "unknown");
  await app.close();
});

// ─── the null invariant ─────────────────────────────────────────────────────

test("an unreadable metric reaches the client as null, never zero", async () => {
  const app = await build({ deviceRows: [deviceRow()], deviceCount: 1 });
  const body = (await app.inject({ method: "GET", url: "/api/devices", headers: auth })).json();

  const device = body.data[0];
  assert.equal(device.latest.cpuPercent, null);
  assert.notEqual(device.latest.cpuPercent, 0);
  assert.equal(device.latest.temperatureC, null);
  // A readable boolean still comes through as a boolean.
  assert.equal(device.latest.isBlackScreen, false);
  await app.close();
});

test("numeric strings from pg are coerced to numbers", async () => {
  const app = await build({
    deviceRows: [deviceRow({ cpu_percent: "42.5", temperature_c: "61" })],
    deviceCount: 1,
  });
  const device = (await app.inject({ method: "GET", url: "/api/devices", headers: auth })).json().data[0];

  // pg returns numeric/decimal as strings; a string would silently break every
  // comparison and chart downstream.
  assert.equal(device.latest.cpuPercent, 42.5);
  assert.equal(typeof device.latest.cpuPercent, "number");
  assert.equal(device.latest.temperatureC, 61);
  await app.close();
});

test("firmwareBehind is derived, not trusted from the client", async () => {
  const app = await build({ deviceRows: [deviceRow()], deviceCount: 1 });
  const device = (await app.inject({ method: "GET", url: "/api/devices", headers: auth })).json().data[0];
  assert.equal(device.firmwareBehind, true);
  await app.close();
});

// ─── pagination and validation ──────────────────────────────────────────────

test("pagination metadata is correct", async () => {
  const app = await build({ deviceRows: [deviceRow()], deviceCount: 137 });
  const body = (await app.inject({
    method: "GET", url: "/api/devices?page=2&limit=50", headers: auth,
  })).json();

  assert.deepEqual(body.meta.page, { page: 2, limit: 50, totalItems: 137, totalPages: 3 });
  await app.close();
});

test("an over-large limit is rejected rather than silently clamped", async () => {
  const app = await build();
  const res = await app.inject({ method: "GET", url: "/api/devices?limit=100000", headers: auth });
  // Silently clamping hides a client bug; a 400 surfaces it.
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /limit/);
  await app.close();
});

test("an unknown status value is rejected", async () => {
  const app = await build();
  const res = await app.inject({ method: "GET", url: "/api/devices?status=exploded", headers: auth });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test("an unknown trend metric is rejected", async () => {
  const app = await build();
  const res = await app.inject({
    method: "GET", url: "/api/fleet/trends?metric=drop%20table", headers: auth,
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

// ─── fleet ──────────────────────────────────────────────────────────────────

test("fleet summary is served from the pre-computed snapshot", async () => {
  const app = await build();
  const body = (await app.inject({ method: "GET", url: "/api/fleet/summary", headers: auth })).json();
  assert.equal(body.data.snapshot.totalDevices, 1247);
  await app.close();
});

test("a missing snapshot is a 503, not a fleet of zero devices", async () => {
  const app = await build({ hasSnapshot: false });
  const res = await app.inject({ method: "GET", url: "/api/fleet/summary", headers: auth });

  // Returning empty numbers here would read as "you have no devices", which is
  // a different and much worse claim than "we have not computed this yet".
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, "no_snapshot");
  await app.close();
});

test("a missing brief is a 404 with guidance", async () => {
  const app = await build();
  const res = await app.inject({ method: "GET", url: "/api/fleet/brief", headers: auth });
  assert.equal(res.statusCode, 404);
  assert.match(res.json().message, /npm run brief/);
  await app.close();
});

// ─── devices ────────────────────────────────────────────────────────────────

test("an unknown device is a 404", async () => {
  const app = await build({ deviceRows: [] });
  const res = await app.inject({ method: "GET", url: "/api/devices/nope", headers: auth });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("device health reports per-metric availability", async () => {
  const app = await build({ deviceRows: [deviceRow()] });
  const body = (await app.inject({
    method: "GET", url: "/api/devices/canvas-1/health", headers: auth,
  })).json();

  // The UI needs this to grey out a tile instead of drawing a flat line at zero.
  assert.ok(body.data.availability);
  assert.equal(body.data.availability["cpu_percent"], false);
  await app.close();
});

// ─── alerts ─────────────────────────────────────────────────────────────────

test("alerts list returns the expected shape", async () => {
  const app = await build({
    alertRows: [{
      id: "11111111-1111-4111-8111-111111111111", device_id: "canvas-1",
      device_name: "Lobby North", location: "New York, NY", rule_id: "black-screen",
      severity: "critical", title: "Screen is black",
      evidence: "Screen is black continuously for 19 minutes across 20 readings.",
      opened_at: new Date(), last_fired_at: new Date(),
      acknowledged_at: null, acknowledged_by: null, resolved_at: null,
      videri_alert_uuid: null,
    }],
  });
  const body = (await app.inject({ method: "GET", url: "/api/alerts", headers: auth })).json();

  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].severity, "critical");
  assert.match(body.data[0].evidence, /19 minutes/);
  await app.close();
});

test("acknowledging requires a `by` field", async () => {
  const app = await build();
  const res = await app.inject({
    method: "POST", url: "/api/alerts/11111111-1111-4111-8111-111111111111/acknowledge",
    headers: auth, payload: {},
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test("a malformed alert id is a 400, not a database error", async () => {
  const app = await build();
  const res = await app.inject({
    method: "POST", url: "/api/alerts/not-a-uuid/acknowledge",
    headers: auth, payload: { by: "stephen" },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /Malformed/);
  await app.close();
});

test("acknowledging succeeds", async () => {
  const app = await build({ acknowledgeResult: true });
  const res = await app.inject({
    method: "POST", url: "/api/alerts/11111111-1111-4111-8111-111111111111/acknowledge",
    headers: auth, payload: { by: "stephen.jenkins@videri.com" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.acknowledgedBy, "stephen.jenkins@videri.com");
  await app.close();
});

test("acknowledging something already handled is a 409", async () => {
  const app = await build({ acknowledgeResult: false });
  const res = await app.inject({
    method: "POST", url: "/api/alerts/11111111-1111-4111-8111-111111111111/acknowledge",
    headers: auth, payload: { by: "stephen" },
  });
  assert.equal(res.statusCode, 409);
  await app.close();
});

test("rules are served from the database, not from DEFAULT_RULES", async () => {
  const app = await build();
  const body = (await app.inject({ method: "GET", url: "/api/alerts/rules", headers: auth })).json();
  assert.equal(body.data[0].id, "black-screen");
  assert.equal(body.data[0].enabled, true);
  await app.close();
});

// ─── system ─────────────────────────────────────────────────────────────────

test("readiness fails when there is no data, even though the process is healthy", async () => {
  const app = await build({ newestSampleMinutesAgo: null });
  const res = await app.inject({ method: "GET", url: "/health/ready" });

  // Liveness and readiness are different questions: a healthy process with an
  // empty database should not receive dashboard traffic.
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().status, "no_data");
  assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);
  await app.close();
});

test("pipeline status exposes telemetry availability", async () => {
  const app = await build();
  const body = (await app.inject({ method: "GET", url: "/api/pipeline/status", headers: auth })).json();

  assert.ok(body.data.telemetryAvailability);
  assert.deepEqual(body.data.telemetryAvailability["cpu_percent"], { readable: 0, total: 100 });
  assert.deepEqual(body.data.telemetryAvailability["playback_quality"], { readable: 95, total: 100 });
  await app.close();
});

test("an unknown endpoint is a clean 404", async () => {
  const app = await build();
  const res = await app.inject({ method: "GET", url: "/api/nonsense", headers: auth });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, "not_found");
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// The console shell, and the contract it depends on
//
// Every check here maps to a bug that actually shipped into the browser and was
// only caught by opening the page. Static typing cannot see any of them: the UI
// is plain HTML served as a string, so these are the guard rails it gets.
// ─────────────────────────────────────────────────────────────────────────────

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const consoleSource = async (): Promise<string> => {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFile(join(here, "..", "..", "public", "console.html"), "utf8");
};

test("the console is served, and without a token", async () => {
  // The shell holds no fleet data. Gating it would only stop the browser from
  // rendering the prompt that collects the token.
  const app = await build();
  for (const url of ["/", "/console.html"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 200, `${url} should serve without auth`);
    assert.match(res.headers["content-type"] as string, /text\/html/);
    assert.match(res.body, /Fleet Intelligence/);
  }
});

test("the console declares no identifier that collides with a browser global", async () => {
  // `function top()` is valid Node and a hard SyntaxError in a browser, because
  // window.top is read-only. It killed the entire script with no network
  // activity and no console line until the page was actually loaded.
  const src = await consoleSource();
  // Only the globals that genuinely throw. Verified empirically in a browser by
  // appending `const <g> = 1;` as a top-level classic script: `top`, `window`,
  // `document` and `location` are non-configurable and raise SyntaxError;
  // `self`, `parent`, `name`, `status`, `length`, `origin`, `closed` and `frames`
  // are writable and shadow harmlessly.
  //
  // The first version of this list included all twelve and produced a false
  // positive on a perfectly legal `const name` inside a function. A guard that
  // cries wolf gets deleted, so it is narrowed to what actually breaks.
  const readOnlyGlobals = ["top", "window", "document", "location"];
  for (const g of readOnlyGlobals) {
    const decl = new RegExp(`\\b(?:function|const|let|var|class)\\s+${g}\\b`);
    assert.ok(!decl.test(src), `console.html declares "${g}", which shadows a read-only browser global`);
  }
});

test("every endpoint the console calls is a route the server registers", async () => {
  // Guards the typo class: a wrong path renders an empty panel rather than an
  // error, so it can sit unnoticed indefinitely.
  const src = await consoleSource();
  const app = await build();
  const called = new Set<string>();
  for (const m of src.matchAll(/\bapi(?:All)?\(\s*"(\/api\/[^"?]*)"/g)) called.add(m[1]!);
  // Template-literal paths: normalise the interpolation to a concrete id.
  for (const m of src.matchAll(/\bapi\(\s*"(\/api\/[^"]*?)"\s*\+/g)) called.add(m[1]! + "x");

  assert.ok(called.size >= 6, `expected the console to call several endpoints, found ${called.size}`);
  const isCatchAll = (r: { statusCode: number; json: () => unknown }): boolean =>
    r.statusCode === 404 && (r.json() as { message?: string }).message === "No such endpoint.";
  for (const path of called) {
    const url = path.replace(/\/$/, "");
    // A 404 from a real route means "no such device" and is fine; a 404 from the
    // catch-all means the path is not routed at all. Some endpoints are POST-only
    // (the capture sweep), which GET reports as a catch-all — so before failing,
    // confirm the path is genuinely absent under POST too.
    let res = await app.inject({ method: "GET", url, headers: auth });
    if (isCatchAll(res)) {
      res = await app.inject({ method: "POST", url, headers: auth });
      assert.ok(
        !isCatchAll(res),
        `console calls ${url}, which the server does not route (GET or POST)`,
      );
    }
  }
});

test("paginated envelopes expose meta.page.totalPages, which the console walks", async () => {
  // The console paginates on meta.page.totalPages. It originally read
  // meta.pagination — which is undefined, so it stopped after one request and
  // silently truncated a 283-alert fleet at the API's 200-row cap. The wrong
  // number looked entirely plausible on screen.
  const app = await build({ deviceRows: [deviceRow()], deviceCount: 283 });
  const body = (await app.inject({ method: "GET", url: "/api/devices?limit=200", headers: auth })).json();
  assert.ok(body.meta, "envelope must carry meta");
  assert.ok(body.meta.page, "envelope must carry meta.page (NOT meta.pagination)");
  assert.equal(typeof body.meta.page.totalPages, "number");
  assert.equal(typeof body.meta.page.totalItems, "number");
  assert.ok(body.meta.page.totalPages >= 2, "283 items at limit 200 must report more than one page");
});

test("every response the console renders carries freshness", async () => {
  // The console's loudest element is the staleness banner. If any endpoint it
  // reads omits freshness, that panel silently claims the data is current.
  const app = await build({ newestSampleMinutesAgo: 90 });
  for (const url of ["/api/fleet/summary", "/api/alerts", "/api/devices", "/api/compliance"]) {
    const body = (await app.inject({ method: "GET", url, headers: auth })).json();
    assert.ok(body.meta && body.meta.freshness, `${url} must carry meta.freshness`);
    assert.ok(typeof body.meta.freshness.state === "string", `${url} freshness needs a state`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Codebase-audit fixes (2026-08-27)
// ─────────────────────────────────────────────────────────────────────────────

test("PATCH rule rejects a definition whose id differs from the URL", async () => {
  // The engine unions rules by the id INSIDE the stored JSON. A mismatched
  // PATCH corrupts two rules at once: the body lands in row A but loads as rule
  // B, while A silently reverts to its default. Nothing errors; both are wrong.
  const app = await build();
  const res = await app.inject({
    method: "PATCH",
    url: "/api/alerts/rules/offline-4h",
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      definition: {
        kind: "offline", id: "black-screen", name: "x", enabled: true,
        severity: "critical", forSeconds: 3600, clearForSeconds: 120,
      },
    },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "id_mismatch");
});

test("a failed batch on a run older than 24h does not warn", async () => {
  // The disabled data-usage poller's one manual run (250 known-403 failures)
  // resurfaced as "on its last run" for days — a stale fact about a dormant
  // poller presented as a current fault.
  const app = await build({ dataUsageFailedDaysAgo: 3 });
  const body = (await app.inject({ method: "GET", url: "/api/fleet/summary", headers: auth })).json();
  const warnings: string[] = body.meta.freshness.warnings;
  assert.ok(
    !warnings.some((w) => w.includes("data-usage")),
    `a 3-day-old failure must not warn as current: ${JSON.stringify(warnings)}`,
  );
});

test("a failed batch on a RECENT run still warns, with its age", async () => {
  const app = await build({ dataUsageFailedDaysAgo: 0.001 }); // ~86 seconds ago
  const body = (await app.inject({ method: "GET", url: "/api/fleet/summary", headers: auth })).json();
  const warnings: string[] = body.meta.freshness.warnings;
  const w = warnings.find((x) => x.includes("data-usage"));
  assert.ok(w, "a recent failure must still surface");
  assert.match(w!, /just now|\d+ min ago/, "the warning must carry the run's age");
});

test("device health separates presence readings from total samples", async () => {
  // Metrics rows carry no presence field. Dividing online rows by ALL rows made
  // a fully-online hour render as ~70% online (amber) in the presence timeline.
  // The endpoint must expose the presence-carrying denominator separately.
  const app = await build({ deviceRows: [deviceRow()] });
  const res = await app.inject({
    method: "GET", url: "/api/devices/canvas-1/health", headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const point = res.json().data.points[0];
  assert.equal(point.samples, 31);
  assert.equal(point.presenceSamples, 28, "presence-only denominator must be exposed");
  assert.equal(point.onlineSamples, 28);
  // Categorical strings ride along as strings — never averaged, never numbers.
  assert.equal(point.ping_quality, "no");
  assert.equal(point.playback_quality, null, '"unavailable" is the platform null');
});

test("every element the console wires up actually exists in its markup", async () => {
  // Renaming the ⌘K button to a header search field left a listener bound to a
  // dead id. One TypeError at parse time and the whole console rendered empty
  // widgets — no error surfaced in the UI, it just looked like no data.
  const src = await consoleSource();
  const scriptAt = src.lastIndexOf("<script>");
  const markup = src.slice(0, scriptAt);
  const script = src.slice(scriptAt);
  const declared = new Set<string>();
  for (const m of markup.matchAll(/id="([A-Za-z0-9_-]+)"/g)) declared.add(m[1]!);
  // ids injected by template literals count as declared
  for (const m of script.matchAll(/id="([A-Za-z0-9_-]+)"/g)) declared.add(m[1]!);
  const missing: string[] = [];
  for (const m of script.matchAll(/\$\("#([A-Za-z0-9_-]+)"\)/g)) {
    if (!declared.has(m[1]!)) missing.push(m[1]!);
  }
  assert.deepEqual(missing, [], `console references ids that do not exist: ${missing.join(", ")}`);
});

test("every nav tab has a matching section", async () => {
  const src = await consoleSource();
  const tabs = [...src.matchAll(/data-v="([a-z]+)"/g)].map((m) => m[1]!);
  assert.ok(tabs.length >= 5, `expected several tabs, found ${tabs.length}`);
  for (const v of new Set(tabs)) {
    assert.ok(src.includes(`id="v-${v}"`), `tab "${v}" has no <section id="v-${v}">`);
  }
});

test("the console styles use no hardcoded colors outside the token blocks", async () => {
  // Dark mode shipped broken because styles added during live wiring carried 129
  // hex literals that bypassed the palette. Tokens are defined in :root blocks;
  // everything after them must reference var(--…).
  const src = await consoleSource();
  const lastToken = src.lastIndexOf('--sh-2:0 1px 3px rgba(0,0,0,.4);');
  const after = src.slice(lastToken);
  const styleEnd = after.lastIndexOf("</style>");
  const styles = after.slice(0, styleEnd);
  // Strip CSS comments first: they contain HTML entities like &#8212; whose
  // digits look exactly like hex colors to a naive matcher.
  const code = styles.replace(/\/\*[\s\S]*?\*\//g, "");
  // #fff on a colored fill is an intentional, theme-independent knob.
  const literals = [...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)]
    .map((m) => m[0]).filter((c) => !/^#f{3,6}$/i.test(c));
  assert.deepEqual(literals, [], `hardcoded colors outside tokens: ${literals.join(", ")}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Brightness endpoint — preflight/verify/rollback wiring
// (the decision logic itself is exhaustively covered in videri/brightness.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

const brightDevice = (over: Record<string, unknown> = {}) => ({
  id: "d1", name: "Test V4", location: null, device_class: "canvas", model_type: null,
  city: null, last_online_time: new Date(), firmware_current: "7.0", firmware_latest: "7.0",
  status: "online", observed_at: new Date(), presence: "online",
  serial_no: "SER123",
  ...over,
});

test("brightness endpoint is 503 when the server has no Videri client", async () => {
  const app = await build({ device: brightDevice() });
  const res = await app.inject({
    method: "POST", url: "/api/devices/d1/brightness",
    headers: { ...auth, "content-type": "application/json" },
    payload: { brightnessPercent: 60, confirm: true },
  });
  assert.equal(res.statusCode, 503);
});

test("brightness endpoint requires confirm:true", async () => {
  const app = await build({ device: brightDevice(), videriScript: () => ({ response_code: "SUCCESS" }) });
  const res = await app.inject({
    method: "POST", url: "/api/devices/d1/brightness",
    headers: { ...auth, "content-type": "application/json" },
    payload: { brightnessPercent: 60 },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "confirmation_required");
});

test("brightness endpoint rejects an out-of-range percent", async () => {
  const app = await build({ device: brightDevice(), videriScript: () => ({ response_code: "SUCCESS" }) });
  const res = await app.inject({
    method: "POST", url: "/api/devices/d1/brightness",
    headers: { ...auth, "content-type": "application/json" },
    payload: { brightnessPercent: 140, confirm: true },
  });
  assert.equal(res.statusCode, 400);
});

test("brightness endpoint reports verified (200) when the device takes the write", async () => {
  // Fake device: get_brightness reflects the last set value.
  let current = 50;
  const app = await build({
    device: brightDevice(),
    videriScript: (arg) => {
      if (arg === "get_brightness") {
        return { response_code: "SUCCESS", message: `Current brightness is: ${current}` };
      }
      const m = /set_brightness:=(\d+)/.exec(arg);
      if (m) { current = Number(m[1]); return { response_code: "SUCCESS", message: "ok" }; }
      return { response_code: "ERROR" };
    },
  });
  const res = await app.inject({
    method: "POST", url: "/api/devices/d1/brightness",
    headers: { ...auth, "content-type": "application/json" },
    payload: { brightnessPercent: 80, confirm: true },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.state, "verified");
  assert.equal(res.json().data.applied, true);
});

test("brightness endpoint reports rollback (502) when the device ignores the write", async () => {
  // Accepts set_brightness but never changes its reported value → verify fails,
  // rollback to the original succeeds → 502, applied:false, device left safe.
  const app = await build({
    device: brightDevice(),
    videriScript: (arg) =>
      arg === "get_brightness"
        ? { response_code: "SUCCESS", message: "Current brightness is: 50" }
        : { response_code: "SUCCESS", message: "ok" },
  });
  const res = await app.inject({
    method: "POST", url: "/api/devices/d1/brightness",
    headers: { ...auth, "content-type": "application/json" },
    payload: { brightnessPercent: 80, confirm: true },
  });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().data.state, "unconfirmed_rolled_back");
  assert.equal(res.json().data.applied, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// On-demand screenshot capture (Phase 3) — per-device throttle + capture route
// ─────────────────────────────────────────────────────────────────────────────

test("decideCaptureThrottle allows a device never asked, and one past the window", () => {
  const now = 1_000_000;
  // Never asked before.
  assert.deepEqual(decideCaptureThrottle(undefined, now, 25_000), { allowed: true, retryAfterMs: 0 });
  // Asked exactly the interval ago — the window has elapsed.
  assert.deepEqual(decideCaptureThrottle(now - 25_000, now, 25_000), { allowed: true, retryAfterMs: 0 });
  // Asked longer ago.
  assert.deepEqual(decideCaptureThrottle(now - 60_000, now, 25_000), { allowed: true, retryAfterMs: 0 });
});

test("decideCaptureThrottle blocks a device asked within the window, with the remaining wait", () => {
  const now = 1_000_000;
  const d = decideCaptureThrottle(now - 5_000, now, 25_000);
  assert.equal(d.allowed, false);
  // The client is told exactly how long to wait — not just refused.
  assert.equal(d.retryAfterMs, 20_000);
});

test("capture endpoint is 503 when the server has no Videri client", async () => {
  const app = await build({ device: brightDevice() });
  const res = await app.inject({
    method: "POST", url: "/api/devices/d1/screenshot/capture", headers: auth,
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, "capture_unavailable");
  await app.close();
});

test("capture accepts once, then rate-limits an immediate second call per device", async () => {
  const app = await build({
    // Use a fresh device id so the module-level per-device cursor is clean for
    // this test regardless of order.
    device: brightDevice({ id: "cap-throttle-1" }),
    videriScript: () => ({ response_code: "SUCCESS" }),
  });
  const first = await app.inject({
    method: "POST", url: "/api/devices/cap-throttle-1/screenshot/capture", headers: auth,
  });
  assert.equal(first.statusCode, 200);
  // One target, accepted by the stubbed device.
  assert.equal(first.json().data.accepted, 1);
  // The fresh-frame age rides along so the client needs no second round-trip.
  assert.ok("meta" in first.json().data, "response must carry the fresh meta");

  const second = await app.inject({
    method: "POST", url: "/api/devices/cap-throttle-1/screenshot/capture", headers: auth,
  });
  assert.equal(second.statusCode, 429);
  assert.equal(second.json().error, "capturing_too_fast");
  assert.ok(second.json().retryAfterMs > 0, "429 must tell the client how long to wait");
  await app.close();
});

test("capture is a clean 4xx (not 500) when the device cannot be captured", async () => {
  // No device row → evidenceCaptureTarget resolves null. The device also does
  // not resolve, so the route 404s rather than 500-ing on a missing target.
  const app = await build({ videriScript: () => ({ response_code: "SUCCESS" }) });
  const res = await app.inject({
    method: "POST", url: "/api/devices/ghost/screenshot/capture", headers: auth,
  });
  assert.equal(res.statusCode, 404);
  assert.ok(res.statusCode < 500, "an uncapturable device is the client's problem, not a server error");
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// Remediation endpoint (Epic 1) — the recommendation surface's contract.
// (The rule logic itself is exhaustively covered in intelligence/remediation.test.ts.)
// ─────────────────────────────────────────────────────────────────────────────

const remediationRow = (over: Record<string, unknown> = {}) => ({
  id: "rem-1", name: "Lobby North", city: "New York",
  firmware_current: "7.0", firmware_latest: "7.0", status: "online",
  last_online_time: new Date("2026-08-31T12:00:00Z"),
  is_black_screen: false, showing_logo: false, now_playing_id: "c1",
  telemetry_observed_at: null, cpu_percent: null, ram_used_percent: null,
  storage_used_percent: null, rssi_dbm: null, ntp_offset_ms: null,
  brightness_raw: null, drift: [],
  ...over,
});

test("remediation endpoint returns a ranked list, a summary, and freshness", async () => {
  const app = await build({
    remediationRows: [
      remediationRow({ id: "d-off", brightness_raw: "0" }), // auto-safe / high
      remediationRow({
        id: "d-stor", telemetry_observed_at: new Date("2026-08-31T12:00:00Z"),
        storage_used_percent: "95",
      }), // manual / medium
    ],
  });
  const res = await app.inject({ method: "GET", url: "/api/remediation", headers: auth });
  assert.equal(res.statusCode, 200);
  const body = res.json();

  // Envelope + freshness, like every other endpoint.
  assert.ok(body.meta.freshness, "must carry freshness");
  // Ranked: the high-severity auto-safe restore comes before the medium storage one.
  assert.equal(body.data.recommendations[0].severity, "high");
  assert.equal(body.data.recommendations[0].kind, "auto-safe");
  assert.equal(body.data.recommendations[1].severity, "medium");
  // Summary counts.
  assert.equal(body.data.summary.total, 2);
  assert.equal(body.data.summary.byKind["auto-safe"], 1);
  assert.equal(body.data.summary.byKind.manual, 1);
  assert.equal(body.data.devicesConsidered, 2);
  await app.close();
});

test("remediation coerces pg numeric strings and honours honest nulls", async () => {
  const app = await build({
    // brightness_raw arrives from pg as the text "0"; it must be read as 0, not
    // dropped as a truthy string. A device with all-null telemetry yields nothing.
    remediationRows: [
      remediationRow({ id: "d-off", brightness_raw: "0" }),
      remediationRow({ id: "d-null" }), // all null → no recommendations
    ],
  });
  const body = (await app.inject({ method: "GET", url: "/api/remediation", headers: auth })).json();
  const forNull = body.data.recommendations.filter((r: { deviceIds: string[] }) =>
    r.deviceIds.includes("d-null"),
  );
  assert.equal(forNull.length, 0, "an all-null device must yield nothing");
  assert.ok(
    body.data.recommendations.some((r: { id: string }) => r.id === "d-off::display-off"),
    "the string \"0\" brightness must be read as display-off",
  );
  await app.close();
});

test("remediation on an empty fleet is an empty list, not an error", async () => {
  const app = await build({ remediationRows: [] });
  const res = await app.inject({ method: "GET", url: "/api/remediation", headers: auth });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.data.recommendations, []);
  assert.equal(body.data.summary.total, 0);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// Correlation endpoint (Epic 2). Reuses the SAME remediation assembly, so the
// stub's `remediationRows` drives it. The rule logic itself is covered
// exhaustively in intelligence/correlation.test.ts; here we only prove the
// endpoint wires the query to the engine, carries freshness, and stays honest on
// degenerate data (a real query would 500 if the engine touched a field the
// DeviceView does not carry).
// ─────────────────────────────────────────────────────────────────────────────

test("correlation endpoint returns findings, notes, freshness on real DeviceView fields", async () => {
  // A tight temporal drop of 3 co-located devices across distinct sites — a
  // real finding — plus enough distinct locations to keep it non-degenerate.
  const off = (id: string, city: string, at: string) =>
    remediationRow({ id, city, status: "offline", last_online_time: new Date(at) });
  const app = await build({
    remediationRows: [
      off("d1", "Boston", "2026-08-31T11:50:00Z"),
      off("d2", "Chicago", "2026-08-31T11:52:00Z"),
      off("d3", "Denver", "2026-08-31T11:54:00Z"),
      remediationRow({ id: "d4", city: "Miami", status: "online" }),
    ],
  });
  const res = await app.inject({ method: "GET", url: "/api/correlation", headers: auth });
  assert.equal(res.statusCode, 200, "endpoint must not 500 on real DeviceView fields");
  const body = res.json();
  assert.ok(body.meta.freshness, "must carry freshness");
  assert.equal(body.data.devicesConsidered, 4);
  assert.ok(Array.isArray(body.data.findings));
  assert.ok(Array.isArray(body.data.notes));
  await app.close();
});

test("correlation endpoint on an empty fleet is an empty report, not an error", async () => {
  const app = await build({ remediationRows: [] });
  const res = await app.inject({ method: "GET", url: "/api/correlation", headers: auth });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.data.findings, []);
  assert.equal(body.data.devicesConsidered, 0);
  await app.close();
});

test("correlation endpoint emits the honest degenerate-location note, not a bogus venue cluster", async () => {
  // All-LONDON, all offline — the degenerate placeholder location this tenant
  // actually has. The engine must refuse to invent one giant venue.
  const rows = Array.from({ length: 8 }, (_, i) =>
    remediationRow({ id: `L${i}`, city: "LONDON", status: "offline",
      last_online_time: new Date("2026-08-31T11:59:00Z") }),
  );
  const app = await build({ remediationRows: rows });
  const body = (await app.inject({ method: "GET", url: "/api/correlation", headers: auth })).json();
  assert.ok(
    body.data.notes.some((n: { kind: string }) => n.kind === "location-degenerate"),
    "expected the honest degenerate-location note",
  );
  assert.equal(
    body.data.findings.find((f: { kind: string }) => f.kind === "venue"),
    undefined,
    "no venue cluster from degenerate location data",
  );
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// Proof-of-play endpoint (Epic 3). Screen-state comes from the bounded
// popScreenState query; the per-canvas schedule comes from the fake Videri
// client's popEvents. The window/gap logic itself is covered exhaustively in
// intelligence/proof-of-play.test.ts; here we prove the endpoint wires the
// query + publisher fan-out to the engine, carries freshness, reports the batch
// honestly, and never fabricates a gap from a missing screen-state (a real query
// would 500 if the route touched a field the row does not carry).
// ─────────────────────────────────────────────────────────────────────────────

const popScreenRow = (over: Record<string, unknown> = {}) => ({
  id: "canvas-1", name: "Lobby North",
  is_screen_on: true, is_black_screen: false, showing_logo: false,
  observed_at: new Date("2026-08-31T12:00:00Z"),
  ...over,
});

/** An always-on event, the shape publisher v1 returns for the demo tenant. */
const alwaysOnEvent = { assetUuid: "a1", assetType: "image", durationMs: 10000,
  startTime: null, endTime: null, priority: 1, frequency: "loop" };

test("proof-of-play joins schedule with screen-state and flags gaps, with freshness", async () => {
  const app = await build({
    popScreenRows: [
      popScreenRow({ id: "healthy" }),
      popScreenRow({ id: "black", is_black_screen: true }),
      popScreenRow({ id: "logo", showing_logo: true }),
    ],
    popEvents: () => [alwaysOnEvent],
  });
  const res = await app.inject({ method: "GET", url: "/api/proof-of-play", headers: auth });
  assert.equal(res.statusCode, 200, "endpoint must not 500 on real popScreenState fields");
  const body = res.json();

  assert.ok(body.meta.freshness, "must carry freshness");
  assert.ok(body.data.basis.includes("Scheduled, not confirmed"), "must carry the honesty basis");
  assert.equal(body.data.controlPlane, true);
  assert.equal(body.data.summary.devicesWithSchedule, 3);
  assert.equal(body.data.summary.gaps, 2);
  assert.equal(body.data.summary.byReason["screen black"], 1);
  assert.equal(body.data.summary.byReason["screen logo"], 1);
  assert.equal(body.data.batch.considered, 3);
  assert.equal(body.data.batch.truncated, false);
  await app.close();
});

test("proof-of-play never fabricates a gap from an unread screen-state", async () => {
  const app = await build({
    popScreenRows: [
      popScreenRow({ id: "unknown", is_screen_on: null, is_black_screen: null, showing_logo: null }),
    ],
    popEvents: () => [alwaysOnEvent],
  });
  const body = (await app.inject({ method: "GET", url: "/api/proof-of-play", headers: auth })).json();
  assert.equal(body.data.summary.gaps, 0, "an unread panel is never a gap");
  assert.equal(body.data.summary.screenStateUnknown, 1);
  assert.equal(body.data.devices[0].gap, false);
  await app.close();
});

test("proof-of-play reports batch truncation honestly, never silently drops the tail", async () => {
  const app = await build({
    popScreenRows: [popScreenRow({ id: "c1" })],
    popEligibleTotal: 500, // far more eligible than the returned batch
    popEvents: () => [alwaysOnEvent],
  });
  const body = (await app.inject({ method: "GET", url: "/api/proof-of-play", headers: auth })).json();
  assert.equal(body.data.batch.eligibleDevices, 500);
  assert.equal(body.data.batch.considered, 1);
  assert.equal(body.data.batch.truncated, true);
  await app.close();
});

test("proof-of-play counts an unreadable schedule, never as a gap", async () => {
  const app = await build({
    popScreenRows: [popScreenRow({ id: "black", is_black_screen: true })],
    popEvents: () => { throw new Error("publisher 500"); },
  });
  const body = (await app.inject({ method: "GET", url: "/api/proof-of-play", headers: auth })).json();
  // Schedule unreadable → the device has no known schedule, so no gap despite the
  // black screen, and the unreadable count is surfaced rather than hidden.
  assert.equal(body.data.batch.schedulesUnreadable, 1);
  assert.equal(body.data.summary.devicesWithSchedule, 0);
  assert.equal(body.data.summary.gaps, 0);
  await app.close();
});

test("proof-of-play without a control plane is an honest empty report, not a 500", async () => {
  const app = await build({ popScreenRows: [popScreenRow()] }); // no popEvents → no videri
  const res = await app.inject({ method: "GET", url: "/api/proof-of-play", headers: auth });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.data.controlPlane, false);
  assert.ok(body.data.note.includes("credentials"), "must say why schedules are unread");
  assert.deepEqual(body.data.devices, []);
  await app.close();
});
