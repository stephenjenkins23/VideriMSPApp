/**
 * Audit logging on the device WRITE paths —
 *   `node --test dist/api/routes/commands.audit.test.js`
 *
 * The audit trail's whole value is that it records what happened, not what we
 * hoped would happen. So what is asserted here is the awkward half:
 *
 *   1. a successful write is logged WITH the value read back off the panel;
 *   2. a rolled-back write is logged AS rolled_back — not as a failure, and
 *      certainly not as applied;
 *   3. a refusal is logged, including the refusals where the device was never
 *      touched at all (no confirm, unreadable preflight, unaddressable);
 *   4. a LOGGING failure does not break, delay or mask the device operation;
 *   5. read commands do not fill the log with non-events, and an attempt to run
 *      a verb that is not on the allowlist always does.
 *
 * Everything runs through `app.inject()` against a stubbed pool and a stubbed
 * Videri client. NO device is contacted and no SQL is executed: `recordDeviceAction`
 * is a stub that captures its argument.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { DeviceActionEntry, Repository } from "../../db/repository.js";
import { buildServer } from "../server.js";
import type { VideriHttp } from "../../videri/http.js";

const TOKEN = "test-token-at-least-16-chars";
const auth = { authorization: `Bearer ${TOKEN}` };

const DEVICE = {
  id: "1000152", name: "Center Spark 5", location: null, device_class: "canvas",
  model_type: "V4", city: null, last_online_time: new Date(),
  firmware_current: "7.0", firmware_latest: "7.0", status: "ok",
  observed_at: new Date(), presence: "online",
  is_black_screen: false, showing_logo: false, serial_no: "SER152",
};

/** Freshness queries plus the single-device detail lookup. Nothing else. */
function stubPool(device: Record<string, unknown> | null = DEVICE): Pool {
  return {
    async query(sql: string) {
      if (sql.includes("MAX(observed_at)")) {
        return { rows: [{ newest: new Date(Date.now() - 60_000) }], rowCount: 1 };
      }
      if (sql.includes("FROM poller_runs")) return { rows: [], rowCount: 0 };
      if (sql.includes("d.serial_no, d.vendor")) {
        return device ? { rows: [device], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
}

interface RepoStub {
  repo: Repository;
  logged: DeviceActionEntry[];
}

function stubRepo(opts: {
  addressable?: boolean;
  /** "error" → returns a failure like a broken insert; "throw" → violates its contract. */
  logging?: "ok" | "error" | "throw";
} = {}): RepoStub {
  const logged: DeviceActionEntry[] = [];
  const mode = opts.logging ?? "ok";
  const repo = {
    async commandTarget() {
      return (opts.addressable ?? true)
        ? { deviceId: "SER152", deviceJid: "d@x", playerId: "p1" }
        : null;
    },
    async recordDeviceAction(entry: DeviceActionEntry) {
      logged.push(entry);
      if (mode === "throw") throw new Error("audit table is gone");
      if (mode === "error") return { id: null, error: 'relation "device_action_log" does not exist' };
      return { id: logged.length, error: null };
    },
    async insertDeviceSettings() { /* not exercised here */ },
  } as unknown as Repository;
  return { repo, logged };
}

/**
 * A Videri stub driven by a brightness SCRIPT: each `get_brightness` answers with
 * the next value in the queue, so a whole preflight → write → verify → rollback
 * cycle is expressed as the sequence of values the panel would report.
 */
function stubVideri(script: {
  reads: Array<number | null>;
  writeCode?: string;
}): { videri: VideriHttp; args: string[] } {
  const args: string[] = [];
  const reads = [...script.reads];
  const videri = {
    async request(_service: string, _path: string, opts?: { body?: { command_params?: { arg?: string } } }) {
      const arg = opts?.body?.command_params?.arg ?? "";
      args.push(arg);
      if (arg === "get_brightness") {
        const next = reads.shift() ?? null;
        return next === null
          ? { response_code: "ERROR", message: "" }
          : {
              response_code: "SUCCESS",
              message: `Current brightness is: ${next} Default brightness is: ${next} Current backlight is: 40`,
            };
      }
      return { response_code: script.writeCode ?? "SUCCESS", message: "" };
    },
  } as unknown as VideriHttp;
  return { videri, args };
}

const build = (opts: {
  videri?: VideriHttp;
  repo?: Repository;
  device?: Record<string, unknown> | null;
} = {}) =>
  buildServer({
    pool: stubPool(opts.device === undefined ? DEVICE : opts.device),
    repo: opts.repo ?? stubRepo().repo,
    auth: { token: TOKEN, allowAnonymous: false },
    ...(opts.videri ? { videri: opts.videri } : {}),
  });

const brightness = async (
  app: Awaited<ReturnType<typeof buildServer>>,
  body: Record<string, unknown>,
  headers: Record<string, string> = auth,
) => {
  const res = await app.inject({
    method: "POST", url: "/api/devices/1000152/brightness", headers, payload: body,
  });
  return { statusCode: res.statusCode, body: res.json() as { data?: { state?: string } } };
};

// ─── 1. a successful write is logged with its READ-BACK value ────────────────

test("a verified brightness write is logged as verified, with the value read back off the panel", async () => {
  // 100 raw preflight, then 179 raw on read-back == 70% requested.
  const { repo, logged } = stubRepo();
  const stub = stubVideri({ reads: [100, 179] });
  const app = await build({ videri: stub.videri, repo });

  const { statusCode, body } = await brightness(app, {
    brightnessPercent: 70, confirm: true, mode: "verify",
  });
  assert.equal(statusCode, 200);
  assert.equal(body.data!.state, "verified");

  assert.equal(logged.length, 1, "exactly one audit row per write");
  const row = logged[0]!;
  assert.equal(row.action, "brightness_write");
  assert.equal(row.verb, "set_brightness");
  assert.equal(row.deviceId, "1000152");
  assert.equal(row.outcome, "verified");
  assert.equal(row.requestedValue, "70%");
  // The read-back, not the request — the point of the verify cycle.
  assert.equal(row.observedValue, "70%");
  assert.deepEqual(row.params, { arg: "set_brightness:=179" });
  assert.equal(row.detail!["observedRaw"], 179);
  assert.equal(row.detail!["originalRaw"], 100);
  assert.equal(row.detail!["mode"], "verify");
  assert.equal(row.error, null);
  assert.ok(row.startedAt instanceof Date);
  assert.ok((row.durationMs ?? -1) >= 0);
});

test("the actor is recorded, and X-VFI-Actor is recorded as the caller's own claim", async () => {
  const { repo, logged } = stubRepo();
  const app = await build({ videri: stubVideri({ reads: [100, 179] }).videri, repo });

  await brightness(app, { brightnessPercent: 70, confirm: true }, { ...auth, "x-vfi-actor": "stephen" });
  assert.equal(logged[0]!.actor, "api:stephen");

  const plain = stubRepo();
  const app2 = await build({ videri: stubVideri({ reads: [100, 179] }).videri, repo: plain.repo });
  await brightness(app2, { brightnessPercent: 70, confirm: true });
  // No user model exists, so an unnamed token holder is exactly that and no more.
  assert.equal(plain.logged[0]!.actor, "api:token");
});

// ─── 2. a rolled-back write is logged AS rolled back ─────────────────────────

test("a write that did not take is logged as rolled_back, never as applied", async () => {
  // Preflight 100, read-back still 100 (the write was ignored), restore reads 100.
  const { repo, logged } = stubRepo();
  const stub = stubVideri({ reads: [100, 100, 100] });
  const app = await build({ videri: stub.videri, repo });

  const { statusCode, body } = await brightness(app, { brightnessPercent: 70, confirm: true });
  assert.equal(statusCode, 502);
  assert.equal(body.data!.state, "unconfirmed_rolled_back");

  const row = logged[0]!;
  assert.equal(row.outcome, "rolled_back");
  assert.notEqual(row.outcome, "applied");
  assert.equal(row.requestedValue, "70%");
  // What the panel actually reported after the write — the evidence it did not take.
  assert.equal(row.observedValue, "39%");
  assert.equal(row.detail!["originalRaw"], 100);
  assert.ok(row.error && /not the requested/.test(row.error), row.error ?? "no error recorded");
});

test("a write whose rollback could not be confirmed is logged as rollback_failed", async () => {
  // Preflight 100, read-back 200 (wrong), restore read-back unreadable.
  const { repo, logged } = stubRepo();
  const app = await build({ videri: stubVideri({ reads: [100, 200, null] }).videri, repo });

  const { statusCode } = await brightness(app, { brightnessPercent: 70, confirm: true });
  assert.equal(statusCode, 500, "a device at an unknown brightness must be a 500");
  assert.equal(logged[0]!.outcome, "rollback_failed");
});

test("an unreadable preflight is logged as refused — we declined, the panel was never touched", async () => {
  const { repo, logged } = stubRepo();
  const stub = stubVideri({ reads: [null] });
  const app = await build({ videri: stub.videri, repo });

  const { statusCode } = await brightness(app, { brightnessPercent: 70, confirm: true });
  assert.equal(statusCode, 409);
  assert.equal(logged[0]!.outcome, "refused");
  // No set_brightness ever went out; the audit row must not imply one did.
  assert.deepEqual(stub.args, ["get_brightness"]);
  assert.equal(logged[0]!.observedValue ?? null, null, "unreadable is null, never 0%");
});

test("a device already at the requested value is logged as no_change, not as a write", async () => {
  const { repo, logged } = stubRepo();
  const stub = stubVideri({ reads: [179] });
  const app = await build({ videri: stub.videri, repo });

  await brightness(app, { brightnessPercent: 70, confirm: true });
  assert.equal(logged[0]!.outcome, "no_change");
  assert.deepEqual(stub.args, ["get_brightness"], "nothing was written");
});

// ─── 3. refusals that never reach a device are still logged ──────────────────

test("a brightness write without confirm is logged as refused", async () => {
  const { repo, logged } = stubRepo();
  const stub = stubVideri({ reads: [100] });
  const app = await build({ videri: stub.videri, repo });

  const { statusCode } = await brightness(app, { brightnessPercent: 70 });
  assert.equal(statusCode, 409);
  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.outcome, "refused");
  assert.equal(logged[0]!.detail!["reason"], "confirmation_required");
  assert.equal(stub.args.length, 0, "no device call at all");
});

test("a brightness write to an unaddressable device is logged as refused", async () => {
  const { repo, logged } = stubRepo({ addressable: false });
  const app = await build({ videri: stubVideri({ reads: [] }).videri, repo });

  const { statusCode } = await brightness(app, { brightnessPercent: 70, confirm: true });
  assert.equal(statusCode, 409);
  assert.equal(logged[0]!.outcome, "refused");
  assert.equal(logged[0]!.detail!["reason"], "not_addressable");
});

test("a command that is not on the allowlist is always logged, whatever it was", async () => {
  const { repo, logged } = stubRepo();
  const app = await build({ videri: stubVideri({ reads: [] }).videri, repo });

  const res = await app.inject({
    method: "POST", url: "/api/devices/1000152/command", headers: auth,
    payload: { command: "su_shell_cmd", confirm: true, params: { cmd: "id" } },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(logged.length, 1, "a blocked destructive verb is the most important row here");
  assert.equal(logged[0]!.outcome, "refused");
  assert.equal(logged[0]!.verb, "su_shell_cmd");
  assert.equal(logged[0]!.detail!["reason"], "command_not_allowed");
});

// ─── 4. a logging failure never breaks the device operation ──────────────────

for (const logging of ["error", "throw"] as const) {
  test(`a logging failure (${logging}) does not break or mask the device write`, async () => {
    const { repo, logged } = stubRepo({ logging });
    const stub = stubVideri({ reads: [100, 179] });
    const app = await build({ videri: stub.videri, repo });

    const { statusCode, body } = await brightness(app, { brightnessPercent: 70, confirm: true });
    // The operation's own outcome is reported unchanged.
    assert.equal(statusCode, 200);
    assert.equal(body.data!.state, "verified");
    // And the device really was driven through the full cycle.
    assert.deepEqual(stub.args, ["get_brightness", "set_brightness:=179", "get_brightness"]);
    assert.equal(logged.length, 1, "we did attempt to log");
  });
}

test("a logging failure does not mask a rollback_failed, the one outcome a human must see", async () => {
  const { repo } = stubRepo({ logging: "throw" });
  const app = await build({ videri: stubVideri({ reads: [100, 200, null] }).videri, repo });
  const { statusCode, body } = await brightness(app, { brightnessPercent: 70, confirm: true });
  assert.equal(statusCode, 500);
  assert.equal(body.data!.state, "unconfirmed_rollback_failed");
});

// ─── 5. reads are not audit events ───────────────────────────────────────────

test("a read command is not logged — the audit trail records writes, not drawer opens", async () => {
  const { repo, logged } = stubRepo();
  const app = await build({
    videri: {
      async request() { return { response_code: "SUCCESS", others: {} }; },
    } as unknown as VideriHttp,
    repo,
  });

  const res = await app.inject({
    method: "POST", url: "/api/devices/1000152/command", headers: auth,
    payload: { command: "ops_get_firmware_info" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(logged.length, 0);
});

test("a state-changing command through the generic endpoint is logged as applied, with NO observed value", async () => {
  const { repo, logged } = stubRepo();
  const app = await build({
    videri: {
      async request() { return { response_code: "SUCCESS", others: {} }; },
    } as unknown as VideriHttp,
    repo,
  });

  const res = await app.inject({
    method: "POST", url: "/api/devices/1000152/command", headers: auth,
    payload: { command: "reboot_device", confirm: true },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(logged[0]!.outcome, "applied");
  // This endpoint does not read back, so it must not imply it confirmed anything.
  assert.equal(logged[0]!.observedValue ?? null, null);
  assert.equal(logged[0]!.detail!["verified"], false);
});

test("a device that answers a non-SUCCESS code is logged as failed", async () => {
  const { repo, logged } = stubRepo();
  const app = await build({
    videri: {
      async request() { return { response_code: "DEVICE_OFFLINE" }; },
    } as unknown as VideriHttp,
    repo,
  });

  const res = await app.inject({
    method: "POST", url: "/api/devices/1000152/command", headers: auth,
    payload: { command: "reboot_device", confirm: true },
  });
  assert.equal(res.statusCode, 502);
  assert.equal(logged[0]!.outcome, "failed");
  assert.match(logged[0]!.error ?? "", /DEVICE_OFFLINE/);
});

test("a transport failure is logged as failed with the reason, not swallowed", async () => {
  const { repo, logged } = stubRepo();
  const app = await build({
    videri: {
      async request() { throw new Error("socket hang up"); },
    } as unknown as VideriHttp,
    repo,
  });

  const res = await app.inject({
    method: "POST", url: "/api/devices/1000152/command", headers: auth,
    payload: { command: "reboot_device", confirm: true },
  });
  assert.equal(res.statusCode, 502);
  assert.equal(logged[0]!.outcome, "failed");
  assert.equal(logged[0]!.detail!["reason"], "transport_error");
  assert.match(logged[0]!.error ?? "", /socket hang up/);
});
