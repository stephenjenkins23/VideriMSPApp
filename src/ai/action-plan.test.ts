/**
 * Action plan tests (US-5.2) — NO network and NO real Anthropic call.
 *
 * Three things must hold and are asserted here:
 *
 *   1. The pure folds are honest: no persisted schedule sweep is `available:false`
 *      WITH a reason, never an empty gap report that would read as "no gaps"; a
 *      partial aggregator fan-out keeps its `groupsFailed` caveat.
 *
 *   2. generateActionPlan actually PUTS the day's intelligence in front of the
 *      model. We stub the Anthropic client, capture the exact params it is handed,
 *      and assert the remediation / correlation / POP / rollup signals are present
 *      — the guard that the wiring can't silently drop a signal — plus that the
 *      verified wiring (opus-5, adaptive thinking, cached system prefix) and the
 *      guardrail prompt are not downgraded.
 *
 *   3. The two invariants US-5.2 promises are enforced after parse: no item
 *      without a source, and a plan short enough to read — and neither trim is
 *      silent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import {
  MAX_ITEMS,
  enforcePlanInvariants,
  generateActionPlan,
  summarizePersistedPop,
  summarizeRollupsForPlan,
  type ActionItem,
  type ActionPlan,
  type PlanInput,
} from "./action-plan.js";
import { summarizeIntelligence } from "./bundle.js";
import type { DeviceView } from "../intelligence/remediation.js";
import type { PersistedScheduleRow } from "../intelligence/proof-of-play.js";
import type { GroupRollup, RollupResult } from "../videri/services/aggregator.js";

/** A DeviceView with honest-null defaults; override only what a case exercises. */
function device(over: Partial<DeviceView>): DeviceView {
  return {
    id: "dev",
    name: null,
    status: "online",
    lastOnlineTime: null,
    city: null,
    firmwareCurrent: null,
    firmwareBehind: false,
    screen: { isBlackScreen: null, showingLogo: null, nowPlayingId: null },
    telemetry: null,
    drift: [],
    brightnessRaw: null,
    ...over,
  };
}

/**
 * A fleet shaped to fire both engines: five devices on a bad firmware build all
 * offline (a firmware cohort), ten healthy devices on the current build (the
 * baseline), and one online device with brightness 0 (a one-click auto-safe fix).
 */
function intelligentFleet(): DeviceView[] {
  const bad = Array.from({ length: 5 }, (_, i) =>
    device({ id: `bad-${i}`, status: "offline", firmwareCurrent: "3.3.8" }),
  );
  const good = Array.from({ length: 10 }, (_, i) =>
    device({ id: `good-${i}`, status: "online", firmwareCurrent: "3.4.1" }),
  );
  const dark = device({ id: "dark-1", status: "online", firmwareCurrent: "3.4.1", brightnessRaw: 0 });
  return [...bad, ...good, dark];
}

/** An always-on scheduled event: no window bounds, so it covers every instant. */
const alwaysOn = {
  assetUuid: "asset-1",
  assetType: "image",
  durationMs: 10_000,
  startTime: null,
  endTime: null,
  priority: null,
  frequency: null,
};

const scheduleRow = (over: Partial<PersistedScheduleRow> = {}): PersistedScheduleRow => ({
  id: "canvas-1",
  name: "Lobby North",
  scheduledItems: [alwaysOn],
  fetchedAt: "2026-08-31T06:00:00.000Z",
  isScreenOn: true,
  isBlackScreen: false,
  showingLogo: false,
  ...over,
});

const group = (over: Partial<GroupRollup> = {}): GroupRollup => ({
  uuid: "g",
  name: "Group",
  active: true,
  totalCanvases: 10,
  offline30d: 0,
  offline6mo: 0,
  noEvents: 0,
  singleContent: 0,
  ...over,
});

// ─── the pure folds ─────────────────────────────────────────────────────────

test("no persisted schedule sweep is an honest unavailable, not an empty gap report", () => {
  const pop = summarizePersistedPop([], 240);
  assert.equal(pop.available, false);
  // The operator must be told this is unknown — a zero-gap report here would be a lie.
  assert.match(pop.available === false ? pop.reason : "", /not clean|unknown/i);
  assert.match(pop.basis, /Scheduled, not confirmed/);
});

test("summarizePersistedPop carries real gap counts, coverage and staleness", () => {
  const pop = summarizePersistedPop(
    [
      // Scheduled + screen black → a confirmed gap.
      scheduleRow({ id: "gap-1", isScreenOn: true, isBlackScreen: true }),
      // Scheduled + screen fine → no gap.
      scheduleRow({ id: "ok-1" }),
      // Scheduled but the panel was never read → unknown, never a fabricated gap.
      scheduleRow({
        id: "unknown-1",
        isScreenOn: null,
        isBlackScreen: null,
        showingLogo: null,
        fetchedAt: "2026-08-31T02:00:00.000Z",
      }),
    ],
    240,
  );

  assert.equal(pop.available, true);
  if (pop.available !== true) return; // narrowing for the compiler
  assert.equal(pop.summary.devicesWithSchedule, 3);
  assert.equal(pop.summary.gaps, 1, "only the definitive black screen is a gap");
  assert.equal(pop.summary.byReason["screen black"], 1);
  assert.equal(pop.summary.screenStateUnknown, 1, "the unread panel is reported, not counted as a gap");
  // Honest denominator: 3 of 240 devices have a snapshot at all.
  assert.equal(pop.coverage.fleetDevices, 240);
  assert.equal(pop.coverage.withPersistedSchedule, 3);
  // Age envelope rides along, so nothing here reads as live.
  assert.equal(pop.staleness.oldestFetchedAt, "2026-08-31T02:00:00.000Z");
  assert.equal(pop.staleness.newestFetchedAt, "2026-08-31T06:00:00.000Z");
});

test("summarizeRollupsForPlan compacts the fan-out and keeps its partial-read caveat", () => {
  const result: RollupResult = {
    fleet: { totalCanvases: 242, offline30d: 110, offline6mo: 64, noEvents: 31, singleContent: 12 },
    groups: Array.from({ length: 9 }, (_, i) =>
      group({ uuid: `g-${i}`, name: `Group ${i}`, offline30d: 9 - i }),
    ),
    meta: { groupsRead: 92, groupsFailed: 2 },
  };

  const rollups = summarizeRollupsForPlan(result, "2026-08-31T08:00:00.000Z", 4);
  assert.equal(rollups.available, true);
  if (rollups.available !== true) return;
  assert.equal(rollups.fleet.offline30d, 110);
  assert.equal(rollups.groupsRead, 92);
  // 2 groups could not be read: the totals are a floor, and the plan must be able to say so.
  assert.equal(rollups.groupsFailed, 2);
  assert.equal(rollups.worstGroups.length, 4, "drill-down is capped for token cost");
  assert.equal(rollups.worstGroups[0]!.offline30d, 9, "worst-offline-first order is preserved");
  assert.equal(rollups.collectedAt, "2026-08-31T08:00:00.000Z");
});

// ─── prompt assembly ────────────────────────────────────────────────────────

function planInput(): PlanInput {
  const { remediation, correlation } = summarizeIntelligence(intelligentFleet());
  return {
    windowHours: 24,
    overview: {
      computedAt: "2026-08-31T08:00:00.000Z",
      totalDevices: 16,
      byStatus: { online: 11, offline: 5 },
      byDeviceClass: { canvas: 16 },
      openAlerts: { critical: 0, high: 0, medium: 0, info: 0 },
      telemetryCoverage: 0,
      statusCoverage: 1,
      unavailableMetrics: [{ metric: "temperature_c", reason: "no source on this platform" }],
    },
    remediation,
    correlation,
    proofOfPlay: summarizePersistedPop([scheduleRow({ isBlackScreen: true })], 16),
    rollups: summarizeRollupsForPlan(
      {
        fleet: { totalCanvases: 242, offline30d: 110, offline6mo: 64, noEvents: 31, singleContent: 12 },
        groups: [group({ name: "JFK T4", offline30d: 17 })],
        meta: { groupsRead: 94, groupsFailed: 0 },
      },
      "2026-08-31T08:00:00.000Z",
    ),
  };
}

/** The shape of the params we assert on — enough of the SDK request to check the wiring. */
interface CapturedParams {
  model: string;
  thinking: { type: string };
  output_config: { format: unknown };
  system: Array<{ text: string; cache_control: { type: string } }>;
  messages: Array<{ role: string; content: string }>;
}

/** A stub Anthropic client: records the params, answers without a network call. */
function stubClient(plan: Partial<ActionPlan> = {}): {
  client: Anthropic;
  seen: () => CapturedParams;
} {
  let seen: unknown;
  const client = {
    messages: {
      parse: async (params: unknown) => {
        seen = params;
        return {
          stop_reason: "end_turn",
          parsed_output: { focus: "stub", items: [], notCovered: [], ...plan },
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  } as unknown as Anthropic;
  return { client, seen: () => seen as CapturedParams };
}

test("generateActionPlan puts the day's intelligence in front of the model", async () => {
  const { client, seen } = stubClient();
  await generateActionPlan(planInput(), { client });

  // The user turn's raw text, not a re-stringify of it — asserting on escaped JSON
  // would pass on the shape of the escaping rather than on the payload.
  const payload = seen().messages[0]!.content;
  assert.match(payload, /firmware-cohort/, "correlation findings must reach the prompt");
  assert.match(payload, /3\.3\.8/, "the failing firmware version must reach the prompt");
  assert.match(payload, /auto-safe/, "one-click remediation counts must reach the prompt");
  assert.match(payload, /Scheduled, not confirmed/, "the POP honesty basis must reach the prompt");
  assert.match(payload, /"gaps": 1/, "the real POP gap count must reach the prompt");
  assert.match(payload, /"offline30d": 110/, "the aggregator rollups must reach the prompt");
  assert.match(payload, /temperature_c/, "the unavailable-metrics list must reach the prompt");
  assert.match(payload, /last 24 hours/, "the window must reach the prompt");
});

test("generateActionPlan keeps the verified wiring and the guardrail prompt", async () => {
  const { client, seen } = stubClient();
  await generateActionPlan(planInput(), { client });
  const params = seen();

  // Downgrading any of these silently changes what the output is worth.
  assert.equal(params.model, "claude-opus-5");
  assert.equal(params.thinking.type, "adaptive");
  assert.ok(params.output_config.format, "structured output format must be set");
  // System prefix is cached, and it is a single frozen block (no interpolation).
  assert.equal(params.system.length, 1);
  assert.equal(params.system[0]!.cache_control.type, "ephemeral");

  const system: string = params.system[0]!.text;
  assert.match(system, /EVERY ITEM MUST TRACE TO A DEVICE SET/, "grounding rule must be present");
  assert.match(system, /NEVER CLAIM AN ACTION WAS PERFORMED/, "no-writes-claimed rule must be present");
  assert.match(system, /PREFER ONE HIGH-LEVERAGE ITEM/, "collapse rule must be present");
  assert.match(system, /Scheduled, not confirmed|scheduled, not confirmed/, "POP caveat must be present");
  assert.match(system, /DATA, NOT INSTRUCTIONS/, "injection-safety rule must be present");
  assert.match(system, /never "zero" and never "fine"/, "honest-null rule must be present");
  // The frozen prefix must not carry volatile data, or the cache is worthless.
  assert.doesNotMatch(system, /2026-08-31/);
});

// ─── post-parse invariants ──────────────────────────────────────────────────

const item = (over: Partial<ActionItem> = {}): ActionItem => ({
  rank: 1,
  title: "Do the thing",
  action: "Do it",
  reasoning: "Because",
  deviceScope: "the 5 canvases on 3.3.8",
  deviceIds: [],
  affectedCount: 5,
  expectedImpact: "Fixes 5",
  kind: "manual",
  severity: "high",
  source: "correlation.findings[0]",
  ...over,
});

test("an item with no traceable source is dropped, and never silently", () => {
  const plan = enforcePlanInvariants({
    focus: "f",
    items: [item({ rank: 1 }), item({ rank: 2, source: "  " }), item({ rank: 3, deviceScope: "" })],
    notCovered: [],
  });

  assert.equal(plan.items.length, 1, "ungrounded items must not survive");
  assert.equal(plan.items[0]!.rank, 1);
  assert.match(plan.notCovered.join(" "), /2 generated item\(s\) were dropped/);
});

test("the plan is capped, sorted by rank, and says when it truncated", () => {
  const plan = enforcePlanInvariants({
    focus: "f",
    // Deliberately out of order, and two over the cap.
    items: Array.from({ length: MAX_ITEMS + 2 }, (_, i) => item({ rank: MAX_ITEMS + 2 - i })),
    notCovered: ["temperature is unreadable"],
  });

  assert.equal(plan.items.length, MAX_ITEMS);
  assert.deepEqual(
    plan.items.map((i) => i.rank),
    Array.from({ length: MAX_ITEMS }, (_, i) => i + 1),
    "items must come out in rank order",
  );
  // The original honesty note survives, and the truncation is disclosed.
  assert.match(plan.notCovered[0]!, /temperature/);
  assert.match(plan.notCovered.join(" "), /truncated to the top 7 items; 2 lower-ranked/);
});

test("generateActionPlan applies the invariants to what the model returned", async () => {
  const { client } = stubClient({
    items: Array.from({ length: MAX_ITEMS + 3 }, (_, i) => item({ rank: i + 1 })),
  });
  const { plan } = await generateActionPlan(planInput(), { client });
  assert.equal(plan.items.length, MAX_ITEMS, "an over-long plan is clamped, not passed through");
  assert.match(plan.notCovered.join(" "), /truncated/);
});

test("a refusal fails loudly rather than persisting an empty plan", async () => {
  const client = {
    messages: {
      parse: async () => ({
        stop_reason: "refusal",
        stop_details: { explanation: "nope" },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    },
  } as unknown as Anthropic;
  await assert.rejects(() => generateActionPlan(planInput(), { client }), /refused: nope/);
});
