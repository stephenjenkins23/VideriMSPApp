/**
 * BUG-10 in the console: the withdrawn co-firing claim, rendered.
 *
 * The fix withdraws the co-firing claim on any window whose opens all landed
 * in the first evaluation pass after our OWN collector regained sight — 131
 * co-firing windows became 91, with 40 withdrawn. Because the withdrawal is
 * expressed as `coFiring: false`, the console's old co-firing tag simply
 * DISAPPEARED: safe, and completely silent. An operator was shown a
 * seven-device window with no account of why it is not a site event, which
 * threw away the most useful thing the fix learned.
 *
 * What is pinned here is exactly that, plus the three things this surface can
 * only get wrong silently:
 *
 *   - a withdrawn window rendering as silence instead of its own provenance,
 *   - `provenance.checked: false` reading as a clean bill of health, which
 *     would be worse than the bug it is reporting on,
 *   - "we did not ask for the correlation cross-link" and "we asked and
 *     nothing matched" rendering as the same grey line.
 *
 * Same technique, and the same warning, as console-incidents.test.ts: this is
 * logic living in a 500 KB HTML file that no type checker can see, so it is
 * lifted by name and run. If a declaration moves, follow it — do not delete
 * the check.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ─── lifting the console's own declarations ──────────────────────────────────

const CONSOLE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "console.html");

const consoleHtml = (): Promise<string> => readFile(CONSOLE_PATH, "utf8");

const consoleScript = async (): Promise<string> => {
  const src = await consoleHtml();
  const open = src.lastIndexOf("<script>");
  const close = src.lastIndexOf("</script>");
  assert.ok(open > 0 && close > open, "console.html must contain a trailing <script> block");
  return src.slice(open + "<script>".length, close);
};

/**
 * Delimited by PARSEABILITY, not by brace counting: these renderers are mostly
 * template literals and a literal `}` inside one is not a closing brace.
 *
 * The window is 600 lines rather than console-incidents.test.ts's 400 purely
 * for headroom. The binding ceiling in this suite is console-overview.test.ts's
 * 300, and renderIncidents() is the longest declaration the console has: this
 * pass pushed it to 358 and blew that limit, which is why the two BUG-10
 * queue-level blocks are now incWithdrawnHtml() and incProvenanceHtml() rather
 * than inline. renderIncidents() is 289 lines again. Anything added to it from
 * here needs the same treatment — and the new name needs adding to every
 * declaration list that lifts renderIncidents, or the harness ReferenceErrors.
 */
const declarationOf = (script: string, name: string): string => {
  const lines = script.split("\n");
  const start = new RegExp(`^(?:async\\s+)?(?:function|const|let)\\s+${name}\\b`);
  const i = lines.findIndex((l) => start.test(l));
  assert.notEqual(
    i, -1,
    `console.html no longer declares a top-level "${name}". This test lifts it by name; ` +
    `if it moved or was renamed, follow it — do not delete the check.`,
  );
  for (let k = 1; k <= 600 && i + k <= lines.length; k++) {
    const text = lines.slice(i, i + k).join("\n");
    try {
      new Function(text);
    } catch {
      continue;
    }
    return text;
  }
  throw new assert.AssertionError({
    message: `could not delimit the declaration of "${name}" within 600 lines`,
  });
};

class El {
  innerHTML = "";
  textContent = "";
  title = "";
  className = "";
  value = "";
  readonly children: El[] = [];
  readonly dataset: Record<string, string> = {};
  appendChild(c: El): El {
    this.children.push(c);
    return c;
  }
  setAttribute(): void {}
  addEventListener(): void {}
  querySelector(): El | null {
    return null;
  }
  querySelectorAll(): El[] {
    return [];
  }
  scrollIntoView(): void {}
}

/** Source order, because these are `const`s and `function`s in one scope. */
const DECLS = [
  "esc", "ago", "SEV",
  "INC_LIMIT", "INC_WINDOWS_SHOWN", "INC_DRILL_ID_CAP",
  "INC_STATES", "INC_SEVS", "INC_WINDOWS",
  "incQuery", "loadIncidents", "incAxis", "incRecurrence", "incFlap",
  "incRosterHtml", "incWindowsHtml", "loadIncidentTransitions", "incDrillHtml",
  "incidentRow",
  // The two BUG-10 queue-level renderers. renderIncidents() calls both, so a
  // harness that lifts renderIncidents and not these gets a ReferenceError at
  // render time — the same fixed-declaration-list trap that once broke 11 of
  // the 22 pinned URL tests at once.
  "incWithdrawnHtml", "incProvenanceHtml",
  "renderIncidents",
] as const;

type Api = {
  incQuery: () => string;
  incRecurrence: (o: unknown, axis: string) => string;
  incWindowsHtml: (i: unknown) => string;
  incidentRow: (i: unknown) => string;
  renderIncidents: () => void;
};

type Harness = {
  api: Api;
  S: Record<string, any>;
  el: (id: string) => El;
  asked: string[];
};

const harness = async (
  state: Record<string, unknown> = {},
  responses: Record<string, unknown> = {},
): Promise<Harness> => {
  const script = await consoleScript();
  const els = new Map<string, El>();
  const el = (id: string): El => {
    const key = id.replace(/^#/, "");
    let e = els.get(key);
    if (!e) {
      e = new El();
      els.set(key, e);
    }
    return e;
  };
  const asked: string[] = [];
  const S: Record<string, unknown> = {
    inc: null, incPage: null, incErr: null, incLoading: false, incAt: Date.now(),
    incF: {
      page: 1, state: "all", severity: "all", rule: null, deviceId: null,
      sinceDays: null, correlate: false,
    },
    incOpen: null, incDrill: {},
    ...state,
  };
  const respond = (path: string): unknown => {
    asked.push(path);
    const key = Object.keys(responses).find((k) => path.startsWith(k));
    if (key === undefined) throw new Error(`no fixture for ${path}`);
    const value = responses[key];
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(value);
  };
  const body =
    `"use strict";\nconst { document, S, api, apiAll, openDevice, switchTab, renderActions } = ctx;\n` +
    `const $ = (s) => document.querySelector(s);\n` +
    DECLS.map((n) => declarationOf(script, n)).join("\n") +
    `\nreturn { incQuery, incRecurrence, incWindowsHtml, incidentRow, renderIncidents };`;
  const api = new Function("ctx", body)({
    document: { querySelector: (sel: string): El => el(sel), createElement: (): El => new El() },
    S,
    api: (p: string) => respond(p),
    apiAll: (p: string) => respond(p),
    openDevice: (): void => {},
    switchTab: (): void => {},
    renderActions: (): void => {},
  }) as Api;
  return { api, S, el, asked };
};

// ─── fixtures, copied off a live /api/incidents read ─────────────────────────

type Row = Record<string, any>;

/**
 * `Montreal Office` / `offline-4h`, verbatim from the corpus: 2 windows, 0
 * co-firing, 1 NOTICED together (six devices, blind 23.6h), 1 isolated. The
 * worked example the fix's own report quotes.
 */
const WITHDRAWN_NOTE =
  "Noticed together, NOT failed together. All 6 device(s) here opened in the first 450s after " +
  "collection resumed at 2026-08-26T18:06:52.734Z, having been blind for 23.6h — so we found " +
  "them already down, at unknown and probably different times, rather than watching them fail " +
  "together. The alerts are real and still listed; the co-firing claim is withdrawn because " +
  "nothing here can date a failure. Dispatching to a site on this evidence would be dispatching " +
  "on our own outage.";

const withdrawnWindow = (over: Row = {}): Row => ({
  windowStart: "2026-08-26T18:00:00.000Z", windowEnd: "2026-08-26T18:30:00.000Z",
  deviceCount: 6, deviceIds: ["1000137", "1000143", "1000179", "1000209", "1000210", "1000304"],
  transitionIds: ["a", "b", "c", "d", "e", "f"],
  coFiring: false,
  failedTogetherDeviceCount: 0,
  noticedTogetherTransitions: 6,
  noticedTogether: true,
  provenance: {
    resumedAt: "2026-08-26T18:06:52.734Z", source: "observation-gap",
    blindSeconds: 84808.269, blindReason: null, lanes: [],
    firstPassSeconds: 450, transitions: 6, devices: 6,
    note: WITHDRAWN_NOTE,
  },
  ...over,
});

const isolatedWindow = (over: Row = {}): Row => ({
  windowStart: "2026-08-25T18:00:00.000Z", windowEnd: "2026-08-25T18:30:00.000Z",
  deviceCount: 1, deviceIds: ["1000180"], transitionIds: ["g"],
  coFiring: false, failedTogetherDeviceCount: 0, noticedTogetherTransitions: 1,
  noticedTogether: false,
  provenance: {
    resumedAt: "2026-08-25T18:14:29.428Z", source: "observation-start",
    blindSeconds: null,
    blindReason: "this is the earliest collector observation we still hold, and both " +
      "poller_runs and fleet_snapshots are retention-pruned, so how long the estate was " +
      "unobserved before it cannot be known",
    lanes: [], firstPassSeconds: 450, transitions: 1, devices: 1,
    note: "Noticed together, NOT failed together. All 1 device(s) here opened in the first 450s…",
  },
  ...over,
});

const montreal = (over: Row = {}): Row => ({
  id: "incident::group:4250f07c::offline-4h",
  scope: {
    axis: "group", id: "4250f07c", label: "Montreal Office", siteResolved: false,
    reason: 'Grouped by the device\'s LEAF group ("Montreal Office"), not by site.',
  },
  ruleId: "offline-4h",
  title: "Device offline for 4 hours",
  severity: "critical",
  severityCounts: { critical: 7, high: 0, medium: 0, info: 0 },
  state: "open",
  transitionCount: 7, openTransitions: 6, resolvedTransitions: 1, acknowledgedTransitions: 0,
  firstSeenAt: "2026-08-25T18:14:00.000Z", lastSeenAt: "2026-09-04T12:00:00.000Z",
  deviceCount: 7,
  roster: [{
    deviceId: "1000137", deviceName: "Montreal Office-1",
    transitionCount: 1, openTransitions: 1,
    firstSeenAt: "2026-08-26T18:06:00.000Z", lastSeenAt: "2026-09-04T12:00:00.000Z",
  }],
  occurrences: {
    total: 2, coFiring: 0, noticedTogether: 1, isolated: 1,
    transitionsCoFiring: 0, transitionsNoticedTogether: 6, transitionsIsolated: 1,
    windowMinutes: 30, minCoFiringDevices: 3,
    basis: "An occurrence is one fixed 30-minute window in which this incident opened at least " +
      "once; 0 of 2 carried 3 or more devices firing together.",
    windows: [isolatedWindow(), withdrawnWindow()],
  },
  flap: {
    classification: "sustained", meanOpenMinutes: 6, resolvedTransitions: 1, openTransitions: 6,
    opensPerDay: 0.7, observedSpanHours: 233.8, distinctHoursOfDay: 1,
    reason: "Recurs only 0.7×/day (under 2), so it is not oscillating.",
  },
  drilldown: { ruleId: "offline-4h", deviceIds: ["1000137"] },
  correlationFindings: [],
  ...over,
});

const CHECKED_NOTE =
  "40 window(s) covering 226 transition(s) carried 3 or more devices but opened inside the " +
  "first 450s after one of 132 collector resume(s), so they are reported as NOTICED together " +
  "rather than FAILED together.";

const payload = (incidents: Row[], over: Record<string, unknown> = {}): Record<string, unknown> => ({
  incidents,
  grouping: {
    axis: "group", axisLabel: "leaf group (devices.group_id) — NOT site",
    incidentsByAxis: { site: 0, group: 204, device: 63 },
    transitionsByAxis: { site: 0, group: 1159, device: 63 },
    siteAxisAvailable: false,
    reason: "Incidents are keyed on (LEAF GROUP, rule), not on (site, rule).",
  },
  totals: {
    incidents: 267, transitions: 1222, openIncidents: 134, openTransitions: 285,
    unattributedTransitions: 63, collapsePercent: 78.2,
    coFiringEvents: 91, coFiringTransitions: 408,
    coFiringSharePercent: 33.4, coFiringShareOfAttributedPercent: 35.2,
    noticedTogetherEvents: 40, noticedTogetherTransitions: 226,
  },
  reconciliation: {
    transitionsIn: 1222, transitionsInIncidents: 1222,
    transitionsInOccurrenceWindows: 1222, distinctTransitionIds: 1222,
    balanced: true, note: "Every transition handed in lands in exactly one incident.",
  },
  provenance: {
    checked: true, reason: null, resumes: 132, firstPassSeconds: 450,
    suppressedEvents: 40, suppressedTransitions: 226, note: CHECKED_NOTE,
    resumesBySource: { "correlated-outage": 130, "observation-gap": 1, "observation-start": 1 },
    coversFrom: "2026-08-25T18:14:29.428Z",
    coverageNote: "Resume history starts at 2026-08-25T18:14:29.428Z.",
  },
  corpus: {
    transitionsRead: 1222, transitionsInWindow: 1235, transitionsExcludedRetired: 13,
    retirementNote: "13 transition(s) belong to retired devices and are excluded.",
    windowDays: null, windowNote: "All history held.",
    incidentsSelected: 267, incidentsInWindow: 267,
  },
  filters: { state: "all", severity: null, rule: null, deviceId: null, sinceDays: null, note: "" },
  correlation: {
    available: false,
    reason: "Not requested. Pass correlate=true to cross-link live correlation findings onto " +
      "the incidents whose device rosters they touch.",
    findings: 0,
  },
  ...over,
});

const pageMeta = (over: Record<string, number> = {}): Record<string, number> =>
  ({ page: 1, limit: 50, totalItems: 267, totalPages: 6, ...over });

/**
 * Text as a reader sees it: tags stripped, entities decoded, whitespace
 * flattened. Every assertion below runs through this, and every extraction
 * asserts it ACTUALLY matched — a previous test on this surface passed only
 * because its regex never matched and it then compared null to null.
 */
const readable = (html: string): string => {
  assert.ok(html.length > 0, "nothing was rendered at all, so there is no text to read");
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#8212;/g, "—").replace(/&#183;/g, "·").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#10003;/g, "✓")
    .replace(/&#8853;/g, "⊕").replace(/&#9888;/g, "⚠")
    .replace(/\s+/g, " ")
    .trim();
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. A withdrawn window explains itself. Never silence.
// ─────────────────────────────────────────────────────────────────────────────

test("a withdrawn window prints the payload's own provenance note, not silence", async () => {
  const h = await harness();
  const html = h.api.incWindowsHtml(montreal());
  const text = readable(html);
  // The pre-written sentence, carrying the resume instant AND the blind duration.
  assert.match(text, /Noticed together, NOT failed together/,
    "the withdrawn window must carry the payload's own sentence");
  assert.match(text, /resumed at 2026-08-26T18:06:52\.734Z/,
    "the note must carry the resume instant — WHEN we noticed is the whole finding");
  assert.match(text, /blind for 23\.6h/,
    "the note must carry how long we were blind before that resume");
  // And it must be where the co-firing tag used to be.
  assert.match(html, /data-ntbadge="1"/, "the withdrawn window must raise its own badge");
  assert.match(text, /noticed together, not failed together/,
    "the badge must say what replaced the co-firing claim");
});

test("the withdrawn badge is INFORMATION, not a fault", async () => {
  const h = await harness();
  const html = h.api.incWindowsHtml(montreal());
  const badge = /<span class="([^"]*)"[^>]*data-ntbadge="1"/.exec(html);
  assert.ok(badge, "the noticed-together badge must be findable by its data attribute");
  const cls = badge[1] ?? "";
  assert.notEqual(cls, "", "the badge matched but captured no class — a vacuous assertion");
  assert.match(cls, /\btag net\b/,
    "noticed-together is styled `.tag.net` (informational blue): nothing is wrong with these " +
    "devices TOGETHER, and each alert is still individually real");
  assert.ok(!/\bbad\b/.test(cls), "a withdrawn claim must not be styled as a failure");
  assert.ok(!/\bwarn\b/.test(cls), "a withdrawn claim must not be styled as a warning");
});

test("a window that is STILL co-firing keeps the co-firing tag AND gains the note", async () => {
  const h = await harness();
  const kept = montreal({
    occurrences: {
      ...montreal().occurrences,
      total: 1, coFiring: 1, noticedTogether: 0, isolated: 0,
      transitionsCoFiring: 7, transitionsNoticedTogether: 0, transitionsIsolated: 0,
      windows: [withdrawnWindow({
        deviceCount: 7, transitionIds: ["a", "b", "c", "d", "e", "f", "g"],
        coFiring: true, noticedTogether: false, failedTogetherDeviceCount: 4,
        provenance: {
          ...withdrawnWindow().provenance,
          note: "3 of this window's transitions opened in the first 450s after collection " +
            "resumed at 2026-08-26T18:06:52.734Z, having been blind for 23.6h, so those open " +
            "times date OUR NOTICING. The window still co-fires on the 4 device(s) that fired " +
            "outside that pass.",
        },
      })],
    },
  });
  const text = readable(h.api.incWindowsHtml(kept));
  assert.match(text, /co-firing/, "a kept claim must still be tagged co-firing");
  assert.match(text, /date OUR NOTICING/,
    "an operator deciding whether to dispatch must see that PART of the burst is our blindness");
  assert.match(text, /4 of them fired outside that first pass/,
    "failedTogetherDeviceCount is the devices the co-firing test was actually made on");
});

test("a sub-threshold window is NOT described as a withdrawal, because nothing was withdrawn", async () => {
  const h = await harness();
  const text = readable(h.api.incWindowsHtml(montreal()));
  assert.match(text, /never carried the 3-device signature, so there was no co-firing claim to withdraw/,
    "a one-device window never had a claim; calling its provenance a withdrawal would be a new lie");
  // Honest null on an unbounded blind window: a reason, never "0h".
  assert.match(text, /blind for an unknown length of time \(this is the earliest collector observation/,
    "blindSeconds: null must render as unknown WITH the reason");
  assert.ok(!/blind for 0h/.test(text), '"0h blind" would read as "there was no outage"');
});

test("a withdrawn window with NO provenance says the payload is missing it, and is not silent", async () => {
  const h = await harness();
  const naked = montreal({
    occurrences: {
      ...montreal().occurrences,
      windows: [withdrawnWindow({ provenance: null })],
    },
  });
  const text = readable(h.api.incWindowsHtml(naked));
  assert.match(text, /withdrawn and the payload carried no provenance to explain it/,
    "an unexplained withdrawal is a bug in /api/incidents, not a quiet window");
  assert.match(text, /bug in \/api\/incidents/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The occurrence triples, asserted client-side
// ─────────────────────────────────────────────────────────────────────────────

test("the window triple is asserted and stated: coFiring + noticedTogether + isolated = total", async () => {
  const h = await harness();
  const text = readable(h.api.incWindowsHtml(montreal()));
  assert.match(text, /0 co-firing \+ 1 noticed together \+ 1 isolated = 2 window\(s\)/,
    "the triple the endpoint designed to be client-assertable must be asserted and printed");
});

test("the transition triple is asserted against the incident's own transition count", async () => {
  const h = await harness();
  const text = readable(h.api.incWindowsHtml(montreal()));
  assert.match(text, /0 \+ 6 \+ 1 transition\(s\) in those three buckets = 7/,
    "the transition triple must sum to transitionCount, and say so");
});

test("a triple that does NOT sum says so, loudly, and sends the reader to the transitions", async () => {
  const h = await harness();
  const broken = montreal({
    occurrences: { ...montreal().occurrences, isolated: 4 },
  });
  const text = readable(h.api.incWindowsHtml(broken));
  assert.match(text, /The window buckets do not add up/,
    "a bucket that moved a window without taking it out of the one it came from must be visible");
  assert.match(text, /trust the transitions below/);
});

test("a transition triple that does not sum says so", async () => {
  const h = await harness();
  const broken = montreal({
    occurrences: { ...montreal().occurrences, transitionsIsolated: 3 },
  });
  assert.match(readable(h.api.incWindowsHtml(broken)), /The transition split does not add up/);
});

test("a MISSING bucket renders unknown, never 0 and never 'it adds up'", async () => {
  const h = await harness();
  const partial = montreal({
    occurrences: { ...montreal().occurrences, noticedTogether: null, transitionsNoticedTogether: undefined },
  });
  const html = h.api.incWindowsHtml(partial);
  const text = readable(html);
  assert.match(text, /did not carry all three window buckets as numbers/,
    "an unchecked triple must say it could not be checked");
  assert.match(text, /which is not the same as it adding up/);
  assert.match(text, /did not carry the transition split as numbers/);
  assert.match(html, /class="unres"/, "an unknown is styled as unresolved, not as a value");
  assert.ok(!/0 co-firing \+ 0 noticed together/.test(text),
    "a missing bucket must never be counted as zero");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The collapsed row names the withdrawn bucket
// ─────────────────────────────────────────────────────────────────────────────

test("the collapsed row prints the withdrawn count beside the co-firing count", async () => {
  const h = await harness();
  const text = readable(h.api.incRecurrence(montreal().occurrences, "group"));
  assert.match(text, /recurred 2 times, 0 of them group-wide/,
    "both the total and the co-firing count are still printed (correction 3 to the epic)");
  assert.match(text, /1 noticed together, not failed together/,
    'without this the row reads "0 of them group-wide" and the six-device window vanishes');
});

test("a row with no withdrawn windows does not invent the clause", async () => {
  const h = await harness();
  const text = readable(h.api.incRecurrence(
    { ...montreal().occurrences, noticedTogether: 0 }, "group"));
  assert.ok(!/noticed together/.test(text),
    "a genuinely empty bucket is not mentioned rather than padded with a zero");
});

test("a row whose payload carries NO noticedTogether count says unknown, not none", async () => {
  const h = await harness();
  const html = h.api.incRecurrence({ ...montreal().occurrences, noticedTogether: null }, "group");
  const text = readable(html);
  assert.match(text, /whether any co-firing claim here was withdrawn is unknown/,
    "silence here is the exact failure this pass exists to end");
  assert.match(text, /which is not the same as none/);
  assert.match(html, /class="unres"/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. provenance.checked — `false` must NEVER read as clean
// ─────────────────────────────────────────────────────────────────────────────

const renderWith = async (over: Record<string, unknown>): Promise<Harness> => {
  const h = await harness({
    inc: payload([montreal()], over),
    incPage: pageMeta(),
  });
  h.api.renderIncidents();
  return h;
};

test("provenance.checked === false reads as NOT CHECKED, never as clean", async () => {
  const h = await renderWith({
    provenance: {
      checked: false,
      reason: "Collector observation history could not be read (no poller_runs rows in range).",
      resumes: 0, firstPassSeconds: 450, suppressedEvents: 0, suppressedTransitions: 0, note: "",
    },
  });
  const html = h.el("#inccollapse").innerHTML;
  const text = readable(html);
  assert.match(text, /Co-firing claims on this page were NOT provenance-checked/,
    "an unchecked surface must say so in the affirmative");
  assert.match(text, /not a clean bill of health/,
    "the one sentence that must exist: unchecked is not clean");
  assert.match(text, /not a finding of "no artifacts"/);
  assert.match(text, /no poller_runs rows in range/, "the payload's own reason must be printed");
  assert.match(text, /upper bound/,
    "with no resume history every co-firing count on the page is an upper bound");
  // And it must NOT be able to read as a positive result.
  assert.ok(!/were provenance-checked against/.test(text),
    "the CHECKED sentence must not appear on an unchecked page");
  // Styled as a banner that stops a reader, not as a neutral aside.
  assert.match(html, /class="note"/,
    "`checked: false` gets the note treatment; a bare `.na` line reads as a clean footnote");
});

test("a payload with NO provenance block at all also reads as not checked", async () => {
  const h = await renderWith({ provenance: undefined });
  const text = readable(h.el("#inccollapse").innerHTML);
  assert.match(text, /NOT provenance-checked/,
    "a missing block is 'we cannot say it was checked', not 'nothing was found'");
  assert.match(text, /carried no provenance block at all/);
  assert.match(text, /not a clean bill of health/);
});

test("a non-boolean `checked` is treated as unchecked rather than as truthy", async () => {
  // `checked: "false"` (a string) is truthy in JS. Anything that is not
  // literally `true` must fall to the unchecked branch.
  const h = await renderWith({
    provenance: { checked: "false", reason: null, resumes: 0, firstPassSeconds: 450,
      suppressedEvents: 0, suppressedTransitions: 0, note: "" },
  });
  assert.match(readable(h.el("#inccollapse").innerHTML), /NOT provenance-checked/,
    'a truthy non-true `checked` must not be read as "checked"');
});

test("provenance.checked === true states what the check withdrew", async () => {
  const h = await renderWith({});
  const html = h.el("#inccollapse").innerHTML;
  const text = readable(html);
  assert.match(text, /were provenance-checked against our own collector outage history/);
  assert.match(text, /40 window\(s\) covering 226 transition\(s\) lost the co-firing claim/,
    "what the check withdrew is the finding, and it is stated as a number");
  assert.match(text, /Checked against 132 collector resume\(s\)/);
  assert.match(text, /130 correlated-outage/, "the resume sources are broken out");
  assert.match(text, /first 450s after each/);
  assert.ok(!/NOT provenance-checked/.test(text),
    "a checked page must not carry the unchecked banner");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The queue totals carry the withdrawn figures
// ─────────────────────────────────────────────────────────────────────────────

test("the totals subtitle carries noticedTogetherEvents beside the co-firing totals", async () => {
  const h = await renderWith({});
  const text = readable(h.el("#inccollapse").innerHTML);
  assert.match(text, /91 of those occurrences carried 3 or more devices firing together/,
    "the co-firing total is still the headline");
  assert.match(text, /A further 40 occurrence\(s\) covering 226 transition\(s\)/,
    "40 of 131 claims were withdrawn and the queue must say so");
  assert.match(text, /NOT in the 91 co-firing figure above/,
    "the reader must be told the two figures do not overlap");
  assert.match(text, /still in the 1222 transitions read/,
    "the alerts are real: the withdrawn transitions never left the corpus");
});

test("absent noticed-together totals render unknown, never zero", async () => {
  const h = await renderWith({
    totals: { ...(payload([montreal()]).totals as Row), noticedTogetherEvents: undefined,
      noticedTogetherTransitions: undefined },
  });
  const html = h.el("#inccollapse").innerHTML;
  const text = readable(html);
  assert.match(text, /carried no noticed-together totals/);
  assert.match(text, /not the same as none being withdrawn/);
  assert.match(html, /class="unres"/);
  assert.ok(!/A further 0 occurrence/.test(text), "a missing total must never print as 0");
});

test("a genuine zero says nothing was withdrawn, in words", async () => {
  const h = await renderWith({
    totals: { ...(payload([montreal()]).totals as Row), noticedTogetherEvents: 0,
      noticedTogetherTransitions: 0 },
  });
  const text = readable(h.el("#inccollapse").innerHTML);
  assert.match(text, /No co-firing claim on this page was withdrawn on collector provenance/,
    "a known zero is a finding and is stated as one, distinct from an unknown");
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The correlate opt-in: "not requested" ≠ "none matched" ≠ "it failed"
// ─────────────────────────────────────────────────────────────────────────────

test("correlate=true is sent only when the toggle is on, and nothing else changes", async () => {
  const off = await harness();
  assert.equal(off.api.incQuery(), "page=1&limit=50",
    "off is the default and must put NO parameter on the wire");
  const on = await harness({
    incF: { page: 2, state: "all", severity: "all", rule: null, deviceId: null,
      sinceDays: null, correlate: true },
  });
  assert.equal(on.api.incQuery(), "page=2&limit=50&correlate=true",
    "on sends the endpoint's own affirmative spelling and keeps the page");
});

test("every parameter incQuery can send is one /api/incidents declares", async () => {
  // The endpoint's ListQuery keys. An accepted-and-ignored filter is
  // indistinguishable from one that matched everything, so it 400s the rest.
  const declared = new Set([
    "page", "limit", "state", "severity", "rule", "deviceId", "sinceDays", "correlate",
  ]);
  const states: Row[] = [
    { page: 1, state: "open", severity: "critical", rule: "offline-4h", deviceId: "1000137",
      sinceDays: 7, correlate: true },
    { page: 3, state: "all", severity: "all", rule: null, deviceId: null, sinceDays: null,
      correlate: false },
  ];
  for (const incF of states) {
    const h = await harness({ incF });
    const keys = h.api.incQuery().split("&").map((p) => p.split("=")[0] ?? "");
    assert.ok(keys.length > 0, "incQuery produced no parameters at all");
    assert.ok(keys.every((k) => k !== ""), "a parameter with no name means the split went wrong");
    for (const k of keys) {
      assert.ok(declared.has(k), `/api/incidents does not declare "${k}" and would 400 it`);
    }
  }
});

test("the toggle is kept OUT of the URL, like the collector card's state", async () => {
  const src = await consoleHtml();
  const decls = /const URL_DEFAULTS = \{[\s\S]*?\n\};/.exec(src);
  assert.ok(decls, "console.html must still declare URL_DEFAULTS — this check lifts it by name");
  assert.ok(decls[0].includes("incstate"),
    "the lifted URL_DEFAULTS must actually contain the incident keys, or this check is vacuous");
  assert.ok(!/correlate/i.test(decls[0]),
    "correlate is a COST, not a filter: a shareable link that silently re-paid the full " +
    "per-device assembly on every load is a link nobody can see the price of");
  // And the popstate patch must not clear it either.
  const patch = /S\.incF = Object\.assign\(S\.incF \|\| \{\}, \{[\s\S]*?\}\);/.exec(src);
  assert.ok(patch, "console.html must still patch S.incF from the URL — this check lifts it");
  assert.ok(patch[0].includes("severity"),
    "the lifted patch must actually be the incident-filter one, not an empty match");
  assert.ok(!/correlate/.test(patch[0]),
    "a Back press must not silently turn the cross-link off (or on)");
});

test("'not requested' and 'none matched' are different sentences", async () => {
  const notAsked = await renderWith({});
  const notAskedText = readable(notAsked.el("#incnote").innerHTML);
  assert.match(notAskedText, /Not requested/,
    "off must say it was not asked for");
  assert.match(notAskedText, /a cost we did not pay, not a finding that nothing is correlated/,
    "the whole point: an unasked question is not an answer");

  const askedEmpty = await harness({
    inc: payload([montreal()], {
      correlation: { available: true, reason: null, findings: 0 },
    }),
    incPage: pageMeta(),
    incF: { page: 1, state: "all", severity: "all", rule: null, deviceId: null,
      sinceDays: null, correlate: true },
  });
  askedEmpty.api.renderIncidents();
  const emptyText = readable(askedEmpty.el("#incnote").innerHTML);
  assert.match(emptyText, /it returned no findings at all/,
    "asked-and-empty is a statement about the fleet");
  assert.match(emptyText, /not a cost we skipped/);
  assert.ok(!/Not requested/.test(emptyText),
    '"none matched" must not be able to read as "not requested"');
  assert.notEqual(emptyText, notAskedText,
    "the two states must not render the same text — that is the bug being pinned");
});

test("requested-and-failed is a third sentence, not folded into 'not requested'", async () => {
  const h = await harness({
    inc: payload([montreal()], {
      correlation: {
        available: false,
        reason: "Correlation could not be computed (connection terminated unexpectedly).",
        findings: 0,
      },
    }),
    incPage: pageMeta(),
    incF: { page: 1, state: "all", severity: "all", rule: null, deviceId: null,
      sinceDays: null, correlate: true },
  });
  h.api.renderIncidents();
  const text = readable(h.el("#incnote").innerHTML);
  assert.match(text, /requested, and it could not be computed/);
  assert.match(text, /connection terminated unexpectedly/, "the failure's own reason is printed");
  assert.match(text, /means the cross-link FAILED, not that nothing overlaps/,
    "an empty findings list must never be readable as 'nothing is correlated'");
  assert.ok(!/Not requested/.test(text));
});

test("on the ROW, an empty findings list says which of the three states it is", async () => {
  const notAsked = await harness({ incOpen: montreal().id });
  const a = readable(notAsked.api.incidentRow(montreal()));
  assert.match(a, /live correlation was not cross-linked onto this row/);
  assert.match(a, /not a finding that nothing overlaps this roster/);

  const asked = await harness({
    incOpen: montreal().id,
    inc: payload([montreal()], { correlation: { available: true, reason: null, findings: 8 } }),
    incF: { page: 1, state: "all", severity: "all", rule: null, deviceId: null,
      sinceDays: null, correlate: true },
  });
  const b = readable(asked.api.incidentRow(montreal()));
  assert.match(b, /No live correlation finding overlaps this roster/);
  assert.match(b, /"nothing matched", not "nothing asked"/);
  assert.notEqual(a, b, "the row must not describe the two states identically");

  const stamped = await harness({
    incOpen: montreal().id,
    inc: payload([montreal()], { correlation: { available: true, reason: null, findings: 8 } }),
    incF: { page: 1, state: "all", severity: "all", rule: null, deviceId: null,
      sinceDays: null, correlate: true },
  });
  const c = readable(stamped.api.incidentRow(montreal({
    correlationFindings: [{ id: "f1", kind: "firmware-cohort", severity: "high",
      summary: "Firmware 6.3.26 is failing at 100% vs a 54% fleet baseline." }],
  })));
  assert.match(c, /Live correlation findings touching this roster/);
  assert.match(c, /Firmware 6\.3\.26 is failing at 100%/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. The house invariants this file has broken before
// ─────────────────────────────────────────────────────────────────────────────

test("the badge count is the RENDERED rows, and server totals live in the subtitle", async () => {
  const h = await renderWith({});
  assert.equal(h.el("#inccount").textContent, "1",
    "one incident was rendered, so the badge says 1 — never the server's 267");
  assert.match(h.el("#incsub").textContent, /of 267 matching/,
    "the server total appears only in the labelled subtitle");
});

test("the axis still introduces the scope label and is still badged as not-site", async () => {
  const h = await harness();
  const text = readable(h.api.incidentRow(montreal()));
  assert.match(text, /leaf group Montreal Office leaf group, not site/,
    "adding the provenance rendering must not have cost the axis honesty");
  assert.ok(!/\bsite Montreal Office\b/.test(text),
    'a leaf group must never be printed as "site Montreal Office"');
});
