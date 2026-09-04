/**
 * Bulk brightness endpoint —
 *   `node --test dist/api/routes/commands.bulk.test.js`
 *
 * The pure planner and executor are covered in videri/bulk-apply.test.ts. What
 * is asserted here is the ROUTE's half of the safety story, all of it through
 * `app.inject()` against a stubbed pool, a stubbed repository and a stubbed
 * Videri client. **No device is contacted anywhere in this file.**
 *
 *   1. DRY RUN TOUCHES NOTHING. No sync_command, no audit row — and it works on
 *      a server with no Videri credentials at all, because a blast radius is
 *      worth showing even where the commit would 503.
 *   2. THE CAP IS ENFORCED, and its message explains itself.
 *   3. CONFIRM IS ENFORCED, and the refusal still hands back the counts so the
 *      console can render the blast radius on the confirm screen.
 *   4. THE SCOPE IS NARROW. reboot_device and the power-schedule drift that
 *      motivated this endpoint are refused by name, with the reason.
 *   5. ONE AUDIT ROW PER DEVICE, refusals included, all carrying the batch id.
 *   6. INTENT AND SUPPRESSION exclude devices at the route, not just in theory.
 *   7. A CHANGED PLAN aborts a commit that was confirmed against a stale preview.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { DeviceActionEntry, Repository, SuppressionRow } from "../../db/repository.js";
import { buildServer } from "../server.js";
import type { VideriHttp } from "../../videri/http.js";

const TOKEN = "test-token-at-least-16-chars";
const auth = { authorization: `Bearer ${TOKEN}`, "x-vfi-actor": "sj" };

interface FleetDevice { id: string; name: string | null; status: string }

/**
 * Freshness plus the ONE fleet projection the planner reads
 * (`queries.remediationDevices`). Nothing else is queried by this route.
 */
function stubPool(devices: FleetDevice[]): { pool: Pool; queries: string[] } {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("MAX(observed_at)")) {
        return { rows: [{ newest: new Date(Date.now() - 60_000) }], rowCount: 1 };
      }
      if (sql.includes("FROM poller_runs")) return { rows: [], rowCount: 0 };
      if (sql.includes("cr.drift")) {
        return {
          rows: devices.map((d) => ({
            id: d.id, name: d.name, status: d.status, city: null, group_id: null,
            firmware_current: "7.0", firmware_latest: "7.0",
            last_online_time: new Date(), timezone: null,
            is_black_screen: null, showing_logo: null, is_screen_on: null,
            telemetry_observed_at: null, cpu_percent: null, ram_used_percent: null,
            storage_used_percent: null, rssi_dbm: null, ntp_offset_ms: null,
            brightness_raw: null, current_brightness_raw: null, display_on: null,
            brightness_schedule_enabled: null, auto_brightness_enabled: null,
            turn_on_time: null, turn_off_time: null, drift: [],
          })),
          rowCount: devices.length,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, queries };
}

function stubRepo(opts: {
  /** Device ids we hold no JID for. */
  unaddressable?: string[];
  suppressions?: SuppressionRow[];
  logging?: "ok" | "error";
} = {}): { repo: Repository; logged: DeviceActionEntry[] } {
  const logged: DeviceActionEntry[] = [];
  const repo = {
    async commandTarget(id: string) {
      if ((opts.unaddressable ?? []).includes(id)) {
        return { deviceId: `SER-${id}`, deviceJid: null, playerId: null };
      }
      return { deviceId: `SER-${id}`, deviceJid: `${id}@x`, playerId: null };
    },
    async listSuppressions() {
      return opts.suppressions ?? [];
    },
    async recordDeviceAction(entry: DeviceActionEntry) {
      logged.push(entry);
      return opts.logging === "error"
        ? { id: null, error: 'relation "device_action_log" does not exist' }
        : { id: logged.length, error: null };
    },
  } as unknown as Repository;
  return { repo, logged };
}

/**
 * A Videri stub that answers every device's brightness reads from one shared
 * script, and RECORDS every call so "the dry run sent nothing" is assertable
 * rather than asserted.
 */
function stubVideri(reads: Array<number | null> = [100, 179]): {
  videri: VideriHttp;
  calls: Array<{ deviceId: string; arg: string }>;
} {
  const calls: Array<{ deviceId: string; arg: string }> = [];
  const perDevice = new Map<string, Array<number | null>>();
  const videri = {
    async request(
      _service: string,
      _path: string,
      opts?: { body?: { device_id?: string; command_params?: { arg?: string } } },
    ) {
      const deviceId = opts?.body?.device_id ?? "?";
      const arg = opts?.body?.command_params?.arg ?? "";
      calls.push({ deviceId, arg });
      if (arg === "get_brightness") {
        if (!perDevice.has(deviceId)) perDevice.set(deviceId, [...reads]);
        const next = perDevice.get(deviceId)!.shift() ?? null;
        return next === null
          ? { response_code: "ERROR", message: "" }
          : {
              response_code: "SUCCESS",
              message: `Current brightness is: ${next} Default brightness is: ${next} Current backlight is: 40`,
            };
      }
      return { response_code: "SUCCESS", message: "" };
    },
  } as unknown as VideriHttp;
  return { videri, calls };
}

const suppressionRow = (over: Partial<SuppressionRow> = {}): SuppressionRow => ({
  id: "sup-1", deviceId: "1000003", ruleId: null, reason: "awaiting RMA collection",
  intent: null, includeCriticalHigh: false, createdBy: "api:sj",
  createdAt: new Date(Date.now() - 86_400_000),
  expiresAt: new Date(Date.now() + 86_400_000), neverExpires: false,
  revokedAt: null, revokedBy: null, revokedReason: null,
  ...over,
});

const FLEET: FleetDevice[] = [
  { id: "1000001", name: "Center Spark 5", status: "online" },
  { id: "1000002", name: "Logo Fallback Board", status: "warning" },
  { id: "1000003", name: "Suppressed Board", status: "online" },
  { id: "1000004", name: "SparkBridge (EoL)", status: "online" },
  { id: "1000005", name: "Dark Panel", status: "offline" },
];

const build = (opts: {
  devices?: FleetDevice[];
  repo?: Repository;
  videri?: VideriHttp | null;
} = {}) =>
  buildServer({
    pool: stubPool(opts.devices ?? FLEET).pool,
    repo: opts.repo ?? stubRepo().repo,
    auth: { token: TOKEN, allowAnonymous: false },
    ...(opts.videri === null ? {} : { videri: opts.videri ?? stubVideri().videri }),
  });

const post = async (
  app: Awaited<ReturnType<typeof buildServer>>,
  payload: Record<string, unknown>,
) => {
  const res = await app.inject({
    method: "POST", url: "/api/bulk/brightness", headers: auth, payload,
  });
  return { statusCode: res.statusCode, body: res.json() as Record<string, any> };
};

// ─── 1. dry run touches nothing ─────────────────────────────────────────────

test("a dry run reports the blast radius and sends nothing, logs nothing", async () => {
  const { repo, logged } = stubRepo();
  const stub = stubVideri();
  const app = await build({ repo, videri: stub.videri });

  const { statusCode, body } = await post(app, {
    brightnessPercent: 70,
    deviceIds: FLEET.map((d) => d.id),
    dryRun: true,
  });

  assert.equal(statusCode, 200);
  assert.equal(body.data.dryRun, true);
  // Three attempt — including 1000002, whose derived status is `warning` because
  // it is on the logo fallback and which is perfectly writable. Two are refused:
  // the `(EoL)` name and the offline panel.
  assert.equal(body.data.counts.attempt, 3);
  assert.equal(body.data.counts.refuse, 2);
  assert.equal(body.data.counts.byReason.intent_tagged, 1);
  assert.equal(body.data.counts.byReason.unreachable, 1);
  assert.equal(body.data.canCommit, true);
  assert.equal(body.data.limits.maxDevices, 100);
  assert.equal(body.data.limits.concurrency, 4);
  // The two things that make a dry run a dry run.
  assert.deepEqual(stub.calls, [], "no device was contacted");
  assert.deepEqual(logged, [], "nothing was written to the audit log");
});

test("a dry run works with no Videri credentials, and says the commit would not", async () => {
  const app = await build({ videri: null });
  const { statusCode, body } = await post(app, {
    brightnessPercent: 70, deviceIds: ["1000001"], dryRun: true,
  });
  assert.equal(statusCode, 200);
  assert.equal(body.data.canCommit, false);
});

test("a COMMIT on a server with no Videri credentials is a 503, not a silent no-op", async () => {
  const app = await build({ videri: null });
  const { statusCode, body } = await post(app, {
    brightnessPercent: 70, deviceIds: ["1000001"], confirm: true,
  });
  assert.equal(statusCode, 503);
  assert.equal(body.error, "commands_unavailable");
});

// ─── 2. the cap ─────────────────────────────────────────────────────────────

test("the batch is capped, and the refusal explains the cap rather than citing a schema", async () => {
  const stub = stubVideri();
  const app = await build({ videri: stub.videri });
  const { statusCode, body } = await post(app, {
    brightnessPercent: 70,
    deviceIds: Array.from({ length: 101 }, (_, i) => `d${i}`),
    confirm: true,
  });
  assert.equal(statusCode, 400);
  assert.equal(body.error, "too_many_devices");
  assert.equal(body.cap, 100);
  assert.equal(body.requested, 101);
  assert.match(body.message, /read before/);
  assert.deepEqual(stub.calls, [], "the cap is checked before anything is contacted");
});

test("duplicates are collapsed before the cap is applied, and reported", async () => {
  const app = await build();
  // 101 entries but only two distinct devices.
  const ids = Array.from({ length: 101 }, (_, i) => (i % 2 === 0 ? "1000001" : "1000002"));
  const { statusCode, body } = await post(app, {
    brightnessPercent: 70, deviceIds: ids, dryRun: true,
  });
  assert.equal(statusCode, 200);
  assert.equal(body.data.duplicatesRemoved, 99);
  assert.equal(body.data.counts.requested, 2);
});

// ─── 3. confirm ─────────────────────────────────────────────────────────────

test("a commit without confirm is refused, with the counts for the confirm screen", async () => {
  const { repo, logged } = stubRepo();
  const stub = stubVideri();
  const app = await build({ repo, videri: stub.videri });
  const { statusCode, body } = await post(app, {
    brightnessPercent: 70, deviceIds: FLEET.map((d) => d.id),
  });
  assert.equal(statusCode, 409);
  assert.equal(body.error, "confirmation_required");
  assert.equal(body.counts.attempt, 3);
  assert.deepEqual(stub.calls, []);
  // Deliberately NOT audited: at batch scale the single-device policy would
  // write up to 100 rows per handshake recording that nothing happened.
  assert.deepEqual(logged, []);
});

// ─── 4. the scope is narrow, by name ────────────────────────────────────────

test("reboot_device is refused by name, with the reason it is out of scope", async () => {
  const stub = stubVideri();
  const app = await build({ videri: stub.videri });
  const { statusCode, body } = await post(app, {
    action: "reboot_device", brightnessPercent: 70, deviceIds: ["1000001"], confirm: true,
  });
  assert.equal(statusCode, 400);
  assert.equal(body.error, "action_not_bulk_applicable");
  assert.match(body.message, /refused by the hardware/);
  assert.match(body.message, /power_display has no documented params/);
  // The cohort that motivated the endpoint and still cannot be bulk-applied.
  assert.match(body.message, /Power schedule enabled/);
  assert.deepEqual([...body.bulkAppliableActions], ["set_brightness"]);
  assert.deepEqual(stub.calls, []);
});

// ─── 5. one audit row per device ────────────────────────────────────────────

test("a committed batch writes one audit row per device — refusals included — all tied to the batch", async () => {
  const { repo, logged } = stubRepo();
  const stub = stubVideri([100, 179]);
  const app = await build({ repo, videri: stub.videri });

  const { statusCode, body } = await post(app, {
    brightnessPercent: 70, deviceIds: FLEET.map((d) => d.id), confirm: true,
  });

  assert.equal(statusCode, 200);
  assert.equal(logged.length, 5, "every device in the batch has its own row");
  assert.deepEqual([...new Set(logged.map((e) => e.action))], ["bulk_brightness_write"]);
  assert.deepEqual([...new Set(logged.map((e) => e.actor))], ["api:sj"]);
  const batchIds = new Set(logged.map((e) => e.detail!["batchId"]));
  assert.equal(batchIds.size, 1, "one batch id ties the whole push together");
  assert.equal([...batchIds][0], body.data.batchId);
  assert.deepEqual([...new Set(logged.map((e) => e.detail!["batchSize"]))], [5]);

  // Refused and applied rows are distinguishable, and the refusals carry why.
  const byDevice = new Map(logged.map((e) => [e.deviceId, e]));
  assert.equal(byDevice.get("1000001")!.outcome, "verified");
  assert.equal(byDevice.get("1000001")!.observedValue, "70%");
  assert.equal(byDevice.get("1000004")!.outcome, "refused");
  assert.equal(byDevice.get("1000004")!.detail!["refusedBecause"], "intent_tagged");
  assert.equal(byDevice.get("1000005")!.detail!["refusedBecause"], "unreachable");
  // A refused device carries no `arg`: nothing was put on the wire for it.
  assert.deepEqual(byDevice.get("1000005")!.params, {});

  // Per-device results, no aggregate verdict, and refused ≠ failed.
  assert.equal(body.data.results.length, 5);
  assert.equal(body.data.counts.byOutcome.verified, 3);
  assert.equal(body.data.counts.byOutcome.refused, 2);
  assert.equal(body.data.counts.byOutcome.failed, 0);
  assert.deepEqual(body.data.needsAttention, []);
  assert.equal(body.data.counts.auditRowsWritten, 5);
  // Only the three attempted devices were contacted, three commands each.
  assert.deepEqual(
    [...new Set(stub.calls.map((c) => c.deviceId))].sort(),
    ["SER-1000001", "SER-1000002", "SER-1000003"],
  );
});

test("a failing audit insert costs one honest flag, not the batch", async () => {
  const { repo, logged } = stubRepo({ logging: "error" });
  const app = await build({ repo, videri: stubVideri().videri });
  const { statusCode, body } = await post(app, {
    brightnessPercent: 70, deviceIds: ["1000001"], confirm: true,
  });
  assert.equal(statusCode, 200);
  assert.equal(body.data.results[0].outcome, "verified", "the write still stands");
  assert.equal(body.data.results[0].audited, false, "and the missing row is stated");
  assert.equal(body.data.counts.auditRowsFailed, 1);
  assert.equal(logged.length, 1, "it was attempted");
});

// ─── 6. intent and suppression at the route ─────────────────────────────────

test("an actively suppressed device is excluded, and the record that did it is named", async () => {
  const { repo } = stubRepo({ suppressions: [suppressionRow()] });
  const stub = stubVideri();
  const app = await build({ repo, videri: stub.videri });
  const { body } = await post(app, {
    brightnessPercent: 70, deviceIds: ["1000001", "1000003"], dryRun: true,
  });
  const item = body.data.plan.find((i: any) => i.deviceId === "1000003");
  assert.equal(item.decision, "refuse");
  assert.equal(item.reason, "suppressed");
  assert.equal(item.suppression.id, "sup-1");
  assert.equal(body.data.counts.attempt, 1);
});

test('a device whose recorded intent is "none" stays in the batch', async () => {
  // The operator override: "the name is lying, this IS production". It must not
  // also remove the device from the bulk path.
  const { repo } = stubRepo({
    suppressions: [
      suppressionRow({
        id: "sup-none", deviceId: "1000004", intent: "none",
        reason: "this is a production screen despite the name",
      }),
    ],
  });
  const app = await build({ repo, videri: stubVideri().videri });
  const { body } = await post(app, {
    brightnessPercent: 70, deviceIds: ["1000004"], dryRun: true,
  });
  assert.equal(body.data.plan[0].decision, "attempt");
  assert.equal(body.data.counts.attempt, 1);
});

test("an unaddressable device is refused rather than attempted", async () => {
  const { repo } = stubRepo({ unaddressable: ["1000002"] });
  const app = await build({ repo, videri: stubVideri().videri });
  const { body } = await post(app, {
    brightnessPercent: 70, deviceIds: ["1000001", "1000002"], dryRun: true,
  });
  const item = body.data.plan.find((i: any) => i.deviceId === "1000002");
  assert.equal(item.reason, "not_addressable");
});

test("a device that is not in the active fleet is refused, not silently dropped", async () => {
  const app = await build();
  const { body } = await post(app, {
    brightnessPercent: 70, deviceIds: ["1000001", "9999999"], dryRun: true,
  });
  assert.equal(body.data.plan.length, 2, "every requested device is accounted for");
  assert.equal(body.data.plan.find((i: any) => i.deviceId === "9999999").reason, "not_found");
});

// ─── 7. a stale confirmation is refused ─────────────────────────────────────

test("a commit confirmed against a stale preview is refused before anything is sent", async () => {
  const { repo, logged } = stubRepo();
  const stub = stubVideri();
  const app = await build({ repo, videri: stub.videri });
  const { statusCode, body } = await post(app, {
    brightnessPercent: 70,
    deviceIds: FLEET.map((d) => d.id),
    confirm: true,
    // The operator approved a preview of 5; the plan now attempts 3.
    expectedAttemptCount: 5,
  });
  assert.equal(statusCode, 409);
  assert.equal(body.error, "plan_changed");
  assert.equal(body.counts.attempt, 3);
  assert.deepEqual(stub.calls, []);
  assert.deepEqual(logged, []);
});

test("a matching expectedAttemptCount lets the commit through", async () => {
  const { repo } = stubRepo();
  const app = await build({ repo, videri: stubVideri().videri });
  const { statusCode, body } = await post(app, {
    brightnessPercent: 70,
    deviceIds: FLEET.map((d) => d.id),
    confirm: true,
    expectedAttemptCount: 3,
  });
  assert.equal(statusCode, 200);
  assert.equal(body.data.counts.byOutcome.verified, 3);
});

// ─── input validation ───────────────────────────────────────────────────────

test("brightness 0 is not reachable here — it is display-off, not a brightness", async () => {
  const app = await build();
  const { statusCode, body } = await post(app, {
    brightnessPercent: 0, deviceIds: ["1000001"], dryRun: true,
  });
  assert.equal(statusCode, 400);
  assert.equal(body.error, "bad_request");
});

test("an empty device list is a 400, not an empty successful batch", async () => {
  const app = await build();
  const { statusCode } = await post(app, {
    brightnessPercent: 70, deviceIds: [], dryRun: true,
  });
  assert.equal(statusCode, 400);
});
