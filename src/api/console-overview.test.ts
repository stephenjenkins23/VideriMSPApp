/**
 * The Overview's named criticals, its density, and the incident filters in the
 * URL (EPIC 8.5 / US-8.5.3, plus the gap US-8.4.1 left behind).
 *
 * THE RECORDED FINDING (docs/25 GAP-9). The Overview was ~9 screens tall and
 * its CRITICAL rows were anonymous: four visually identical offline rows, all
 * dark to the same second, all at one site, rendered with no device name and no
 * place. On the corpus this file is written against those four are KH VQ Lower,
 * KH V4 Left, KH VQ Upper and KH V4 Right, all in the leaf group "Kelcie Home
 * Office". A critical an operator cannot act on is not a critical.
 *
 * So this file asserts three things that cannot be asserted by reading the
 * file: that a critical row NAMES its device and its place, that the place is
 * named on the AXIS it really came from (leaf group, with the badge, never the
 * word "site" over a group name), and that a row whose device we do not hold
 * says so rather than rendering a blank or a neighbour's data — BUG-1's lesson.
 *
 * The density half is structural by necessity: pixel height needs a browser
 * (measured there: 6,167px → 1,285px, the section's top moving from y=962 to
 * y=418 on a 900px viewport). What IS assertable here is that nothing was
 * deleted to get there — every folded widget still has its host element, its
 * summary still carries its status line, and the buttons that exist to reveal
 * a fold open it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ─── loading the console's own source ────────────────────────────────────────

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
  for (let k = 1; k <= 300 && i + k <= lines.length; k++) {
    const text = lines.slice(i, i + k).join("\n");
    try {
      new Function(text);
    } catch {
      continue;
    }
    return text;
  }
  throw new assert.AssertionError({
    message: `could not delimit the declaration of "${name}" within 300 lines`,
  });
};

// ─── the element stub ────────────────────────────────────────────────────────

class El {
  innerHTML = "";
  textContent = "";
  className = "";
  title = "";
  value = "";
  open = false;
  readonly children: El[] = [];
  readonly attrs: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  appendChild(c: El): El {
    this.children.push(c);
    return c;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  addEventListener(): void {}
  querySelectorAll(): El[] {
    return [];
  }
}

// ─── fixtures: the recorded finding, at its real shape ───────────────────────
//
// Four criticals on four devices in ONE leaf group, opened inside the same
// second, plus one critical in a different group and one on a device this page
// does not hold. That last one is the BUG-1 case: a row we cannot place.

type Alert = {
  id: string; deviceId: string; deviceName: string; severity: string;
  title: string; ruleId: string; evidence: string; openedAt: string;
  lastFiredAt: string; location?: string | null;
};

const SAME_SECOND = "2026-09-03T04:44:16.923Z";

const alert = (n: number, deviceId: string, deviceName: string, severity: string,
               openedAt = SAME_SECOND): Alert => ({
  id: `a-${n}`, deviceId, deviceName, severity,
  title: "Device offline for 4 hours", ruleId: "offline-4h",
  evidence: "Offline for 38 hours.", openedAt, lastFiredAt: openedAt, location: null,
});

const NO_CRED =
  "No Videri credentials are configured, so the group hierarchy could not be read " +
  "and no device could be placed at a site.";

const device = (id: string, name: string, groupName: string | null,
                location: string | null = null): Record<string, unknown> => ({
  id, name, location, city: "LONDON", groupName,
  site: { id: null, name: null, resolved: false, reason: NO_CRED },
  status: "offline",
});

const KELCIE = ["1001626", "1001624", "1001623", "1001622"];
const KELCIE_NAMES = ["KH VQ Lower", "KH V4 Left", "KH VQ Upper", "KH V4 Right"];

const ALERTS: Alert[] = [
  ...KELCIE.map((id, i) => alert(i + 1, id, KELCIE_NAMES[i] as string, "critical")),
  alert(5, "1004419", "Spark 5", "critical", "2026-09-03T02:27:12.643Z"),
  // A critical whose device is NOT in the loaded fleet list.
  alert(6, "9999999", "Ghost canvas", "critical", "2026-09-03T01:00:00.000Z"),
  alert(7, "1000001", "Someone's desk", "medium", "2026-09-01T01:00:00.000Z"),
];

const DEVICES = [
  ...KELCIE.map((id, i) => device(id, KELCIE_NAMES[i] as string, "Kelcie Home Office")),
  device("1004419", "Spark 5", "Hanging"),
  device("1000001", "Someone's desk", "Becca Home Office"),
];

// ─── the alerts sandbox ──────────────────────────────────────────────────────

type Scope = { noun: string; label: string | null; siteResolved: boolean; reason: string };
type Bands = {
  scoped: Alert[];
  scopeOf: (a: Alert) => Scope;
  scopeBadge: (s: Scope) => string;
};
type AlertsApi = { alertBands: () => Bands; renderAlertWidget: () => void };

const ALERT_DECLS = [
  "esc", "ago", "SEV", "thumbFor",
  "dormantIdSet", "NEVER_ABSORBED", "isDormantAlert", "alertBands", "renderAlertWidget",
] as const;

type Row = { id: string; text: string; head: string; where: string };

const alertHarness = async (state: Record<string, unknown>): Promise<{
  api: AlertsApi; el: (id: string) => El; rows: () => Row[];
}> => {
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
  const document = { querySelector: (sel: string): El => el(sel), createElement: (): El => new El() };
  const S: Record<string, unknown> = {
    alerts: [], devices: [], hyg: null, aband: "incidents", sev: "all", trunc: {}, ...state,
  };
  const body =
    `"use strict";\nconst { document, S, openDevice, switchTab } = ctx;\n` +
    `const $ = (s) => document.querySelector(s);\n` +
    ALERT_DECLS.map((n) => declarationOf(script, n)).join("\n") +
    `\nreturn { alertBands, renderAlertWidget };`;
  const api = new Function("ctx", body)({
    document, S, openDevice: (): void => {}, switchTab: (): void => {},
  }) as AlertsApi;
  /**
   * Each rendered critical row: the device id it opens, its whole markup, and —
   * separately — the text a human actually READS on it.
   *
   * `title` matters: a first version of this helper searched the whole markup,
   * and a mutation that removed the device name from the visible row still
   * passed, because the row's tooltip ("Open KH VQ Lower") still carried it. A
   * tooltip is not a named critical. So `head` is the row's title line and
   * `where` is its scope line, and the assertions below use those.
   */
  const rows = (): Row[] =>
    [...el("walerts").innerHTML.matchAll(/<button class="arow" data-id="([^"]*)"[\s\S]*?<\/button>/g)]
      .map((m) => {
        const text = m[0] as string;
        const head = /<span class="ti">([\s\S]*?)<\/span>/.exec(text);
        const where = /<span class="ds">([\s\S]*?)<\/span>\s*<span class="mt">/.exec(text);
        return {
          id: m[1] as string, text,
          head: (head ? head[1] : "") as string,
          where: (where ? where[1] : "") as string,
        };
      });
  return { api, el, rows };
};

// ─────────────────────────────────────────────────────────────────────────────
// 0. The harness is really running the console's code
// ─────────────────────────────────────────────────────────────────────────────

test("the overview harness lifts and runs the real alert widget", async () => {
  const script = await consoleScript();
  const src = declarationOf(script, "renderAlertWidget");
  assert.match(src, /^function renderAlertWidget\(\)/);
  assert.ok(src.includes("scopeOf"), "the lifted widget must be the version that names a place");
  const h = await alertHarness({ alerts: ALERTS, devices: DEVICES });
  h.api.renderAlertWidget();
  assert.ok(h.rows().length > 0, "the lifted widget must actually render rows");
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. A critical names its device, and its place
// ─────────────────────────────────────────────────────────────────────────────

test("every critical row names the device it is about", async () => {
  // THE recorded finding: four rows, identical text, no device name anywhere.
  const h = await alertHarness({ alerts: ALERTS, devices: DEVICES });
  h.api.renderAlertWidget();
  const rows = h.rows();
  assert.ok(rows.length >= 5, `expected the criticals to render, found ${rows.length}`);
  for (const name of KELCIE_NAMES) {
    // On the row's TITLE LINE, not merely somewhere in its markup: a device
    // name that only exists in a tooltip is still an anonymous critical.
    assert.ok(rows.some((r) => r.head.includes(name)),
      `no rendered critical row names "${name}" on its title line — ` +
      `this is the anonymous-critical regression`);
  }
  // Every row names a device, not just the ones we went looking for.
  for (const r of rows) {
    assert.notEqual(r.head.trim(), "", `the row for ${r.id} rendered no title line at all`);
    assert.match(r.head, /\S+ &#8212; /,
      `the row for ${r.id} does not lead with a device name: "${r.head.trim()}"`);
  }
  // And each row is one device, addressed BY ID (BUG-1: never a name lookup).
  for (const id of KELCIE) {
    assert.ok(rows.some((r) => r.id === id), `no row opens device id ${id}`);
  }
});

test("the four same-second criticals each name their leaf group, and it is the same group", async () => {
  const h = await alertHarness({ alerts: ALERTS, devices: DEVICES });
  h.api.renderAlertWidget();
  const four = h.rows().filter((r) => KELCIE.includes(r.id));
  assert.equal(four.length, 4, "the fixture's four same-second criticals must all render");
  for (const r of four) {
    assert.match(r.where, /leaf group <b>Kelcie Home Office<\/b>/,
      "the scope must be named, with its axis, on the row's own scope line");
    assert.match(r.where, /leaf group, not site/,
      "and an unresolved site axis must carry the badge, not a footnote");
    // And the device it is about is on the row too, beside the place.
    assert.ok(KELCIE_NAMES.some((n) => r.head.includes(n)),
      `a Kelcie row named its place but not its device: "${r.head.trim()}"`);
  }
});

test("the scope is never called a site when the payload says the site did not resolve", async () => {
  // Seven of ten "sites" on this tenant are internal kit and staff homes, and
  // with no credential the group tree cannot be read at all. A leaf-group name
  // under the word "site" is the misrepresentation this project exists to stop.
  const h = await alertHarness({ alerts: ALERTS, devices: DEVICES });
  const { scopeOf } = h.api.alertBands();
  for (const a of ALERTS) {
    const s = scopeOf(a);
    if (s.siteResolved === false && s.label) {
      assert.equal(s.noun, "leaf group",
        `an unresolved scope was named "${s.noun}" — only "leaf group" is true here`);
    }
    assert.ok(!(s.noun === "site" && s.siteResolved === false),
      "nothing may be called a site on the strength of an unresolved site axis");
  }
});

test("a resolved site IS called a site, and carries no badge", async () => {
  // The axis travels with the label in BOTH directions: the badge is the
  // payload's statement, not a decoration.
  const resolved = {
    id: "1002000", name: "Regus front", location: null, city: "LONDON",
    groupName: "Regus New Side",
    site: { id: "site-7", name: "Regus Stockholm", resolved: true, reason: "" },
    status: "offline",
  };
  const h = await alertHarness({
    alerts: [alert(1, "1002000", "Regus front", "critical")], devices: [resolved],
  });
  const { scopeOf, scopeBadge } = h.api.alertBands();
  const s = scopeOf(alert(1, "1002000", "Regus front", "critical"));
  assert.equal(s.noun, "site");
  assert.equal(s.label, "Regus Stockholm");
  assert.equal(scopeBadge(s), "", "a resolved site must not carry the not-a-site badge");
});

test("a critical on a device this page does not hold says so, and invents no place", async () => {
  // BUG-1's lesson: never show one device's data under another's name, and
  // never fill a blank with a plausible neighbour.
  //
  // Two alerts rather than the whole fixture: the widget lists the first five
  // criticals, and the unlocatable one is the sixth in ALERTS — a row that is
  // not drawn cannot be inspected, and a test that silently inspected nothing
  // would be the harness failure this suite is written to avoid.
  const h = await alertHarness({
    alerts: [ALERTS[0] as Alert, ALERTS[5] as Alert], devices: DEVICES,
  });
  h.api.renderAlertWidget();
  const { scopeOf } = h.api.alertBands();
  const ghost = scopeOf(ALERTS[5] as Alert);
  assert.equal(ghost.label, null, "an unlocatable device must have NO label");
  assert.equal(ghost.noun, "unknown");
  assert.match(ghost.reason, /not in the fleet list this page loaded/);
  // And that reason is what renders — not an empty cell, and not a guess.
  const row = h.rows().find((r) => r.id === "9999999");
  assert.ok(row, "the unlocatable critical must still render");
  assert.match(row.where, /not in the fleet list this page loaded/);
  assert.match(row.head, /Ghost canvas/,
    "a row we cannot place must still name the device it is about");
  assert.ok(!/Kelcie|Hanging|Becca/.test(row.text),
    "no other device's place may appear on a row we could not place");
});

test("a device with neither location nor group is named unplaced, not blank", async () => {
  const bare = device("1003000", "Bare canvas", null);
  const h = await alertHarness({
    alerts: [alert(1, "1003000", "Bare canvas", "critical")], devices: [bare],
  });
  const { scopeOf } = h.api.alertBands();
  const s = scopeOf(alert(1, "1003000", "Bare canvas", "critical"));
  assert.equal(s.label, null);
  assert.equal(s.noun, "unplaced");
  assert.match(s.reason, /no location and no group/);
});

test("the canvas's own location wins over the group, and the group over nothing", async () => {
  // `location` is the finest true statement about where a screen is. NOT
  // `city`, which reads LONDON on 199 of 200 devices including the Swedish
  // ones — a fact the scope helper must never be tempted by.
  const placed = device("1004000", "Kungsgatan 4", "Some Group", "Kungsgatan 4, Stockholm");
  const h = await alertHarness({
    alerts: [alert(1, "1004000", "Kungsgatan 4", "critical")], devices: [placed],
  });
  const { scopeOf } = h.api.alertBands();
  const s = scopeOf(alert(1, "1004000", "Kungsgatan 4", "critical"));
  assert.equal(s.noun, "location");
  assert.equal(s.label, "Kungsgatan 4, Stockholm");
  assert.ok(!/LONDON/i.test(JSON.stringify(s)), "the account city must never become a place");
});

test("the badge wording is textually identical to the incident queue's", async () => {
  // Two surfaces saying "this was not grouped by site" in two different ways
  // reads as two different facts. The string is duplicated because the
  // console-invariant harness lifts the alert renderers without incAxis(), so
  // it is pinned here instead — the same move the offline-unasked sentence got.
  const script = await consoleScript();
  const axis = declarationOf(script, "incAxis");
  const bands = declarationOf(script, "alertBands");
  const m = /"(leaf group, not site)"/.exec(axis);
  assert.ok(m, "incAxis() must still carry the leaf-group badge wording");
  assert.ok(bands.includes(`>${m[1]}<`) || bands.includes(`"${m[1]}"`),
    `alertBands()'s badge has drifted from incAxis()'s "${m[1]}"`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The numbers beside the named rows count the named rows
// ─────────────────────────────────────────────────────────────────────────────

test("the critical heading states how many are shown out of how many are open", async () => {
  const h = await alertHarness({ alerts: ALERTS, devices: DEVICES });
  h.api.renderAlertWidget();
  const html = h.el("walerts").innerHTML;
  // Six criticals in the fixture, five shown.
  assert.match(html, /5 of 6 shown/,
    "the heading must state the slice and the total it came from");
  assert.equal(h.rows().length, 5, "and it must be telling the truth about the slice");
});

test("the place count counts the places on screen, not the places in the fleet", async () => {
  // The count-the-thing-you-filter rule applied to a sentence rather than a
  // chip: "2 places" over five rows must be the two places those five rows name.
  const h = await alertHarness({ alerts: ALERTS, devices: DEVICES });
  h.api.renderAlertWidget();
  const html = h.el("walerts").innerHTML;
  // Rows shown: 4 × Kelcie Home Office, 1 × Hanging → two places, one nameless
  // row is NOT shown (it is the sixth critical, past the cap).
  assert.match(html, /2 places named below/);
  const named = new Set(
    [...html.matchAll(/leaf group <b>([^<]+)<\/b>/g)].map((m) => m[1]),
  );
  assert.equal(named.size, 2, `the rows name ${named.size} place(s) under a claim of 2`);
});

test("rows with nowhere recorded are counted separately, never folded into a place", async () => {
  const h = await alertHarness({
    alerts: [
      alert(1, KELCIE[0] as string, KELCIE_NAMES[0] as string, "critical"),
      alert(2, "9999999", "Ghost canvas", "critical"),
    ],
    devices: DEVICES,
  });
  h.api.renderAlertWidget();
  const html = h.el("walerts").innerHTML;
  assert.match(html, /1 place named below/);
  assert.match(html, /1 with nowhere recorded/,
    "a row we could not place must be counted as such, not quietly dropped from the tally");
});

test("with no critical open the section says so and still names what it shows", async () => {
  // A heading that read "Critical — requires action" over a medium alert would
  // be a fabricated severity.
  const h = await alertHarness({
    alerts: [alert(7, "1000001", "Someone's desk", "medium")], devices: DEVICES,
  });
  h.api.renderAlertWidget();
  const html = h.el("walerts").innerHTML;
  assert.ok(!/Critical &#8212; requires action/.test(html));
  assert.match(html, /no critical is open/);
  // esc() writes the apostrophe as an entity, so this is the rendered form.
  assert.match(html, /Someone&#39;s desk/, "the rows shown instead must still be named");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Density: folded, not deleted
// ─────────────────────────────────────────────────────────────────────────────

test("the first three Overview widgets are the shift-opening decisions", async () => {
  // Measured in a browser before this change: the section began at y=962 on a
  // 900px viewport, so NOTHING of the estate's status was on the first screen.
  const src = await consoleSource();
  const section = /<section id="v-overview">([\s\S]*?)<\/section>/.exec(src);
  assert.ok(section, "the Overview section must still exist");
  // By POSITION in the markup, not by a regex over every id — the alert
  // widget's header carries #wacount, which would otherwise read as a widget.
  const order = ["whealth", "wstatus", "walerts", "wfirmware", "wshots", "wpipefold", "wgapsfold"];
  const at = order.map((id) => {
    const i = (section[1] as string).indexOf(`id="${id}"`);
    assert.notEqual(i, -1, `the Overview lost #${id}`);
    return i;
  });
  assert.deepEqual([...at].sort((a, b) => a - b), at,
    `the Overview widgets are out of order — expected ${order.join(" → ")}`);
  // And the three decisions come before everything that folds.
  assert.ok((at[2] as number) < (at[5] as number),
    "the named criticals must come before our own collector's self-diagnosis");
});

test("the folded widgets keep every host element the renderers write into", async () => {
  // Folding must not be a way of losing a widget: each renderer still targets
  // its own host, and the host must still be in the markup.
  const src = await consoleSource();
  for (const id of ["wpipesub", "wpipepills", "wpipeline", "wgaps", "wrollups",
                    "wfirmware", "wfwsub", "wshots", "wshotsub"]) {
    assert.ok(src.includes(`id="${id}"`), `the Overview lost the host element #${id}`);
  }
  for (const fold of ["wpipefold", "wgapsfold"]) {
    assert.ok(new RegExp(`<details class="w[^"]*" id="${fold}">`).test(src),
      `#${fold} must be a <details> — that is what makes it reachable rather than gone`);
  }
});

test("a closed fold still reads as a status line", async () => {
  // The condition on which folding is honest. The pipeline fold's summary
  // carries #wpipesub, which renderPipelineWidget() fills with "N of M lanes
  // delivering · worst: …" — so closed, it still answers the question.
  const src = await consoleSource();
  const fold = /<details class="w[^"]*" id="wpipefold">([\s\S]*?)<\/summary>/.exec(src);
  assert.ok(fold, "the pipeline fold must have a <summary>");
  assert.ok((fold[1] as string).includes(`id="wpipesub"`),
    "the pipeline fold's summary must carry the lane status line");
});

test("the buttons that exist to reveal a fold open it", async () => {
  // Scrolling to a closed <summary> lands the reader on a header and reads as
  // the content having gone away.
  const script = await consoleScript();
  const gaps = /\$\("#gapsbtn"\)\.addEventListener\([\s\S]*?\n\}\);/.exec(script);
  assert.ok(gaps, "the 'What we cannot see' button must still be wired");
  assert.match(gaps[0] as string, /#wgapsfold[\s\S]*?\.open = true/,
    "it must open the fold before scrolling to it");
  const banner = declarationOf(script, "renderPipelineBanner");
  assert.match(banner, /#wpipefold[\s\S]*?\.open = true/,
    "the banner's 'see all lanes' link must open the pipeline fold");
});

test("the pipeline banner still names every lane that is not delivering", async () => {
  // The banner was 643px of eleven near-identical impact paragraphs, which is
  // what pushed the estate status off the first screen. The paragraphs folded;
  // the LANE NAMES did not, because those are the actionable half.
  const script = await consoleScript();
  const banner = declarationOf(script, "renderPipelineBanner");
  assert.match(banner, /Not delivering:/, "the lane names must still be inline");
  assert.match(banner, /sp\.faults\.map\(\(f\) => `<b>\$\{esc\(f\.lane\)\}<\/b>`\)/,
    "…and they must come from the faults themselves, not a summary string");
  assert.match(banner, /<details class="fold">/, "the per-lane prose must be folded, not dropped");
  assert.match(banner, /esc\(f\.dataImpact\)/,
    "and every word of it must still be there inside the fold");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The incident filters travel in a link
// ─────────────────────────────────────────────────────────────────────────────

type Patch = Record<string, unknown> & {
  incState: string; incSev: string; incWin: number | null;
};
type UrlApi = {
  urlParamsFor: (s: Record<string, unknown>) => Record<string, string>;
  urlQueryFor: (s: Record<string, unknown>) => string;
  urlReadParams: (q: string) => { patch: Patch; problems: string[] };
  urlApplyPatch: (p: Patch) => void;
  URL_DEFAULTS: Record<string, string>;
};

/** The same declaration list console-url-state.test.ts uses. Kept identical on
 *  purpose: if a new top-level constant were needed here, that pinned harness
 *  would be the thing that broke. */
const URL_DECLS = [
  "esc", "TR_WINDOWS", "SEV", "DTABS", "LANE_DOT", "SORTS", "PAGES",
  "URL_DEFAULTS", "URL_DRILL_CAP",
  "URL_ALERT_AGES", "URL_ALERT_SORTS", "URL_ALERT_BANDS", "URL_TREND_DIRS",
  "urlParamsFor", "urlQueryFor", "urlReadParams", "urlApplyPatch",
] as const;

const idleState = (): Record<string, unknown> => ({
  view: "overview", q: "", cls: "all", dsite: "all", sort: { key: "status", dir: 1 },
  dids: null, aband: "incidents", sev: "all", aq: "", arule: "all", aage: "all",
  asort: "sev", devOpen: null, dtab: "overview", awork: null, trpin: false, trwin: 1,
  trdir: "all", plane: "all",
  cq: "", ccheck: "all", cband: "all", csort: "score", cpage: 1,
  aud: { page: 1, outcome: "all", action: "all", actor: null, deviceId: null },
  incF: { page: 1, state: "all", severity: "all", rule: null, deviceId: null, sinceDays: null },
});

const urlHarness = async (state?: Record<string, unknown>): Promise<UrlApi & {
  S: Record<string, unknown>;
}> => {
  const script = await consoleScript();
  const els = new Map<string, El>();
  const box = (id: string): El => {
    let e = els.get(id);
    if (!e) {
      e = new El();
      els.set(id, e);
    }
    return e;
  };
  const S = { ...idleState(), ...(state || {}) };
  const body =
    `"use strict";\nconst { document, S } = ctx;\n` +
    `const $ = (s) => document.querySelector(s);\n` +
    URL_DECLS.map((n) => declarationOf(script, n)).join("\n") +
    `\nreturn { urlParamsFor, urlQueryFor, urlReadParams, urlApplyPatch, URL_DEFAULTS };`;
  const api = new Function("ctx", body)({
    document: { querySelector: (sel: string): El => box(sel) }, S,
  }) as UrlApi;
  return { ...api, S };
};

test("the three incident filters survive a link round trip", async () => {
  const h = await urlHarness({
    view: "incidents",
    incF: { page: 3, state: "open", severity: "critical", rule: "offline-4h",
            deviceId: "1001626", sinceDays: 30 },
  });
  const link = h.urlQueryFor(h.S);
  assert.match(link, /incstate=open/);
  assert.match(link, /incsev=critical/);
  assert.match(link, /incwin=30/);
  const { patch, problems } = h.urlReadParams(link);
  assert.deepEqual(problems, [], `a link this console wrote must parse clean: ${link}`);
  assert.equal(patch.incState, "open");
  assert.equal(patch.incSev, "critical");
  assert.equal(patch.incWin, 30);
  // Applied, the state is back where it started.
  h.urlApplyPatch(patch);
  const back = h.S.incF as Record<string, unknown>;
  assert.equal(back.state, "open");
  assert.equal(back.severity, "critical");
  assert.equal(back.sinceDays, 30);
  assert.equal(h.urlQueryFor(h.S), link, "and writing it back must produce the same link");
});

test("a drilldown handed over by a row does not travel in the link", async () => {
  // `rule` and `deviceId` are somebody's click, not their view. A link that
  // carried one would reproduce a drilldown the reader never asked for, and the
  // incident queue's own filters would then disagree with its subtitle.
  const h = await urlHarness({
    incF: { page: 1, state: "all", severity: "all", rule: "offline-4h",
            deviceId: "1001626", sinceDays: null },
  });
  const params = h.urlParamsFor(h.S);
  assert.equal(params.rule, undefined, "the alert-rule parameter must not be reused for incidents");
  assert.ok(!Object.keys(params).some((k) => /^inc/.test(k) && k !== "incstate" && k !== "incsev" && k !== "incwin"),
    `only the three filters travel: ${Object.keys(params).join(", ")}`);
});

test("an incident filter at its default adds nothing to the link", async () => {
  const h = await urlHarness();
  assert.equal(h.urlQueryFor(h.S), "",
    "the idle view must still produce no query string at all");
  const { patch, problems } = h.urlReadParams("");
  assert.deepEqual(problems, []);
  assert.equal(patch.incState, "all");
  assert.equal(patch.incSev, "all");
  assert.equal(patch.incWin, null, "an unpinned window must be null, never a fabricated 0 days");
  h.urlApplyPatch(patch);
  assert.equal(h.urlQueryFor(h.S), "",
    "parsing an empty link and writing it back must still be an empty link");
});

test("both spellings of an idle incident filter produce the same link", async () => {
  // The audit filters' lesson: opening a tab initialises its filters, and if ""
  // and "all" wrote different links the URL would change under the reader.
  const a = await urlHarness({ incF: { state: "", severity: "", sinceDays: null } });
  const b = await urlHarness({ incF: { state: "all", severity: "all", sinceDays: null } });
  assert.equal(a.urlQueryFor(a.S), b.urlQueryFor(b.S));
  assert.equal(a.urlQueryFor(a.S), "");
});

test("an incident option this console does not have is reported, never coerced", async () => {
  const { patch, problems } = (await urlHarness())
    .urlReadParams("?v=incidents&incstate=triaged&incsev=urgent&incwin=90");
  assert.equal(patch.incState, "all", "an unknown state must fall back to no filter");
  assert.equal(patch.incSev, "all");
  assert.equal(patch.incWin, null);
  assert.equal(problems.length, 3, `each refusal must be SAID: ${problems.join(" / ")}`);
  assert.ok(problems.some((p) => p.includes("triaged")));
  assert.ok(problems.some((p) => p.includes("urgent")));
  assert.ok(problems.some((p) => p.includes("90")));
});

test("the incident parser's vocabularies are exactly the ones the tab offers", async () => {
  // Duplicated for the same reason URL_ALERT_AGES is: urlReadParams() is lifted
  // in isolation and cannot reference INC_STATES. So they are pinned instead.
  const script = await consoleScript();
  const parser = declarationOf(script, "urlReadParams");
  const listOf = (param: string): string[] => {
    const m = new RegExp(`pick\\("${param}", \\[([^\\]]*)\\]`).exec(parser);
    assert.ok(m, `urlReadParams() must still validate ${param} against an inline list`);
    return [...(m[1] as string).matchAll(/"([a-z0-9]+)"/g)].map((x) => x[1] as string);
  };
  const tableOf = (name: string): string[] => {
    const decl = declarationOf(script, name);
    return [...decl.matchAll(/\["([a-z0-9]*)",/g)].map((x) => x[1] as string);
  };
  assert.deepEqual(listOf("incstate").sort(), tableOf("INC_STATES").sort(),
    "the link's incident states have drifted from INC_STATES");
  assert.deepEqual(listOf("incsev").sort(), tableOf("INC_SEVS").sort(),
    "the link's incident severities have drifted from INC_SEVS");
  // INC_WINDOWS carries "" for "all history held", which is the ABSENCE of the
  // parameter rather than a value it can take.
  assert.deepEqual(listOf("incwin").sort(),
    tableOf("INC_WINDOWS").filter((k) => k !== "").sort(),
    "the link's incident windows have drifted from INC_WINDOWS");
});

test("every incident parameter the link uses is declared in the URL vocabulary", async () => {
  // URL_DEFAULTS is the whole parameter surface, and urlReadParams() reports
  // anything not in it as a parameter it does not know. A filter written into
  // the link but missing from URL_DEFAULTS would report itself as foreign.
  const h = await urlHarness({
    incF: { page: 1, state: "open", severity: "high", rule: null, deviceId: null, sinceDays: 7 },
  });
  const link = h.urlQueryFor(h.S);
  const { problems } = h.urlReadParams(link);
  assert.deepEqual(problems, [], `the console's own link reported itself as unknown: ${link}`);
  for (const k of ["incstate", "incsev", "incwin"]) {
    assert.ok(k in h.URL_DEFAULTS, `URL_DEFAULTS is missing "${k}"`);
  }
});

test("the URL vocabulary never collides with the endpoint's own parameter names", async () => {
  // Rule 2 of the URL block: /api/incidents 400s on an unknown parameter, so
  // the page's words and the API's words are kept deliberately different.
  const h = await urlHarness();
  /* The three this epic added, in the endpoint's spelling. Deliberately NOT a
     check over every /api/incidents parameter: `rule` has been a URL parameter
     since 8.4 as the ALERT queue's client-side rule filter, and that collision
     is a coincidence of vocabulary rather than a risk of one being sent as the
     other — a guard that fired on it would cry wolf and get deleted. What
     matters is that the incident filters are not spelled the way the endpoint
     spells them, so neither can be mistaken for the other. */
  for (const name of ["state", "severity", "sinceDays"]) {
    assert.ok(!(name in h.URL_DEFAULTS),
      `"${name}" is the incidents endpoint's own parameter name and must not be a URL parameter too`);
  }
  // …and the page's own names for them are there instead.
  for (const name of ["incstate", "incsev", "incwin"]) {
    assert.ok(name in h.URL_DEFAULTS, `URL_DEFAULTS is missing the page's name "${name}"`);
  }
});

test("the incident filter selects carry no per-option counts", async () => {
  // THE FACETS GATE. These three filters are server-side and there is no facets
  // payload, so a per-option count could only ever be derived from the page on
  // screen — a page count in a queue count's clothes. They must render with no
  // number at all, which is UNKNOWN, rather than with a 0 that is a claim.
  const script = await consoleScript();
  const render = declarationOf(script, "renderIncidents");
  const ctl = /const ctl = \$\("#incctl"\);[\s\S]*?ctl\.innerHTML =[\s\S]*?;/.exec(render);
  assert.ok(ctl, "renderIncidents() must still build #incctl");
  assert.ok(!/\(\$\{[^}]*\}\)/.test(ctl[0] as string),
    "an incident filter option must not interpolate a count into its label");
  // The <option> builder takes [key, label] pairs only — a third element would
  // be a count.
  const opts = /const opts = \(options, value\) =>[\s\S]*?\.join\(""\);/.exec(render);
  assert.ok(opts, "renderIncidents() must still have its option builder");
  assert.ok(!/\bn\b/.test((opts[0] as string).replace(/options|value/g, "")),
    "the incident option builder must not carry an n (count) at all");
});

test("the incident signature ignores the drilldowns, so Back cannot refetch over one", async () => {
  const script = await consoleScript();
  const sig = declarationOf(script, "incSignature");
  assert.match(sig, /f\.state/);
  assert.match(sig, /f\.severity/);
  assert.match(sig, /f\.sinceDays/);
  assert.ok(!/f\.rule|f\.deviceId/.test(sig),
    "rule and deviceId are drilldowns, not link state, and must stay out of the signature");
  // Run the lifted function against two states differing only in the drilldown.
  const call = (incF: Record<string, unknown>): string =>
    new Function("S", `${sig}\nreturn incSignature();`)({ incF }) as string;
  assert.equal(
    call({ state: "open", severity: "all", sinceDays: null, rule: "a" }),
    call({ state: "open", severity: "all", sinceDays: null, rule: "b" }),
  );
  assert.notEqual(
    call({ state: "open", severity: "all", sinceDays: null }),
    call({ state: "resolved", severity: "all", sinceDays: null }),
  );
  assert.notEqual(
    call({ state: "open", severity: "all", sinceDays: null }),
    call({ state: "open", severity: "all", sinceDays: 7 }),
  );
});

test("a filter change writes the link, and does it by replacing rather than pushing", async () => {
  // Thirty keystrokes must not cost thirty Back presses — the rule the device
  // and alert filters already follow.
  const script = await consoleScript();
  const load = declarationOf(script, "loadIncidents");
  assert.match(load, /urlSync\("replace"\)/,
    "changing an incident filter must write the address bar");
  assert.ok(!/urlSync\("push"\)/.test(load),
    "…and must not push a history entry for a select change");
});
