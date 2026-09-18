/**
 * The collector-availability surface, and the two reachability numbers that
 * contradicted each other (US-8.5.4).
 *
 * TWO RECORDED FINDINGS, both of them about a number nobody could place.
 *
 * ONE. `GET /api/collector/availability` shipped in e201ace with no UI at all.
 * The figure that gates every SLA claim the product makes — on this corpus,
 * 1,793 of 8,640 five-minute buckets over 720 h, 20.8%, NOT claimable, cause
 * OURS — was readable only in SQL, while the SLA tab went on printing
 * percentages over a window whose coverage it never stated. The endpoint's
 * author left explicit instructions about how it must be rendered, and every
 * one of them is a trap this codebase has already fallen into once:
 *
 *   a null share is NOT 0%          `fleet.collectorUp.value` is null when the
 *                                   window holds no observation. On this corpus
 *                                   every window up to 168 h is exactly that. A
 *                                   literal "0%" in an availability slot is
 *                                   arguably true of us and reads as an estate
 *                                   outage — the worst number this page could
 *                                   print. `coverage.note` is the sentence that
 *                                   goes there instead.
 *   only `measured` has a rate      The other four states are not low rates,
 *                                   they are four DIFFERENT absences of a rate.
 *   `off-by-choice` is not a fault  A self-check that reports a deliberate
 *                                   configuration as a fault gets ignored, and
 *                                   then it reports the real fault to nobody.
 *   `silent` is not `unobservable`  The first means we CAN tell and nothing was
 *                                   recorded; the second that we cannot tell at
 *                                   all. One is a finding, the other is unknown.
 *   gaps in CADENCES, not seconds   A daily lane's 24 h gap is that lane
 *                                   working. `longestGapWithinCadence` decides
 *                                   whether a gap is a problem, never its size.
 *
 * TWO. The Overview's status widget read Online 90 / Warning 18 / Offline 139,
 * counted from the device rows. The health-score drawer read "108 of 247 devices
 * reachable", taken from the five-minute snapshot, which reports `warning: 0`.
 * Both were correct — 90 + 18 = 108 — and nothing on screen reconciled them, so
 * an operator was left choosing between two numbers that looked like a
 * disagreement. The fix is copy and provenance, not arithmetic: neither figure
 * moves, and both now say what they count and when they were counted.
 *
 * Everything below runs the console's REAL functions, lifted out of
 * public/console.html by name, because none of these are claims that can be
 * checked by reading the file.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ─── lifting the console's own source ────────────────────────────────────────

const consoleSource = async (): Promise<string> => {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFile(join(here, "..", "..", "public", "console.html"), "utf8");
};

const consoleScript = async (): Promise<string> => {
  const src = await consoleSource();
  const open = src.lastIndexOf("<script>");
  const close = src.lastIndexOf("</script>");
  assert.ok(open > 0 && close > open, "console.html must contain a trailing <script> block");
  return src.slice(open + "<script>".length, close);
};

const declarationOf = (script: string, name: string): string => {
  const lines = script.split("\n");
  const start = new RegExp(`^(?:async\\s+)?(?:function|const|let)\\s+${name}\\b`);
  const i = lines.findIndex((l) => start.test(l));
  assert.notEqual(
    i, -1,
    `console.html no longer declares a top-level "${name}". This test lifts it by name; ` +
    `if it moved or was renamed, follow it — do not delete the check.`,
  );
  for (let k = 1; k <= 400 && i + k <= lines.length; k++) {
    const text = lines.slice(i, i + k).join("\n");
    try {
      new Function(text);
    } catch {
      continue;
    }
    return text;
  }
  throw new assert.AssertionError({
    message: `could not delimit the declaration of "${name}" within 400 lines`,
  });
};

class El {
  innerHTML = "";
  textContent = "";
  className = "";
  title = "";
  open = false;
  readonly children: El[] = [];
  readonly dataset: Record<string, string> = {};
  appendChild(c: El): El { this.children.push(c); return c; }
  setAttribute(): void {}
  addEventListener(): void {}
  classList = { add: (): void => {}, remove: (): void => {}, toggle: (): void => {} };
  querySelectorAll(): El[] { return []; }
}

/**
 * Build a sandbox holding the named declarations and nothing else.
 *
 * The declaration list is FIXED, exactly as every other console suite's is —
 * which is the trap recorded in this file's neighbours: a render function that
 * reaches for a new top-level constant is undefined in here, and it took out 11
 * of 22 pinned URL tests at once when it last happened. That is why the lane
 * state vocabulary lives INSIDE renderCollectorAvailability, and why the
 * presence tally is inlined in both of the US-8.5.4 functions rather than
 * shared. If a test in this file starts failing with "x is not defined", the
 * console has grown a new top-level dependency and that is the finding.
 */
const sandbox = async <T>(
  decls: readonly string[], returns: string, state: Record<string, unknown>,
): Promise<{ api: T; el: (id: string) => El }> => {
  const script = await consoleScript();
  const els = new Map<string, El>();
  const el = (id: string): El => {
    const key = id.replace(/^#/, "");
    let e = els.get(key);
    if (!e) { e = new El(); els.set(key, e); }
    return e;
  };
  const body =
    `"use strict";\nconst { document, S, switchTab } = ctx;\n` +
    `const $ = (s) => document.querySelector(s);\n` +
    decls.map((n) => declarationOf(script, n)).join("\n") +
    `\nreturn ${returns};`;
  const api = new Function("ctx", body)({
    document: { querySelector: (sel: string): El => el(sel), createElement: (): El => new El() },
    S: { devices: [], compliance: [], summary: null, trunc: {}, cstate: "all", ...state },
    switchTab: (): void => {},
  }) as T;
  return { api, el };
};

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — the collector-availability surface
// ─────────────────────────────────────────────────────────────────────────────

const CAV_DECLS = [
  "esc", "ago", "dur", "kv", "na", "LANE_WORD", "CAV_WINDOW_HOURS",
  "renderCollectorAvailability",
] as const;

type CavApi = { renderCollectorAvailability: () => void; CAV_WINDOW_HOURS: number };

/** One lane, at the shape `laneAvailability()` really returns. */
const lane = (over: Record<string, unknown>): Record<string, unknown> => ({
  lane: "a-lane", feeds: "something", state: "measured", health: "healthy",
  configuredIntervalSeconds: 300,
  observability: { kind: "poller-runs", source: "poller_runs", why: null },
  optIn: { env: null, reading: "not-gated" },
  expectedFires: 100, observedFires: 99,
  coverage: {
    value: 0.99, basis: "99 row(s) in poller_runs",
    coverage: { measured: 99, inScope: 100, unit: "fires", share: 0.99, note: "99 of 100" },
  },
  coverageExcludingOutages: 0.99, spanSeconds: 86400, windowShare: 1,
  longestGapSeconds: 600, longestGapIntervals: 1.2, longestGapWithinCadence: true,
  missedFires: 1, missedFiresOutsideOutages: 1, incomplete: false,
  claim: { claimable: true, shortfalls: [] },
  ...over,
});

const WINDOW = {
  from: "2026-08-19T13:00:00.000Z", to: "2026-09-18T13:00:00.000Z",
  seconds: 2592000, hours: 720, bucketSeconds: 300, expectedBuckets: 8640,
  halfOpen: true, statement: "The 30 days ending 2026-09-18T13:00:00.000Z, in 5 min buckets — 8640 of them.",
};

const REFUSAL =
  "Declining to state an availability figure for 2026-08-19 → 2026-09-18. Coverage is 20.8% " +
  "against the 95.0% bar, with 24 days blind.";
const HEADLINE =
  "NOTHING over this window is claimable, and the cause is OURS: the collector was up for " +
  "20.8% of it against a 95.0% bar.";
const OUTAGE_VERDICT =
  "These 130 windows total 3 days across 8 lane(s), and they are OUR PROCESS STOPPING, not " +
  "8 lane failures.";

/** The live 720 h shape, all five lane states present. */
const cav = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  scope: "vfi-collector",
  generatedAt: "2026-09-18T13:00:00.000Z",
  window: WINDOW,
  fleet: {
    collectorUp: {
      value: 0.20752314814814815,
      basis: "Distinct 5 min buckets in which any active screen reported presence.",
      coverage: {
        measured: 1793, inScope: 8640, unit: "time-buckets", share: 0.2075,
        note: "1793 of 8640 buckets carried a reading from some screen; the other 6847 " +
          "(24 days) carried none from any screen and are counted as blind, never as offline.",
      },
    },
    observedBuckets: 1793, blindBuckets: 6847, blindSeconds: 2054100,
    windowHasNoObservations: false,
    lastCollectionAt: "2026-09-04T15:07:04.235Z", blindSinceSeconds: 1203264,
    weakestLane: { lane: "snapshot", coverage: 0.5932441942294159 },
    lanes: {
      declared: 5, measured: 1, silent: 1, offByChoice: 1, flagNotVisible: 1,
      unobservable: 1, claimable: 0,
    },
  },
  lanes: [
    lane({
      lane: "status", feeds: "presence", state: "measured", health: "stalled",
      configuredIntervalSeconds: 120, expectedFires: 6391, observedFires: 3857,
      coverage: {
        value: 0.6035049288061336, basis: "3857 row(s) in poller_runs over 9 days",
        coverage: { measured: 3857, inScope: 6391, unit: "fires", share: 0.6035, note: "3857 of 6391" },
      },
      coverageExcludingOutages: 0.8475, spanSeconds: 766807, windowShare: 0.2958,
      longestGapSeconds: 80217.795, longestGapIntervals: 668.481625,
      longestGapWithinCadence: false, missedFires: 2233, missedFiresOutsideOutages: 643,
      claim: { claimable: false, shortfalls: ["status ran at 60.4% of its configured 2 min cadence."] },
    }),
    // A daily lane whose worst gap skipped no scheduled fire: the lane WORKING.
    lane({
      lane: "data-usage", feeds: "daily per-device data usage", state: "measured",
      health: "healthy", configuredIntervalSeconds: 86400,
      expectedFires: 30, observedFires: 30,
      coverage: {
        value: 1, basis: "30 row(s) in poller_runs over 30 days",
        coverage: { measured: 30, inScope: 30, unit: "fires", share: 1, note: "30 of 30" },
      },
      coverageExcludingOutages: 1, spanSeconds: 2592000, windowShare: 1,
      longestGapSeconds: 87480, longestGapIntervals: 1.0125,
      longestGapWithinCadence: true, missedFires: 0, missedFiresOutsideOutages: 0,
      claim: { claimable: true, shortfalls: [] },
    }),
    lane({
      lane: "alert-cross-check", feeds: "the second opinion on our detection",
      state: "silent", health: "never-ran", configuredIntervalSeconds: 3600,
      expectedFires: null, observedFires: 0,
      coverage: {
        value: null, basis: "no rows in poller_runs for the assessed window.",
        coverage: { measured: 0, inScope: 0, unit: "fires", share: null, note: "no rows in poller_runs" },
      },
      coverageExcludingOutages: null, spanSeconds: null, windowShare: null,
      longestGapSeconds: null, longestGapIntervals: null, longestGapWithinCadence: null,
      missedFires: null, missedFiresOutsideOutages: null,
      claim: {
        claimable: false,
        shortfalls: ["alert-cross-check produced nothing in this window. There is no RATE to " +
          "report, so this is not 0% coverage; it is no coverage at all."],
      },
    }),
    lane({
      lane: "data-usage-off", feeds: "daily per-device data usage",
      state: "off-by-choice", health: "disabled", configuredIntervalSeconds: 86400,
      optIn: { env: "ENABLE_DATA_USAGE_POLL", reading: "off" },
      expectedFires: null, observedFires: 0,
      coverage: {
        value: null, basis: "no rows in poller_runs for the assessed window.",
        coverage: { measured: 0, inScope: 0, unit: "fires", share: null, note: "no rows in poller_runs" },
      },
      coverageExcludingOutages: null, spanSeconds: null, windowShare: null,
      longestGapSeconds: null, longestGapIntervals: null, longestGapWithinCadence: null,
      missedFires: null, missedFiresOutsideOutages: null,
      claim: {
        claimable: false,
        shortfalls: ["data-usage-off is off by choice (ENABLE_DATA_USAGE_POLL is not set), so " +
          "it collected nothing in this window. That is a configuration decision, not a " +
          "fault — but daily per-device data usage is absent all the same."],
      },
    }),
    lane({
      lane: "ai-brief", feeds: "the generated fleet brief", state: "flag-not-visible",
      health: "unknown", configuredIntervalSeconds: 86400,
      optIn: { env: "ENABLE_AI_JOBS", reading: "not-visible" },
      expectedFires: null, observedFires: 0,
      coverage: {
        value: null, basis: "no rows in poller_runs for the assessed window.",
        coverage: { measured: 0, inScope: 0, unit: "fires", share: null, note: "no rows in poller_runs" },
      },
      coverageExcludingOutages: null, spanSeconds: null, windowShare: null,
      longestGapSeconds: null, longestGapIntervals: null, longestGapWithinCadence: null,
      missedFires: null, missedFiresOutsideOutages: null,
      claim: {
        claimable: false,
        shortfalls: ["ai-brief is opt-in behind ENABLE_AI_JOBS, which is not set in this " +
          "process, and nothing was observed in this window."],
      },
    }),
    // The state this corpus cannot produce (no lane in the registry declares
    // observability kind "none"), so it is only ever exercised here.
    lane({
      lane: "phantom", feeds: "nothing we can see", state: "unobservable",
      health: "unknown", configuredIntervalSeconds: 600,
      observability: { kind: "none", source: null, why: "this lane writes no row anywhere" },
      expectedFires: null, observedFires: null,
      coverage: {
        value: null, basis: "this lane cannot be observed.",
        coverage: { measured: 0, inScope: 0, unit: "fires", share: null, note: "cannot be observed" },
      },
      coverageExcludingOutages: null, spanSeconds: null, windowShare: null,
      longestGapSeconds: null, longestGapIntervals: null, longestGapWithinCadence: null,
      missedFires: null, missedFiresOutsideOutages: null,
      claim: {
        claimable: false,
        shortfalls: ["phantom cannot be observed at all, so its availability is UNKNOWN " +
          "rather than low."],
      },
    }),
  ],
  outages: {
    count: 130, totalSeconds: 222715, lanesAffected: ["alerting", "status"],
    largest: {
      startedAt: "2026-08-26T18:19:16.493Z", endedAt: "2026-08-27T16:36:09.181Z",
      seconds: 80212, lanes: ["alerting", "status"], stopSpreadSeconds: 4.616,
      resumeSpreadSeconds: 35.228,
    },
    stopSpreadSeconds: { p50: 0.048, p90: 11.632, max: 104.65 },
    shareOfBlindTime: 0.1084, verdict: OUTAGE_VERDICT,
  },
  verdict: {
    claimable: false, headline: HEADLINE, cause: "ours",
    bars: { minCoverage: 0.95, maxCadenceSeconds: 3600 },
    missing: [
      { kind: "fleet-coverage-below-bar", subject: "(the whole fleet)", detail: "20.8% against the 95.0% bar." },
      { kind: "lane-off-by-choice", subject: "data-usage-off", detail: "Its flag is off." },
      { kind: "lane-flag-not-visible", subject: "ai-brief", detail: "The flag is unset here." },
      { kind: "lane-unobservable", subject: "phantom", detail: "It writes no row anywhere." },
      { kind: "lane-silent", subject: "alert-cross-check", detail: "It produced nothing." },
    ],
    claimableLanes: [], refusal: REFUSAL,
  },
  pipelineSummary: "0 of 16 lane(s) healthy.",
  summary: HEADLINE,
  ...over,
});

/** The empty-window shape: NULL share, and a note where the figure would be. */
const EMPTY_NOTE =
  "NO bucket in this window carried a reading from any screen. That is not 0% availability " +
  "of the estate — it is 7 days in which we were not looking at all, the last reading of any " +
  "kind being 2026-09-04T15:07:04.235Z (14 days ago).";

const cavEmpty = (): Record<string, unknown> => {
  const base = cav() as Record<string, any>;
  base.fleet.collectorUp = {
    value: null,
    basis: "Distinct 5 min buckets in which any active screen reported presence.",
    coverage: {
      measured: 0, inScope: 2016, unit: "time-buckets", share: null, note: EMPTY_NOTE,
    },
  };
  base.fleet.observedBuckets = 0;
  base.fleet.blindBuckets = 2016;
  base.fleet.windowHasNoObservations = true;
  base.fleet.weakestLane = null;
  base.verdict.headline =
    "NO availability figure can be stated for this window: we hold no reading from any " +
    "screen in it. This is our collector, not the estate.";
  base.verdict.refusal =
    "Declining to state an availability figure. The window carries no observations at all, " +
    "so any percentage would be an artefact of the window's placement rather than a measurement.";
  return base;
};

const cavHarness = async (state: Record<string, unknown>) =>
  sandbox<CavApi>(CAV_DECLS, "{ renderCollectorAvailability, CAV_WINDOW_HOURS }", state);

/** The lane table's rows, as the DOM would give them, keyed by lane name. */
const laneRows = (html: string): Map<string, string> => {
  const body = /<tbody>([\s\S]*)<\/tbody>/.exec(html);
  if (!body) return new Map();
  return new Map(
    [...(body[1] as string).matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => {
      const cell = /<td><b>([^<]*)<\/b>/.exec(m[1] as string);
      return [(cell ? cell[1] : "?") as string, m[0] as string];
    }),
  );
};

/** Text a human READS: markup stripped, entities folded, whitespace collapsed. */
const readable = (html: string): string =>
  html.replace(/<[^>]+>/g, " ")
    .replace(/&#8212;/g, "—").replace(/&#215;/g, "×").replace(/&#8220;|&#8221;/g, '"')
    .replace(/&amp;/g, "&").replace(/&#183;/g, "·").replace(/&#8594;/g, "→")
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim();

/**
 * The same text with every sentence the PAYLOAD supplied removed.
 *
 * Needed because the endpoint's own prose contains the string "0%" in sentences
 * that deny it — "this is not 0% coverage; it is no coverage at all" — so a
 * blunt search for a zero percentage matches the very copy that exists to
 * prevent one. What must be asserted is narrower and exactly right: the console
 * adds no zero of its own to anything it was handed a null for.
 */
const withoutPayloadProse = (text: string, payload: unknown): string => {
  const prose: string[] = [];
  const walk = (o: unknown): void => {
    if (typeof o === "string") { prose.push(o); return; }
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o && typeof o === "object") { Object.values(o).forEach(walk); }
  };
  walk(payload);
  let t = text;
  for (const s of prose.sort((a, b) => b.length - a.length)) {
    const needle = readable(s);
    if (needle.length > 8) t = t.split(needle).join(" ");
  }
  return t;
};

test("the harness lifts and runs the real collector surface", async () => {
  const script = await consoleScript();
  const src = declarationOf(script, "renderCollectorAvailability");
  assert.match(src, /^function renderCollectorAvailability\(\)/);
  const h = await cavHarness({ cav: cav() });
  h.api.renderCollectorAvailability();
  assert.ok(h.el("cavbody").innerHTML.length > 500, "the lifted surface must render something");
  assert.equal(laneRows(h.el("cavbody").innerHTML).size, 6, "every lane must get a row");
});

test("the endpoint's five lane states are all known to the renderer", async () => {
  /* Pinned to the endpoint's OWN union, by source text on both sides. The
     vocabulary is inline in the render function on purpose (see `sandbox`), so
     this is the check that keeps it honest: a sixth state added server-side
     must be taught here, not silently rendered as its raw key. */
  const here = dirname(fileURLToPath(import.meta.url));
  // Read from src/, not dist/: it is the declared union that is being pinned.
  const route = await readFile(
    join(here, "..", "..", "src", "api", "routes", "collector.ts"), "utf8");
  const union = /export type LaneCollectorState =([\s\S]*?);/.exec(route);
  assert.ok(union, "collector.ts must still declare LaneCollectorState as a union");
  const states = [...(union[1] as string).matchAll(/"([a-z-]+)"/g)].map((m) => m[1] as string);
  assert.deepEqual(
    [...states].sort(),
    ["flag-not-visible", "measured", "off-by-choice", "silent", "unobservable"],
    "the endpoint's state union changed — the console must be taught the new state",
  );
  const src = declarationOf(await consoleScript(), "renderCollectorAvailability");
  for (const s of states) {
    assert.ok(
      src.includes(`"${s}"`) || src.includes(`${s}:`),
      `renderCollectorAvailability does not mention the "${s}" state at all`,
    );
  }
});

test("a null collectorUp renders its note, and NOTHING that reads as a zero", async () => {
  // THE finding. `value` is null on every window up to 168 h on this corpus.
  const payload = cavEmpty();
  const h = await cavHarness({ cav: payload });
  h.api.renderCollectorAvailability();
  const html = h.el("cavbody").innerHTML;
  const text = readable(html);
  assert.ok(text.includes(EMPTY_NOTE),
    `the note that belongs in the figure's place was not rendered: ${text.slice(0, 400)}`);
  // No percentage of the console's OWN making anywhere in the fleet figure
  // block. Checked on the fleet block only — the lane table legitimately carries
  // per-lane rates — and with the payload's own prose removed, because that
  // prose says "not 0%" on purpose.
  const fleetBlock = html.slice(0, html.indexOf("<tbody>") < 0 ? html.length : html.indexOf("<tbody>"));
  const added = withoutPayloadProse(readable(fleetBlock), payload);
  assert.ok(!/(?<![\d.])0(\.0)?\s*%/.test(added),
    `a zero percentage appeared in the availability slot: ${added.slice(0, 500)}`);
  assert.ok(!/<b[^>]*font-size:26px/.test(fleetBlock),
    "the big-figure element must not be rendered at all when there is no figure");
  assert.ok(readable(fleetBlock).includes("no availability figure"),
    "the slot must say there is no figure, rather than leaving a blank");
});

test("a measured fleet share IS stated, with its own counts", async () => {
  // The other half of the same rule: a real measurement must not be refused.
  const h = await cavHarness({ cav: cav() });
  h.api.renderCollectorAvailability();
  const html = h.el("cavbody").innerHTML;
  /* On the FIGURE ELEMENT, not merely somewhere in the card: the verdict prose
     quotes "20.8%" too, so a card that refused to state the figure while still
     printing the headline passed the first version of this assertion. */
  assert.match(html, /<b[^>]*font-size:26px[^>]*>20\.8%<\/b>/,
    "the measured share must be stated as the figure, not only quoted in the prose");
  assert.ok(readable(html).includes("1793 of 8640 buckets"),
    "and it must carry its own counts");
});

test("the verdict's refusal, headline and cause are rendered VERBATIM", async () => {
  const h = await cavHarness({ cav: cav() });
  h.api.renderCollectorAvailability();
  const text = readable(h.el("cavbody").innerHTML);
  assert.ok(text.includes(HEADLINE), "the headline must be shown word for word, not summarised");
  assert.ok(text.includes(REFUSAL), "the refusal must be shown word for word");
  assert.match(text, /cause: OURS/,
    "the cause must be on screen: a low coverage figure with no attribution reads as an estate fault");
});

test("only `measured` lanes get a percentage; the other four get their shortfalls", async () => {
  const h = await cavHarness({ cav: cav() });
  h.api.renderCollectorAvailability();
  const rows = laneRows(h.el("cavbody").innerHTML);
  const payload = cav() as Record<string, any>;
  for (const l of payload.lanes) {
    const row = rows.get(l.lane);
    assert.ok(row, `no row rendered for ${l.lane}`);
    const text = readable(row);
    if (l.state === "measured") {
      assert.ok(text.includes(`${(l.coverage.value * 100).toFixed(1)}%`),
        `the measured lane ${l.lane} did not render its rate`);
    } else {
      assert.ok(text.includes("no rate"),
        `${l.lane} is ${l.state} and must say there is NO rate, not show one: ${text}`);
      assert.ok(!/(?<![\d.])0(\.0)?\s*%/.test(withoutPayloadProse(text, l)),
        `${l.lane} is ${l.state} and rendered a zero percentage: ${text}`);
      for (const s of l.claim.shortfalls) {
        assert.ok(text.includes(readable(s)),
          `${l.lane}'s shortfall text was not rendered in place of its rate: ${text}`);
      }
    }
  }
});

test("off-by-choice does not read as a fault", async () => {
  const h = await cavHarness({ cav: cav() });
  h.api.renderCollectorAvailability();
  const html = h.el("cavbody").innerHTML;
  const row = laneRows(html).get("data-usage-off");
  assert.ok(row, "the off-by-choice lane must still get a row");
  const text = readable(row);
  assert.ok(text.includes("off by choice"), `it must be named as a choice: ${text}`);
  assert.ok(/not a fault|NOT a fault/.test(text),
    `an off-by-choice lane must say in words that it is not a fault: ${text}`);
  // And it must not be dressed in the fault colour the silent lane wears.
  assert.ok(!/class="d red"/.test(row as string),
    "an off-by-choice lane must not carry the fault dot");
  assert.ok(/class="d gry"/.test(row as string),
    "an off-by-choice lane must carry the unjudged dot, like `disabled` does everywhere else");
  // Its blocker entry, too: listed, because what it feeds is absent, but labelled.
  const blockers = html.slice(html.indexOf("Exactly what is missing"));
  assert.ok(readable(blockers).includes("a configuration decision, not a fault"),
    "the blocker list must label an off-by-choice entry as not a fault");
});

test("silent and unobservable are told apart, in words", async () => {
  const h = await cavHarness({ cav: cav() });
  h.api.renderCollectorAvailability();
  const rows = laneRows(h.el("cavbody").innerHTML);
  const silent = readable(rows.get("alert-cross-check") as string);
  const unobs = readable(rows.get("phantom") as string);
  assert.ok(/we CAN tell/.test(silent),
    `a silent lane must say we can tell and nothing was recorded: ${silent}`);
  assert.ok(/we CANNOT tell/.test(unobs),
    `an unobservable lane must say we cannot tell at all: ${unobs}`);
  assert.ok(/UNKNOWN/.test(unobs),
    "an unobservable lane's availability is unknown, never low");
  assert.notEqual(
    /silent[\s\S]*?we CAN tell[^.]*/.exec(silent)?.[0],
    /unobservable[\s\S]*?we CANNOT tell[^.]*/.exec(unobs)?.[0],
    "the two absences must not share one sentence",
  );
});

test("a gap is shown in multiples of the lane's OWN cadence, never in seconds", async () => {
  const h = await cavHarness({ cav: cav() });
  h.api.renderCollectorAvailability();
  const rows = laneRows(h.el("cavbody").innerHTML);
  const status = readable(rows.get("status") as string);
  assert.ok(status.includes("×668.5"), `the gap must be a multiple of the cadence: ${status}`);
  assert.ok(status.includes("of its configured 2 min cadence"),
    "and it must name the cadence it is a multiple of");
  // The raw seconds must not appear anywhere in the table — that is the number
  // that makes a daily lane look broken every single day.
  const payload = cav() as Record<string, any>;
  for (const l of payload.lanes) {
    if (l.longestGapSeconds == null) continue;
    const row = readable(rows.get(l.lane) as string);
    assert.ok(!row.includes(String(Math.round(l.longestGapSeconds))),
      `${l.lane} rendered its longest gap in raw seconds (${l.longestGapSeconds}): ${row}`);
  }
});

test("a daily lane's 24 h gap is styled as the lane WORKING, not as a problem", async () => {
  // longestGapWithinCadence is what decides this, never the gap's size: 87,480 s
  // is 24.3 h and skipped no scheduled fire of a 24 h lane.
  const h = await cavHarness({ cav: cav() });
  h.api.renderCollectorAvailability();
  const rows = laneRows(h.el("cavbody").innerHTML);
  const daily = rows.get("data-usage") as string;
  assert.ok(/class="v ok">&#215;1\.0</.test(daily),
    `a within-cadence gap must be styled as fine, not as a fault: ${daily}`);
  assert.ok(readable(daily).includes("within cadence"),
    "and it must say so in words");
  const bad = rows.get("status") as string;
  assert.ok(/class="v bd">&#215;668\.5/.test(bad),
    "a gap that DID skip fires must still be styled as a problem");
});

test("the outage verdict sits ABOVE the per-lane table", async () => {
  // It is the single most useful sentence here: one process stopping, or N lanes
  // failing. Below the table it is the last thing read instead of the first.
  const h = await cavHarness({ cav: cav() });
  h.api.renderCollectorAvailability();
  const html = h.el("cavbody").innerHTML;
  const verdictAt = html.indexOf(OUTAGE_VERDICT);
  const tableAt = html.indexOf("<table");
  assert.notEqual(verdictAt, -1, "the outage verdict must be rendered");
  assert.notEqual(tableAt, -1, "the lane table must be rendered");
  assert.ok(verdictAt < tableAt,
    "the outage verdict must come BEFORE the per-lane table, not after it");
  assert.ok(readable(html).includes("p50 0.048 s"),
    "the stop spread is the evidence for the claim and must be shown with it");
});

test("with no correlated outage the surface says so, rather than showing a zero", async () => {
  const payload = cav() as Record<string, any>;
  payload.outages = {
    count: 0, totalSeconds: 0, lanesAffected: [], largest: null,
    stopSpreadSeconds: null, shareOfBlindTime: null, verdict: null,
  };
  const h = await cavHarness({ cav: payload });
  h.api.renderCollectorAvailability();
  const text = readable(h.el("cavbody").innerHTML);
  assert.ok(text.includes("No correlated outage in this window"),
    "a null outage verdict must be said in words");
  assert.ok(text.includes("not a statement that there were no gaps"),
    "and it must not be read as 'there were no gaps'");
  assert.ok(!/0 correlated window/.test(text), "nor rendered as a count of zero");
});

test("the state pills count the rows the table renders, in every state", async () => {
  /* Shipped broken three times in this file: a count beside a filtered list
     must come from the same array the rows come from. */
  const states = ["measured", "silent", "off-by-choice", "flag-not-visible", "unobservable"];
  for (const s of [...states, "all"]) {
    const h = await cavHarness({ cav: cav(), cstate: s });
    h.api.renderCollectorAvailability();
    const html = h.el("cavbody").innerHTML;
    const rows = laneRows(html).size;
    const pill = new RegExp(`data-st="${s}"[\\s\\S]*?<b>(\\d+)</b>`).exec(html);
    assert.ok(pill, `no pill rendered for state "${s}"`);
    if (s === "all") {
      assert.equal(Number(pill[1]), 6, "the all pill must count every lane");
      assert.equal(rows, 6, "and the unfiltered table must render every lane");
    } else {
      assert.equal(rows, Number(pill[1]),
        `the "${s}" pill says ${pill[1]} but the table renders ${rows} row(s)`);
    }
    assert.ok(readable(html).includes(`Showing ${rows} of 6 lane(s)`),
      "the row set must name how many of how many it is showing");
  }
});

test("the endpoint's own roster count appears only as a labelled subtitle", async () => {
  // fleet.lanes.declared is 5 in this fixture while six lanes are rendered — a
  // deliberate disagreement. The badge must follow the ROWS; the server's count
  // may appear only in the subtitle, and labelled.
  const h = await cavHarness({ cav: cav() });
  h.api.renderCollectorAvailability();
  const html = h.el("cavbody").innerHTML;
  const all = /data-st="all"[\s\S]*?<b>(\d+)<\/b>/.exec(html);
  assert.equal(Number(all?.[1]), 6, "the pill must count the rendered lanes, not fleet.lanes.declared");
  assert.match(h.el("cavsub").textContent, /5 lanes declared by the scheduler/,
    "the server's roster count belongs in the labelled subtitle");
});

test("the window is stated in words, and the figure's freshness with it", async () => {
  const h = await cavHarness({ cav: cav() });
  h.api.renderCollectorAvailability();
  const text = readable(h.el("cavbody").innerHTML);
  assert.ok(text.includes(WINDOW.statement), "the window statement must be rendered verbatim");
  assert.match(h.el("cavsub").textContent, /720 h window in 5 min buckets/);
  assert.match(h.el("cavsub").textContent, /assembled .* ago/,
    "a snapshot must never be presented without its age");
});

test("the window label follows the PAYLOAD, never the window the card asked for", async () => {
  /* The card requests CAV_WINDOW_HOURS, but what it must describe is the window
     the payload actually covers. Rendering a 168 h payload under a "720 h"
     label is the mislabelling this whole surface exists to prevent, and it
     happened the first time a narrower payload was put through this renderer. */
  const payload = cav() as Record<string, any>;
  payload.window = {
    ...WINDOW, hours: 168, seconds: 604800, expectedBuckets: 2016,
    statement: "The 7 days ending 2026-09-18T13:00:00.000Z, in 5 min buckets — 2016 of them.",
  };
  const h = await cavHarness({ cav: payload });
  h.api.renderCollectorAvailability();
  const text = readable(h.el("cavbody").innerHTML);
  assert.ok(text.includes("Measured over a 168 h lookback"),
    `the card must name the payload's window: ${text.slice(0, 600)}`);
  assert.ok(!text.includes(`${h.api.CAV_WINDOW_HOURS} h lookback`),
    "and must not name the window it happened to request");
  assert.match(h.el("cavsub").textContent, /168 h window/);
});

test("an unavailable endpoint says the coverage is UNKNOWN, not full and not zero", async () => {
  const h = await cavHarness({ cav: null });
  h.api.renderCollectorAvailability();
  const text = readable(h.el("cavbody").innerHTML);
  assert.ok(text.includes("did not answer"), "it must say the endpoint did not answer");
  assert.ok(/UNKNOWN, not full/.test(text),
    `an absent gate must not read as a cleared gate: ${text}`);
  assert.ok(!/%/.test(text), "and it must not state any share at all");
});

test("the card asks for the window it says it asks for", async () => {
  const h = await cavHarness({ cav: cav() });
  const script = await consoleScript();
  assert.equal(typeof h.api.CAV_WINDOW_HOURS, "number");
  assert.ok(
    script.includes("`/api/collector/availability?windowHours=${CAV_WINDOW_HOURS}`"),
    "the fetch must use the same constant the card quotes, or the label lies about the window",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — US-8.5.4: the two reachability numbers
// ─────────────────────────────────────────────────────────────────────────────

type StatusApi = { renderStatusWidget: () => void };
type HealthApi = { healthScore: () => any; showHealthBreakdown: (h: any) => void };

const STATUS_DECLS = ["esc", "ago", "statusOrder", "renderStatusWidget"] as const;
const HEALTH_DECLS = ["esc", "ago", "truncMark", "healthScore", "showHealthBreakdown"] as const;

/** The live corpus: 90 online, 18 warning, 139 offline, 108 reachable. */
const dev = (id: number, status: string, presence: string | null): Record<string, unknown> => ({
  id: `d-${id}`, name: `Canvas ${id}`, status, deviceClass: "canvas",
  latest: presence === null ? { observedAt: null, presence: null } : { presence },
});
const CORPUS = [
  ...Array.from({ length: 90 }, (_, i) => dev(i, "online", "online")),
  ...Array.from({ length: 18 }, (_, i) => dev(100 + i, "warning", "online")),
  ...Array.from({ length: 139 }, (_, i) => dev(200 + i, "offline", "offline")),
];
const SNAP_AT = "2026-09-04T15:03:23.606Z";
const SUMMARY = {
  snapshot: {
    computedAt: SNAP_AT, totalDevices: 247,
    byStatus: { online: 108, offline: 139, warning: 0, alert: 0, unknown: 0 },
    firmwareDistribution: [{ version: "7.0.14", count: 103, isLatest: true },
                           { version: "7.0.13", count: 144, isLatest: false }],
    openAlertsBySeverity: { critical: 36, high: 2, medium: 32, info: 221 },
    telemetryCoverage: 0.437,
  },
};

const statusHarness = async (state: Record<string, unknown>) =>
  sandbox<StatusApi>(STATUS_DECLS, "{ renderStatusWidget }", state);
const healthHarness = async (state: Record<string, unknown>) =>
  sandbox<HealthApi>(HEALTH_DECLS, "{ healthScore, showHealthBreakdown }", state);

const widgetCounts = (html: string): Record<string, number> =>
  [...html.matchAll(/data-status="([a-z]+)"[\s\S]*?<span class="sv">([\d,]+)<\/span>/g)]
    .reduce<Record<string, number>>(
      (o, m) => ({ ...o, [m[1] as string]: Number((m[2] as string).replace(/,/g, "")) }), {});

test("neither figure moved: the widget still counts rows and the drawer still counts the snapshot", async () => {
  // The fix is copy and provenance. If either number changed, the fix is wrong.
  const w = await statusHarness({ devices: CORPUS, summary: SUMMARY, fresh: null });
  w.api.renderStatusWidget();
  assert.deepEqual(widgetCounts(w.el("wstatus").innerHTML),
    { online: 90, warning: 18, offline: 139 },
    "the status widget must still count the device rows");

  const h = await healthHarness({ devices: CORPUS, summary: SUMMARY, compliance: [], slaCap: null });
  const score = h.api.healthScore();
  const reach = score.dims.find((d: any) => d.key === "Reachability");
  assert.ok(reach, "the reachability dimension must still exist");
  assert.ok(reach.detail.includes("108 of 247 devices reachable"),
    `the drawer must still report the snapshot's 108: ${reach.detail}`);
  assert.equal(reach.value, 44, "and its score must be unchanged");
});

test("each reachability number states what it counts and when it was counted", async () => {
  const w = await statusHarness({
    devices: CORPUS, summary: SUMMARY,
    fresh: { newestSampleAt: "2026-09-04T15:07:04.235Z" },
  });
  w.api.renderStatusWidget();
  const widget = readable(w.el("wstatus").innerHTML);
  // WHAT it counts.
  assert.ok(/Counted from the 247 device rows this page holds/.test(widget),
    `the widget must name its source: ${widget}`);
  assert.ok(/by presence AND screen state/.test(widget),
    "and say that it counts screen state as well as presence");
  // WHEN it was counted.
  assert.ok(/newest reading/.test(widget) && /14 d ago|ago/.test(widget),
    "and when the rows were read");

  const h = await healthHarness({ devices: CORPUS, summary: SUMMARY, compliance: [], slaCap: null });
  const reach = h.api.healthScore().dims.find((d: any) => d.key === "Reachability");
  assert.ok(/presence only/i.test(reach.detail + reach.source),
    "the drawer's figure must say it counts presence only");
  assert.ok(reach.source.includes("5-minute fleet snapshot"),
    `the drawer's figure must name its feed: ${reach.source}`);
  assert.ok(reach.source.includes(SNAP_AT),
    "and the instant that feed was computed");
});

test("each reachability number names the other, and the arithmetic that joins them", async () => {
  // 90 + 18 = 108, said on BOTH surfaces, so a reader on either one is never
  // left choosing between two numbers that look like a disagreement.
  const w = await statusHarness({ devices: CORPUS, summary: SUMMARY, fresh: null });
  w.api.renderStatusWidget();
  const widget = readable(w.el("wstatus").innerHTML);
  assert.ok(widget.includes("Online 90 + Warning 18 = 108"),
    `the widget must show the bridge arithmetic: ${widget}`);
  assert.ok(/health-score drawer/.test(widget), "and name the surface it reconciles with");
  assert.ok(widget.includes("108 of 247 devices reachable"),
    "quoting the other number as that surface states it");

  const h = await healthHarness({ devices: CORPUS, summary: SUMMARY, compliance: [], slaCap: null });
  const reach = h.api.healthScore().dims.find((d: any) => d.key === "Reachability");
  assert.ok(reach.source.includes("Online 90 + Warning 18 = 108"),
    `the drawer must show the same arithmetic: ${reach.source}`);
  assert.ok(/status widget/.test(reach.source), "and name the surface it reconciles with");
});

test("the bridge is DERIVED: change the rows and both sides follow", async () => {
  // Not a sentence with numbers typed into it. Two of the warning screens go
  // black (status "alert", presence still online) and both surfaces must move.
  const shifted = [
    ...CORPUS.slice(0, 106),
    dev(900, "alert", "online"), dev(901, "alert", "online"),
    ...CORPUS.slice(108),
  ];
  const w = await statusHarness({ devices: shifted, summary: SUMMARY, fresh: null });
  w.api.renderStatusWidget();
  const widget = readable(w.el("wstatus").innerHTML);
  assert.ok(widget.includes("Online 90 + Warning 16 + Alert 2 = 108"),
    `the widget's bridge must be recomputed from the rows: ${widget}`);
  const h = await healthHarness({ devices: shifted, summary: SUMMARY, compliance: [], slaCap: null });
  const reach = h.api.healthScore().dims.find((d: any) => d.key === "Reachability");
  assert.ok(reach.source.includes("Online 90 + Warning 16 + Alert 2 = 108"),
    `the drawer's bridge must be recomputed too: ${reach.source}`);
});

test("the two inlined presence tallies agree — they are duplicated on purpose", async () => {
  /* The tally is inline in renderStatusWidget AND in healthScore because the
     console suites lift each against a fixed declaration list. That duplication
     is only safe if something asserts the copies agree, so this does. */
  const fixtures = [
    CORPUS,
    [...CORPUS.slice(0, 50), dev(500, "unknown", null)],
    [dev(1, "online", "online")],
    [dev(1, "offline", "offline")],
  ];
  for (const devices of fixtures) {
    const w = await statusHarness({ devices, summary: SUMMARY, fresh: null });
    w.api.renderStatusWidget();
    const h = await healthHarness({ devices, summary: SUMMARY, compliance: [], slaCap: null });
    const reach = h.api.healthScore().dims.find((d: any) => d.key === "Reachability");
    /* "Online 90 + Warning 18 = 108", wherever it appears in either sentence.
       The FIRST version of this extractor never matched anything, so the test
       passed null against null on every fixture — a vacuous test that a
       mutation of the drawer's tally sailed straight through. Hence the guard
       below: the extractor must have found something before it can compare. */
    const terms = (t: string): string | null => {
      const m = /((?:[A-Z][a-z]+ [\d,]+)(?: \+ [A-Z][a-z]+ [\d,]+)*) = ([\d,]+)/.exec(t);
      return m ? `${m[1]} = ${m[2]}` : null;
    };
    const fromWidget = terms(readable(w.el("wstatus").innerHTML));
    const fromDrawer = terms(reach.source);
    if (devices.some((d) => (d as any).latest?.presence === "online")) {
      assert.ok(fromWidget, `no presence split found in the widget over ${devices.length} rows`);
      assert.ok(fromDrawer, `no presence split found in the drawer over ${devices.length} rows`);
    }
    assert.equal(
      fromWidget, fromDrawer,
      `the widget and the drawer disagree about the presence split over ${devices.length} rows`,
    );
  }
});

test("rows with no presence field are UNKNOWN, never reconciled to zero", async () => {
  // The honest-nulls rule, on the bridge itself: a tally that cannot be computed
  // must not print "0 of these rows are reachable".
  const noPresence = [
    ...Array.from({ length: 90 }, (_, i) => ({ id: `d-${i}`, name: "x", status: "online" })),
    ...Array.from({ length: 18 }, (_, i) => ({ id: `w-${i}`, name: "x", status: "warning" })),
  ];
  const w = await statusHarness({ devices: noPresence, summary: SUMMARY, fresh: null });
  w.api.renderStatusWidget();
  const widget = readable(w.el("wstatus").innerHTML);
  assert.ok(/cannot be reconciled here/.test(widget),
    `an uncomputable bridge must say so: ${widget}`);
  assert.ok(/unknown, not equal/.test(widget), "in the words unknown, not equal");
  assert.ok(!/= 0\b/.test(widget), "and it must never print a reconciliation of zero");

  const h = await healthHarness({ devices: noPresence, summary: SUMMARY, compliance: [], slaCap: null });
  const reach = h.api.healthScore().dims.find((d: any) => d.key === "Reachability");
  assert.ok(/cannot be reconciled here/.test(reach.source),
    `the drawer's side must refuse too: ${reach.source}`);
  assert.ok(!/= 0\b/.test(reach.source), "and print no zero either");
});

test("a real drift between the two is reported as a clock difference, not as equality", async () => {
  // The snapshot is computed on its own cadence, so the two CAN differ. When
  // they do, the copy must not put an equals sign over the gap.
  const stale = { snapshot: { ...SUMMARY.snapshot, byStatus: { ...SUMMARY.snapshot.byStatus, online: 101 } } };
  const w = await statusHarness({ devices: CORPUS, summary: stale, fresh: null });
  w.api.renderStatusWidget();
  const widget = readable(w.el("wstatus").innerHTML);
  assert.ok(/a difference of 7/.test(widget), `the difference must be named: ${widget}`);
  assert.ok(!/exactly the/.test(widget), "and equality must not be claimed");

  const h = await healthHarness({ devices: CORPUS, summary: stale, compliance: [], slaCap: null });
  const reach = h.api.healthScore().dims.find((d: any) => d.key === "Reachability");
  assert.ok(/7 away from this 101/.test(reach.source), `the drawer must name it too: ${reach.source}`);
  assert.ok(/clock difference, not a fault/.test(reach.source),
    "and attribute it to the clocks rather than to a broken number");
});

test("every counted dimension in the drawer carries its feed and its clock", async () => {
  const h = await healthHarness({
    devices: CORPUS, summary: SUMMARY, lastLoadAt: Date.now(),
    compliance: [{ deviceId: "d-0", score: 92 }, { deviceId: "d-1", score: 88 }], slaCap: null,
  });
  const score = h.api.healthScore();
  for (const d of score.dims) {
    assert.ok(typeof d.source === "string" && d.source.length > 40,
      `the "${d.key}" dimension states no source — the US-8.5.4 regression`);
  }
  // And the drawer actually renders them.
  h.api.showHealthBreakdown(score);
  const body = readable(h.el("dbody").innerHTML);
  for (const d of score.dims) {
    assert.ok(body.includes(readable(d.source)),
      `the "${d.key}" source was computed but never rendered`);
  }
  assert.ok(/count different things from different feeds are not a contradiction/.test(body),
    "the drawer must say why two honest numbers can differ");
});

test("the compliance dimension names its OWN collection, not the snapshot", async () => {
  // Its mean comes from a walked collection, on a different clock from the
  // snapshot. Attributing it to the snapshot would be the same bug again.
  const h = await healthHarness({
    devices: CORPUS, summary: SUMMARY, lastLoadAt: Date.now(),
    compliance: [{ deviceId: "d-0", score: 92 }], slaCap: null,
  });
  const drift = h.api.healthScore().dims.find((d: any) => d.key === "Configuration drift");
  assert.ok(/NOT the fleet snapshot/.test(drift.source), drift.source);
  assert.ok(/absent from the mean rather than scored zero/.test(drift.source),
    "and it must say that unscored devices are absent, not zeroed");
});
