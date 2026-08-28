/**
 * Alerting tests — `node --test dist/alerting/alerting.test.js`
 *
 * Alerting is the one subsystem where a subtle bug either wakes someone at 3am
 * over nothing, or stays silent through a real outage. Evaluation is pure, so it
 * is tested exhaustively; the engine is tested against a stub repository.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRule, formatDuration, type SampleRow, type DeviceRow } from "./evaluate.js";
import { DEFAULT_RULES, validateRule, requiredWindowSeconds, type AlertRule } from "./rules.js";
import { runAlerting, loadRules } from "./engine.js";
import { previewRule } from "./preview.js";
import { EQUIVALENT_RULES } from "./videri-cross-check.js";
import type { Repository, OpenAlertRow } from "../db/repository.js";

const NOW = new Date("2026-08-25T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

/** A sample with everything null unless specified — the realistic default. */
function sample(agoMinutes: number, over: Partial<SampleRow> = {}): SampleRow {
  return {
    observedAt: minutesAgo(agoMinutes),
    source: "metrics",
    presence: null, isScreenOn: null, isBlackScreen: null, showingLogo: null,
    downloading: null, pingQuality: null, playbackQuality: null,
    nowPlayingType: null, nowPlayingId: null,
    cpuPercent: null, ramPercent: null, temperatureC: null, wifiSignalDbm: null,
    packetLossPercent: null, jitterMs: null, ntpSyncPercent: null, storagePercent: null,
    ...over,
  };
}

const device = (over: Partial<DeviceRow> = {}): DeviceRow => ({
  id: "canvas-1", name: "Lobby North", location: "New York, NY",
  firmwareCurrent: "3.4.1", firmwareLatest: "3.4.1",
  components: { "com.videri.icanvasplayer": { current: "3.4.1", latest: "3.4.1" } },
  lastOnlineTime: minutesAgo(1),
  ...over,
});

/** A series of readings one minute apart, oldest first. */
const series = (
  values: Array<number | boolean | null>,
  field: keyof SampleRow,
): SampleRow[] =>
  values.map((v, i) => sample(values.length - 1 - i, { [field]: v } as Partial<SampleRow>));

const cpuRule = (over: Partial<Extract<AlertRule, { kind: "metric" }>> = {}) =>
  ({
    kind: "metric", id: "cpu-high", name: "CPU high", enabled: true, severity: "medium",
    field: "cpu_percent", comparator: "gt", threshold: 85,
    sustainedForSeconds: 600, minSamples: 3, clearForSeconds: 300, ...over,
  }) as AlertRule;

// ─────────────────────────────────────────────────────────────────────────────
// The invariant: missing data is not low data
// ─────────────────────────────────────────────────────────────────────────────

test("an unreadable metric does NOT fire a `gt` rule", () => {
  const v = evaluateRule(cpuRule(), {
    device: device(), samples: series([null, null, null, null], "cpuPercent"), now: NOW,
  });
  assert.equal(v.firing, false);
  assert.match(v.skipped ?? "", /not readable/);
});

test("an unreadable metric does NOT fire a `lt` rule — the dangerous case", () => {
  // This is the one that would carpet the fleet in false alerts if NULL were
  // treated as 0: "signal below -75 dBm" would match every unreadable device.
  const rule = cpuRule({
    id: "wifi-weak", field: "wifi_signal_dbm", comparator: "lt", threshold: -75,
  });
  const v = evaluateRule(rule, {
    device: device(), samples: series([null, null, null, null, null], "wifiSignalDbm"), now: NOW,
  });
  assert.equal(v.firing, false, "NULL must never satisfy a less-than comparator");
  assert.match(v.skipped ?? "", /not readable/);
});

test("a partially readable metric is still judged on the readings that exist", () => {
  const samples = [
    sample(12, { cpuPercent: 92 }),
    sample(8, { cpuPercent: null }),
    sample(4, { cpuPercent: 94 }),
    sample(0, { cpuPercent: 91 }),
  ];
  const v = evaluateRule(cpuRule({ minSamples: 3, sustainedForSeconds: 600 }), {
    device: device(), samples, now: NOW,
  });
  assert.equal(v.firing, true, "nulls should be skipped, not treated as breaking the run");
});

// ─────────────────────────────────────────────────────────────────────────────
// Sustain, minSamples, sparsity
// ─────────────────────────────────────────────────────────────────────────────

test("does not fire before the sustain window has elapsed", () => {
  // Three readings over 2 minutes, but the rule wants 10.
  const samples = [
    sample(2, { cpuPercent: 95 }), sample(1, { cpuPercent: 96 }), sample(0, { cpuPercent: 97 }),
  ];
  const v = evaluateRule(cpuRule({ sustainedForSeconds: 600 }), { device: device(), samples, now: NOW });
  assert.equal(v.firing, false);
  assert.match(v.skipped ?? "", /has held 2 min, needs 10 min/);
});

test("fires once the condition has held long enough", () => {
  const samples = series([90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 91, 92], "cpuPercent");
  const v = evaluateRule(cpuRule({ sustainedForSeconds: 600, minSamples: 3 }), {
    device: device(), samples, now: NOW,
  });
  assert.equal(v.firing, true, v.skipped);
});

test("enforces minSamples even when the span is satisfied", () => {
  const samples = [sample(30, { cpuPercent: 95 }), sample(0, { cpuPercent: 96 })];
  const v = evaluateRule(cpuRule({ sustainedForSeconds: 600, minSamples: 5 }), {
    device: device(), samples, now: NOW,
  });
  assert.equal(v.firing, false);
  assert.match(v.skipped ?? "", /need 5/);
});

test("rejects a run stitched across too large a gap", () => {
  // Three readings, but spread across hours — not evidence of a continuous
  // condition, just three coincidences.
  const samples = [
    sample(240, { cpuPercent: 95 }), sample(120, { cpuPercent: 96 }), sample(0, { cpuPercent: 97 }),
  ];
  const v = evaluateRule(cpuRule({ sustainedForSeconds: 600, minSamples: 3 }), {
    device: device(), samples, now: NOW,
  });
  assert.equal(v.firing, false);
  assert.match(v.skipped ?? "", /too sparse/);
});

test("a single good reading breaks the run", () => {
  // Newest first: 95, 96, then 40 — the condition is not continuous.
  const samples = [
    sample(20, { cpuPercent: 99 }), sample(15, { cpuPercent: 98 }),
    sample(10, { cpuPercent: 40 }), sample(5, { cpuPercent: 96 }), sample(0, { cpuPercent: 95 }),
  ];
  const v = evaluateRule(cpuRule({ sustainedForSeconds: 600, minSamples: 3 }), {
    device: device(), samples, now: NOW,
  });
  assert.equal(v.firing, false, "the 40% reading must break continuity");
});

test("evidence carries real numbers, not prose", () => {
  const samples = series([90, 92, 94, 96, 98, 91, 93, 95, 97, 99, 92, 94], "cpuPercent");
  const v = evaluateRule(cpuRule({ sustainedForSeconds: 600, minSamples: 3 }), {
    device: device(), samples, now: NOW,
  });
  assert.equal(v.firing, true);
  // The AI layer reads this string, and numericGrounding will check every
  // figure in the brief against the data — so the evidence must be concrete.
  assert.match(v.evidence, /85%/);
  assert.match(v.evidence, /Latest \d/);
  assert.match(v.evidence, /mean \d/);
  assert.match(v.evidence, /peak \d/);
});

// ─────────────────────────────────────────────────────────────────────────────
// State rules
// ─────────────────────────────────────────────────────────────────────────────

const blackScreenRule = DEFAULT_RULES.find((r) => r.id === "black-screen")!;

test("black screen fires when sustained", () => {
  const samples = series([true, true, true, true, true, true, true], "isBlackScreen");
  const v = evaluateRule(blackScreenRule, { device: device(), samples, now: NOW });
  assert.equal(v.firing, true, v.skipped);
  assert.match(v.evidence, /Screen is black/);
});

test("black screen does not fire when the screen recovered", () => {
  const samples = [
    sample(6, { isBlackScreen: true }), sample(4, { isBlackScreen: true }),
    sample(2, { isBlackScreen: false }), sample(0, { isBlackScreen: false }),
  ];
  const v = evaluateRule(blackScreenRule, { device: device(), samples, now: NOW });
  assert.equal(v.firing, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Offline
// ─────────────────────────────────────────────────────────────────────────────

const offline30 = DEFAULT_RULES.find((r) => r.id === "offline-30m")!;

test("offline fires after the threshold", () => {
  const samples = [
    sample(90, { presence: "offline" }), sample(60, { presence: "offline" }),
    sample(30, { presence: "offline" }), sample(0, { presence: "offline" }),
  ];
  const v = evaluateRule(offline30, {
    device: device({ lastOnlineTime: minutesAgo(95) }), samples, now: NOW,
  });
  assert.equal(v.firing, true, v.skipped);
  assert.match(v.evidence, /Offline for/);
});

test("offline does not fire for a present device", () => {
  const v = evaluateRule(offline30, {
    device: device(), samples: [sample(0, { presence: "online" })], now: NOW,
  });
  assert.equal(v.firing, false);
  assert.match(v.skipped ?? "", /currently present/);
});

test("offline falls back to the registry when we have no readings at all", () => {
  // A device we have never successfully polled must still be able to alert —
  // otherwise the most broken devices are the quietest.
  const v = evaluateRule(offline30, {
    device: device({ lastOnlineTime: minutesAgo(300) }), samples: [], now: NOW,
  });
  assert.equal(v.firing, true, v.skipped);
  assert.match(v.evidence, /No presence reading/);
});

test("offline cannot be judged with neither readings nor last_online_time", () => {
  const v = evaluateRule(offline30, {
    device: device({ lastOnlineTime: null }), samples: [], now: NOW,
  });
  assert.equal(v.firing, false);
  assert.match(v.skipped ?? "", /cannot judge/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Firmware
// ─────────────────────────────────────────────────────────────────────────────

test("firmware rule names the components that are behind", () => {
  const rule = DEFAULT_RULES.find((r) => r.id === "firmware-behind")!;
  // Live data reports up to 16 packages per device, each with its own versions.
  const behind = evaluateRule(rule, {
    device: device({
      components: {
        "com.videri.icanvasplayer": { current: "7.0.14", latest: "7.0.14" },
        "com.videri.adsync": { current: "5.1.1", latest: "6.4.10" },
        "com.videri.superuserservice": { current: "6.4.0", latest: "6.5.0" },
      },
    }),
    samples: [], now: NOW,
  });
  assert.equal(behind.firing, true);
  assert.match(behind.evidence, /2 of 3 components behind/);
  assert.match(behind.evidence, /com\.videri\.adsync 5\.1\.1 → 6\.4\.10/);
  // The component that IS current must not be named.
  assert.equal(/icanvasplayer/.test(behind.evidence), false);

  const current = evaluateRule(rule, { device: device(), samples: [], now: NOW });
  assert.equal(current.firing, false);
  assert.match(current.skipped ?? "", /all components current/);
});

test("firmware rule cannot be judged with no component data", () => {
  const rule = DEFAULT_RULES.find((r) => r.id === "firmware-behind")!;
  const v = evaluateRule(rule, { device: device({ components: {} }), samples: [], now: NOW });
  assert.equal(v.firing, false);
  assert.match(v.skipped ?? "", /no component versions/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule metadata
// ─────────────────────────────────────────────────────────────────────────────

test("Tier B rules are disabled after the live-API finding", () => {
  // super_props carries a software manifest, not runtime telemetry — there is no
  // CPU/RAM/temperature/signal/storage/NTP value anywhere (docs/05 §2). These
  // rules are retained but must stay off until a command-based collector exists.
  const tierB = ["cpu-high", "ram-high", "temp-high", "wifi-weak", "storage-full", "ntp-drift"];
  for (const id of tierB) {
    const rule = DEFAULT_RULES.find((r) => r.id === id);
    assert.ok(rule, `${id} should still be defined`);
    assert.equal(rule.enabled, false, `${id} must be disabled`);
  }
  // And the rules that DO work are still on.
  for (const id of ["offline-30m", "offline-4h", "black-screen", "showing-logo", "firmware-behind"]) {
    assert.equal(DEFAULT_RULES.find((r) => r.id === id)?.enabled, true, `${id} should be enabled`);
  }
});

test("no rule thresholds against the string quality signals", () => {
  // ping_quality / playback_quality are strings with an undocumented vocabulary.
  const offenders = DEFAULT_RULES.filter(
    (r) => r.kind === "metric" && /quality/.test(r.field),
  );
  assert.deepEqual(offenders, []);
});

test("cross-check equivalents cover every offline rule", () => {
  // The Videri cross-check maps their alertType → our rule ids. When a new
  // offline tier was added without updating that map, the cross-check reported
  // 0 agreements and 79 phantom blind spots against live data. This test makes
  // the two definitions impossible to drift apart silently.
  const ourOfflineRules = DEFAULT_RULES.filter((r) => r.kind === "offline").map((r) => r.id);
  const mapped = EQUIVALENT_RULES["offline"] ?? [];
  for (const id of ourOfflineRules) {
    assert.ok(mapped.includes(id), `"${id}" is missing from EQUIVALENT_RULES.offline`);
  }
});

test("every default rule is valid", () => {
  for (const rule of DEFAULT_RULES) {
    assert.deepEqual(validateRule(rule), [], `rule "${rule.id}" is invalid`);
  }
});

test("default rule ids are unique", () => {
  const ids = DEFAULT_RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("the evaluation window covers the longest rule", () => {
  // offline-4h is the longest at 4h; the window must exceed it with margin.
  assert.ok(requiredWindowSeconds(DEFAULT_RULES) >= 4 * 3600 * 1.5);
});

test("formatDuration reads naturally across scales", () => {
  assert.equal(formatDuration(45), "45 seconds");
  assert.equal(formatDuration(600), "10 minutes");
  assert.equal(formatDuration(3600 * 5), "5.0 hours");
  assert.equal(formatDuration(3600 * 72), "3 days");
});

// ─────────────────────────────────────────────────────────────────────────────
// Engine lifecycle
// ─────────────────────────────────────────────────────────────────────────────

interface StubState {
  opened: Array<{ deviceId: string; ruleId: string; severity: string }>;
  refreshed: Array<{ id: string; evidence: string }>;
  resolved: Array<{ id: string; clearForSeconds: number }>;
}

function stubRepo(
  input: Map<string, { device: DeviceRow; samples: SampleRow[] }>,
  open: OpenAlertRow[] = [],
): { repo: Repository; state: StubState } {
  const state: StubState = { opened: [], refreshed: [], resolved: [] };
  const repo = {
    async loadEvaluationInput() { return input; },
    async loadOpenAlerts() {
      return new Map(open.map((a) => [`${a.device_id}:${a.rule_id}`, a]));
    },
    async openAlert(a: { deviceId: string; ruleId: string; severity: string }) {
      state.opened.push(a); return true;
    },
    async touchAlerts(updates: Array<{ id: string; evidence: string }>) {
      state.refreshed.push(...updates); return updates.length;
    },
    async resolveStaleAlerts(candidates: Array<{ id: string; clearForSeconds: number }>) {
      state.resolved.push(...candidates); return candidates.length;
    },
  } as unknown as Repository;
  return { repo, state };
}

const openAlertRow = (over: Partial<OpenAlertRow> = {}): OpenAlertRow => ({
  id: "alert-1", device_id: "canvas-1", rule_id: "black-screen", severity: "critical",
  title: "Screen is black", evidence: "old evidence",
  opened_at: minutesAgo(60), last_fired_at: minutesAgo(1), acknowledged_at: null, ...over,
});

test("engine opens an alert for a new firing condition", async () => {
  const input = new Map([
    ["canvas-1", { device: device(), samples: series([true, true, true, true, true, true], "isBlackScreen") }],
  ]);
  const { repo, state } = stubRepo(input);
  const result = await runAlerting(repo, { rules: [blackScreenRule], now: NOW });

  assert.equal(result.opened, 1);
  assert.equal(state.opened[0]?.ruleId, "black-screen");
  assert.equal(state.opened[0]?.severity, "critical");
});

test("engine refreshes rather than duplicating an already-open alert", async () => {
  const input = new Map([
    ["canvas-1", { device: device(), samples: series([true, true, true, true, true, true], "isBlackScreen") }],
  ]);
  const { repo, state } = stubRepo(input, [openAlertRow()]);
  const result = await runAlerting(repo, { rules: [blackScreenRule], now: NOW });

  assert.equal(result.opened, 0, "must not open a second alert for the same condition");
  assert.equal(result.refreshed, 1);
  assert.notEqual(state.refreshed[0]?.evidence, "old evidence", "evidence should be updated");
});

test("engine queues a cleared alert for resolution with the rule's clear window", async () => {
  const input = new Map([
    ["canvas-1", { device: device(), samples: series([false, false, false], "isBlackScreen") }],
  ]);
  const { repo, state } = stubRepo(input, [openAlertRow()]);
  const result = await runAlerting(repo, { rules: [blackScreenRule], now: NOW });

  assert.equal(result.resolved, 1);
  // Flap suppression: resolution is deferred by the rule's clearForSeconds,
  // enforced in SQL against last_fired_at.
  assert.equal(state.resolved[0]?.clearForSeconds, blackScreenRule.clearForSeconds);
});

test("a superseding rule resolves the rule it outranks", async () => {
  const offline4h = DEFAULT_RULES.find((r) => r.id === "offline-4h")!;
  const samples = [
    sample(400, { presence: "offline" }), sample(300, { presence: "offline" }),
    sample(120, { presence: "offline" }), sample(0, { presence: "offline" }),
  ];
  const input = new Map([
    ["canvas-1", { device: device({ lastOnlineTime: minutesAgo(400) }), samples }],
  ]);
  // offline-30m is already open; offline-4h now fires and outranks it.
  const { repo, state } = stubRepo(input, [openAlertRow({ id: "a30", rule_id: "offline-30m" })]);
  const result = await runAlerting(repo, { rules: [offline30, offline4h], now: NOW });

  assert.equal(result.opened, 1, "the critical alert opens");
  assert.equal(state.opened[0]?.ruleId, "offline-4h");
  assert.equal(result.supersededResolved, 1, "the outranked alert is retired");
  // Superseded alerts resolve immediately — the duplicate should not linger.
  assert.equal(state.resolved.find((r) => r.id === "a30")?.clearForSeconds, 0);
});

test("engine reports Tier B rules as inert rather than silently quiet", async () => {
  // No telemetry readable at all — the likely production state until the
  // payload vocabulary is known.
  const input = new Map([
    ["canvas-1", { device: device(), samples: [sample(0, { presence: "online" })] }],
  ]);
  const { repo } = stubRepo(input);
  const result = await runAlerting(repo, { rules: [cpuRule()], now: NOW });

  assert.equal(result.opened, 0);
  const inert = result.inertRules.find((r) => r.ruleId === "cpu-high");
  assert.ok(inert, "an unjudgeable rule must be reported, not silently skipped");
  assert.equal(inert.tierB, true);
  assert.match(inert.reason, /not readable/);
});

test("engine rejects an invalid rule instead of evaluating it", async () => {
  const { repo } = stubRepo(new Map());
  const broken = { ...cpuRule({ minSamples: 0 }) } as AlertRule;
  const result = await runAlerting(repo, { rules: [broken], now: NOW });

  assert.equal(result.rulesEvaluated, 0);
  assert.ok(result.errors.some((e) => e.includes("minSamples")));
});

test("a disabled rule is not evaluated", async () => {
  const input = new Map([
    ["canvas-1", { device: device(), samples: series([true, true, true, true, true, true], "isBlackScreen") }],
  ]);
  const { repo } = stubRepo(input);
  const result = await runAlerting(repo, {
    rules: [{ ...blackScreenRule, enabled: false }], now: NOW,
  });
  assert.equal(result.opened, 0);
  assert.equal(result.rulesEvaluated, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Configurability: the engine must honour the database, not its own defaults
//
// This subsystem shipped with a real bug — it seeded `alert_rule_definitions`
// on startup and then evaluated the hardcoded DEFAULT_RULES anyway, so every
// threshold edit was silently discarded. These tests exist so it cannot recur.
// ─────────────────────────────────────────────────────────────────────────────

/** A repository stub that only answers rule-definition reads. */
function ruleStore(stored: unknown[]): Repository {
  return { async loadRuleDefinitions() { return stored; } } as unknown as Repository;
}

test("with an empty store the engine falls back to the code defaults", async () => {
  const rules = await loadRules(ruleStore([]));
  assert.deepEqual(rules, DEFAULT_RULES);
});

test("a stored threshold OVERRIDES the code default of the same id", async () => {
  const edited = { ...(blackScreenRule as Extract<AlertRule, { kind: "state" }>), sustainedForSeconds: 42 };
  const rules = await loadRules(ruleStore([edited]));

  const got = rules.find((r) => r.id === "black-screen") as Extract<AlertRule, { kind: "state" }>;
  assert.equal(got.sustainedForSeconds, 42, "the DB edit must win over the hardcoded default");
});

test("a rule added in code but never seeded still runs", async () => {
  // Only one rule is in the store, but the operator should not silently lose
  // the other twelve just because a migration has not run yet.
  const rules = await loadRules(ruleStore([blackScreenRule]));
  assert.equal(rules.length, DEFAULT_RULES.length);
  for (const d of DEFAULT_RULES) {
    assert.ok(rules.some((r) => r.id === d.id), `${d.id} disappeared`);
  }
});

test("disabling a rule in the store disables it in the engine", async () => {
  const off = { ...blackScreenRule, enabled: false };
  const rules = await loadRules(ruleStore([off]));
  assert.equal(rules.find((r) => r.id === "black-screen")!.enabled, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Preview: tell the operator what a threshold will do BEFORE they save it
// ─────────────────────────────────────────────────────────────────────────────

/** Preview needs both rule reads and evaluation input, so combine the stubs. */
function previewRepo(input: Map<string, { device: DeviceRow; samples: SampleRow[] }>): Repository {
  return {
    async loadEvaluationInput() { return input; },
    async loadRuleDefinitions() { return []; },
  } as unknown as Repository;
}

const blackFleet = (n: number, firing: number) =>
  new Map(
    Array.from({ length: n }, (_, i) => [
      `canvas-${i}`,
      {
        device: device({ id: `canvas-${i}`, name: `Screen ${i}` }),
        samples: series(Array(7).fill(i < firing), "isBlackScreen"),
      },
    ]),
  );

test("preview refuses to evaluate an invalid rule and says why", async () => {
  const p = await previewRule(previewRepo(blackFleet(10, 0)), cpuRule({ minSamples: 0 }));
  assert.equal(p.valid, false);
  assert.equal(p.devicesEvaluated, 0);
  assert.ok(p.problems.some((x) => x.includes("minSamples")));
});

test("preview counts what would fire without persisting anything", async () => {
  const repo = previewRepo(blackFleet(10, 3));
  const p = await previewRule(repo, blackScreenRule);

  assert.equal(p.valid, true);
  assert.equal(p.devicesEvaluated, 10);
  assert.equal(p.wouldFire, 3);
  assert.ok(Math.abs(p.fireRate - 0.3) < 1e-9);
  assert.ok(p.examples.length > 0, "an operator needs to see which devices");
  assert.match(p.examples[0]!.evidence, /black/i);
});

test("preview warns when a threshold matches most of the fleet", async () => {
  // The trap this catches: a rule that fires on nearly everything is a
  // definition of the fleet, not a detector of a problem.
  const p = await previewRule(previewRepo(blackFleet(10, 9)), blackScreenRule);
  assert.equal(p.wouldFire, 9);
  assert.match(p.assessment, /definition, not a detector/i);
});

test("preview says a rule on an unavailable metric will stay permanently silent", async () => {
  // cpu_percent is not readable on any Videri device. A rule on it is not
  // "quiet because the fleet is healthy" — it is structurally dead, and the
  // operator must be told the difference.
  const p = await previewRule(previewRepo(blackFleet(10, 0)), cpuRule());

  assert.equal(p.wouldFire, 0);
  assert.equal(p.notJudgeable, 10, "every device is unjudgeable, not merely passing");
  assert.match(p.assessment, /permanently silent/i);
  assert.ok(p.topSkipReason?.includes("cpu_percent"));
});

test("preview distinguishes a healthy fleet from an unreadable one", async () => {
  // Same zero firings, completely different meaning.
  const healthy = await previewRule(previewRepo(blackFleet(10, 0)), blackScreenRule);
  const dead = await previewRule(previewRepo(blackFleet(10, 0)), cpuRule());

  assert.equal(healthy.wouldFire, 0);
  assert.equal(dead.wouldFire, 0);
  // Same zero firings; opposite meanings, and the counters must show it.
  assert.equal(healthy.notJudgeable, 0);
  assert.equal(healthy.heldBelowThreshold, 10, "a judged, passing device is evidence of health");
  assert.equal(dead.notJudgeable, 10);
  assert.equal(dead.heldBelowThreshold, 0, "an unreadable device proves nothing about health");
  assert.notEqual(healthy.assessment, dead.assessment);
  assert.match(dead.assessment, /permanently silent/i);
  assert.match(healthy.assessment, /genuinely judged/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// The monitor must not page the fleet for its own outage
//
// Found live: after a 20-hour collection gap, the 30-minute offline rule fired
// on 236 of 250 devices, none of which had changed state. Every offline rule
// compares "now" against the last time WE saw the device, so a collector outage
// looks identical to a total fleet outage — except it arrives as 236 pages.
// ─────────────────────────────────────────────────────────────────────────────

const offlineRule = DEFAULT_RULES.find((r) => r.id === "offline-30m")
  ?? (DEFAULT_RULES.find((r) => r.kind === "offline")! as AlertRule);

/** Fleet that WOULD all fire an offline rule, with a settable collection age. */
function staleRepo(collectionAgeSeconds: number | null, n = 20) {
  const input = new Map(
    Array.from({ length: n }, (_, i) => [
      `canvas-${i}`,
      {
        device: device({ id: `canvas-${i}`, lastOnlineTime: minutesAgo(24 * 60) }),
        samples: [] as SampleRow[],
      },
    ]),
  );
  const state: StubState = { opened: [], refreshed: [], resolved: [] };
  const repo = {
    async collectionAgeSeconds() {
      return { overall: collectionAgeSeconds, bySource: {} as Record<string, number> };
    },
    async loadEvaluationInput() { return input; },
    async loadOpenAlerts() { return new Map(); },
    async openAlert(a: { deviceId: string; ruleId: string; severity: string }) {
      state.opened.push(a); return true;
    },
    async touchAlerts() { return 0; },
    async resolveStaleAlerts() { return 0; },
  } as unknown as Repository;
  return { repo, state };
}

test("fresh collection: an offline fleet DOES alert normally", async () => {
  const { repo, state } = staleRepo(120);
  const result = await runAlerting(repo, { rules: [offlineRule], now: NOW });

  assert.equal(result.collectionStale, null);
  assert.ok(state.opened.length > 0, "with fresh data a genuinely down fleet must still page");
});

test("stale collection SUPPRESSES device alerting instead of paging the fleet", async () => {
  const { repo, state } = staleRepo(20 * 3600); // the 20-hour gap we actually hit
  const result = await runAlerting(repo, { rules: [offlineRule], now: NOW });

  assert.ok(result.collectionStale, "the engine must notice its own data is too old");
  assert.equal(state.opened.length, 0, "not one device alert may be opened on stale data");
  assert.equal(result.devicesEvaluated, 0);
  assert.match(result.collectionStale!.message, /collector is the fault/i);
});

test("no telemetry at all is reported as unjudgeable, not as a healthy fleet", async () => {
  const { repo, state } = staleRepo(null);
  const result = await runAlerting(repo, { rules: [offlineRule], now: NOW });

  assert.ok(result.collectionStale);
  assert.equal(state.opened.length, 0);
  assert.match(result.collectionStale!.message, /never been collected|has ever been collected/i);
});

test("the staleness threshold is configurable and respected at the boundary", async () => {
  const justUnder = await runAlerting(staleRepo(1799).repo, {
    rules: [offlineRule], now: NOW, maxCollectionAgeSeconds: 1800,
  });
  const justOver = await runAlerting(staleRepo(1801).repo, {
    rules: [offlineRule], now: NOW, maxCollectionAgeSeconds: 1800,
  });
  assert.equal(justUnder.collectionStale, null);
  assert.ok(justOver.collectionStale);
});

// ─────────────────────────────────────────────────────────────────────────────
// "Last present at" must mean what it says
//
// Caught in the live UI: a drawer showed "Last seen: never" beside an alert
// reading "Last present at 2026-08-25T18:14:23Z". The device's last_online_time
// was genuinely null; the alert had taken the oldest OFFLINE reading and
// labelled it a presence. An alert that invents a time the device was up sends
// someone hunting for an outage that started somewhere else entirely.
// ─────────────────────────────────────────────────────────────────────────────

const offRule = (over = {}) =>
  ({ kind: "offline", id: "off", name: "Offline", enabled: true, severity: "critical",
     forSeconds: 3600, clearForSeconds: 120, ...over }) as AlertRule;

test("a real online-to-offline transition is dated from the ONLINE reading", () => {
  const samples = [
    sample(300, { presence: "offline" }),
    sample(240, { presence: "offline" }),
    sample(600, { presence: "online" }),   // last time it was genuinely up
  ];
  const v = evaluateRule(offRule({ forSeconds: 60 }), {
    device: device({ lastOnlineTime: null }), samples, now: NOW,
  });
  assert.equal(v.firing, true, v.skipped);
  assert.match(v.evidence, /Last present at/);
  assert.match(v.evidence, new RegExp(minutesAgo(600).toISOString()));
});

test("with only offline readings the evidence states a LOWER BOUND, not a presence", () => {
  const samples = [sample(300, { presence: "offline" }), sample(240, { presence: "offline" })];
  const v = evaluateRule(offRule({ forSeconds: 60 }), {
    device: device({ lastOnlineTime: null }), samples, now: NOW,
  });
  assert.equal(v.firing, true, v.skipped);
  assert.doesNotMatch(v.evidence, /Last present at/,
    "claiming a last-present time we do not have is the bug this guards");
  assert.match(v.evidence, /at least/);
  assert.match(v.evidence, /may be considerably longer/);
});

test("the registry's last_online_time is preferred when it is more recent", () => {
  // Our window only reaches back 5 hours; Videri knows it was up 2 hours ago.
  const samples = [sample(300, { presence: "offline" }), sample(120, { presence: "offline" })];
  const v = evaluateRule(offRule({ forSeconds: 3600 }), {
    device: device({ lastOnlineTime: minutesAgo(120) }), samples, now: NOW,
  });
  assert.equal(v.firing, true, v.skipped);
  assert.match(v.evidence, new RegExp(minutesAgo(120).toISOString()));
  assert.match(v.evidence, /Offline for 2\.0 hours/);
});

test("the outage is not inflated by taking the earlier of two timestamps", () => {
  // Registry says up 90 min ago; our oldest offline reading is 5 hours old.
  // The outage is 90 minutes, not 5 hours.
  const samples = [sample(300, { presence: "offline" }), sample(60, { presence: "offline" })];
  const v = evaluateRule(offRule({ forSeconds: 600 }), {
    device: device({ lastOnlineTime: minutesAgo(90) }), samples, now: NOW,
  });
  assert.match(v.evidence, /Offline for 1\.5 hours/);
  assert.doesNotMatch(v.evidence, /\b5\.0 hours/, "must not date the outage from the oldest offline reading");
});

// ─────────────────────────────────────────────────────────────────────────────
// A screen-state reading from an offline device is stale, not current
//
// Videri's alerting reports "showingLogo" on nine devices; seven have been
// offline for months, one since November 2025. The logo reading is simply the
// last thing the platform heard before the device went dark. Dispatching someone
// to fix content on a device with no power is the costliest false positive there
// is, so a state rule must decline to judge an offline device.
// ─────────────────────────────────────────────────────────────────────────────

const logoRule = DEFAULT_RULES.find((r) => r.id === "showing-logo")!;

test("a sustained logo reading on an ONLINE device still fires", () => {
  const samples = [0, 4, 8, 12, 16, 20].map((m) =>
    sample(m, { showingLogo: true, presence: "online" }),
  );
  const v = evaluateRule(logoRule, { device: device(), samples, now: NOW });
  assert.equal(v.firing, true, v.skipped);
});

test("the same reading on an OFFLINE device does not fire", () => {
  const samples = [0, 4, 8, 12, 16, 20].map((m) =>
    sample(m, { showingLogo: true, presence: "offline" }),
  );
  const v = evaluateRule(logoRule, { device: device(), samples, now: NOW });
  assert.equal(v.firing, false);
  assert.match(v.skipped ?? "", /stale/);
  assert.match(v.skipped ?? "", /the actionable fault is the outage/);
  assert.equal(v.unreadable, true, "an unjudgeable device must not count as healthy");
});

test("presence we cannot read does NOT suppress the state rule", () => {
  // Guessing offline on absent presence would silently mute real content faults.
  const samples = [0, 4, 8, 12, 16, 20].map((m) =>
    sample(m, { showingLogo: true, presence: null }),
  );
  const v = evaluateRule(logoRule, { device: device(), samples, now: NOW });
  assert.equal(v.firing, true, v.skipped);
});

test("a device that recovered is judged on its current presence, not its oldest", () => {
  const samples = [
    sample(0, { showingLogo: true, presence: "online" }),
    sample(4, { showingLogo: true, presence: "online" }),
    sample(8, { showingLogo: true, presence: "online" }),
    sample(12, { showingLogo: true, presence: "online" }),
    sample(16, { showingLogo: true, presence: "online" }),
    sample(20, { showingLogo: true, presence: "offline" }), // older, irrelevant
  ];
  const v = evaluateRule(logoRule, { device: device(), samples, now: NOW });
  assert.equal(v.firing, true, v.skipped);
});

test("offline rules supersede every content-state rule", () => {
  // Any open logo/black-screen alert must be resolved once the outage is the
  // finding, or the queue carries both and the operator triages twice.
  const CONTENT = ["showing-logo", "black-screen", "screen-off-during-schedule"];
  for (const id of ["offline-4h", "offline-30d"]) {
    const rule = DEFAULT_RULES.find((r) => r.id === id);
    if (!rule) continue;
    const sup = rule.supersedes ?? [];
    for (const c of CONTENT) {
      assert.ok(sup.includes(c), `${id} must supersede ${c}`);
    }
  }
});
