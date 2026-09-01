/**
 * Screen-verdict wiring into the black-screen rule —
 *   `node --test dist/alerting/screen-verdict.test.js`
 *
 * The premise, verified live 2026-09-01: the platform reported
 * `is_black_screen = true` in every sample for device 1000152 while the panel was
 * showing a live dashboard, and this rule raised a CRITICAL from it. The panel's
 * own answer now gets a say — and the failure modes of giving it that say are all
 * silent, so every branch is pinned here:
 *
 *   suppressing on a STALE refutation → a real dark screen goes unreported;
 *   reading silence as refutation      → same, and worse, on every unanswered verb;
 *   suppressing invisibly              → the disagreement stops being measurable;
 *   downgrading a CONFIRMED claim      → we mute the alerts we are most sure of.
 *
 * All pure: no database, no device, no clock.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateRule,
  screenVerdictStanding,
  SCREEN_VERDICT_MAX_AGE_SECONDS,
  type SampleRow,
  type DeviceRow,
  type ScreenVerdictRecord,
} from "./evaluate.js";
import { DEFAULT_RULES, type AlertRule } from "./rules.js";
import { runAlerting } from "./engine.js";
import type { Repository, OpenAlertRow } from "../db/repository.js";

const NOW = new Date("2026-09-01T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const secondsAgo = (sec: number) => new Date(NOW.getTime() - sec * 1000);

function sample(agoMinutes: number, over: Partial<SampleRow> = {}): SampleRow {
  return {
    observedAt: minutesAgo(agoMinutes),
    source: "status",
    presence: null, isScreenOn: null, isBlackScreen: null, showingLogo: null,
    downloading: null, pingQuality: null, playbackQuality: null,
    nowPlayingType: null, nowPlayingId: null,
    cpuPercent: null, ramPercent: null, temperatureC: null, wifiSignalDbm: null,
    packetLossPercent: null, jitterMs: null, ntpSyncPercent: null, storagePercent: null,
    ...over,
  };
}

const device = (over: Partial<DeviceRow> = {}): DeviceRow => ({
  id: "canvas-1", name: "Center Spark 5", location: "New York, NY",
  firmwareCurrent: "3.4.1", firmwareLatest: "3.4.1",
  components: {}, lastOnlineTime: minutesAgo(1), ...over,
});

const blackScreenRule = DEFAULT_RULES.find((r) => r.id === "black-screen")!;

/**
 * A sustained black episode: 7 readings a minute apart, all true, newest at
 * `now`. Comfortably past the rule's 5-minute / 3-sample gates, so anything the
 * assertions see comes from the verdict logic and not from a sustain boundary.
 * The episode therefore STARTED 6 minutes ago.
 */
const blackEpisode = (): SampleRow[] =>
  [6, 5, 4, 3, 2, 1, 0].map((ago) => sample(ago, { isBlackScreen: true }));

const record = (
  verdict: string,
  observedAt: Date,
  deviceIsBlack: boolean | null = null,
): ScreenVerdictRecord => ({ verdict, observedAt, deviceIsBlack });

// ─────────────────────────────────────────────────────────────────────────────
// contradicted + fresh → no critical, but a visible, auditable finding
// ─────────────────────────────────────────────────────────────────────────────

test("a fresh contradiction does NOT raise the critical", () => {
  const v = evaluateRule(blackScreenRule, {
    device: device(),
    samples: blackEpisode(),
    now: NOW,
    screenVerdict: record("contradicted", secondsAgo(30), false),
  });

  assert.notEqual(v.severity, "critical", "we can disprove this claim; it must not page");
  assert.equal(v.severity, "info");
});

test("a refuted claim still FIRES — suppression must never be silent", () => {
  const v = evaluateRule(blackScreenRule, {
    device: device(),
    samples: blackEpisode(),
    now: NOW,
    screenVerdict: record("contradicted", secondsAgo(30), false),
  });

  assert.equal(v.firing, true, "the disagreement is itself a finding, not nothing");
  assert.equal(v.refuted, true, "and it must be marked so the count is possible");
  assert.equal(v.skipped, undefined, "a refutation is not a skip");
  assert.notEqual(v.unreadable, true, "the input was perfectly readable");
});

test("the refutation evidence names both observations and both times", () => {
  const verdictAt = secondsAgo(30);
  const v = evaluateRule(blackScreenRule, {
    device: device(),
    samples: blackEpisode(),
    now: NOW,
    screenVerdict: record("contradicted", verdictAt, false),
  });

  assert.match(v.evidence, /is_black_screen=true/);
  assert.match(v.evidence, /not-black/);
  assert.match(v.evidence, /refuted/);
  // The exact instants matter: a claim from 40 minutes ago and an answer from 30
  // seconds ago are different kinds of evidence and the operator must see which.
  assert.ok(v.evidence.includes(NOW.toISOString()), "the platform's latest sample instant");
  assert.ok(v.evidence.includes(verdictAt.toISOString()), "the panel's answer instant");
  assert.match(v.title, /refuted/i, "the title should not still read as a dark screen");
});

// ─────────────────────────────────────────────────────────────────────────────
// contradicted but STALE → the critical stands. The dangerous branch.
// ─────────────────────────────────────────────────────────────────────────────

test("a contradiction OLDER than the current episode does NOT suppress", () => {
  // Panel said not-black 10 minutes ago; this black run only began 6 minutes ago.
  // The answer is fresh by the clock and still says nothing about this episode.
  const v = evaluateRule(blackScreenRule, {
    device: device(),
    samples: blackEpisode(),
    now: NOW,
    screenVerdict: record("contradicted", minutesAgo(10), false),
  });

  assert.equal(v.firing, true);
  assert.equal(v.severity, "critical", "a stale refutation must not mute a new outage");
  assert.notEqual(v.refuted, true);
  assert.match(v.evidence, /UNVERIFIED/);
  assert.match(v.evidence, /predates/);
});

test("a contradiction older than the freshness window does NOT suppress", () => {
  // Inside this episode (which began 90 minutes ago) but well past the age limit.
  // Five-minute spacing keeps the run inside the rule's own continuity tolerance,
  // so the only thing under test here is the verdict's age.
  const samples = Array.from({ length: 19 }, (_, i) => 90 - i * 5)
    .map((ago) => sample(ago, { isBlackScreen: true }));
  const v = evaluateRule(blackScreenRule, {
    device: device(),
    samples,
    now: NOW,
    screenVerdict: record("contradicted", minutesAgo(45), false),
  });

  assert.equal(v.severity, "critical");
  assert.notEqual(v.refuted, true);
  assert.match(v.evidence, /UNVERIFIED/);
});

// ─────────────────────────────────────────────────────────────────────────────
// The freshness boundary, exactly
// ─────────────────────────────────────────────────────────────────────────────

test("the age limit is 20 minutes, and the boundary instant is still fresh", () => {
  assert.equal(SCREEN_VERDICT_MAX_AGE_SECONDS, 20 * 60);

  const episodeStart = minutesAgo(120);
  const atLimit = screenVerdictStanding(
    record("contradicted", secondsAgo(SCREEN_VERDICT_MAX_AGE_SECONDS)),
    episodeStart,
    NOW,
  );
  assert.equal(atLimit.standing, "refutes", "exactly at the limit still counts");

  const pastLimit = screenVerdictStanding(
    record("contradicted", secondsAgo(SCREEN_VERDICT_MAX_AGE_SECONDS + 1)),
    episodeStart,
    NOW,
  );
  assert.equal(pastLimit.standing, "unverified", "one second past it does not");
  assert.match(pastLimit.why, /past the/);
});

test("the episode gate requires the verdict to be STRICTLY newer than the episode start", () => {
  const episodeStart = minutesAgo(6);

  const same = screenVerdictStanding(record("contradicted", episodeStart), episodeStart, NOW);
  assert.equal(same.standing, "unverified", "same instant is not evidence about the episode");

  const oneMsEarlier = screenVerdictStanding(
    record("contradicted", new Date(episodeStart.getTime() - 1)),
    episodeStart,
    NOW,
  );
  assert.equal(oneMsEarlier.standing, "unverified");

  const oneMsLater = screenVerdictStanding(
    record("contradicted", new Date(episodeStart.getTime() + 1)),
    episodeStart,
    NOW,
  );
  assert.equal(oneMsLater.standing, "refutes", "inside the run, so it speaks to the run");
});

// ─────────────────────────────────────────────────────────────────────────────
// confirmed + fresh → the critical, with the stronger claim
// ─────────────────────────────────────────────────────────────────────────────

test("a fresh confirmation fires the critical and says the device confirmed it", () => {
  const verdictAt = secondsAgo(30);
  const v = evaluateRule(blackScreenRule, {
    device: device(),
    samples: blackEpisode(),
    now: NOW,
    screenVerdict: record("confirmed", verdictAt, true),
  });

  assert.equal(v.firing, true);
  assert.equal(v.severity, "critical");
  assert.notEqual(v.refuted, true);
  assert.match(v.evidence, /is_blackscreen=true/);
  assert.match(v.evidence, /confirm/i);
  assert.match(v.evidence, /Higher confidence/);
  assert.ok(v.evidence.includes(verdictAt.toISOString()));
  assert.doesNotMatch(v.evidence, /UNVERIFIED/);
});

// ─────────────────────────────────────────────────────────────────────────────
// unanswered / no-claim / no verdict → exactly as before, and labelled so
// ─────────────────────────────────────────────────────────────────────────────

test("an unanswered verb fires the critical unchanged — silence is not refutation", () => {
  const v = evaluateRule(blackScreenRule, {
    device: device(),
    samples: blackEpisode(),
    now: NOW,
    screenVerdict: record("unanswered", secondsAgo(30), null),
  });

  assert.equal(v.firing, true);
  assert.equal(v.severity, "critical");
  assert.notEqual(v.refuted, true);
  assert.match(v.evidence, /UNVERIFIED/);
  assert.match(v.evidence, /did not answer/);
});

test("a `no-claim` verdict fires the critical unchanged — silence is not agreement either", () => {
  const v = evaluateRule(blackScreenRule, {
    device: device(),
    samples: blackEpisode(),
    now: NOW,
    screenVerdict: record("no-claim", secondsAgo(30), null),
  });

  assert.equal(v.severity, "critical");
  assert.match(v.evidence, /UNVERIFIED/);
});

test("no verdict at all behaves exactly as it did before this feature existed", () => {
  const samples = blackEpisode();
  const withoutField = evaluateRule(blackScreenRule, { device: device(), samples, now: NOW });
  const withNull = evaluateRule(blackScreenRule, {
    device: device(), samples, now: NOW, screenVerdict: null,
  });

  for (const v of [withoutField, withNull]) {
    assert.equal(v.firing, true);
    assert.equal(v.severity, "critical");
    assert.notEqual(v.refuted, true);
    assert.match(v.evidence, /Screen is black/);
    assert.match(v.evidence, /UNVERIFIED/);
  }
  assert.equal(withoutField.evidence, withNull.evidence, "absent and null must agree");
});

test("an unrecognised verdict string is unverified, never a refutation", () => {
  // Defends against a future verdict vocabulary landing in the table before this
  // code understands it: the fail-safe direction is "we do not know".
  const v = evaluateRule(blackScreenRule, {
    device: device(),
    samples: blackEpisode(),
    now: NOW,
    screenVerdict: record("probably-fine", secondsAgo(30), null),
  });
  assert.equal(v.severity, "critical");
  assert.notEqual(v.refuted, true);
  assert.match(v.evidence, /unrecognised/);
});

// ─────────────────────────────────────────────────────────────────────────────
// The verdict must not leak into other state rules
// ─────────────────────────────────────────────────────────────────────────────

test("a contradiction does not touch the showing-logo rule", () => {
  const logoRule = DEFAULT_RULES.find((r) => r.id === "showing-logo")!;
  const samples = [20, 16, 12, 8, 4, 0].map((ago) => sample(ago, { showingLogo: true }));
  const v = evaluateRule(logoRule, {
    device: device(), samples, now: NOW,
    screenVerdict: record("contradicted", secondsAgo(30), false),
  });

  assert.equal(v.firing, true);
  assert.equal(v.severity, "high", "the claim under test was about blackness, not the logo");
  assert.notEqual(v.refuted, true);
});

test("a black-screen rule with equals:false is not a claim of blackness", () => {
  // `is_black_screen = false` sustained is the opposite assertion; a
  // `contradicted` verdict has nothing to say about it.
  const notBlack = {
    ...(blackScreenRule as Extract<AlertRule, { kind: "state" }>),
    id: "screen-lit", equals: false,
  } as AlertRule;
  const samples = [6, 5, 4, 3, 2, 1, 0].map((ago) => sample(ago, { isBlackScreen: false }));
  const v = evaluateRule(notBlack, {
    device: device(), samples, now: NOW,
    screenVerdict: record("contradicted", secondsAgo(30), false),
  });

  assert.equal(v.firing, true);
  assert.notEqual(v.refuted, true);
  assert.match(v.evidence, /Screen is not black/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Engine: the count, and the fact that it never commands a device
// ─────────────────────────────────────────────────────────────────────────────

interface StubState {
  opened: Array<{ deviceId: string; ruleId: string; severity: string; evidence: string }>;
  refreshed: Array<{ id: string; evidence: string; severity: string }>;
  resolved: Array<{ id: string; clearForSeconds: number }>;
  verdictReads: number;
}

function stubRepo(
  input: Map<string, { device: DeviceRow; samples: SampleRow[] }>,
  verdicts: Map<string, ScreenVerdictRecord> | "absent",
  open: OpenAlertRow[] = [],
): { repo: Repository; state: StubState } {
  const state: StubState = { opened: [], refreshed: [], resolved: [], verdictReads: 0 };
  const repo = {
    async loadEvaluationInput() { return input; },
    async loadOpenAlerts() {
      return new Map(open.map((a) => [`${a.device_id}:${a.rule_id}`, a]));
    },
    async openAlert(a: StubState["opened"][number]) { state.opened.push(a); return true; },
    async touchAlerts(updates: StubState["refreshed"]) {
      state.refreshed.push(...updates); return updates.length;
    },
    async resolveStaleAlerts(c: StubState["resolved"]) {
      state.resolved.push(...c); return c.length;
    },
    ...(verdicts === "absent"
      ? {}
      : {
          async latestScreenVerdicts() {
            state.verdictReads += 1;
            return verdicts;
          },
        }),
  } as unknown as Repository;
  return { repo, state };
}

test("the engine reads verdicts ONCE per cycle, fleet-wide, not per device", async () => {
  const input = new Map(
    ["canvas-1", "canvas-2", "canvas-3"].map((id) => [
      id, { device: device({ id }), samples: blackEpisode() },
    ]),
  );
  const { repo, state } = stubRepo(input, new Map());
  await runAlerting(repo, { rules: [blackScreenRule], now: NOW });
  assert.equal(state.verdictReads, 1, "one query for the fleet — never N+1, never a command");
});

test("the engine counts refuted claims so the disagreement is measurable", async () => {
  const input = new Map([
    ["canvas-1", { device: device({ id: "canvas-1" }), samples: blackEpisode() }],
    ["canvas-2", { device: device({ id: "canvas-2" }), samples: blackEpisode() }],
    ["canvas-3", { device: device({ id: "canvas-3" }), samples: blackEpisode() }],
  ]);
  const verdicts = new Map<string, ScreenVerdictRecord>([
    ["canvas-1", record("contradicted", secondsAgo(30), false)],
    ["canvas-2", record("contradicted", secondsAgo(30), false)],
    ["canvas-3", record("confirmed", secondsAgo(30), true)],
  ]);
  const { repo, state } = stubRepo(input, verdicts);
  const result = await runAlerting(repo, { rules: [blackScreenRule], now: NOW });

  assert.equal(result.refutedClaims, 2);
  // All three still produce a visible alert — two informational, one critical.
  assert.equal(result.opened, 3, "nothing was silently dropped");
  const bySeverity = state.opened.map((a) => a.severity).sort();
  assert.deepEqual(bySeverity, ["critical", "info", "info"]);
});

test("an already-open CRITICAL de-escalates in place rather than vanishing", async () => {
  const input = new Map([
    ["canvas-1", { device: device(), samples: blackEpisode() }],
  ]);
  const openCritical: OpenAlertRow = {
    id: "alert-1", device_id: "canvas-1", rule_id: "black-screen", severity: "critical",
    title: "Screen is black", evidence: "old evidence",
    opened_at: minutesAgo(60), last_fired_at: minutesAgo(1), acknowledged_at: null,
  };
  const verdicts = new Map<string, ScreenVerdictRecord>([
    ["canvas-1", record("contradicted", secondsAgo(30), false)],
  ]);
  const { repo, state } = stubRepo(input, verdicts, [openCritical]);
  const result = await runAlerting(repo, { rules: [blackScreenRule], now: NOW });

  // Keeping the same rule id is deliberate: the alert an operator is already
  // watching changes severity and evidence in front of them, instead of silently
  // resolving and reappearing under a different id.
  assert.equal(result.resolved, 0, "the finding is not resolved — it is reinterpreted");
  assert.equal(result.refreshed, 1);
  assert.equal(state.refreshed[0]?.severity, "info");
  assert.match(state.refreshed[0]?.evidence ?? "", /refuted/);
});

test("a repository without latestScreenVerdicts degrades to unverified, not to refuted", async () => {
  const input = new Map([["canvas-1", { device: device(), samples: blackEpisode() }]]);
  const { repo, state } = stubRepo(input, "absent");
  const result = await runAlerting(repo, { rules: [blackScreenRule], now: NOW });

  assert.equal(result.refutedClaims, 0);
  assert.equal(state.opened[0]?.severity, "critical");
  assert.match(state.opened[0]?.evidence ?? "", /UNVERIFIED/);
});

test("an offline device is still short-circuited before the verdict is consulted", async () => {
  // Presence beats everything: the actionable fault is the outage, and a stored
  // verdict must not resurrect a screen-state alert on a dark device.
  const samples = [6, 4, 2, 0].map((ago) =>
    sample(ago, { isBlackScreen: true, presence: "offline" }),
  );
  const v = evaluateRule(blackScreenRule, {
    device: device(), samples, now: NOW,
    screenVerdict: record("confirmed", secondsAgo(30), true),
  });
  assert.equal(v.firing, false);
  assert.match(v.skipped ?? "", /offline/);
});
