/**
 * Alert hygiene tests — `node --test dist/alerting/hygiene.test.js`
 *
 * Two things are being defended here, and they pull in opposite directions:
 *
 *   1. The list must be short enough that an operator finishes reading it.
 *   2. Nothing may disappear. Every alert must still be counted, and the counts
 *      must still add up, or the surface is worse than the noisy one it replaced.
 *
 * So the chips-sum invariant is asserted on every shape, including the awkward
 * ones (empty, all-dormant, an unrecognised severity), and the return-to-life
 * path is tested from both ends: the classifier must stop calling a device
 * dormant, and the engine must resolve the alert that made it dormant.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyOpenAlerts,
  chipsSumToTotal,
  type OpenAlertFact,
  type DeviceDarkFact,
} from "./hygiene.js";
import {
  DEFAULT_RULES,
  dormantRuleIds,
  dormantAfterSeconds,
  alertClassOf,
  validateRule,
  type AlertRule,
} from "./rules.js";
import { evaluateRule, type SampleRow, type DeviceRow } from "./evaluate.js";
import { runAlerting, loadRules } from "./engine.js";
import type { Repository, OpenAlertRow } from "../db/repository.js";
import type { Severity } from "../domain/types.js";

const NOW = new Date("2026-09-01T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

let seq = 0;
const alert = (over: Partial<OpenAlertFact> = {}): OpenAlertFact => ({
  id: `alert-${(seq += 1)}`,
  deviceId: "canvas-1",
  ruleId: "offline-30d",
  severity: "medium",
  openedAt: daysAgo(1),
  ...over,
});

const dark = (deviceId: string, days: number | null): DeviceDarkFact => ({
  deviceId,
  lastOnlineTime: days === null ? null : daysAgo(days),
});

const classify = (alerts: OpenAlertFact[], over: Partial<Parameters<typeof classifyOpenAlerts>[2]> = {}) =>
  classifyOpenAlerts(alerts, DEFAULT_RULES, { now: NOW, ...over });

// ─────────────────────────────────────────────────────────────────────────────
// The mechanism is driven by the rules, not by a second hardcoded list
// ─────────────────────────────────────────────────────────────────────────────

test("dormant rule ids come from the rule set", () => {
  const ids = dormantRuleIds(DEFAULT_RULES);
  assert.deepEqual([...ids].sort(), ["offline-30d", "offline-6mo"]);
  // The rules that describe a LIVE device's outage must never be dormant.
  for (const id of ["offline-30m", "offline-4h", "black-screen", "showing-logo"]) {
    assert.equal(ids.has(id), false, `${id} must stay an incident`);
  }
});

test("the dormancy boundary is the shortest dormant rule's window", () => {
  assert.equal(dormantAfterSeconds(DEFAULT_RULES), 30 * 24 * 3600);
  // No dormant rule means no boundary — null, not a made-up default.
  assert.equal(dormantAfterSeconds(DEFAULT_RULES.filter((r) => alertClassOf(r) === "incident")), null);
});

test("dormancy may only be declared on an offline rule", () => {
  const bad = {
    kind: "state", id: "black-screen", name: "Screen is black", enabled: true,
    severity: "critical", field: "is_black_screen", equals: true,
    sustainedForSeconds: 300, minSamples: 3, clearForSeconds: 120,
    alertClass: "dormant",
  } as AlertRule;
  assert.deepEqual(validateRule(bad), ['alertClass "dormant" is only valid on an offline rule']);
});

test("offline-6mo extends the supersede chain so a long-dead device has ONE alert", () => {
  const sixMonth = DEFAULT_RULES.find((r) => r.id === "offline-6mo");
  assert.ok(sixMonth, "offline-6mo must exist");
  for (const outranked of ["offline-30m", "offline-4h", "offline-30d", "black-screen"]) {
    assert.ok(sixMonth.supersedes?.includes(outranked), `must supersede ${outranked}`);
  }
  assert.equal(sixMonth.severity, "info", "a screen dark for years is not an incident");
});

// ─────────────────────────────────────────────────────────────────────────────
// Classification boundaries
// ─────────────────────────────────────────────────────────────────────────────

test("a dormant-classed alert lands in the dormant band, not the incident list", () => {
  const view = classify([alert({ ruleId: "offline-30d" })]);
  assert.equal(view.incidents.total, 0);
  assert.equal(view.dormant.total, 1);
  assert.equal(view.totalOpen, 1, "still open, still counted");
  assert.ok(chipsSumToTotal(view));
});

test("a NEW outage on a live device stays an incident at full severity", () => {
  const view = classify([
    alert({ deviceId: "live-1", ruleId: "offline-4h", severity: "critical" }),
    alert({ deviceId: "live-2", ruleId: "black-screen", severity: "critical" }),
  ]);
  assert.equal(view.incidents.total, 2);
  assert.equal(view.incidents.bySeverity.critical, 2);
  assert.equal(view.dormant.total, 0);
  assert.equal(view.rollup, null, "no dormant cohort, no rollup row");
});

test("un-actionable alerts on a dormant device roll up with the outage that explains them", () => {
  // The real shape on this fleet: 96 "firmware behind" alerts about devices
  // nobody can reach to update.
  const view = classify([
    alert({ deviceId: "dead-1", ruleId: "offline-30d" }),
    alert({ deviceId: "dead-1", ruleId: "firmware-behind", severity: "info" }),
    alert({ deviceId: "live-1", ruleId: "firmware-behind", severity: "info" }),
  ]);
  assert.equal(view.dormant.total, 2, "outage + the firmware alert about the same dark screen");
  assert.equal(view.incidents.total, 1, "the live device's firmware alert is still actionable");
  const absorbed = view.dormant.byRule.find((r) => r.ruleId === "firmware-behind");
  assert.equal(absorbed?.dormantRule, false, "absorbed by the device, not by its own rule");
  assert.ok(view.notes.some((n) => /Rolled up with the outage/.test(n)));
});

test("a CRITICAL on a dormant device is deliberately kept in the incident list", () => {
  // If something fires critical on a screen we believe has been dark for six
  // months, the device spoke. That is news, and burying it would be the exact
  // silent suppression this module exists to prevent.
  const view = classify([
    alert({ deviceId: "dead-1", ruleId: "offline-30d" }),
    alert({ deviceId: "dead-1", ruleId: "black-screen", severity: "critical" }),
    alert({ deviceId: "dead-1", ruleId: "showing-logo", severity: "high" }),
  ]);
  assert.equal(view.incidents.total, 2);
  assert.equal(view.incidents.bySeverity.critical, 1);
  assert.equal(view.incidents.bySeverity.high, 1);
  assert.equal(view.dormant.total, 1);
  assert.ok(view.notes.some((n) => /deliberately KEPT/.test(n)));
  assert.ok(chipsSumToTotal(view));
});

test("a device that returns to life stops being dormant", () => {
  const withOutage = [
    alert({ deviceId: "back-1", ruleId: "offline-30d" }),
    alert({ deviceId: "back-1", ruleId: "firmware-behind", severity: "info" }),
  ];
  assert.equal(classify(withOutage).dormant.total, 2);

  // The engine resolves the offline alert when presence returns, so it leaves
  // the open set — and with it, the device's dormancy. Nothing needs clearing
  // by hand, and the firmware alert becomes actionable again the moment the
  // device is reachable.
  const afterRecovery = withOutage.filter((a) => a.ruleId !== "offline-30d");
  const view = classify(afterRecovery);
  assert.equal(view.dormant.total, 0);
  assert.equal(view.incidents.total, 1);
  assert.equal(view.rollup, null);
  assert.ok(chipsSumToTotal(view));
});

test("engine queues the dormancy alert for resolution once presence returns", async () => {
  const samples: SampleRow[] = [0, 1, 2, 3].map((i) => baseSample(i, "online"));
  const input = new Map([["canvas-1", { device: liveDevice(), samples }]]);
  const open: OpenAlertRow[] = [
    {
      id: "alert-1", device_id: "canvas-1", rule_id: "offline-30d", severity: "medium",
      title: "Device dark for over 30 days", evidence: "old", opened_at: daysAgo(40),
      last_fired_at: minutesAgo(30), acknowledged_at: null,
    } as OpenAlertRow,
  ];
  const { repo, state } = stubRepo(input, open);
  const rule = DEFAULT_RULES.find((r) => r.id === "offline-30d")!;
  await runAlerting(repo, { rules: [rule], now: NOW });
  assert.deepEqual(state.resolved.map((r) => r.id), ["alert-1"]);
});

test("the offline-30d threshold is a boundary, not a vibe", () => {
  const rule = DEFAULT_RULES.find((r) => r.id === "offline-30d")!;
  const at = (days: number) =>
    evaluateRule(rule, {
      device: liveDevice({ lastOnlineTime: daysAgo(days) }),
      samples: [baseSample(0, "offline")],
      now: NOW,
    }).firing;
  assert.equal(at(29.9), false, "29.9 days is not yet dormant");
  assert.equal(at(30.1), true);
  assert.equal(at(400), true);
});

test("the engine counts dormant devices once, however many rules they trip", async () => {
  const input = new Map([
    ["canvas-1", { device: liveDevice({ lastOnlineTime: daysAgo(400) }), samples: [baseSample(0, "offline")] }],
  ]);
  const { repo } = stubRepo(input);
  const rules = DEFAULT_RULES.filter((r) => r.id === "offline-30d" || r.id === "offline-6mo");
  const result = await runAlerting(repo, { rules, now: NOW });
  assert.equal(result.dormantDevices, 1, "one dark asset, one entry in the count");
});

test("a field added in code survives a rule already stored in the database", async () => {
  // The bug this pins: `loadRules` used to replace the compiled rule with the
  // stored row wholesale, so `alertClass` — added after the row was seeded —
  // vanished, and 200 alerts sat in the incident list while the code believed
  // they were dormant. Nothing errored; the classification was simply absent.
  const storedWithoutAlertClass = DEFAULT_RULES.filter((r) => r.id === "offline-30d").map((r) => {
    const { alertClass, ...rest } = r as AlertRule & { alertClass?: unknown };
    return rest;
  });
  const repo = {
    async loadRuleDefinitions() { return storedWithoutAlertClass; },
  } as unknown as Repository;

  const loaded = await loadRules(repo);
  const offline30d = loaded.find((r) => r.id === "offline-30d")!;
  assert.equal(alertClassOf(offline30d), "dormant", "the new field must come from code");
  assert.ok(dormantRuleIds(loaded).has("offline-30d"));
});

test("an operator's stored value still wins over the compiled default", async () => {
  const tuned = { ...DEFAULT_RULES.find((r) => r.id === "offline-30d")!, forSeconds: 999, enabled: false };
  const repo = { async loadRuleDefinitions() { return [tuned]; } } as unknown as Repository;
  const loaded = await loadRules(repo);
  const offline30d = loaded.find((r) => r.id === "offline-30d")!;
  assert.equal(offline30d.kind === "offline" && offline30d.forSeconds, 999);
  assert.equal(offline30d.enabled, false, "merging must not resurrect a disabled rule");
});

test("a stored rule of a different kind replaces the default outright", async () => {
  // Merging across kinds would produce a shape satisfying neither branch of the
  // union — a rule with both `forSeconds` and `threshold`.
  const swapped = {
    kind: "metric", id: "offline-30d", name: "repurposed", enabled: true, severity: "medium",
    field: "cpu_percent", comparator: "gt", threshold: 90,
    sustainedForSeconds: 600, minSamples: 3, clearForSeconds: 0,
  };
  const repo = { async loadRuleDefinitions() { return [swapped]; } } as unknown as Repository;
  const loaded = await loadRules(repo);
  const rule = loaded.find((r) => r.id === "offline-30d")!;
  assert.equal(rule.kind, "metric");
  assert.equal("forSeconds" in rule, false, "no chimera");
});

// ─────────────────────────────────────────────────────────────────────────────
// The chips-sum invariant — broken once, guarded from now on
// ─────────────────────────────────────────────────────────────────────────────

test("chips sum to the total: nothing open", () => {
  const view = classify([]);
  assert.equal(view.totalOpen, 0);
  assert.ok(chipsSumToTotal(view));
  assert.equal(view.rollup, null);
  assert.ok(view.notes.length > 0, "an empty list still explains itself");
});

test("chips sum to the total: everything dormant", () => {
  const alerts = Array.from({ length: 40 }, (_, i) =>
    alert({ deviceId: `dead-${i}`, ruleId: "offline-30d" }),
  );
  const view = classify(alerts);
  assert.equal(view.incidents.total, 0);
  assert.equal(view.chips.filter((c) => c.inDefaultList).every((c) => c.count === 0), true);
  assert.equal(view.chips.find((c) => c.key === "dormant")?.count, 40);
  assert.ok(chipsSumToTotal(view));
});

test("chips sum to the total: the real fleet shape", () => {
  // 104 dormant outages, 96 firmware alerts on those same devices, plus the
  // live incidents that were being buried.
  const alerts: OpenAlertFact[] = [];
  for (let i = 0; i < 104; i += 1) {
    alerts.push(alert({ deviceId: `dead-${i}`, ruleId: "offline-30d" }));
    if (i < 96) alerts.push(alert({ deviceId: `dead-${i}`, ruleId: "firmware-behind", severity: "info" }));
  }
  for (let i = 0; i < 37; i += 1) {
    alerts.push(alert({ deviceId: `live-${i}`, ruleId: "offline-4h", severity: "critical" }));
  }
  for (let i = 0; i < 45; i += 1) {
    alerts.push(alert({ deviceId: `live-${i}`, ruleId: "firmware-behind", severity: "info" }));
  }
  const view = classify(alerts, { activeDeviceCount: 249 });

  assert.equal(view.totalOpen, 104 + 96 + 37 + 45);
  assert.equal(view.dormant.total, 200);
  assert.equal(view.incidents.total, 82);
  assert.equal(view.incidents.bySeverity.critical, 37, "the real criticals are still there");
  assert.ok(chipsSumToTotal(view));
});

test("alerts on retired devices are excluded but reconcilable, never mysterious", () => {
  // The live discrepancy this pins: /api/alerts counted 306 while the hygiene
  // view counted 304, because two open alerts sat on one retired device. A gap
  // nobody can explain is how a list stops being believed.
  const view = classify([alert({ deviceId: "live-1", ruleId: "offline-4h", severity: "critical" })], {
    retiredAlertCount: 2,
  });
  assert.equal(view.totalOpen, 1);
  assert.equal(view.excludedRetiredAlerts, 2);
  assert.ok(chipsSumToTotal(view), "the invariant is over the active estate");
  assert.ok(view.notes.some((n) => /reads 3 rather than 1/.test(n)));
});

test("an unrecognised severity is counted, not dropped — the invariant holds", () => {
  const view = classify([
    alert({ deviceId: "live-1", ruleId: "black-screen", severity: "catastrophic" as Severity }),
  ]);
  assert.equal(view.incidents.total, 1);
  assert.ok(chipsSumToTotal(view), "a row with a bad severity must not break the sum");
});

// ─────────────────────────────────────────────────────────────────────────────
// The rollup: discoverable, graded on the estate, never silent
// ─────────────────────────────────────────────────────────────────────────────

test("the rollup names the cohort, its size and how to find every row", () => {
  const alerts = [
    alert({ deviceId: "dead-1", ruleId: "offline-30d" }),
    alert({ deviceId: "dead-2", ruleId: "offline-6mo", severity: "info" }),
    alert({ deviceId: "dead-2", ruleId: "firmware-behind", severity: "info" }),
  ];
  const view = classify(alerts, {
    activeDeviceCount: 249,
    neverSeenDeviceCount: 14,
    darkness: [dark("dead-1", 45), dark("dead-2", 400)],
  });
  const rollup = view.rollup!;
  assert.equal(rollup.deviceCount, 2);
  assert.equal(rollup.alertCount, 3);
  assert.deepEqual(rollup.drilldown.deviceIds, ["dead-1", "dead-2"]);
  assert.equal(rollup.neverSeenDevices, 14);
  assert.match(rollup.evidence, /Nothing was resolved or hidden/);
  assert.match(rollup.evidence, /asset-register/);
  assert.ok(rollup.longestDarkSeconds! > 390 * 86_400);
  assert.deepEqual(
    rollup.darkness.map((b) => [b.label, b.devices]),
    [["30–90 days", 1], ["over a year", 1]],
  );
  assert.ok(view.notes.some((n) => /never been recorded\s+online/.test(n)));
});

test("the rollup is graded on the share of the estate, not on the rows inside it", () => {
  const cohort = (devices: number, estate: number | null) =>
    classify(
      Array.from({ length: devices }, (_, i) => alert({ deviceId: `dead-${i}`, ruleId: "offline-30d" })),
      { activeDeviceCount: estate },
    ).rollup!.severity;

  assert.equal(cohort(110, 249), "high", "45% of the estate dark is a serious estate finding");
  assert.equal(cohort(30, 249), "medium");
  assert.equal(cohort(5, 249), "info");
  assert.equal(cohort(5, null), "medium", "unknown estate size must not read as harmless");
});

test("a dormant device with no known last-online time is still counted", () => {
  const view = classify([alert({ deviceId: "dead-1", ruleId: "offline-30d" })], {
    darkness: [dark("dead-1", null)],
  });
  assert.deepEqual(
    view.rollup!.darkness.map((b) => [b.label, b.devices]),
    [["never seen online", 1]],
  );
});

test("with dormancy disabled everything is an incident, and the notes say so", () => {
  const rules = DEFAULT_RULES.map((r) =>
    alertClassOf(r) === "dormant" ? { ...r, enabled: false, alertClass: undefined } : r,
  ) as AlertRule[];
  const view = classifyOpenAlerts(
    [alert({ deviceId: "dead-1", ruleId: "offline-30d" })],
    rules,
    { now: NOW },
  );
  assert.equal(view.incidents.total, 1);
  assert.equal(view.dormant.total, 0);
  assert.ok(view.notes.some((n) => /No rule is classified dormant/.test(n)));
  assert.ok(chipsSumToTotal(view));
});

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function baseSample(minutes: number, presence: string): SampleRow {
  return {
    observedAt: minutesAgo(minutes), source: "status", presence,
    isScreenOn: null, isBlackScreen: null, showingLogo: null, downloading: null,
    pingQuality: null, playbackQuality: null, nowPlayingType: null, nowPlayingId: null,
    cpuPercent: null, ramPercent: null, temperatureC: null, wifiSignalDbm: null,
    packetLossPercent: null, jitterMs: null, ntpSyncPercent: null, storagePercent: null,
  };
}

const liveDevice = (over: Partial<DeviceRow> = {}): DeviceRow => ({
  id: "canvas-1", name: "Lobby North", location: "New York, NY",
  firmwareCurrent: "3.4.1", firmwareLatest: "3.4.1", components: {},
  lastOnlineTime: minutesAgo(1),
  ...over,
});

interface StubState {
  opened: Array<{ deviceId: string; ruleId: string; severity: string }>;
  resolved: Array<{ id: string; clearForSeconds: number }>;
}

function stubRepo(
  input: Map<string, { device: DeviceRow; samples: SampleRow[] }>,
  open: OpenAlertRow[] = [],
): { repo: Repository; state: StubState } {
  const state: StubState = { opened: [], resolved: [] };
  const repo = {
    async loadEvaluationInput() { return input; },
    async loadOpenAlerts() {
      return new Map(open.map((a) => [`${a.device_id}:${a.rule_id}`, a]));
    },
    async openAlert(a: { deviceId: string; ruleId: string; severity: string }) {
      state.opened.push(a); return true;
    },
    async touchAlerts(updates: unknown[]) { return updates.length; },
    async resolveStaleAlerts(candidates: Array<{ id: string; clearForSeconds: number }>) {
      state.resolved.push(...candidates); return candidates.length;
    },
  } as unknown as Repository;
  return { repo, state };
}
