/**
 * The three surfaces that shipped as backends with nothing rendering them, and
 * the invariants each of them can only lose silently.
 *
 *   1. `GET /api/incidents` -- the incident queue (Epic 8.8).
 *   2. `summary.byCause` on `GET /api/remediation` (US-8.6.3).
 *   3. `GET /api/audit/counts` -- the outcome pills' numbers.
 *
 * Same technique as console-invariants.test.ts and console-audit.test.ts, and
 * for the same reason: all three are logic living in an 8,000-line HTML file
 * that no type checker can see. What is pinned here is exactly the set of
 * mistakes the epic's own CORRECTIONS section says were made once already:
 *
 *   - a leaf-group label presented as a site,
 *   - "14 occurrences" printed where the truth is 21 of which 14 co-fired,
 *   - `indeterminate` rendered as a fault when it is 177 of 267 incidents,
 *   - an outcome absent from `byOutcome` rendered as 0 when it was never
 *     counted at all,
 *   - a null rendered as a zero, anywhere,
 *   - and a count beside a filtered list taken from something wider than the
 *     list. That one has shipped broken in this file three times.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEVICE_ACTION_OUTCOMES } from "../db/repository.js";

// ─── lifting the console's own declarations ──────────────────────────────────

const consoleScript = async (): Promise<string> => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = await readFile(join(here, "..", "..", "public", "console.html"), "utf8");
  const open = src.lastIndexOf("<script>");
  const close = src.lastIndexOf("</script>");
  assert.ok(open > 0 && close > open, "console.html must contain a trailing <script> block");
  return src.slice(open + "<script>".length, close);
};

/**
 * Delimited by PARSEABILITY rather than by brace counting, because the
 * renderers here are mostly template literals and a literal `}` inside one is
 * not a closing brace. The window is 400 lines: renderIncidents() is the
 * longest declaration this file lifts.
 */
const declarationOf = (script: string, name: string): string => {
  const lines = script.split("\n");
  const start = new RegExp(`^(?:async\\s+)?(?:function|const|let)\\s+${name}\\b`);
  const i = lines.findIndex((l) => start.test(l));
  assert.notEqual(
    i, -1,
    `console.html no longer declares a top-level "${name}". This test lifts it by ` +
    `name; if it moved or was renamed, follow it — do not delete the check.`,
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
  title = "";
  className = "";
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
const INCIDENT_DECLS = [
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

type IncidentApi = {
  INC_WINDOWS_SHOWN: number;
  INC_DRILL_ID_CAP: number;
  incQuery: () => string;
  incAxis: (scope: unknown) => { noun: string; label: string; badge: string; axis: string };
  incRecurrence: (o: unknown, axis: string) => string;
  incFlap: (f: unknown) => string;
  incidentRow: (i: unknown) => string;
  renderIncidents: () => void;
  loadIncidentTransitions: (id: string) => Promise<void>;
};

type Harness<A> = {
  api: A;
  S: Record<string, any>;
  el: (id: string) => El;
  asked: string[];
};

/**
 * Build a scope with the console's own declarations in it.
 *
 * `api`/`apiAll` are recorded rather than stubbed blindly: what this console
 * ASKS for is half of what is being tested — /api/alerts 400s an unknown
 * parameter and /api/audit/counts 400s a page control, so a request built wrong
 * takes the surface with it.
 */
const scope = async <A>(
  decls: readonly string[],
  ret: string,
  state: Record<string, unknown>,
  responses: Record<string, unknown> = {},
): Promise<Harness<A>> => {
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
  const S: Record<string, unknown> = { ...state };
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
    decls.map((n) => declarationOf(script, n)).join("\n") +
    `\nreturn ${ret};`;
  const built = new Function("ctx", body)({
    document: { querySelector: (sel: string): El => el(sel), createElement: (): El => new El() },
    S,
    api: (path: string) => respond(path),
    apiAll: (path: string) => respond(path),
    openDevice: (): void => {},
    switchTab: (): void => {},
    renderActions: (): void => {},
  }) as A;
  return { api: built, S, el, asked };
};

const incidentState = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  inc: null, incPage: null, incErr: null, incLoading: false, incAt: Date.now(),
  incF: { page: 1, state: "all", severity: "all", rule: null, deviceId: null, sinceDays: null },
  incOpen: null, incDrill: {},
  ...over,
});

const incidentHarness = (
  state: Record<string, unknown> = {},
  responses: Record<string, unknown> = {},
): Promise<Harness<IncidentApi>> =>
  scope<IncidentApi>(
    INCIDENT_DECLS,
    `{ INC_WINDOWS_SHOWN, INC_DRILL_ID_CAP, incQuery, incAxis, incRecurrence, incFlap,` +
      ` incidentRow, renderIncidents, loadIncidentTransitions }`,
    incidentState(state),
    responses,
  );

// ─── fixtures, shaped like /api/incidents actually answers ───────────────────

type Row = Record<string, any>;

/**
 * The worked example, with the numbers the epic's correction 3 publishes: five
 * screens in leaf group "Jay" (device names `Leedy_Home_Spark*`), 72
 * transitions, 21 half-hour windows of which 14 carry three or more devices.
 */
const leedy = (over: Row = {}): Row => ({
  id: "incident::group:jay::screen-off-during-schedule",
  scope: {
    axis: "group", id: "grp-jay", label: "Jay", siteResolved: false,
    reason: 'Grouped by the device\'s LEAF group ("Jay"), not by site: No Videri credentials ' +
      "are configured, so the group hierarchy could not be read and no device could be placed " +
      "at a site. Leaf groups are finer than sites.",
  },
  ruleId: "screen-off-during-schedule",
  title: "Screen powered off",
  severity: "medium",
  severityCounts: { critical: 0, high: 0, medium: 72, info: 0 },
  state: "resolved",
  transitionCount: 72, openTransitions: 0, resolvedTransitions: 72, acknowledgedTransitions: 0,
  firstSeenAt: "2026-08-27T21:35:00.000Z", lastSeenAt: "2026-09-04T12:43:31.142Z",
  deviceCount: 5,
  roster: [{
    deviceId: "1027424", deviceName: "Leedy_Home_Spark5_Landscape",
    transitionCount: 20, openTransitions: 0,
    firstSeenAt: "2026-08-27T21:35:00.000Z", lastSeenAt: "2026-09-04T12:35:52.540Z",
  }],
  occurrences: {
    total: 21, coFiring: 14, isolated: 7,
    transitionsCoFiring: 64, transitionsIsolated: 8,
    windowMinutes: 30, minCoFiringDevices: 3,
    basis: "An occurrence is one fixed 30-minute window in which this incident opened at least " +
      "once; 14 of 21 carried 3 or more devices firing together.",
    windows: [{
      windowStart: "2026-08-27T21:30:00.000Z", windowEnd: "2026-08-27T22:00:00.000Z",
      deviceCount: 5, deviceIds: ["1027424"], transitionIds: new Array(72).fill("t").map((t, n) => t + n),
      coFiring: true,
    }],
  },
  flap: {
    classification: "sustained", meanOpenMinutes: 248.3,
    resolvedTransitions: 72, openTransitions: 0, opensPerDay: 9.5,
    observedSpanHours: 183.1, distinctHoursOfDay: 11,
    reason: "Holds open a mean of 248.3 min (at or over 60) each time, over 9.5×/day.",
  },
  drilldown: { ruleId: "screen-off-during-schedule", deviceIds: ["1027424"] },
  correlationFindings: [],
  ...over,
});

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
    coFiringEvents: 131, coFiringTransitions: 634,
    coFiringSharePercent: 51.9, coFiringShareOfAttributedPercent: 54.7,
  },
  reconciliation: {
    transitionsIn: 1222, transitionsInIncidents: 1222,
    transitionsInOccurrenceWindows: 1222, distinctTransitionIds: 1222,
    balanced: true,
    note: "Every transition handed in lands in exactly one incident.",
  },
  corpus: {
    transitionsRead: 1222, transitionsInWindow: 1235, transitionsExcludedRetired: 13,
    retirementNote: "13 transition(s) in this window belong to retired devices and are excluded.",
    windowDays: null,
    windowNote: "All history held. Occurrence counts are over the whole retained corpus.",
    incidentsSelected: 267, incidentsInWindow: 267,
  },
  filters: { state: "all", severity: null, rule: null, deviceId: null, sinceDays: null, note: "" },
  correlation: { available: false, reason: "Not requested.", findings: 0 },
  ...over,
});

const pageMeta = (over: Record<string, number> = {}): Record<string, number> =>
  ({ page: 1, limit: 50, totalItems: 267, totalPages: 6, ...over });

// ─────────────────────────────────────────────────────────────────────────────
// 1. The axis is never misrepresented
// ─────────────────────────────────────────────────────────────────────────────

test("a scope that is NOT a resolved site carries the axis badge", async () => {
  const h = await incidentHarness();
  for (const [axis, text] of [["group", "leaf group, not site"], ["device", "no group, not site"]]) {
    const out = h.api.incAxis({ axis, id: "x", label: "Jay", siteResolved: false, reason: "because" });
    assert.match(out.badge, new RegExp(text as string),
      `axis "${axis}" with siteResolved:false must raise a badge saying so`);
    assert.match(out.badge, /data-axisbadge=/);
  }
});

test("a resolved site carries NO badge, because there is nothing to correct", async () => {
  const h = await incidentHarness();
  const out = h.api.incAxis({
    axis: "site", id: "s1", label: "Montreal Office", siteResolved: true, reason: null,
  });
  assert.equal(out.badge, "", "a real site must not be badged as a fallback");
  assert.equal(out.noun, "site");
});

test("the row names the axis beside the label and never heads it 'site'", async () => {
  const h = await incidentHarness();
  const html = h.api.incidentRow(leedy());
  assert.match(html, /leaf group <b>Jay<\/b>/,
    "the label must be introduced by the axis it was actually grouped on");
  assert.match(html, /leaf group, not site/);
  // The word "site" may appear in the payload's own reason, but never as this
  // label's own noun: "site Jay" is the sentence that must not exist.
  assert.ok(!/\bsite <b>Jay<\/b>/.test(html), 'a leaf group must never be printed as "site Jay"');
});

test("a scope with no label says so instead of rendering an empty cell", async () => {
  const h = await incidentHarness();
  const out = h.api.incAxis({ axis: "group", id: "g", label: null, siteResolved: false, reason: "r" });
  assert.match(out.label, /class="unres"/, "a nameless group is a fact with a reason, not a blank");
  assert.match(out.label, /no name/i);
});

test("the expansion prints the payload's own scope reason, verbatim", async () => {
  const h = await incidentHarness({ incOpen: leedy().id });
  const html = h.api.incidentRow(leedy());
  // esc() escapes the apostrophe and the quotes, so the sentence is matched in
  // the form it actually reaches the DOM in.
  assert.match(html, /Grouped by the device&#39;s LEAF group \(&quot;Jay&quot;\), not by site/);
  assert.match(html, /Leaf groups are finer than sites/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Both occurrence numbers, because printing one hides the other
// ─────────────────────────────────────────────────────────────────────────────

test("the headline states the total AND the co-firing count", async () => {
  const h = await incidentHarness();
  const html = h.api.incRecurrence(leedy().occurrences, "group");
  // 21 windows, 14 of them co-firing. Correction 3: printing only the 14 hides
  // seven real recurrences.
  assert.match(html, /<b>21<\/b> times/);
  assert.match(html, /<b>14<\/b> of them/);
  const numbers = [...html.matchAll(/<b>(\d+)<\/b>/g)].map((m) => m[1]);
  assert.deepEqual(numbers, ["21", "14"], "both occurrence figures, in that order, and no others");
});

test("the row itself carries both figures, not just the co-firing subset", async () => {
  const h = await incidentHarness();
  const html = h.api.incidentRow(leedy());
  assert.match(html, /recurred <b>21<\/b> times, <b>14<\/b> of them/);
});

test("'together' is named on the axis that was actually grouped", async () => {
  const h = await incidentHarness();
  // Only a real site axis may say site-wide. On a leaf group, "site-wide" would
  // be the same mislabel as printing the group's name in a site column.
  assert.match(h.api.incRecurrence(leedy().occurrences, "site"), /site-wide/);
  assert.match(h.api.incRecurrence(leedy().occurrences, "group"), /group-wide/);
  assert.ok(!/site-wide/.test(h.api.incRecurrence(leedy().occurrences, "group")));
  assert.match(h.api.incRecurrence(leedy().occurrences, "device"), /multi-device/);
});

test("a co-firing count of zero is still printed, because it was counted", async () => {
  const h = await incidentHarness();
  const html = h.api.incRecurrence({ total: 3, coFiring: 0, isolated: 3 }, "group");
  assert.match(html, /<b>3<\/b> times/);
  assert.match(html, /<b>0<\/b> of them/);
});

test("occurrence counts the payload did not carry are a reason, never a 1 or a 0", async () => {
  const h = await incidentHarness();
  const html = h.api.incRecurrence({}, "group");
  assert.match(html, /class="unres"/);
  assert.match(html, /not the same as once, and not the same\s+as never/);
  assert.ok(!/<b>0<\/b>/.test(html));
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. `indeterminate` is a refusal, not a fault
// ─────────────────────────────────────────────────────────────────────────────

const indeterminate = (over: Row = {}): Row => ({
  classification: "indeterminate", meanOpenMinutes: null,
  resolvedTransitions: 0, openTransitions: 3, opensPerDay: null,
  observedSpanHours: null, distinctHoursOfDay: 1,
  reason: "All 3 transitions are still open, so there is no closed duration to average. " +
    "Mean time-open is null, not zero.",
  ...over,
});

test("indeterminate reads 'too few occurrences to classify' and is styled neutral", async () => {
  const h = await incidentHarness();
  const html = h.api.incFlap(indeterminate());
  assert.match(html, /too few occurrences to classify/);
  // `und` is the muted neutral chip. `bad` is the red one, and this is 177 of
  // 267 incidents on today's corpus — styling it as a failure mislabels two
  // thirds of the queue as broken.
  assert.match(html, /class="tag und"/);
  assert.ok(!/class="tag bad"/.test(html), "a refusal to classify must not wear the fault colour");
  assert.ok(!/class="tag warn"/.test(html));
  // The word itself never reaches the screen as a verdict.
  assert.ok(!/>indeterminate</.test(html));
});

test("a classification that IS a verdict keeps its own colour", async () => {
  const h = await incidentHarness();
  assert.match(h.api.incFlap({ ...indeterminate(), classification: "sustained", meanOpenMinutes: 248.3, resolvedTransitions: 72, opensPerDay: 9.5 }), /class="tag bad"/);
  assert.match(h.api.incFlap({ ...indeterminate(), classification: "oscillating", meanOpenMinutes: 18.2, resolvedTransitions: 81, opensPerDay: 10.3 }), /class="tag warn"/);
});

test("the flap's own stated basis travels with the chip", async () => {
  const h = await incidentHarness();
  assert.match(h.api.incFlap(indeterminate()), /still open, so there is no closed duration/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Honest nulls
// ─────────────────────────────────────────────────────────────────────────────

test("a mean time-open with nothing resolved is a null WITH the reason, never 0", async () => {
  const h = await incidentHarness();
  const html = h.api.incFlap(indeterminate());
  assert.match(html, /no mean time-open/);
  assert.match(html, /nothing has resolved yet, so there is no closed duration to average/);
  assert.ok(!/<b>0<\/b> min/.test(html), "0 minutes open is a condition that cleared instantly");
  // A dash may INTRODUCE the reason; it may never BE the value. "no mean
  // time-open —" with nothing after it is the bare dash this file forbids.
  assert.ok(!/time-open\s*(—|&#8212;)\s*(<|$)/.test(html),
    "a dash must never stand in for the value it is supposed to explain");
});

test("a rate with too short a span is a null WITH the span, never 0/day", async () => {
  const h = await incidentHarness();
  const html = h.api.incFlap(indeterminate({ observedSpanHours: 0.2 }));
  assert.match(html, /no daily rate/);
  assert.match(html, /0\.2h/);
  assert.ok(!/opens <b>0<\/b>/.test(html));
});

test("an unread queue renders '?' and the reason, never zero incidents", async () => {
  const h = await incidentHarness({ inc: null, incErr: "GET /api/incidents returned 500" });
  h.api.renderIncidents();
  assert.equal(h.el("inccount").textContent, "?");
  assert.notEqual(h.el("inccount").textContent, "0");
  assert.match(h.el("inccount").title, /not zero/i);
  assert.match(h.el("inccollapse").innerHTML, /could not be read/i);
  assert.match(h.el("inccollapse").innerHTML, /500/, "the failure's own words must reach the screen");
  assert.match(h.el("inccollapse").innerHTML, /not.*the same as saying there are none/is);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Count the thing you filter
// ─────────────────────────────────────────────────────────────────────────────

test("the badge counts the rows in its own list, not the server's match", async () => {
  const rows = [leedy(), leedy({ id: "b" }), leedy({ id: "c" })];
  const h = await incidentHarness({ inc: payload(rows), incPage: pageMeta({ totalItems: 267 }) });
  h.api.renderIncidents();
  assert.equal(h.el("inccount").textContent, "3");
  assert.equal((h.el("inclist").innerHTML.match(/data-inc="/g) || []).length, 3,
    "the list must hold exactly the rows the badge counted");
  // ...and the sentence beside it carries the server's own total, so the "3" is
  // never read as "three conditions exist on this estate".
  assert.match(h.el("incsub").textContent, /of 267 matching/);
  assert.match(h.el("incsub").textContent, /page 1 of 6/);
});

test("a page of a larger queue says out loud that it is not the whole queue", async () => {
  const h = await incidentHarness({ inc: payload([leedy()]), incPage: pageMeta() });
  h.api.renderIncidents();
  assert.match(h.el("incpager").innerHTML, /not the whole queue/i);
  assert.match(h.el("incpager").innerHTML, /Showing <b>1<\/b> of <b>267<\/b>/);
});

test("a queue that fits on one page is not described as truncated", async () => {
  const h = await incidentHarness({
    inc: payload([leedy()]), incPage: pageMeta({ totalItems: 1, totalPages: 1 }),
  });
  h.api.renderIncidents();
  assert.match(h.el("incpager").innerHTML, /This page is the whole queue/);
});

test("a response with no page meta refuses to claim the list is complete", async () => {
  const h = await incidentHarness({ inc: payload([leedy()]), incPage: null });
  h.api.renderIncidents();
  assert.match(h.el("incpager").innerHTML, /cannot.*say.*whether more incidents exist/is);
});

test("the filters named beside the list are the filters that were sent", async () => {
  const h = await incidentHarness({
    inc: payload([leedy()]), incPage: pageMeta({ totalItems: 1, totalPages: 1 }),
    incF: { page: 1, state: "open", severity: "critical", rule: "black-screen", deviceId: "1009858", sinceDays: 7 },
  });
  h.api.renderIncidents();
  const sub = h.el("incsub").textContent;
  for (const fragment of ["state open", "worst severity critical", "rule black-screen",
    "roster contains 1009858", "opened in the last 7 day(s)"]) {
    assert.ok(sub.includes(fragment), `#incsub must name "${fragment}"; it read: ${sub}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The reconciliation gate
// ─────────────────────────────────────────────────────────────────────────────

test("an unbalanced collapse withholds the incidents and points at the transitions", async () => {
  const h = await incidentHarness({
    inc: payload([leedy()], {
      reconciliation: {
        transitionsIn: 1222, transitionsInIncidents: 1221,
        transitionsInOccurrenceWindows: 1222, distinctTransitionIds: 1222,
        balanced: false, note: "If these disagree, trust the transitions, not the incidents.",
      },
    }),
    incPage: pageMeta(),
  });
  h.api.renderIncidents();
  assert.match(h.el("incgate").innerHTML, /lost a transition/i);
  assert.match(h.el("incgate").innerHTML, /1221/, "the numbers that disagree must be on screen");
  assert.match(h.el("incgate").innerHTML, /trust the transitions, not the incidents/);
  // NOT ONE INCIDENT ROW. An incident view that has lost a transition is worse
  // than the noisy queue it replaced.
  assert.ok(!h.el("inclist").innerHTML.includes("data-inc="),
    "no incident row may render once the invariant has failed");
  assert.match(h.el("inclist").innerHTML, /withheld/i);
  assert.match(h.el("inclist").innerHTML, /id="incgatealerts"/, "the way to the transitions must exist");
  // And no count is offered, because none of them is trustworthy.
  assert.equal(h.el("inccount").textContent, "?");
  assert.equal(h.el("inccollapse").innerHTML, "", "no collapse figure may be shown over a broken partition");
});

test("a missing reconciliation block is the same refusal as a failed one", async () => {
  const h = await incidentHarness({
    inc: payload([leedy()], { reconciliation: undefined }), incPage: pageMeta(),
  });
  h.api.renderIncidents();
  assert.match(h.el("incgate").innerHTML, /no reconciliation block/i);
  assert.ok(!h.el("inclist").innerHTML.includes("data-inc="));
});

test("a balanced collapse publishes the proof rather than asserting it", async () => {
  const h = await incidentHarness({ inc: payload([leedy()]), incPage: pageMeta() });
  h.api.renderIncidents();
  assert.equal(h.el("incgate").innerHTML, "");
  assert.match(h.el("incnote").innerHTML, /1222 transition\(s\) in,\s+1222 in an incident/);
  assert.match(h.el("incnote").innerHTML, /all four\s*equal/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. The corpus figures that explain 1,222 rather than 1,235
// ─────────────────────────────────────────────────────────────────────────────

test("the excluded retired transitions and the window note are on screen", async () => {
  const h = await incidentHarness({ inc: payload([leedy()]), incPage: pageMeta() });
  h.api.renderIncidents();
  const html = h.el("inccollapse").innerHTML;
  assert.match(html, /<b>1222<\/b> of\s*<b>1235<\/b> transition\(s\)/);
  assert.match(html, /belong to retired devices and are excluded/);
  assert.match(html, /All history held/);
  assert.match(html, /78\.2%/, "the collapse itself is the headline figure");
  assert.match(html, /leaf group \(devices\.group_id\) — NOT site/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Truncation must be visible
// ─────────────────────────────────────────────────────────────────────────────

test("a capped window list says how many it left out and that the cap is its own", async () => {
  const windows = new Array(81).fill(null).map((_, n) => ({
    windowStart: `2026-09-0${(n % 9) + 1}T01:00:00.000Z`,
    windowEnd: `2026-09-0${(n % 9) + 1}T01:30:00.000Z`,
    deviceCount: 1, deviceIds: ["1009858"], transitionIds: ["t" + n], coFiring: false,
  }));
  const oscillator = leedy({
    id: "osc", transitionCount: 81,
    occurrences: { ...leedy().occurrences, total: 81, coFiring: 0, isolated: 81, windows },
  });
  const h = await incidentHarness({ incOpen: "osc" });
  const html = h.api.incidentRow(oscillator);
  assert.match(html, /<b>61<\/b> further window\(s\)/);
  assert.match(html, new RegExp(`stops at ${h.api.INC_WINDOWS_SHOWN}`));
  assert.match(html, /cap on\s*the LIST and not the end of the partition/);
  assert.match(html, /All 81 are in the payload/);
});

test("the windows are asserted to partition the incident, and a mismatch says so", async () => {
  const h = await incidentHarness({ incOpen: leedy().id });
  const good = h.api.incidentRow(leedy());
  assert.match(good, /which is\s*exactly this incident's 72 transition\(s\)/);
  const bad = h.api.incidentRow(leedy({ transitionCount: 73 }));
  assert.match(bad, /hold 72 transition ids but the incident claims\s*73/);
  assert.match(bad, /trust the transitions below/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. The queries this view sends
// ─────────────────────────────────────────────────────────────────────────────

test("incQuery sends only parameters /api/incidents declares, and omits 'all'", async () => {
  const h = await incidentHarness();
  const plain = h.api.incQuery();
  assert.match(plain, /(^|&)page=1(&|$)/);
  assert.match(plain, /(^|&)limit=50(&|$)/);
  assert.ok(!plain.includes("state="), '"all" is the absence of a filter, not a value to send');
  assert.ok(!plain.includes("severity="));
  assert.ok(!plain.includes("sinceDays="));

  Object.assign(h.S.incF, {
    state: "open", severity: "critical", rule: "black screen", deviceId: "1009858", sinceDays: 7,
  });
  const full = h.api.incQuery();
  assert.match(full, /state=open/);
  assert.match(full, /severity=critical/);
  assert.match(full, /rule=black%20screen/, "a rule id must be encoded, not concatenated raw");
  assert.match(full, /deviceId=1009858/);
  assert.match(full, /sinceDays=7/);
  // Every name must be one the route's schema declares; an unknown one is a 400.
  const here = dirname(fileURLToPath(import.meta.url));
  const route = await readFile(join(here, "..", "..", "src", "api", "routes", "incidents.ts"), "utf8");
  for (const pair of full.split("&")) {
    const name = pair.split("=")[0] as string;
    assert.ok(new RegExp(`\\b${name}\\s*:`).test(route),
      `the console sends "${name}" to /api/incidents, which that route's schema does not declare`);
  }
});

test("the drilldown asks with the payload's own filter, and with state=all", async () => {
  const h = await incidentHarness(
    { inc: payload([leedy()]), incPage: pageMeta() },
    { "/api/alerts?": { data: new Array(72).fill({ deviceId: "1027424", severity: "medium" }), loaded: 72, total: 72, truncated: false } },
  );
  await h.api.loadIncidentTransitions(leedy().id);
  assert.equal(h.asked.length, 1);
  const asked = h.asked[0] as string;
  assert.match(asked, /rule=screen-off-during-schedule/);
  assert.match(asked, /deviceIds=1027424/);
  // /api/alerts DEFAULTS to state=open and both rows this epic was designed
  // from are fully resolved: on the default this drilldown returns nothing and
  // reads as a lost partition.
  assert.match(asked, /state=all/);
  // Only names /api/alerts accepts — an unknown one is a 400 there.
  const here = dirname(fileURLToPath(import.meta.url));
  const route = await readFile(join(here, "..", "..", "src", "api", "routes", "alerts.ts"), "utf8");
  for (const pair of (asked.split("?")[1] as string).split("&")) {
    const name = pair.split("=")[0] as string;
    assert.ok(new RegExp(`\\b${name}\\s*:`).test(route),
      `the drilldown sends "${name}" to /api/alerts, which that route does not declare`);
  }
});

test("an over-cap roster is REFUSED, never silently trimmed", async () => {
  const ids = new Array(600).fill(null).map((_, n) => "d" + n);
  const big = leedy({ id: "big", drilldown: { ruleId: "offline-4h", deviceIds: ids } });
  const h = await incidentHarness({ inc: payload([big]), incPage: pageMeta() });
  await h.api.loadIncidentTransitions("big");
  assert.equal(h.asked.length, 0, "nothing may be sent once the list is over the endpoint's cap");
  assert.match(String(h.S.incDrill["big"].error), /Refused\s*rather than trimmed/);
  assert.match(String(h.S.incDrill["big"].error), new RegExp(String(h.api.INC_DRILL_ID_CAP)));
});

test("a failed drilldown is a failure to ask, not a finding about the incident", async () => {
  const h = await incidentHarness(
    { inc: payload([leedy()]), incPage: pageMeta(), incOpen: leedy().id,
      incDrill: { [leedy().id]: { error: "timeout" } } },
  );
  const html = h.api.incidentRow(leedy());
  assert.match(html, /could not be read/);
  assert.match(html, /timeout/);
  assert.match(html, /failure to ask, not a finding/);
});

test("a drilldown that disagrees with the incident reports the discrepancy", async () => {
  const id = leedy().id;
  const h = await incidentHarness({
    inc: payload([leedy()]), incPage: pageMeta(), incOpen: id,
    incDrill: { [id]: { rows: new Array(70).fill({ deviceId: "x", severity: "medium" }), loaded: 70, total: 70, truncated: false } },
  });
  const html = h.api.incidentRow(leedy());
  assert.match(html, /70 transition\(s\) came back and this incident claims\s*72/);
  assert.match(html, /discrepancy worth reporting rather than a filter working/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. `summary.byCause` — the reason, never a zero
// ─────────────────────────────────────────────────────────────────────────────

const BY_CAUSE_DECLS = [
  "esc", "ago", "BY_CAUSE_ID_CAP", "byCauseTone", "loadRemediationDiff",
  "rebaselineRemediation", "byCauseCard",
] as const;

type ByCauseApi = {
  BY_CAUSE_ID_CAP: number;
  byCauseCard: (bc: unknown) => string;
  loadRemediationDiff: () => Promise<void>;
  rebaselineRemediation: () => void;
};

const byCauseHarness = (
  state: Record<string, unknown> = {},
  responses: Record<string, unknown> = {},
): Promise<Harness<ByCauseApi>> =>
  scope<ByCauseApi>(
    BY_CAUSE_DECLS,
    `{ BY_CAUSE_ID_CAP, byCauseCard, loadRemediationDiff, rebaselineRemediation }`,
    {
      remediation: { recommendations: [{ id: "a::display-off", kind: "auto-safe" }] },
      remMark: { at: new Date(Date.now() - 600_000).toISOString(), ids: ["a::display-off"] },
      remCauseErr: null, remCauseAt: 0,
      ...state,
    },
    responses,
  );

const unavailable = (problem: string, reason: string): Record<string, unknown> => ({
  available: false, value: null, problem, reason,
  howToGet: "Add your own previous read to the query string: `?since=<...>&previous=<...>`.",
  baseline: null,
});

test("every byCause refusal prints the endpoint's own reason and no tally", async () => {
  const h = await byCauseHarness();
  const problems: [string, string][] = [
    ["no-baseline", "Unknown, because this request carried no baseline to diff against."],
    ["unusable-baseline", "The baseline on the query string could not be used."],
    ["window-unreadable", "We could not read our own collection coverage for the window."],
    ["unobserved-window", "No device reported at all between the two reads (0 of 2 buckets)."],
  ];
  for (const [problem, reason] of problems) {
    const html = h.api.byCauseCard(unavailable(problem, reason));
    assert.match(html, new RegExp(problem), `the problem must be named: ${problem}`);
    assert.ok(html.includes(reason), `the endpoint's own reason must be printed for ${problem}`);
    // NO ZEROS. Not one, anywhere in the card.
    assert.ok(!/<b>0<\/b>/.test(html), `${problem} rendered a zero where the value is null`);
    // And the recipe is literal, because it is a recipe.
    assert.match(html, /previous=/, `${problem} must carry the howToGet recipe`);
  }
});

test("'we were not watching' is not painted as an error, and 'we failed to read' is", async () => {
  const h = await byCauseHarness();
  // On this deployment the collector is stopped, so a short window legitimately
  // lands on unobserved-window. That is the honest answer, not a fault state.
  const quiet = h.api.byCauseCard(unavailable("unobserved-window", "No device reported at all."));
  assert.match(quiet, /class="note na"/, "a window we did not observe is neutral, not an alarm");
  assert.match(quiet, /Not attributable/);
  const baseline = h.api.byCauseCard(unavailable("no-baseline", "No baseline was sent."));
  assert.match(baseline, /class="note na"/);
  // This one IS ours, and says so.
  const ours = h.api.byCauseCard(unavailable("window-unreadable", "We could not read our own coverage."));
  assert.match(ours, /this one is on us/i);
  assert.ok(!/class="note na"/.test(ours));
});

test("an available tally prints its counted zeros, which are the opposite of a null", async () => {
  const h = await byCauseHarness();
  const html = h.api.byCauseCard({
    available: true, problem: null,
    value: { applied: 2, "schedule-window-closed": 1, undetermined: 0 },
    baseline: { observedAt: new Date(Date.now() - 600_000).toISOString(), attestedBy: "caller", count: 5 },
    kind: "auto-safe",
    movement: { from: 5, to: 2, net: -3 },
    figure: {
      value: {}, basis: "Counted over the 3 departures between the two reads.",
      coverage: { measured: 3, inScope: 3, unit: "items", share: 1, note: "Computed from all 3 items in scope." },
    },
    window: { clearsGates: true, blind: false, reason: null },
    headline: "The auto-safe set went from 5 to 2.",
    itemisedBy: "POST the same baseline to /api/trends/churn.",
  });
  assert.match(html, /<b>2<\/b> applied/);
  assert.match(html, /<b>0<\/b> undetermined/);
  assert.match(html, /Counted, and none of the departures had this cause/,
    "a counted zero must say it was counted, so it cannot be read as the null above");
  assert.match(html, /<b>5<\/b> &#8594; <b>2<\/b> \(net -3\)/);
  assert.match(html, /Counted over the 3 departures/);
  assert.match(html, /attested by caller/);
});

test("a baseline over the id cap is refused rather than truncated", async () => {
  const ids = new Array(200).fill(null).map((_, n) => "r" + n);
  const h = await byCauseHarness({ remMark: { at: new Date().toISOString(), ids } });
  await h.api.loadRemediationDiff();
  assert.equal(h.asked.length, 0, "an over-cap baseline must never be sent, nor sliced to fit");
  assert.match(String(h.S.remCauseErr), /refuses outright rather than trimming/);
  assert.match(String(h.S.remCauseErr), /Nothing was sent/);
  assert.match(String(h.S.remCauseErr), /\/api\/trends\/churn/);
  const html = h.api.byCauseCard(unavailable("no-baseline", "none"));
  assert.match(html, new RegExp(`past the ${h.api.BY_CAUSE_ID_CAP}-id ceiling`));
});

test("the diff sends the held instant and the held ids, and nothing else", async () => {
  const at = new Date(Date.now() - 600_000).toISOString();
  const h = await byCauseHarness(
    { remMark: { at, ids: ["a::display-off", "b::display-off"] } },
    { "/api/remediation?": { data: { recommendations: [], summary: { byCause: unavailable("unobserved-window", "quiet") } } } },
  );
  await h.api.loadRemediationDiff();
  const asked = h.asked[0] as string;
  assert.match(asked, new RegExp("since=" + encodeURIComponent(at)));
  assert.match(asked, /previous=a%3A%3Adisplay-off%2Cb%3A%3Adisplay-off/);
  assert.equal(asked.split("&").length, 2, "only since and previous belong on this request");
  // The whole response replaces the state, so the breakdown and the list beside
  // it provably came from one response.
  assert.equal((h.S.remediation as Record<string, unknown>).summary !== undefined, true);
});

test("a failed diff leaves the recommendation list alone", async () => {
  const before = { recommendations: [{ id: "a::display-off", kind: "auto-safe" }] };
  const h = await byCauseHarness(
    { remediation: before },
    { "/api/remediation?": new Error("500") },
  );
  await h.api.loadRemediationDiff();
  assert.equal(h.S.remediation, before, "the queue is never withheld over a baseline problem");
  assert.match(String(h.S.remCauseErr), /500/);
});

test("re-baselining records the auto-safe ids and the instant, and nothing manual", async () => {
  const h = await byCauseHarness({
    remediation: {
      recommendations: [
        { id: "a::display-off", kind: "auto-safe" },
        { id: "b::firmware", kind: "manual" },
      ],
    },
    remMark: null,
  });
  h.api.rebaselineRemediation();
  const mark = h.S.remMark as { at: string; ids: string[] };
  assert.deepEqual(mark.ids, ["a::display-off"],
    "sending manual items would put them in the `from` end of the movement and overstate it");
  assert.ok(Math.abs(Date.parse(mark.at) - Date.now()) < 5_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. The audit outcome pills' numbers
// ─────────────────────────────────────────────────────────────────────────────

const AUDIT_DECLS = [
  "esc", "ago",
  "AUD_LIMIT", "AUD_OUTCOMES", "AUD_ATTENTION", "AUD_ACTIONS",
  "auditQuery", "auditCountsQuery", "auditOutcome", "auditWhyNoValue", "auditFromValue",
  "auditTable", "renderAuditFilters", "renderAudit",
] as const;

type AuditApi = {
  AUD_ATTENTION: string[];
  auditQuery: (over?: Record<string, unknown>) => string;
  auditCountsQuery: () => string;
  renderAuditFilters: () => void;
  renderAudit: () => void;
};

const auditHarness = (state: Record<string, unknown> = {}): Promise<Harness<AuditApi>> =>
  scope<AuditApi>(
    AUDIT_DECLS,
    `{ AUD_ATTENTION, auditQuery, auditCountsQuery, renderAuditFilters, renderAudit }`,
    {
      audit: { actions: [], emptyReason: "nothing yet", retention: { retainDays: 730, enforced: false } },
      audPage: { page: 1, limit: 50, totalItems: 0, totalPages: 1 },
      audErr: null, audLoading: false, audAt: Date.now(),
      audCounts: null, audCountsErr: null,
      aud: { page: 1, outcome: "all", action: "all", actor: null, deviceId: null },
      ...state,
    },
  );

const counts = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  matched: 12, logSize: 1043,
  byOutcome: {
    verified: 5, applied: 2, no_change: 1, rolled_back: 2, rollback_failed: 0, refused: 1, failed: 1,
  },
  byAction: [{ action: "brightness_write", count: 12 }],
  oldestActionAt: "2026-09-01T00:00:00.000Z", newestActionAt: "2026-09-16T00:00:00.000Z",
  emptyReason: null,
  filters: { deviceId: null, actor: null, outcome: null, action: null, since: null, until: null },
  outcomeScope: { counted: [...DEVICE_ACTION_OUTCOMES], excludedByFilter: [], note: "all counted" },
  actionScope: { note: "`action` is an open vocabulary." },
  countedAt: "2026-09-16T12:00:00.000Z",
  retention: { retainDays: 730, enforced: false, note: "nothing has aged out" },
  ...over,
});

test("the counts query is the list query minus the page controls it 400s", async () => {
  const h = await auditHarness();
  const q = h.api.auditCountsQuery();
  assert.ok(!q.includes("page="), "`page` is a 400 on /api/audit/counts, not an ignored parameter");
  assert.ok(!q.includes("limit="));
  assert.equal(q, "", "an unfiltered read asks for no parameters at all");

  (h.S.aud as Record<string, unknown>).outcome = "attention";
  (h.S.aud as Record<string, unknown>).deviceId = "canvas-1";
  const filtered = h.api.auditCountsQuery();
  assert.ok(!filtered.includes("page="));
  assert.ok(!filtered.includes("limit="));
  // Everything ELSE must survive verbatim, or the counts describe a different
  // set from the rows they are printed beside.
  for (const part of h.api.auditQuery().split("&")) {
    if (/^(page|limit)=/.test(part)) continue;
    assert.ok(filtered.includes(part), `the counts query dropped "${part}"`);
  }
});

test("an outcome ABSENT from byOutcome renders no number, and never a zero", async () => {
  // The caller filtered to `failed`, so the endpoint counted only that one and
  // the other six are absent. A 0 for them would claim we counted them.
  const h = await auditHarness({
    aud: { page: 1, outcome: "failed", action: "all", actor: null, deviceId: null },
    audCounts: counts({
      matched: 1, byOutcome: { failed: 1 },
      filters: { deviceId: null, actor: null, outcome: ["failed"], action: null, since: null, until: null },
      outcomeScope: {
        counted: ["failed"],
        excludedByFilter: ["verified", "applied", "no_change", "rolled_back", "rollback_failed", "refused"],
        note: "Your `outcome=` filter narrowed this breakdown.",
      },
    }),
  });
  h.api.renderAuditFilters();
  const html = h.el("audfp").innerHTML;
  assert.match(html, /<b>1<\/b> failed/, "the outcome that WAS counted carries its count");
  for (const absent of ["verified", "applied", "no_change", "rolled_back", "rollback_failed", "refused"]) {
    const pill = new RegExp(`data-audout="${absent}"[\\s\\S]*?</button>`).exec(html);
    assert.ok(pill, `the ${absent} pill must still exist`);
    assert.ok(!/<b>0<\/b>/.test(pill[0]),
      `"${absent}" was excluded by the caller's filter and must not be rendered as 0`);
    assert.match(pill[0], /not counted/);
    assert.match(pill[0], /That is not zero/);
  }
  // "All outcomes" and "Needs attention" have no countable answer under an
  // outcome filter either, and say so rather than summing what survived.
  const all = /data-audout="all"[\s\S]*?<\/button>/.exec(html) as RegExpExecArray;
  assert.match(all[0], /not counted/);
  assert.match(all[0], /whole-log total was not counted/);
  const att = /data-audout="attention"[\s\S]*?<\/button>/.exec(html) as RegExpExecArray;
  assert.match(att[0], /summing what is left would under-report/);
});

test("a zero the endpoint DID count is printed as a zero", async () => {
  const h = await auditHarness({ audCounts: counts() });
  h.api.renderAuditFilters();
  const html = h.el("audfp").innerHTML;
  // rollback_failed is in scope and genuinely holds none: that is a count.
  assert.match(html, /<b>0<\/b> rollback_failed/);
  assert.match(html, /<b>5<\/b> verified/);
  assert.match(html, /<b>12<\/b> All outcomes/);
  // failed 1 + rollback_failed 0 + rolled_back 2
  assert.match(html, /<b>3<\/b> Needs attention/);
});

test("counts that could not be read leave every pill numberless, not zeroed", async () => {
  const h = await auditHarness({ audCounts: null, audCountsErr: "GET /api/audit/counts returned 500" });
  h.api.renderAuditFilters();
  const html = h.el("audfp").innerHTML;
  assert.ok(!/<b>\d+<\/b>/.test(html), "a failed count must not put a number on any pill");
  assert.match(html, /not counted/);
  assert.match(html, /That is not zero/);
  assert.match(html, /returned 500/, "the failure's own words belong on the pill that lost them");
});

test("matched, the log size and WHICH empty it is are three separate facts", async () => {
  const h = await auditHarness({ audCounts: counts() });
  h.api.renderAudit();
  assert.match(h.el("audcnote").innerHTML, /<b>12<\/b> row\(s\) match these filters, of <b>1043<\/b>/);

  const never = await auditHarness({
    audCounts: counts({
      matched: 0, logSize: 0, byAction: [], oldestActionAt: null, newestActionAt: null,
      emptyReason: "No device action has been logged yet, under any filter.",
    }),
  });
  never.api.renderAudit();
  assert.match(never.el("audcnote").innerHTML, /No device action has been logged yet/);

  const filteredOut = await auditHarness({
    audCounts: counts({
      matched: 0, logSize: 1043, byAction: [],
      emptyReason: "No logged action matches these filters. The log itself holds 1043 action(s).",
    }),
  });
  filteredOut.api.renderAudit();
  assert.match(filteredOut.el("audcnote").innerHTML, /this is your filter matching none of them|holds 1043 action\(s\)/);
});

test("an action with no matching row is absent, and that absence is explained", async () => {
  const h = await auditHarness({ audCounts: counts({ byAction: [] }) });
  h.api.renderAudit();
  const html = h.el("audcnote").innerHTML;
  assert.match(html, /no list here rather than a list of zeros/);
  assert.ok(!/<b>0<\/b>/.test(html));
});

test("an empty queue says WHICH empty it is, and never reads as a quiet estate", async () => {
  // The filter matched none of the incidents that exist.
  const filtered = await incidentHarness({
    inc: payload([], { corpus: { ...(payload([]).corpus as Record<string, unknown>), incidentsSelected: 0 } }),
    incPage: pageMeta({ totalItems: 0, totalPages: 1 }),
  });
  filtered.api.renderIncidents();
  assert.match(filtered.el("inclist").innerHTML, /the filter matching\s+none of them rather than a quiet estate/);

  // The WINDOW holds no transition — a statement about the window, not the fleet.
  const narrow = await incidentHarness({
    inc: payload([], {
      corpus: {
        transitionsRead: 0, transitionsInWindow: 0, transitionsExcludedRetired: 0,
        retirementNote: "No transitions were excluded for device retirement.",
        windowDays: 1, windowNote: "Only transitions opened in the last 1 day(s) are counted.",
        incidentsSelected: 0, incidentsInWindow: 0,
      },
    }),
    incPage: pageMeta({ totalItems: 0, totalPages: 1 }),
  });
  narrow.api.renderIncidents();
  assert.match(narrow.el("inclist").innerHTML, /No alert transition OPENED inside this window/);
  assert.match(narrow.el("inclist").innerHTML, /statement about the window, not about the estate/);

  // Transitions but no incidents cannot happen from a correct collapse.
  const broken = await incidentHarness({
    inc: payload([], {
      corpus: { ...(payload([]).corpus as Record<string, unknown>), incidentsInWindow: 0 },
    }),
    incPage: pageMeta({ totalItems: 0, totalPages: 1 }),
  });
  broken.api.renderIncidents();
  assert.match(broken.el("inclist").innerHTML, /cannot happen from a correct\s+collapse/);
  // Nothing matched, so there is nothing to page: "page 1 of 1" under the
  // sentence that explains the emptiness is noise over it.
  assert.equal(broken.el("incpager").innerHTML, "");
});
