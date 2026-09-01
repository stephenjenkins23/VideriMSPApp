/**
 * The brief now reasons over the intelligence layer, so two things must hold and
 * are asserted here with NO network and NO real Anthropic call:
 *
 *   1. summarizeIntelligence folds the real engines (remediation + correlation)
 *      into the compact bundle block — a firmware cohort with its device count, a
 *      one-click ("auto-safe") count, and the honest proof-of-play caveat.
 *
 *   2. generateFleetBrief actually PUTS that block in front of the model. We stub
 *      the Anthropic client, capture the exact messages payload it is handed, and
 *      assert the intelligence signals are present in it. This is the guard that
 *      the wiring (bundle → prompt) can't silently drop the new signals.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { summarizeIntelligence, type FleetBundle } from "./bundle.js";
import { generateFleetBrief } from "./brief.js";
import type { DeviceView } from "../intelligence/remediation.js";

/** A DeviceView with honest-null defaults; override only what a case exercises. */
function device(over: Partial<DeviceView>): DeviceView {
  return {
    id: "dev",
    name: null,
    status: "online",
    lastOnlineTime: null,
    city: null,
    groupId: null,
    site: null,
    firmwareCurrent: null,
    firmwareBehind: false,
    screen: { isBlackScreen: null, showingLogo: null, nowPlayingId: null },
    telemetry: null,
    drift: [],
    brightnessRaw: null,
    // Live panel state + schedule (screen-state.ts). Null = unread, so no
    // display verdict fires unless a case sets it.
    currentBrightnessRaw: null,
    displayOn: null,
    brightnessScheduleEnabled: null,
    autoBrightnessEnabled: null,
    turnOnTime: null,
    turnOffTime: null,
    timezone: null,
    ...over,
  };
}

/**
 * A fleet shaped to fire both engines: five devices on a bad firmware build all
 * offline (a firmware cohort, failing well above baseline), ten healthy devices
 * on the current build (the baseline), and one online device whose panel is genuinely dark
 * (a one-click auto-safe restore).
 */
function intelligentFleet(): DeviceView[] {
  const bad = Array.from({ length: 5 }, (_, i) =>
    device({ id: `bad-${i}`, status: "offline", firmwareCurrent: "3.3.8" }),
  );
  const good = Array.from({ length: 10 }, (_, i) =>
    device({ id: `good-${i}`, status: "online", firmwareCurrent: "3.4.1" }),
  );
  // Dark on LIVE evidence (current_brightness 0 + display_on false) with no
  // schedule to explain it — the only shape that still earns a one-click.
  const dark = device({
    id: "dark-1",
    status: "online",
    firmwareCurrent: "3.4.1",
    brightnessRaw: 0,
    currentBrightnessRaw: 0,
    displayOn: false,
    brightnessScheduleEnabled: false,
  });
  return [...bad, ...good, dark];
}

test("summarizeIntelligence folds the engines into a compact bundle block", () => {
  const intel = summarizeIntelligence(intelligentFleet());

  // Remediation: the brightness-0 device is a one-click restore.
  assert.ok(intel.remediation.summary.byKind["auto-safe"] >= 1, "expected an auto-safe recommendation");
  assert.ok(
    intel.remediation.top.some((r) => r.kind === "auto-safe" && /brightness/i.test(r.action)),
    "expected a brightness restore in the top recommendations",
  );

  // Correlation: a firmware cohort tied to its device count.
  const cohort = intel.correlation.findings.find((f) => f.kind === "firmware-cohort");
  assert.ok(cohort, "expected a firmware-cohort finding");
  assert.equal(cohort!.affectedCount, 5, "cohort should carry its five failing devices");
  assert.match(cohort!.summary, /3\.3\.8/, "cohort summary should name the version");

  // Proof-of-play is honestly not measured in the batch brief.
  assert.equal(intel.proofOfPlay.available, false);
  assert.match(intel.proofOfPlay.note, /not (assessed|measured)/i);
});

test("generateFleetBrief puts the intelligence signals in front of the model", async () => {
  const intelligence = summarizeIntelligence(intelligentFleet());
  const bundle: FleetBundle = {
    overview: {
      computedAt: "2026-08-31T08:00:00.000Z",
      totalDevices: 16,
      byStatus: { online: 11, offline: 5 },
      byDeviceClass: { canvas: 16 },
      openAlerts: { critical: 0, high: 0, medium: 0, info: 0 },
      telemetryCoverage: 0,
      statusCoverage: 1,
      unavailableMetrics: [],
    },
    firmware: {
      latestVersion: "3.4.1",
      devicesBehind: 5,
      versions: [
        { version: "3.4.1", count: 11, isLatest: true, sharePercent: 68.8 },
        { version: "3.3.8", count: 5, isLatest: false, sharePercent: 31.3 },
      ],
    },
    attention: [],
    changes: {
      windowHours: 24,
      wentOffline: [],
      cameBackOnline: [],
      newAlerts: [],
      resolvedAlertCount: 0,
      firmwareChanges: [],
    },
    intelligence,
  };

  // Capture exactly what the SDK would be sent, and answer without a network call.
  let seen: unknown;
  const stub = {
    messages: {
      parse: async (params: unknown) => {
        seen = params;
        return {
          stop_reason: "end_turn",
          parsed_output: {
            headline: "stub",
            fleetState: "stub",
            needsAttention: [],
            changes: [],
            dataGaps: [],
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  } as unknown as Anthropic;

  await generateFleetBrief(bundle, { client: stub });

  const payload = JSON.stringify((seen as { messages: Array<{ content: string }> }).messages);
  // The engine output the model must reason over is actually present in the turn.
  assert.match(payload, /firmware-cohort/, "firmware cohort finding must reach the prompt");
  assert.match(payload, /auto-safe/, "one-click remediation counts must reach the prompt");
  assert.match(payload, /3\.3\.8/, "the failing firmware version must reach the prompt");
  assert.match(payload, /Scheduled, not confirmed/, "the POP honesty basis must reach the prompt");
});
