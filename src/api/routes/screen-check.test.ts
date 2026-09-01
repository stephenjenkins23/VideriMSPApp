/**
 * `GET /api/devices/:id/screen-check` endpoint tests —
 *   `node --test dist/api/routes/screen-check.test.js`
 *
 * The parsers are covered in videri/screen-verbs.test.ts and the verdict in
 * intelligence/screen-verify.test.ts. This file covers what only the route can
 * get wrong:
 *
 *   1. contradicted — the motivating case: the platform's latest sample says
 *      black, the panel says it is not;
 *   2. unanswered — a silent or unreachable device must NOT become a
 *      confirmation, and must not become a 500 either;
 *   3. sending the two READ verbs and nothing else;
 *   4. the gates: no credentials, unknown device, unaddressable device, no token.
 *
 * Everything runs through `app.inject()` against a stubbed pool and a stubbed
 * Videri client that RECORDS every arg. No device is contacted.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { Repository } from "../../db/repository.js";
import { buildServer } from "../server.js";
import type { VideriHttp } from "../../videri/http.js";

const TOKEN = "test-token-at-least-16-chars";
const auth = { authorization: `Bearer ${TOKEN}` };

const SAMPLE_AT = new Date("2026-09-01T13:30:00.000Z");

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

/** A device whose newest platform sample claims a black screen — the 1000152 case. */
const claimingBlack = {
  id: "1000152", name: "Center Spark 5", location: null, device_class: "canvas",
  model_type: "V4", city: null, last_online_time: new Date(),
  firmware_current: "7.0", firmware_latest: "7.0", status: "alert",
  observed_at: SAMPLE_AT, presence: "online",
  is_black_screen: true, showing_logo: false, serial_no: "SER152",
};

const stubRepo = (addressable = true): Repository =>
  ({
    async commandTarget() {
      return addressable ? { deviceId: "SER152", deviceJid: "d@x", playerId: "p1" } : null;
    },
  }) as unknown as Repository;

type Reply = { response_code: string; message?: string; others?: Record<string, unknown> };

function stubVideri(reply: (arg: string) => Reply): { videri: VideriHttp; args: string[] } {
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
    pool: stubPool(opts.device === undefined ? claimingBlack : opts.device),
    repo: stubRepo(opts.addressable ?? true),
    auth: { token: TOKEN, allowAnonymous: false },
    ...(opts.videri ? { videri: opts.videri } : {}),
  });

interface CheckBody {
  data?: {
    platform: { isBlackScreen: boolean | null; showingLogo: boolean | null; observedAt: string | null };
    device: { isBlack: boolean | null; isShowingLogo: boolean | null; read: string[]; observedAt: string; error: string | null };
    verdict: string;
    detail: string;
  };
  meta?: { freshness: { state: string } };
  error?: string;
}

const get = async (app: Awaited<ReturnType<typeof buildServer>>, id = "1000152") => {
  const res = await app.inject({ method: "GET", url: `/api/devices/${id}/screen-check`, headers: auth });
  return { statusCode: res.statusCode, body: res.json() as CheckBody };
};

// ─── contradicted: the motivating case ────────────────────────────────────────

test("a platform black-screen claim the panel denies is reported as contradicted", async () => {
  const stub = stubVideri((arg) =>
    arg === "is_blackscreen"
      ? { response_code: "SUCCESS", message: "is_blackscreen=false" }
      : { response_code: "SUCCESS", message: "is_showing_logo=false" });
  const app = await build({ videri: stub.videri });
  const { statusCode, body } = await get(app);

  assert.equal(statusCode, 200);
  assert.equal(body.data!.platform.isBlackScreen, true);
  assert.equal(body.data!.platform.observedAt, SAMPLE_AT.toISOString());
  assert.equal(body.data!.device.isBlack, false);
  assert.equal(body.data!.device.isShowingLogo, false);
  assert.deepEqual(body.data!.device.read.sort(), ["is_blackscreen", "is_showing_logo"]);
  assert.equal(body.data!.verdict, "contradicted");
  assert.match(body.data!.detail, /but the panel itself answered is_blackscreen=false/);
  assert.equal(body.data!.device.error, null);
  assert.ok(body.meta!.freshness.state, "the standard poller envelope rides along");
  await app.close();
});

test("a claim the panel confirms is reported as confirmed, with both timestamps", async () => {
  const stub = stubVideri(() => ({ response_code: "SUCCESS", message: "true" }));
  const app = await build({ videri: stub.videri });
  const { body } = await get(app);

  assert.equal(body.data!.verdict, "confirmed");
  assert.equal(body.data!.device.isBlack, true);
  assert.match(body.data!.detail, /2026-09-01T13:30:00\.000Z/, "the claim's own time");
  assert.equal(typeof body.data!.device.observedAt, "string");
  await app.close();
});

test("a JSON answer arriving in `others` is not read as silence", async () => {
  // The reply-shape trap: verbs answering in JSON leave `message` EMPTY. A
  // `message`-only read would report both verbs unsupported on every device.
  const stub = stubVideri((arg) => ({
    response_code: "SUCCESS", message: "", others: { message_json: { [arg]: false } },
  }));
  const app = await build({ videri: stub.videri });
  const { body } = await get(app);

  assert.equal(body.data!.device.isBlack, false);
  assert.equal(body.data!.verdict, "contradicted");
  await app.close();
});

// ─── unanswered: silence is not agreement ────────────────────────────────────

test("a silent device is a 200 with verdict unanswered, never a confirmation", async () => {
  // TIME_OUT and DEVICE_OFFLINE both arrive as HTTP 200 with a response_code.
  const stub = stubVideri(() => ({ response_code: "TIME_OUT", message: "" }));
  const app = await build({ videri: stub.videri });
  const { statusCode, body } = await get(app);

  assert.equal(statusCode, 200, "an unresponsive device is not our error");
  assert.equal(body.data!.device.isBlack, null);
  assert.deepEqual(body.data!.device.read, []);
  assert.equal(body.data!.verdict, "unanswered");
  assert.match(body.data!.detail, /neither confirmed nor refuted/);
  // The platform's claim is still reported — unverified, and labelled as theirs.
  assert.equal(body.data!.platform.isBlackScreen, true);
  await app.close();
});

test("a verb the hardware does not support reads as unanswered, not as false", async () => {
  const stub = stubVideri(() => ({ response_code: "SUCCESS", message: "Unknown command" }));
  const app = await build({ videri: stub.videri });
  const { body } = await get(app);

  assert.equal(body.data!.device.isBlack, null, "an unparseable SUCCESS is not an answer");
  assert.deepEqual(body.data!.device.read, []);
  assert.equal(body.data!.verdict, "unanswered");
  await app.close();
});

test("an upstream transport failure is unanswered with a reason, not a 500", async () => {
  const videri = {
    async request() { throw new Error("gateway 504"); },
  } as unknown as VideriHttp;
  const app = await build({ videri });
  const { statusCode, body } = await get(app);

  assert.equal(statusCode, 200);
  assert.equal(body.data!.verdict, "unanswered");
  assert.equal(body.data!.device.error, "gateway 504", "why we could not ask is stated");
  await app.close();
});

test("a device the platform is not flagging returns no-claim", async () => {
  const stub = stubVideri(() => ({ response_code: "SUCCESS", message: "false" }));
  const app = await build({
    videri: stub.videri,
    device: { ...claimingBlack, is_black_screen: false, status: "online" },
  });
  const { statusCode, body } = await get(app);

  assert.equal(statusCode, 200);
  assert.equal(body.data!.verdict, "no-claim");
  assert.equal(body.data!.platform.isBlackScreen, false);
  await app.close();
});

// ─── read-only ───────────────────────────────────────────────────────────────

test("the endpoint sends exactly the two documented READ verbs", async () => {
  const stub = stubVideri(() => ({ response_code: "SUCCESS", message: "false" }));
  const app = await build({ videri: stub.videri });
  await get(app);

  assert.deepEqual([...stub.args].sort(), ["is_blackscreen", "is_showing_logo"]);
  for (const forbidden of [
    "clear", "kill_media_server", "su_shell_cmd", "adb_enable", "reset",
    "set_brightness", "reboot", "get_screenshot",
  ]) {
    assert.ok(!stub.args.some((a) => a.includes(forbidden)), `${forbidden} must never be sent`);
  }
  // And it stays off the telemetry slow lane.
  for (const telemetryVerb of ["meminfo", "read_proc_stat", "wifi_strength"]) {
    assert.ok(!stub.args.includes(telemetryVerb), `${telemetryVerb} belongs to /telemetry`);
  }
  await app.close();
});

// ─── gates ───────────────────────────────────────────────────────────────────

test("no Videri credentials is a 503, because half a verification verifies nothing", async () => {
  const app = await build({}); // no videri
  const { statusCode, body } = await get(app);
  assert.equal(statusCode, 503);
  assert.equal(body.error, "screen_check_unavailable");
  assert.equal(body.data, undefined);
  await app.close();
});

test("an unknown device is a 404 and reaches no device", async () => {
  const stub = stubVideri(() => ({ response_code: "SUCCESS", message: "false" }));
  const app = await build({ videri: stub.videri, device: null });
  const { statusCode, body } = await get(app, "nope");
  assert.equal(statusCode, 404);
  assert.equal(body.error, "not_found");
  assert.equal(stub.args.length, 0);
  await app.close();
});

test("a device with no JID is a 409, not a silent all-null reading", async () => {
  const stub = stubVideri(() => ({ response_code: "SUCCESS", message: "false" }));
  const app = await build({ videri: stub.videri, addressable: false });
  const { statusCode, body } = await get(app);
  assert.equal(statusCode, 409);
  assert.equal(body.error, "not_addressable");
  assert.equal(stub.args.length, 0, "an unaddressable device must not be commanded");
  await app.close();
});

test("the endpoint requires a token like every other data route", async () => {
  const stub = stubVideri(() => ({ response_code: "SUCCESS", message: "false" }));
  const app = await build({ videri: stub.videri });
  const res = await app.inject({ method: "GET", url: "/api/devices/1000152/screen-check" });
  assert.equal(res.statusCode, 401);
  assert.equal(stub.args.length, 0, "an unauthenticated request must not reach a device");
  await app.close();
});

test("the screen-check endpoint is GET-only", async () => {
  const stub = stubVideri(() => ({ response_code: "SUCCESS", message: "false" }));
  const app = await build({ videri: stub.videri });
  const res = await app.inject({
    method: "POST", url: "/api/devices/1000152/screen-check",
    headers: { ...auth, "content-type": "application/json" }, payload: {},
  });
  assert.equal(res.statusCode, 404, "there is no write path on this route");
  assert.equal(stub.args.length, 0);
  await app.close();
});
