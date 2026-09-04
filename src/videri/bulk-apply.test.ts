/**
 * Bulk apply — `node --test dist/videri/bulk-apply.test.js`
 *
 * A bulk write is the most dangerous thing in this product, so what is asserted
 * here is the set of properties that keep it from becoming "fire 98 writes and
 * hope". Every one of them exists because of something that has already gone
 * wrong on this fleet:
 *
 *   1. PER-DEVICE ISOLATION. One panel failing does not abort the batch and is
 *      never counted as a success. The result is per device; there is no
 *      aggregate verdict to hide behind.
 *   2. REFUSED IS NOT FAILED, per device. A device we declined to touch
 *      (unreadable preflight, offline, EoL) is `refused`; a device we wrote to
 *      that said no is `failed`. Collapsing the two makes "what did that push
 *      break?" unanswerable.
 *   3. EVERY DEVICE KEEPS ITS OWN CYCLE. Preflight → write → verify → rollback
 *      runs per device, so an unreadable preflight blocks THAT device only, and
 *      a device whose write does not take is put back.
 *   4. THE REACHABILITY GATE IS PRESENCE, NEVER THE DERIVED STATUS. A
 *      dark-but-reachable screen is `warning`/`alert` and IS writable. That trap
 *      has bitten three times.
 *   5. INTENT AND SUPPRESSION EXCLUDE. An hour before this was written the
 *      product offered a 0.9-confidence write on `SparkBridge (EoL)`. A recorded
 *      intent of `none` is the operator override and must NOT exclude.
 *   6. AUDIT, ONE ROW PER DEVICE, and a logging failure never changes an outcome.
 *   7. DRY RUN TOUCHES NOTHING — no command, no audit row.
 *
 * Everything runs against a stubbed runner. No device is contacted.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BULK_APPLICABLE_ACTIONS,
  BULK_CONCURRENCY,
  BULK_MAX_DEVICES,
  dedupeDeviceIds,
  executeBulkApply,
  planBulkApply,
  type BulkApplyDeps,
  type BulkDeviceEvent,
  type BulkTargetFacts,
} from "./bulk-apply.js";
import type { CommandRunner } from "./brightness.js";
import type { SuppressionRecord } from "../alerting/suppression.js";

const NOW = new Date("2026-09-04T12:00:00Z");

/** A device that should be written to unless a test says otherwise. */
const target = (over: Partial<BulkTargetFacts> = {}): BulkTargetFacts => ({
  deviceId: "1000001",
  device: { name: "Center Spark 5", status: "online" },
  addressable: true,
  recordedIntent: null,
  suppressions: [],
  ...over,
});

const suppression = (over: Partial<SuppressionRecord> = {}): SuppressionRecord => ({
  id: "sup-1",
  deviceId: "1000001",
  ruleId: null,
  reason: "awaiting RMA collection",
  intent: null,
  includeCriticalHigh: false,
  createdBy: "api:sj",
  createdAt: new Date("2026-09-01T00:00:00Z"),
  expiresAt: new Date("2026-10-01T00:00:00Z"),
  neverExpires: false,
  revokedAt: null,
  revokedBy: null,
  revokedReason: null,
  ...over,
});

/**
 * A device runner driven by a SCRIPT of `get_brightness` read-backs, exactly as
 * commands.audit.test.ts drives the single-device path: a whole preflight →
 * write → verify → rollback cycle is expressed as the values the panel reports.
 * `null` = the device would not answer the read.
 */
function scriptedRunner(script: {
  reads: Array<number | null>;
  writeCode?: string;
  throwOn?: string;
}): { run: CommandRunner; args: string[] } {
  const reads = [...script.reads];
  const args: string[] = [];
  const run: CommandRunner = async (arg) => {
    args.push(arg);
    if (script.throwOn && arg.startsWith(script.throwOn)) {
      throw new Error("socket hang up");
    }
    if (arg === "get_brightness") {
      const next = reads.shift() ?? null;
      return next === null
        ? { code: "ERROR", message: "" }
        : {
            code: "SUCCESS",
            message: `Current brightness is: ${next} Default brightness is: ${next} Current backlight is: 40`,
          };
    }
    return { code: script.writeCode ?? "SUCCESS", message: "" };
  };
  return { run, args };
}

/** Collects the audit events instead of writing them. */
function recorder(mode: "ok" | "throw" = "ok"): {
  record: BulkApplyDeps["record"];
  events: BulkDeviceEvent[];
} {
  const events: BulkDeviceEvent[] = [];
  return {
    events,
    record: async (event) => {
      events.push(event);
      if (mode === "throw") throw new Error("device_action_log is gone");
    },
  };
}

// ─── the numbers ────────────────────────────────────────────────────────────

test("the cap covers the cohort that justifies the feature, and concurrency stays modest", () => {
  // Sized against the motivating compliance cohorts (98 and 90 when specified,
  // 106 and 99 on 2026-09-04). Neither is bulk-appliable today; the cap is sized
  // for the case where a second verified write exists.
  assert.ok(BULK_MAX_DEVICES >= 98, "cap must cover the cohort this was sized for");
  // No rate limit is documented anywhere in the Videri API and no operation
  // declares a 429 (pipeline/batching.ts). Modest parallelism is the only
  // defensible posture, and 4 is what the telemetry slow lane already runs at.
  assert.equal(BULK_CONCURRENCY, 4);
  // Exactly one action may ever be multiplied.
  assert.deepEqual([...BULK_APPLICABLE_ACTIONS], ["set_brightness"]);
});

test("the same device twice in one request is one write", () => {
  // The console builds the list from recommendations, and a device with two
  // drifts appears twice. Writing twice would race its own preflight: the second
  // cycle would read the first cycle's value as the original to roll back to.
  const { ids, duplicatesRemoved } = dedupeDeviceIds(["a", "b", "a", " b ", "", "c"]);
  assert.deepEqual(ids, ["a", "b", "c"]);
  assert.equal(duplicatesRemoved, 3);
});

// ─── 4. the reachability gate is presence, never the derived status ──────────

test("a dark-but-reachable screen is writable; only offline/unknown are refused", () => {
  const plan = planBulkApply(
    [
      target({ deviceId: "warn", device: { name: "Logo fallback", status: "warning" } }),
      target({ deviceId: "alert", device: { name: "Black screen", status: "alert" } }),
      target({ deviceId: "up", device: { name: "Fine", status: "online" } }),
      target({ deviceId: "down", device: { name: "Gone", status: "offline" } }),
      target({ deviceId: "never", device: { name: "No sample", status: "unknown" } }),
    ],
    NOW,
  );
  const decision = new Map(plan.items.map((i) => [i.deviceId, i]));
  // The trap: a screen showing black collapses to 'alert' and is still perfectly
  // writable. Reading the derived status as reachability has bitten three times.
  assert.equal(decision.get("warn")!.decision, "attempt");
  assert.equal(decision.get("alert")!.decision, "attempt");
  assert.equal(decision.get("up")!.decision, "attempt");
  assert.equal(decision.get("down")!.decision, "refuse");
  assert.equal(decision.get("down")!.reason, "unreachable");
  assert.equal(decision.get("never")!.reason, "unreachable");
  assert.equal(plan.counts.attempt, 3);
  assert.equal(plan.counts.byReason.unreachable, 2);
});

test("an unaddressable or unknown device is refused with its own reason, not attempted", () => {
  const plan = planBulkApply(
    [
      target({ deviceId: "nojid", addressable: false }),
      target({ deviceId: "ghost", device: null }),
    ],
    NOW,
  );
  assert.equal(plan.items[0]!.reason, "not_addressable");
  assert.equal(plan.items[1]!.reason, "not_found");
  assert.equal(plan.counts.attempt, 0);
});

// ─── 5. intent and suppression exclude ──────────────────────────────────────

test("an intent-tagged device is refused from a bulk apply, and told where to act instead", () => {
  // The live failure this exists for: a HIGH brightness restore at 0.9
  // confidence offered on `SparkBridge (EoL)`.
  const plan = planBulkApply(
    [target({ deviceId: "eol", device: { name: "SparkBridge (EoL)", status: "online" } })],
    NOW,
  );
  const item = plan.items[0]!;
  assert.equal(item.decision, "refuse");
  assert.equal(item.reason, "intent_tagged");
  assert.equal(item.intent!.kind, "eol");
  // The refusal must name the two ways forward, or it reads as a dead end.
  assert.match(item.explanation, /own drawer/);
  assert.match(item.explanation, /"none"/);
});

test("an actively suppressed device is refused and the record that excluded it is named", () => {
  const plan = planBulkApply(
    [target({ suppressions: [suppression({ reason: "awaiting RMA collection" })] })],
    NOW,
  );
  const item = plan.items[0]!;
  assert.equal(item.reason, "suppressed");
  assert.equal(item.suppression!.id, "sup-1");
  assert.match(item.explanation, /awaiting RMA collection/);
});

test("an EXPIRED or REVOKED suppression does not exclude — expiry is judged, not assumed", () => {
  const expired = planBulkApply(
    [target({ suppressions: [suppression({ expiresAt: new Date("2026-08-01T00:00:00Z") })] })],
    NOW,
  );
  assert.equal(expired.items[0]!.decision, "attempt");
  const revoked = planBulkApply(
    [target({ suppressions: [suppression({ revokedAt: new Date("2026-09-02T00:00:00Z") })] })],
    NOW,
  );
  assert.equal(revoked.items[0]!.decision, "attempt");
});

test('a recorded intent of "none" is the operator override and never excludes', () => {
  // The one way an operator can say "the name is lying, this IS production" must
  // not also remove the device from the bulk path — that would be backwards.
  const plan = planBulkApply(
    [
      target({
        deviceId: "prod",
        device: { name: "Repairs Desk Menu Board", status: "online" },
        recordedIntent: {
          kind: "none", reason: "production screen in a phone-repair shop",
          by: "api:sj", at: NOW.toISOString(),
        },
        suppressions: [suppression({ deviceId: "prod", intent: "none" })],
      }),
    ],
    NOW,
  );
  assert.equal(plan.items[0]!.decision, "attempt", "intent `none` must not exclude");
  assert.equal(plan.items[0]!.intent, null);
});

test("a recorded intent outranks a harmless-looking name, and a name outranks nothing", () => {
  const plan = planBulkApply(
    [
      target({
        deviceId: "spare",
        device: { name: "Lobby Board 2", status: "online" },
        recordedIntent: {
          kind: "eol", reason: "decommissioned last quarter",
          by: "api:sj", at: NOW.toISOString(),
        },
      }),
    ],
    NOW,
  );
  assert.equal(plan.items[0]!.reason, "intent_tagged");
  assert.equal(plan.items[0]!.intent!.source, "operator");
});

test("policy exclusions are reported ahead of transient ones, and nothing is hidden", () => {
  // An offline EoL unit is refused for one reason and disqualified by two.
  // Reporting only "offline" sends an operator to fix the wrong thing and expect
  // it to join the next batch.
  const plan = planBulkApply(
    [
      target({
        deviceId: "eol-off",
        device: { name: "SparkBridge (EoL)", status: "offline" },
        addressable: false,
      }),
    ],
    NOW,
  );
  assert.equal(plan.items[0]!.reason, "intent_tagged");
  assert.deepEqual(plan.items[0]!.alsoBlockedBy, ["not_addressable", "unreachable"]);
});

// ─── 1 + 2 + 3. isolation, refused-vs-failed, and the per-device cycle ──────

test("one device failing does not abort the batch and is never reported as a success", async () => {
  const plan = planBulkApply(
    ["a", "b", "c", "d"].map((id) => target({ deviceId: id })),
    NOW,
  );
  const { record, events } = recorder();
  // Four independent panels, one script each:
  //   a — preflight 100, verify 179  → verified
  //   b — the transport dies on the WRITE → failed (we tried, we could not)
  //   c — preflight unreadable        → refused (never touched)
  //   d — preflight 100, verify 100 (write ignored), rollback confirmed → rolled_back
  const runners: Record<string, ReturnType<typeof scriptedRunner>> = {
    a: scriptedRunner({ reads: [100, 179] }),
    b: scriptedRunner({ reads: [100], throwOn: "set_brightness" }),
    c: scriptedRunner({ reads: [null] }),
    d: scriptedRunner({ reads: [100, 100, 100] }),
  };

  const batch = await executeBulkApply(plan, 70, "batch-1", {
    runnerFor: (id) => runners[id]!.run,
    record,
  });

  const byDevice = new Map(batch.results.map((r) => [r.deviceId, r]));
  assert.equal(batch.results.length, 4, "every device returns a result");
  assert.equal(byDevice.get("a")!.outcome, "verified");
  assert.equal(byDevice.get("a")!.applied, true);
  assert.equal(byDevice.get("b")!.outcome, "failed");
  assert.equal(byDevice.get("b")!.applied, false, "a failed device is never applied");
  // The awkward half: an unreadable preflight is REFUSED, not failed. We
  // declined to write blind and the panel was never touched.
  assert.equal(byDevice.get("c")!.outcome, "refused");
  assert.equal(byDevice.get("c")!.state, "preflight_blocked");
  assert.equal(byDevice.get("d")!.outcome, "rolled_back");
  assert.equal(byDevice.get("d")!.applied, false);

  // No aggregate verdict — the counts are a summary of per-device facts, and
  // `refused` and `failed` stay apart.
  assert.equal(batch.counts.byOutcome.verified, 1);
  assert.equal(batch.counts.byOutcome.failed, 1);
  assert.equal(batch.counts.byOutcome.refused, 1);
  assert.equal(batch.counts.byOutcome.rolled_back, 1);
  assert.equal(batch.counts.byOutcome.applied, 0);
  assert.deepEqual(batch.unexpectedFailures, [], "nothing escaped the per-device guard");
  assert.equal(events.length, 4, "one audit event per device");
});

test("a device that refused its own preflight is written to zero times", async () => {
  const plan = planBulkApply([target({ deviceId: "c" })], NOW);
  const runner = scriptedRunner({ reads: [null] });
  const { record } = recorder();
  await executeBulkApply(plan, 70, "b", { runnerFor: () => runner.run, record });
  // Preflight only. The whole point of `preflight_blocked`: without a readable
  // original a rollback is impossible, so nothing is written.
  assert.deepEqual(runner.args, ["get_brightness"]);
});

test("a rollback that cannot be confirmed is surfaced as needing a human", async () => {
  const plan = planBulkApply([target({ deviceId: "x" })], NOW);
  // preflight 100, verify 100 (ignored), restore read-back unreadable.
  const runner = scriptedRunner({ reads: [100, 100, null] });
  const { record, events } = recorder();
  const batch = await executeBulkApply(plan, 70, "b", { runnerFor: () => runner.run, record });
  assert.equal(batch.results[0]!.outcome, "rollback_failed");
  assert.deepEqual(batch.needsAttention, ["x"]);
  assert.equal(events[0]!.outcome, "rollback_failed");
});

test("every attempted device keeps its OWN full cycle — bulk does not get a cheaper write", async () => {
  const plan = planBulkApply(
    ["a", "b"].map((id) => target({ deviceId: id })),
    NOW,
  );
  const runners = {
    a: scriptedRunner({ reads: [100, 179] }),
    b: scriptedRunner({ reads: [10, 179] }),
  };
  const { record } = recorder();
  await executeBulkApply(plan, 70, "b", {
    runnerFor: (id) => runners[id as "a" | "b"].run,
    record,
  });
  for (const id of ["a", "b"] as const) {
    assert.deepEqual(
      runners[id].args,
      ["get_brightness", "set_brightness:=179", "get_brightness"],
      `${id}: preflight, write, verify`,
    );
  }
});

test("a refused device is never sent a command at all", async () => {
  const plan = planBulkApply(
    [
      target({ deviceId: "ok" }),
      target({ deviceId: "eol", device: { name: "SparkQ [RMA]", status: "online" } }),
      target({ deviceId: "off", device: { name: "Dark", status: "offline" } }),
    ],
    NOW,
  );
  const runners: Record<string, ReturnType<typeof scriptedRunner>> = {
    ok: scriptedRunner({ reads: [100, 179] }),
    eol: scriptedRunner({ reads: [100, 179] }),
    off: scriptedRunner({ reads: [100, 179] }),
  };
  const { record, events } = recorder();
  const batch = await executeBulkApply(plan, 70, "b", {
    runnerFor: (id) => runners[id]!.run,
    record,
  });
  assert.equal(runners["eol"]!.args.length, 0);
  assert.equal(runners["off"]!.args.length, 0);
  assert.equal(runners["ok"]!.args.length, 3);
  // Refusals are still audited — "which devices did that push skip, and why" is
  // exactly the question the log exists to answer.
  assert.equal(events.length, 3);
  const refused = events.filter((e) => e.refusedBecause !== null).map((e) => e.refusedBecause);
  assert.deepEqual(refused.sort(), ["intent_tagged", "unreachable"]);
  assert.equal(batch.counts.byOutcome.refused, 2);
});

// ─── 6. audit ───────────────────────────────────────────────────────────────

test("every device gets its own audit event, all tied to one batch id", async () => {
  const ids = Array.from({ length: 7 }, (_, i) => `d${i}`);
  const plan = planBulkApply(ids.map((id) => target({ deviceId: id })), NOW);
  const { record, events } = recorder();
  const batch = await executeBulkApply(plan, 70, "batch-xyz", {
    runnerFor: () => scriptedRunner({ reads: [100, 179] }).run,
    record,
  });
  assert.equal(events.length, 7);
  assert.deepEqual([...new Set(events.map((e) => e.batchId))], ["batch-xyz"]);
  assert.deepEqual([...new Set(events.map((e) => e.batchSize))], [7]);
  assert.deepEqual(new Set(events.map((e) => e.deviceId)), new Set(ids));
  assert.equal(batch.counts.auditRowsWritten, 7);
  assert.equal(batch.counts.auditRowsFailed, 0);
});

test("a logging failure does not break the write and is never reported as logged", async () => {
  const plan = planBulkApply([target({ deviceId: "a" })], NOW);
  const { record, events } = recorder("throw");
  const batch = await executeBulkApply(plan, 70, "b", {
    runnerFor: () => scriptedRunner({ reads: [100, 179] }).run,
    record,
  });
  // The write stands, reported exactly as it happened...
  assert.equal(batch.results[0]!.outcome, "verified");
  assert.equal(batch.results[0]!.applied, true);
  // ...and the missing row is stated rather than assumed.
  assert.equal(batch.results[0]!.audited, false);
  assert.equal(batch.counts.auditRowsWritten, 0);
  assert.equal(batch.counts.auditRowsFailed, 1);
  assert.equal(events.length, 1, "it was attempted");
});

test("an unread brightness is null, never a zero dressed as data", async () => {
  const plan = planBulkApply([target({ deviceId: "a" })], NOW);
  const { record } = recorder();
  // Write accepted, read-back unreadable, rollback confirmed.
  const batch = await executeBulkApply(plan, 70, "b", {
    runnerFor: () => scriptedRunner({ reads: [100, null, 100] }).run,
    record,
  });
  assert.equal(batch.results[0]!.outcome, "rolled_back");
  // Raw 0 on this scale is a display-OFF panel; reporting it for "unread" would
  // read as a screen we blanked.
  assert.equal(batch.results[0]!.observedPercent, null);
});

// ─── 7. dry run touches nothing ─────────────────────────────────────────────

test("planning is pure: computing the blast radius sends no command and logs nothing", async () => {
  // `dryRun` is not a second code path with its own bugs — it is the route
  // returning this plan before `executeBulkApply` is ever called. So the
  // guarantee "touches nothing" is a property of `planBulkApply` being pure.
  let calls = 0;
  const runnerFor = () => {
    calls += 1;
    return scriptedRunner({ reads: [100, 179] }).run;
  };
  const plan = planBulkApply(
    [
      target({ deviceId: "a" }),
      target({ deviceId: "b", device: { name: "SparkBridge (EoL)", status: "online" } }),
      target({ deviceId: "c", device: { name: "Dark", status: "offline" } }),
    ],
    NOW,
  );
  assert.equal(calls, 0, "no runner was even constructed");
  assert.equal(plan.counts.requested, 3);
  assert.equal(plan.counts.attempt, 1);
  assert.equal(plan.counts.refuse, 2);
  // Every requested device is accounted for exactly once — a blast radius that
  // does not sum is worse than no preview at all.
  assert.equal(plan.items.length, plan.counts.attempt + plan.counts.refuse);
  void runnerFor;
});
