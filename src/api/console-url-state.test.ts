/**
 * URL state (US-8.4.1), asserted against the console's own source.
 *
 * Same technique and the same reason as console-invariants.test.ts: the link
 * vocabulary is logic living in a ~7,000-line HTML file that no type checker can
 * see, and it has three properties that only a test can hold.
 *
 *   1. A LINK ROUND-TRIPS. Whatever a technician was looking at must come back
 *      out of the address bar unchanged. The failure mode is not a crash, it is
 *      a colleague opening the link and seeing a *slightly* different view —
 *      which is worse than seeing nothing, because they will act on it.
 *
 *   2. THE URL VOCABULARY IS NOT THE API VOCABULARY. /api/alerts now rejects
 *      any query parameter it does not know with a 400, so a page parameter
 *      that leaked into a request would not degrade gracefully, it would break
 *      the console. The names are deliberately different and nothing forwards
 *      one to the other.
 *
 *   3. TRUNCATION IN A LINK IS STILL TRUNCATION. The device-id drilldown is the
 *      one piece of state that can outgrow a URL. A shortened drilldown must be
 *      distinguishable from a complete one — that is the apiAll bug, in a link.
 *
 * Two vocabularies are DUPLICATED in the console on purpose (the alert age
 * windows and the alert sort keys live inside alertBands(), because the
 * console-invariant tests lift that function in isolation). This file pins the
 * copies against the originals by source text, so they cannot drift.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ─── lifting the console's own declarations ──────────────────────────────────

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

/** Delimited by parseability, not by brace counting — see console-invariants. */
const declarationOf = (script: string, name: string): string => {
  const lines = script.split("\n");
  const start = new RegExp(`^(?:async\\s+)?(?:function|const|let)\\s+${name}\\b`);
  const i = lines.findIndex((l) => start.test(l));
  assert.notEqual(
    i, -1,
    `console.html no longer declares a top-level "${name}". This test lifts it by ` +
    `name; if it moved or was renamed, follow it — do not delete the check.`,
  );
  for (let k = 1; k <= 250 && i + k <= lines.length; k++) {
    const text = lines.slice(i, i + k).join("\n");
    try {
      new Function(text);
    } catch {
      continue;
    }
    return text;
  }
  throw new assert.AssertionError({
    message: `could not delimit the declaration of "${name}" within 250 lines`,
  });
};

/** The two-line element stub. The URL functions touch one thing in the DOM —
 *  the value of the two search boxes — so that is all this needs to be. */
class El {
  value = "";
  innerHTML = "";
  textContent = "";
}

/** Source order: these are `const`s and `function`s sharing one scope. */
const URL_DECLS = [
  "esc", "TR_WINDOWS", "SEV", "DTABS", "LANE_DOT", "SORTS", "PAGES",
  "URL_DEFAULTS", "URL_DRILL_CAP",
  "URL_ALERT_AGES", "URL_ALERT_SORTS", "URL_ALERT_BANDS", "URL_TREND_DIRS",
  "urlParamsFor", "urlQueryFor", "urlReadParams", "urlApplyPatch",
] as const;

type Patch = {
  view: string; q: string; cls: string; dsite: string;
  sort: { key: string; dir: number };
  dids: { ids: Set<string>; label: string; carried: number; total: number } | null;
  aband: string; sev: string; aq: string; arule: string; aage: string; asort: string;
  device: string; dtab: string; alert: string;
  trwin: number | null; trdir: string; plane: string;
  aud: Record<string, unknown> | null;
};

type UrlApi = {
  urlParamsFor: (s: Record<string, unknown>) => Record<string, string>;
  urlQueryFor: (s: Record<string, unknown>) => string;
  urlReadParams: (query: string) => { patch: Patch; problems: string[] };
  urlApplyPatch: (patch: Patch) => void;
  URL_DEFAULTS: Record<string, string>;
  URL_DRILL_CAP: number;
};

/** A state object shaped like the console's `S`, at its defaults. */
const idleState = (): Record<string, unknown> => ({
  view: "overview", q: "", cls: "all", dsite: "all", sort: { key: "status", dir: 1 },
  dids: null, aband: "incidents", sev: "all", aq: "", arule: "all", aage: "all",
  asort: "sev", devOpen: null, dtab: "overview", awork: null, trpin: false, trwin: 1,
  trdir: "all", plane: "all",
  aud: { page: 1, outcome: "all", action: "all", actor: null, deviceId: null },
});

const harness = async (state?: Record<string, unknown>): Promise<UrlApi & {
  S: Record<string, unknown>;
  box: (id: string) => El;
}> => {
  const script = await consoleScript();
  const els = new Map<string, El>();
  const box = (id: string): El => {
    const key = id.replace(/^#/, "");
    let e = els.get(key);
    if (!e) {
      e = new El();
      els.set(key, e);
    }
    return e;
  };
  const S = { ...idleState(), ...(state || {}) };
  const body =
    `"use strict";\nconst { document, S } = ctx;\n` +
    `const $ = (s) => document.querySelector(s);\n` +
    URL_DECLS.map((n) => declarationOf(script, n)).join("\n") +
    `\nreturn { urlParamsFor, urlQueryFor, urlReadParams, urlApplyPatch, ` +
    `URL_DEFAULTS, URL_DRILL_CAP };`;
  const api = new Function("ctx", body)({
    document: { querySelector: (sel: string): El => box(sel) },
    S,
  }) as UrlApi;
  return { ...api, S, box };
};

// ─────────────────────────────────────────────────────────────────────────────
// 0. The harness is really running the console's code
// ─────────────────────────────────────────────────────────────────────────────

test("the URL harness lifts the real console source", async () => {
  const script = await consoleScript();
  const src = declarationOf(script, "urlReadParams");
  assert.match(src, /^function urlReadParams\(query\)/,
    "urlReadParams must still be a top-level function taking a query string");
  assert.ok(src.includes("URLSearchParams"), "the lifted parser must be the URLSearchParams one");
  const h = await harness();
  assert.equal(h.urlQueryFor(h.S), "",
    "the default view must produce NO query string — a link carries only what was chosen");
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. The round trip. A pasted link reproduces the view.
// ─────────────────────────────────────────────────────────────────────────────

test("every filter, the selection and the open drawer survive a link round trip", async () => {
  const h = await harness({
    view: "devices", q: " kungs ", cls: "offline", dsite: "site-7",
    sort: { key: "seen", dir: -1 },
    aband: "suppressed", sev: "critical", aq: "logo", arule: "showing-logo",
    aage: "o30d", asort: "oldest",
    devOpen: "79101X02R01621500133J2000", dtab: "network",
    awork: { id: "alert-99" },
    trpin: true, trwin: 7, trdir: "regression", plane: "stalled",
    aud: { page: 3, outcome: "failed", action: "device_command", actor: "SJ", deviceId: "dev-1" },
  });
  const link = h.urlQueryFor(h.S);
  const { patch, problems } = h.urlReadParams(link);

  assert.deepEqual(problems, [], `a link this console wrote must parse clean: ${link}`);
  assert.equal(patch.view, "devices");
  // Trimmed on the way out, because a trailing space in a shared search box is
  // not a filter anybody chose.
  assert.equal(patch.q, "kungs");
  assert.equal(patch.cls, "offline");
  assert.equal(patch.dsite, "site-7");
  assert.deepEqual(patch.sort, { key: "seen", dir: -1 });
  assert.equal(patch.aband, "suppressed");
  assert.equal(patch.sev, "critical");
  assert.equal(patch.aq, "logo");
  assert.equal(patch.arule, "showing-logo");
  assert.equal(patch.aage, "o30d");
  assert.equal(patch.asort, "oldest");
  assert.equal(patch.device, "79101X02R01621500133J2000");
  assert.equal(patch.dtab, "network");
  assert.equal(patch.alert, "alert-99");
  assert.equal(patch.trwin, 7);
  assert.equal(patch.trdir, "regression");
  assert.equal(patch.plane, "stalled");
  assert.deepEqual(patch.aud, {
    outcome: "failed", action: "device_command", actor: "SJ", deviceId: "dev-1", page: 3,
  });
});

test("applying a parsed link puts the filters into state and into the search boxes", async () => {
  // The bug this guards: a restored search filter with an empty search box is a
  // narrowed table with no visible cause, which reads as a small fleet.
  const h = await harness();
  const { patch } = h.urlReadParams("?v=devices&q=kungs&status=offline&aq=logo&sort=seen&dir=desc");
  h.urlApplyPatch(patch);
  assert.equal(h.S.view, "devices");
  assert.equal(h.S.q, "kungs");
  assert.equal(h.S.cls, "offline");
  assert.deepEqual(h.S.sort, { key: "seen", dir: -1 });
  assert.equal(h.box("#q").value, "kungs", "the device search box must show the restored search");
  assert.equal(h.box("#aq").value, "logo", "the alert search box must show the restored search");
});

test("a round trip of the idle state is stable, and adds no parameter of its own", async () => {
  // Opening the Audit tab used to be able to rewrite the URL just by
  // initialising its filters, which made a link change under the reader.
  const h = await harness();
  assert.equal(h.urlQueryFor(h.S), "");
  const { patch, problems } = h.urlReadParams("");
  assert.deepEqual(problems, []);
  h.urlApplyPatch(patch);
  assert.equal(h.urlQueryFor(h.S), "",
    "parsing an empty link and writing it back must still be an empty link");
});

test("a trend window is carried only when the operator chose it", async () => {
  // trendsAutoWindow() escalates past a refusal; that is not a choice, and a
  // link that pinned it would force every reader into a window nobody picked.
  const auto = await harness({ trwin: 14, trpin: false });
  assert.equal(auto.urlQueryFor(auto.S), "", "an auto-escalated window must not travel in a link");
  const picked = await harness({ trwin: 14, trpin: true });
  assert.equal(picked.urlQueryFor(picked.S), "?trwin=14");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. A link that names something this console has no such option for
// ─────────────────────────────────────────────────────────────────────────────

test("an option this console does not have is reported and ignored, never coerced", async () => {
  const h = await harness();
  const { patch, problems } = h.urlReadParams("?v=dashboard&sev=urgent&age=fortnight&asort=size");
  assert.equal(patch.view, "overview", "an unknown view falls back to the default view");
  assert.equal(patch.sev, "all");
  assert.equal(patch.aage, "all");
  assert.equal(patch.asort, "sev");
  assert.equal(problems.length, 4, `each ignored option must be reported: ${problems.join(" | ")}`);
  for (const bad of ["dashboard", "urgent", "fortnight", "size"]) {
    assert.ok(problems.some((p) => p.includes(bad)),
      `the reader must be told "${bad}" was ignored, not left to wonder`);
  }
});

test("a parameter from a newer console is reported rather than dropped in silence", async () => {
  const h = await harness();
  const { problems } = h.urlReadParams("?v=devices&customer=acme&foo=1");
  assert.equal(problems.length, 1);
  assert.ok((problems[0] as string).includes("customer") && (problems[0] as string).includes("foo"),
    `both unknown names must be named: ${problems[0]}`);
});

test("a trend window this console does not offer is refused with its own sentence", async () => {
  const h = await harness();
  const { patch, problems } = h.urlReadParams("?trwin=90");
  assert.equal(patch.trwin, null, "an unoffered window must not be applied");
  assert.equal(problems.length, 1);
  assert.match(problems[0] as string, /90-day trend window/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Truncation in a link is still truncation
// ─────────────────────────────────────────────────────────────────────────────

test("a drilldown too large for a link says how much of it the link carries", async () => {
  // The apiAll lesson: hitting a cap must never be indistinguishable from
  // carrying all of it. A 213-device finding shared as 50 ids must arrive
  // announced as 50 of 213.
  const h = await harness();
  const ids = Array.from({ length: 213 }, (_, i) => `dev-${i}`);
  const state = {
    ...idleState(),
    dids: { ids: new Set(ids), label: "43 devices named by a correlated finding" },
  };
  const params = h.urlParamsFor(state);
  const carried = (params.drill as string).split(",");
  assert.equal(carried.length, h.URL_DRILL_CAP, "the link carries at most URL_DRILL_CAP ids");
  assert.equal(params.drilln, "213", "the link records the TRUE size of the drilldown");

  const { patch, problems } = h.urlReadParams(h.urlQueryFor(state));
  assert.equal((patch.dids as { ids: Set<string> }).ids.size, h.URL_DRILL_CAP);
  assert.equal((patch.dids as { total: number }).total, 213);
  assert.match((patch.dids as { label: string }).label, /carried 50 of 213 device ids/,
    "the label the Devices table prints must itself say the set is a subset");
  assert.equal(problems.length, 1, "and the reader is told once, loudly");
  assert.match(problems[0] as string, /named 213 devices/);
});

test("a drilldown that fits is carried whole, with no truncation claim", async () => {
  const h = await harness();
  const ids = ["dev-1", "dev-2", "dev-3"];
  const state = { ...idleState(), dids: { ids: new Set(ids), label: "three devices" } };
  const { patch, problems } = h.urlReadParams(h.urlQueryFor(state));
  assert.deepEqual([...(patch.dids as { ids: Set<string> }).ids], ids);
  assert.equal((patch.dids as { label: string }).label, "three devices",
    "a complete drilldown must not be labelled as a subset");
  assert.deepEqual(problems, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The URL vocabulary is not the API vocabulary
// ─────────────────────────────────────────────────────────────────────────────

test("no URL parameter is ever forwarded into an API request", async () => {
  // /api/alerts 400s on any parameter it does not know, so a page parameter
  // that leaked into a request would break the console rather than degrade.
  const script = await consoleScript();
  for (const m of script.matchAll(/\bapi(?:All)?\([^)]*\)/g)) {
    const call = m[0];
    assert.ok(!/url(?:QueryFor|ParamsFor)/.test(call),
      `an API call builds its path from the URL vocabulary: ${call}`);
    assert.ok(!/location\.search/.test(call),
      `an API call builds its path from the address bar: ${call}`);
  }
});

test("every query parameter the console sends to /api/alerts is one the API accepts", async () => {
  // The accepted set, from the alerts route's own schema (read, not retyped by
  // hand from memory): anything else is a 400.
  const here = dirname(fileURLToPath(import.meta.url));
  // Read from src: this file runs out of dist, where the .ts does not exist.
  const route = await readFile(join(here, "..", "..", "src", "api", "routes", "alerts.ts"), "utf8");
  const script = await consoleScript();
  const sent = new Set<string>();
  for (const m of script.matchAll(/["'`]\/api\/alerts\?([^"'`]+)["'`]/g)) {
    for (const pair of (m[1] as string).split("&")) {
      const name = pair.split("=")[0];
      if (name && !name.includes("$")) sent.add(name);
    }
  }
  // One today (`band`), and the point is the RULE rather than the count: the
  // console opts into a band explicitly and sends nothing else.
  assert.ok(sent.size >= 1, `expected the console to query /api/alerts with a parameter, found ${sent.size}`);
  assert.ok(sent.has("band"), `expected the band opt-in to still be there: ${[...sent].join(", ")}`);
  for (const name of sent) {
    assert.ok(new RegExp(`\\b${name}\\s*:`).test(route),
      `the console sends "${name}" to /api/alerts, which the route's schema does not declare — ` +
      `an unknown parameter there is a 400 and takes the whole alerts view with it`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The vocabularies that are duplicated on purpose must not drift
// ─────────────────────────────────────────────────────────────────────────────

test("the URL's alert-age keys are exactly the ones alertBands() filters on", async () => {
  const script = await consoleScript();
  const bands = declarationOf(script, "alertBands");
  const table = /const AGES = \[([\s\S]*?)\n  \];/.exec(bands);
  assert.ok(table, "alertBands() must still declare its AGES table — this test pins the URL copy to it");
  const keys = [...(table[1] as string).matchAll(/\["([a-z0-9]+)",/g)].map((m) => m[1]);
  const h = await harness();
  const { patch } = h.urlReadParams("?age=" + keys.join("&age="));
  // Every key alertBands() offers must be accepted by the parser; the round
  // trip below proves the list, not just the first entry.
  for (const k of keys) {
    const one = h.urlReadParams("?age=" + k);
    assert.deepEqual(one.problems, [], `alertBands() offers age "${k}" and the URL rejects it`);
    assert.equal(one.patch.aage, k);
  }
  assert.ok(patch.aage, "the parser must still read an age at all");
  const urlList = declarationOf(script, "URL_ALERT_AGES");
  for (const k of keys) {
    assert.ok(urlList.includes(`"${k}"`), `URL_ALERT_AGES has drifted from AGES: "${k}" is missing`);
  }
  assert.equal([...urlList.matchAll(/"[a-z0-9]+"/g)].length, keys.length,
    "URL_ALERT_AGES must hold exactly the keys AGES does — no extras, no omissions");
});

test("the URL's alert-sort keys are exactly the ones alertBands() sorts by", async () => {
  const script = await consoleScript();
  const bands = declarationOf(script, "alertBands");
  const table = /const SORTS_A = \{([\s\S]*?)\n  \};/.exec(bands);
  assert.ok(table, "alertBands() must still declare SORTS_A — this test pins the URL copy to it");
  const keys = [...(table[1] as string).matchAll(/^\s{4}([a-z]+):/gm)].map((m) => m[1]);
  assert.ok(keys.length >= 4, `expected several alert sorts, found ${keys.join(", ")}`);
  const h = await harness();
  for (const k of keys) {
    const one = h.urlReadParams("?asort=" + k);
    assert.deepEqual(one.problems, [], `alertBands() sorts by "${k}" and the URL rejects it`);
  }
  const urlList = declarationOf(script, "URL_ALERT_SORTS");
  assert.equal([...urlList.matchAll(/"[a-z]+"/g)].length, keys.length,
    "URL_ALERT_SORTS must hold exactly the keys SORTS_A does");
});

test("the views a link can name are exactly the tabs the console has", async () => {
  const src = await consoleSource();
  const script = await consoleScript();
  const nav = [...src.matchAll(/data-v="([a-z]+)"/g)].map((m) => m[1]).filter(Boolean);
  assert.ok(nav.length >= 5, `expected several nav tabs, found ${nav.length}`);
  const pages = declarationOf(script, "PAGES");
  const viewsAll = declarationOf(script, "VIEWS_ALL");
  for (const v of nav) {
    assert.ok(new RegExp(`\\b${v}\\s*:`).test(pages),
      `nav tab "${v}" has no PAGES entry, so a link naming it would be refused`);
    assert.ok(viewsAll.includes(`"${v}"`), `nav tab "${v}" is missing from VIEWS_ALL`);
  }
  const pageKeys = [...pages.matchAll(/^\s{2}([a-z]+):/gm)].map((m) => m[1]);
  assert.deepEqual([...pageKeys].sort(), [...nav].sort(),
    "PAGES and the nav must name the same views — PAGES is the vocabulary a link is checked against");
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. push vs replace
// ─────────────────────────────────────────────────────────────────────────────

test("history is pushed in exactly one place, and only for things Back should undo", async () => {
  // Thirty keystrokes must not cost thirty Back presses, so every incidental
  // change replaces. The only pushes are a tab change and the two layers.
  const script = await consoleScript();
  const pushes = [...script.matchAll(/history\.pushState/g)];
  assert.equal(pushes.length, 1, "history.pushState belongs in urlSync() and nowhere else");
  assert.ok(declarationOf(script, "urlSync").includes("history.pushState"),
    "the one pushState must be the one inside urlSync()");
  const pushCallers = [...script.matchAll(/urlSync\((?:[^)]*?)"push"(?:[^)]*?)\)/g)].length;
  assert.equal(pushCallers, 3,
    `exactly three things push: the tab change, the device drawer and the alert work ` +
    `surface. Found ${pushCallers} push call site(s)`);
  // And they are those three. A drawer that replaced instead of pushing would
  // leave Back doing nothing from an open drawer, which is the one Back press
  // every reviewer tries first.
  for (const fn of ["openDevice", "openAlertWork"]) {
    assert.match(declarationOf(script, fn), /urlSync\([^)]*"push"/,
      `${fn}() must push: a Back press is how an opened layer is closed`);
  }
  const nav = /document\.querySelectorAll\("#nav button"\)\.forEach\([\s\S]*?\n\}\)\);/.exec(script);
  assert.ok(nav, "the nav wiring must still be findable");
  assert.match(nav[0], /urlSync\("push"\)/, "a tab change must add a history entry");
  const replaceCallers = [...script.matchAll(/urlSync\("replace"/g)].length;
  assert.ok(replaceCallers >= 8,
    `every incidental control must replace instead of pushing; found only ${replaceCallers}`);
});

test("a popstate is applied with history writes suspended", async () => {
  // Closing the drawer on the way past a Back press must not push a new entry
  // over the entry being restored.
  const script = await consoleScript();
  assert.ok(/addEventListener\("popstate"/.test(script), "the console must handle popstate");
  const sync = declarationOf(script, "urlSync");
  assert.ok(/^\s*if \(URL_SUSPEND\) return;/m.test(sync),
    "urlSync must refuse to write while a popstate is being applied");
});

/**
 * urlSync() itself, against a fake history.
 *
 * The textual check above proves there is exactly one pushState; this proves it
 * is REACHED, and reached only where a Back press should undo something. A
 * console that only ever replaced would look identical in the source and would
 * have no working Back button at all.
 */
type SyncApi = {
  urlSync: (mode: string, layer?: string) => void;
  suspend: (v: boolean) => void;
  calls: { how: string; url: string; layer: string | null }[];
  S: Record<string, unknown>;
};

const syncHarness = async (state?: Record<string, unknown>): Promise<SyncApi> => {
  const script = await consoleScript();
  const calls: { how: string; url: string; layer: string | null }[] = [];
  const loc = { pathname: "/console.html", search: "" };
  const history = {
    state: null as unknown,
    pushState(st: { vfiLayer: string | null }, _t: string, url: string): void {
      calls.push({ how: "push", url, layer: st.vfiLayer });
      loc.search = url.slice(loc.pathname.length);
      history.state = st;
    },
    replaceState(st: { vfiLayer: string | null }, _t: string, url: string): void {
      calls.push({ how: "replace", url, layer: st.vfiLayer });
      loc.search = url.slice(loc.pathname.length);
      history.state = st;
    },
  };
  const S = { ...idleState(), ...(state || {}) };
  const body =
    `"use strict";\nconst { S, history, location } = ctx;\n` +
    ["URL_DEFAULTS", "urlParamsFor", "urlQueryFor", "URL_SUSPEND", "urlSync"]
      .map((n) => declarationOf(script, n)).join("\n") +
    `\nreturn { urlSync, suspend: (v) => { URL_SUSPEND = v; } };`;
  const api = new Function("ctx", body)({ S, history, location: loc }) as
    { urlSync: (m: string, l?: string) => void; suspend: (v: boolean) => void };
  return { ...api, calls, S };
};

test("urlSync pushes a new entry for a real change and never for the same link twice", async () => {
  const h = await syncHarness({ view: "devices" });
  h.urlSync("push");
  assert.deepEqual(h.calls, [{ how: "push", url: "/console.html?v=devices", layer: null }],
    "a tab change must add a history entry, or Back does nothing");

  // The same state again: renderers run on a timer, and a repaint must not
  // stack a second identical entry.
  h.urlSync("push");
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1]?.how, "replace", "an unchanged link must replace, never push");

  h.S.cls = "offline";
  h.urlSync("replace");
  assert.equal(h.calls[2]?.how, "replace");
  assert.equal(h.calls[2]?.url, "/console.html?v=devices&status=offline");
});

test("an opened layer is tagged so closing it can step back through its own entry", async () => {
  const h = await syncHarness({ view: "devices", devOpen: "d1" });
  h.urlSync("push", "device");
  assert.equal(h.calls[0]?.layer, "device",
    "the drawer's entry must be identifiable as ours; closeDevice() reads this tag");
  assert.match(h.calls[0]?.url as string, /device=d1/);
});

test("nothing is written to history while a popstate is being applied", async () => {
  const h = await syncHarness({ view: "devices" });
  h.suspend(true);
  h.urlSync("push");
  h.urlSync("replace");
  assert.deepEqual(h.calls, [],
    "applying a Back press must not write over the entry it is restoring");
});

test("a REPLACED layer carries no tag — there is no entry underneath it to go back to", async () => {
  // Found in the browser. A deep-linked drawer writes its state with replace,
  // so it used to get the same "device" tag as a pushed one; closing it then
  // called history.back() on the FIRST entry in the tab, nothing moved, and the
  // address bar went on naming a device that was no longer open. The tag now
  // means exactly "we pushed an entry and there is one underneath".
  const h = await syncHarness({ view: "devices", devOpen: "d1" });
  h.urlSync("replace", "device");
  assert.equal(h.calls[0]?.how, "replace");
  assert.equal(h.calls[0]?.layer, null,
    "a replace must not claim there is an entry to step back through");

  // And a push that turns out to be the same link is a replace, so it is
  // untagged too.
  h.urlSync("push", "device");
  assert.equal(h.calls[1]?.how, "replace");
  assert.equal(h.calls[1]?.layer, null);
});

test("re-sharing a shortened drilldown keeps its TRUE size and does not double its sentence", async () => {
  // Found in the browser: the receiver's console re-emitted the augmented label
  // and the size of the subset, so 3-of-213 became 3-of-3 on the second hop and
  // the "this link carried" sentence stacked. A truncation that heals itself on
  // a re-share is the apiAll bug with extra steps.
  const h = await harness();
  const ids = Array.from({ length: 213 }, (_, i) => `dev-${i}`);
  const first = h.urlQueryFor({
    ...idleState(),
    dids: { ids: new Set(ids), label: "213 devices from a correlated finding" },
  });
  const hop1 = h.urlReadParams(first);
  const hop2 = h.urlReadParams(h.urlQueryFor({ ...idleState(), dids: hop1.patch.dids }));
  const d = hop2.patch.dids as { ids: Set<string>; label: string; total: number };
  assert.equal(d.total, 213, "the true size of the drilldown must survive a re-share");
  assert.equal(d.ids.size, 50);
  assert.equal([...d.label.matchAll(/this link carried/g)].length, 1,
    `the subset sentence must appear exactly once: ${d.label}`);
  assert.equal(hop2.problems.length, 1);
});
