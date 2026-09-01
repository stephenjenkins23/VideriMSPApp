/**
 * `GET /api/devices/:id/network` endpoint tests —
 *   `node --test dist/api/routes/network.test.js`
 *
 * The parser logic is covered exhaustively in videri/network.test.ts. This file
 * covers what only the route can get wrong:
 *
 *   1. sending the three READ verbs and nothing else — a network endpoint that
 *      ever emitted `set_ethernet_settings` could strand a panel;
 *   2. staying OFF the telemetry hot path (it must not fire meminfo & friends);
 *   3. reporting an unreadable field as null with the verb missing from `read`,
 *      instead of a zero;
 *   4. the gates: no credentials, unknown device, unaddressable device, no token.
 *
 * Everything runs through `app.inject()` against a stubbed pool and a stubbed
 * Videri client that RECORDS every arg it is sent. No device is contacted.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { Repository } from "../../db/repository.js";
import { buildServer } from "../server.js";
import type { VideriHttp } from "../../videri/http.js";

const TOKEN = "test-token-at-least-16-chars";
const auth = { authorization: `Bearer ${TOKEN}` };

/**
 * The REAL wire shapes, captured 2026-08-31. Note where each payload lives:
 * `wifi_ip` answers in `message`, while the JSON verbs answer in `others` and
 * leave `message` empty. Stubbing both the same way would have hidden the bug
 * this pair of fields exists to pin.
 */
const WM_LIVE = {
  message_json: {
    ping_ms: -1, ping_host: "xmpp-go.videri.com", wifi_dbm: -47,
    wifi_ip: "192.168.1.163", wifi_ssid: "Verizon_TFFN7C", wifi_status: "CONNECTED",
    cellular_dbm: 0, cellular_status: "UNKNOWN", ethernet: [],
  },
};
const SCAN_LIVE = {
  message_json: {
    networks: [
      { ssid: "Verizon_TFFN7C", security_type: "PSK", signal_strength: -47, frequency_mhz: 5700, connected: true },
      { ssid: "", security_type: "PSK", signal_strength: -47, frequency_mhz: 5700, connected: false },
      { ssid: "ghova", security_type: "PSK", signal_strength: -53, frequency_mhz: 5745 },
      { ssid: "ghova", security_type: "PSK", signal_strength: -68, frequency_mhz: 5745 },
    ],
  },
};

/** The freshness envelope's queries, plus the single-device detail lookup. */
function stubPool(device?: Record<string, unknown> | null): Pool {
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
      // queries.device — identified by the detail-only ride-along columns.
      if (sql.includes("d.serial_no, d.vendor")) {
        return device ? { rows: [device], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
}

const deviceRow = {
  id: "d1", name: "Test V4", location: null, device_class: "canvas", model_type: "V4",
  city: null, last_online_time: new Date(), firmware_current: "7.0", firmware_latest: "7.0",
  status: "online", observed_at: new Date(), presence: "online", serial_no: "SER123",
};

const stubRepo = (addressable = true): Repository =>
  ({
    async commandTarget() {
      return addressable ? { deviceId: "SER123", deviceJid: "d@x", playerId: "p1" } : null;
    },
  }) as unknown as Repository;

interface VideriStub {
  videri: VideriHttp;
  /** Every demo_command arg sent, in order — proves what the route did. */
  args: string[];
}

/** One sync_command reply, in either of the two shapes the gateway uses. */
type Reply = { response_code: string; message?: string; others?: Record<string, unknown> };

/** A recording fake control plane. `reply` maps a verb to its device answer. */
function stubVideri(reply: (arg: string) => Reply): VideriStub {
  const args: string[] = [];
  const videri = {
    async request(
      _service: string,
      path: string,
      opts?: { body?: { command_params?: { arg?: string } } },
    ) {
      assert.equal(path, "/messaging/sync_command");
      const arg = opts?.body?.command_params?.arg ?? "";
      args.push(arg);
      return reply(arg);
    },
  } as unknown as VideriHttp;
  return { videri, args };
}

const build = (opts: {
  videri?: VideriHttp;
  device?: Record<string, unknown> | null;
  addressable?: boolean;
} = {}) =>
  buildServer({
    pool: stubPool(opts.device === undefined ? deviceRow : opts.device),
    repo: stubRepo(opts.addressable ?? true),
    auth: { token: TOKEN, allowAnonymous: false },
    ...(opts.videri ? { videri: opts.videri } : {}),
  });

const get = async (app: Awaited<ReturnType<typeof buildServer>>, id = "d1") => {
  const res = await app.inject({ method: "GET", url: `/api/devices/${id}/network`, headers: auth });
  return { statusCode: res.statusCode, body: res.json() as { data?: Record<string, unknown>; error?: string } };
};

// ─── the happy path ───────────────────────────────────────────────────────────

const liveReply = (arg: string): Reply => {
  if (arg === "wm_network") return { response_code: "SUCCESS", message: "", others: WM_LIVE };
  if (arg === "wifi_ip") return { response_code: "SUCCESS", message: "wifi_ip:=192.168.1.163", others: {} };
  if (arg === "ssid_scan_json") return { response_code: "SUCCESS", message: "", others: SCAN_LIVE };
  return { response_code: "ERROR", message: "unexpected verb" };
};

test("a fully answering device returns IP, SSID, latency, signal and the nearby scan", async () => {
  const stub = stubVideri(liveReply);
  const app = await build({ videri: stub.videri });
  const { statusCode, body } = await get(app);

  assert.equal(statusCode, 200);
  assert.equal(body.data!["ip"], "192.168.1.163");
  assert.equal(body.data!["ssid"], "Verizon_TFFN7C");
  assert.equal(body.data!["status"], "CONNECTED");
  assert.equal(body.data!["signalDbm"], -47);
  assert.equal(body.data!["pingMs"], null, "ping_ms:-1 is a failed probe, not 0 ms");
  // The nameless (hidden) AP is dropped; the duplicated "ghova" collapses to
  // its strongest reading.
  assert.deepEqual(body.data!["nearby"], [
    { ssid: "Verizon_TFFN7C", signalDbm: -47, security: "PSK" },
    { ssid: "ghova", signalDbm: -53, security: "PSK" },
  ]);
  assert.equal(body.data!["nearbyIsLastScan"], true, "a cached scan must never look live");
  assert.deepEqual((body.data!["read"] as string[]).sort(), ["ssid_scan_json", "wifi_ip", "wm_network"]);
  await app.close();
});

test("a SUCCESS whose JSON payload sits in `others` is not read as silence", async () => {
  // The bug this pins: the JSON verbs answer with an EMPTY `message` and their
  // real payload under `others.message_json`. A runner that reads only `message`
  // reported both of them as unsupported on every device in the fleet.
  const stub = stubVideri((arg) =>
    arg === "wm_network"
      ? { response_code: "SUCCESS", message: "", others: WM_LIVE }
      : { response_code: "SUCCESS", message: "" });
  const app = await build({ videri: stub.videri });
  const { body } = await get(app);

  assert.equal(body.data!["ssid"], "Verizon_TFFN7C");
  assert.equal(body.data!["signalDbm"], -47);
  assert.deepEqual(body.data!["read"], ["wm_network"]);
  await app.close();
});

test("a JSON payload arriving in `message` instead is still read", async () => {
  // Defensive: we have seen `others` on this tenant, but the parsers accept the
  // same JSON in `message` so a firmware that answers the other way still works.
  const stub = stubVideri((arg) =>
    arg === "wm_network"
      ? { response_code: "SUCCESS", message: JSON.stringify(WM_LIVE) }
      : { response_code: "ERROR", message: "" });
  const app = await build({ videri: stub.videri });
  const { body } = await get(app);

  assert.equal(body.data!["ssid"], "Verizon_TFFN7C");
  assert.deepEqual(body.data!["read"], ["wm_network"]);
  await app.close();
});

test("the payload carries the freshness envelope and its own observation instant", async () => {
  const stub = stubVideri(() => ({ response_code: "SUCCESS", message: "wifi_ip:=10.0.0.5" }));
  const app = await build({ videri: stub.videri });
  const res = await app.inject({ method: "GET", url: "/api/devices/d1/network", headers: auth });
  const body = res.json() as { data: Record<string, unknown>; meta: { freshness: { state: string } } };

  assert.ok(body.meta.freshness.state, "the standard poller envelope rides along");
  assert.equal(body.data["live"], true, "this reading came from the device, not a cache");
  assert.equal(typeof body.data["observedAt"], "string");
  assert.ok(Number.isFinite(body.data["durationMs"] as number));
  await app.close();
});

// ─── read-only, and off the hot path ──────────────────────────────────────────

test("the endpoint sends exactly the three documented READ verbs", async () => {
  const stub = stubVideri(() => ({ response_code: "SUCCESS", message: "" }));
  const app = await build({ videri: stub.videri });
  await get(app);

  assert.deepEqual([...stub.args].sort(), ["ssid_scan_json", "wifi_ip", "wm_network"]);
  // The write counterpart on this surface, and every destructive verb, must be
  // unreachable from a GET.
  for (const forbidden of [
    "set_ethernet_settings", "su_shell_cmd", "adb_enable", "reset", "wifi_reconnect",
  ]) {
    assert.ok(!stub.args.some((a) => a.includes(forbidden)), `${forbidden} must never be sent`);
  }
  await app.close();
});

test("the network read does not drag the telemetry slow lane along with it", async () => {
  // The whole reason this is a separate endpoint: /telemetry already costs six
  // device commands on every drawer open.
  const stub = stubVideri(() => ({ response_code: "SUCCESS", message: "" }));
  const app = await build({ videri: stub.videri });
  await get(app);

  for (const telemetryVerb of ["meminfo", "read_proc_stat", "wifi_strength", "ops_chrony_stats_json"]) {
    assert.ok(!stub.args.includes(telemetryVerb), `${telemetryVerb} belongs to /telemetry`);
  }
  assert.equal(stub.args.length, 3);
  await app.close();
});

// ─── honest nulls ─────────────────────────────────────────────────────────────

test("a device that answers nothing yields nulls and an empty read list, not zeros", async () => {
  // TIME_OUT and DEVICE_OFFLINE arrive as HTTP 200 with a response_code, so the
  // route must read the body — and report the silence rather than a 0 dBm panel.
  const stub = stubVideri(() => ({ response_code: "TIME_OUT", message: "" }));
  const app = await build({ videri: stub.videri });
  const { statusCode, body } = await get(app);

  assert.equal(statusCode, 200, "an unresponsive device is not our error");
  assert.equal(body.data!["ip"], null);
  assert.equal(body.data!["ssid"], null);
  assert.equal(body.data!["pingMs"], null);
  assert.equal(body.data!["signalDbm"], null);
  assert.equal(body.data!["status"], null);
  assert.deepEqual(body.data!["nearby"], []);
  assert.equal(body.data!["nearbyIsLastScan"], false);
  assert.deepEqual(body.data!["read"], [], "nothing answered, and we say so");
  await app.close();
});

test("a partial device is served: the scan can fail without losing the IP", async () => {
  const stub = stubVideri((arg) => {
    if (arg === "wifi_ip") return { response_code: "SUCCESS", message: "wifi_ip:=172.20.1.44" };
    if (arg === "ssid_scan_json") return { response_code: "ERROR", message: "no scan results" };
    return { response_code: "ERROR", message: "Unknown command" };
  });
  const app = await build({ videri: stub.videri });
  const { statusCode, body } = await get(app);

  assert.equal(statusCode, 200);
  assert.equal(body.data!["ip"], "172.20.1.44");
  assert.deepEqual(body.data!["nearby"], []);
  assert.deepEqual(body.data!["read"], ["wifi_ip"], "only the verb that answered is credited");
  await app.close();
});

test("an error string is never rendered as an IP address", async () => {
  const stub = stubVideri(() => ({ response_code: "SUCCESS", message: "Invalid path: /storage/sdcard1" }));
  const app = await build({ videri: stub.videri });
  const { body } = await get(app);

  assert.equal(body.data!["ip"], null);
  assert.deepEqual(body.data!["read"], [], "SUCCESS with an unparseable body is not an answer");
  await app.close();
});

// ─── gates ────────────────────────────────────────────────────────────────────

test("no Videri credentials is a 503, never a stale reading dressed as live", async () => {
  const app = await build({}); // no videri
  const { statusCode, body } = await get(app);
  assert.equal(statusCode, 503);
  assert.equal(body.error, "network_unavailable");
  assert.equal(body.data, undefined);
  await app.close();
});

test("an unknown device is a 404 and reaches no device", async () => {
  const stub = stubVideri(() => ({ response_code: "SUCCESS", message: "" }));
  const app = await build({ videri: stub.videri, device: null });
  const { statusCode, body } = await get(app, "nope");
  assert.equal(statusCode, 404);
  assert.equal(body.error, "not_found");
  assert.equal(stub.args.length, 0);
  await app.close();
});

test("a device with no JID is a 409, not a silent all-null reading", async () => {
  const stub = stubVideri(() => ({ response_code: "SUCCESS", message: "" }));
  const app = await build({ videri: stub.videri, addressable: false });
  const { statusCode, body } = await get(app);
  assert.equal(statusCode, 409);
  assert.equal(body.error, "not_addressable");
  assert.equal(stub.args.length, 0, "an unaddressable device must not be commanded");
  await app.close();
});

test("the endpoint requires a token like every other data route", async () => {
  const stub = stubVideri(() => ({ response_code: "SUCCESS", message: "" }));
  const app = await build({ videri: stub.videri });
  const res = await app.inject({ method: "GET", url: "/api/devices/d1/network" });
  assert.equal(res.statusCode, 401);
  assert.equal(stub.args.length, 0, "an unauthenticated request must not reach a device");
  await app.close();
});

test("the network endpoint is GET-only", async () => {
  const stub = stubVideri(() => ({ response_code: "SUCCESS", message: "" }));
  const app = await build({ videri: stub.videri });
  const res = await app.inject({
    method: "POST", url: "/api/devices/d1/network",
    headers: { ...auth, "content-type": "application/json" }, payload: {},
  });
  assert.equal(res.statusCode, 404, "there is no write path on this route");
  assert.equal(stub.args.length, 0);
  await app.close();
});
