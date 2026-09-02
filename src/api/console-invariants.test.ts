/**
 * Durable home for the console invariants that keep regressing.
 *
 * public/console.html is a ~4300-line single file served as a string. Static
 * typing cannot see any of it, and the "count the thing you filter" invariant
 * has broken and been fixed THREE times in it: device status chips summing to
 * 248 above a header saying 250; the Alerts severity chips counting a stale
 * 5-minute snapshot instead of the live rows; the Overview header printing 289
 * above chips summing to 89. Each fix was verified by a throwaway browser
 * script, so nothing stopped the next one.
 *
 * HOW THIS WORKS, AND WHAT IT IS NOT.
 *
 * The precedent in api.test.ts ("every element the console wires up actually
 * exists in its markup") parses console.html from disk and asserts on its text.
 * That is a static assertion and it is all it can be for markup. But the band
 * split, the token prompt and the "we never asked" helper are *logic*, and
 * logic asserted by grep is a test that implies coverage it does not have.
 *
 * So this file extends the same read-from-disk approach one step: it lifts named
 * top-level declarations out of the console's <script> by source text and
 * evaluates them with `new Function` against a ~30-line hand-written element
 * stub. That is not a DOM and does not pretend to be one — no jsdom, no
 * Playwright, no new dependency of any kind. It is enough to run four renderers
 * and read the numbers they wrote, which is precisely the property that keeps
 * breaking: the header, the chips, the rows and the band pills must all be
 * counting ONE array.
 *
 * Where a property genuinely is textual (a retracted sentence must not drift
 * from its constant), the assertion is textual and says so in its title.
 *
 * If the console renames or restructures any declaration this file lifts, the
 * extraction FAILS LOUDLY rather than silently skipping — a harness that
 * quietly stops testing is the failure mode this file exists to prevent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ─── loading the console's own source ────────────────────────────────────────

const consoleHtml = async (): Promise<string> => {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFile(join(here, "..", "..", "public", "console.html"), "utf8");
};

/** The last <script> block: the console's code, without the markup or styles. */
const consoleScript = async (): Promise<string> => {
  const src = await consoleHtml();
  const open = src.lastIndexOf("<script>");
  const close = src.lastIndexOf("</script>");
  assert.ok(open > 0 && close > open, "console.html must contain a trailing <script> block");
  return src.slice(open + "<script>".length, close);
};

/**
 * Lift one named top-level declaration out of the script by source text.
 *
 * Delimited by parseability, not by brace counting: take the declaration line
 * and grow one line at a time until the accumulated text is a syntactically
 * complete statement. That handles `function f() {…}`, single-line consts and
 * multi-line arrows identically, and it cannot stop early — an unclosed brace
 * or an unterminated template literal is a parse error.
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

/** Build a sandbox holding the named declarations, in the order given. */
const sandbox = <T>(script: string, names: readonly string[], preamble: string, ctx: unknown): T => {
  const body =
    `"use strict";\n${preamble}\n` +
    names.map((n) => declarationOf(script, n)).join("\n") +
    `\nreturn { ${names.filter((n) => /^[a-z]/.test(n)).join(", ")} };`;
  return new Function("ctx", body)(ctx) as T;
};

/** Strip block comments and whole-line `//` comments. Prose about a bug quotes
 *  the very tokens the structural checks look for, so it must not count. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
    .filter((l) => !/^\s*(?:\/\/|\*)/.test(l)).join("\n");

/** name → body, for declarations at column 0 closed by a `}` at column 0.
 *  That is the console's formatting throughout; the size assertion below is the
 *  canary for it changing. */
const topLevelFunctions = (script: string): Map<string, string> => {
  const lines = script.split("\n");
  const out = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(lines[i] as string);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && lines[j] !== "}") j++;
    out.set(m[1] as string, lines.slice(i, j + 1).join("\n"));
  }
  return out;
};

// Byte ranges of every block comment, so a token quoted in prose is not
// mistaken for rendered text.
const commentRanges = (src: string): [number, number][] =>
  [...src.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => [m.index as number, (m.index as number) + m[0].length]);

// ─── the element stub ────────────────────────────────────────────────────────
//
// Deliberately dumb and deliberately incomplete. It records what a renderer
// wrote and nothing else. `querySelectorAll` returning [] means the click
// handlers the renderers attach are never bound, which is fine: this file tests
// counting, not interaction.

class El {
  innerHTML = "";
  textContent = "";
  className = "";
  readonly style: Record<string, string> = {};
  readonly children: El[] = [];
  readonly attrs: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly classList = { toggle: (): void => {} };
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

// ─── fixtures ────────────────────────────────────────────────────────────────

type Alert = {
  id: string;
  deviceId: string;
  severity: string;
  title: string;
  ruleId: string;
  evidence: string;
  openedAt: string;
};

const alert = (id: string, deviceId: string, severity: string): Alert => ({
  id, deviceId, severity,
  title: `${severity} on ${deviceId}`,
  ruleId: "offline-4h",
  evidence: "evidence",
  openedAt: new Date().toISOString(),
});

/**
 * Shaped like the real fleet, at 1/25 scale: a large dormant tail, a couple of
 * live incidents, and a critical sitting ON a dormant device — the case the
 * server holds back and the client must not sweep away.
 */
const FLEET = {
  // live incidents
  live: [alert("L1", "live-1", "critical"), alert("L2", "live-2", "medium"), alert("L3", "live-3", "info")],
  // alerts whose device is dormant, and which the server DID absorb
  absorbed: [alert("D1", "dark-1", "medium"), alert("D2", "dark-2", "medium"), alert("D3", "dark-3", "info")],
  // alerts whose device is dormant but which are never absorbed (critical/high)
  heldBack: [alert("H1", "dark-1", "critical"), alert("H2", "dark-2", "high")],
};
const ALL_ALERTS: Alert[] = [...FLEET.live, ...FLEET.absorbed, ...FLEET.heldBack];
const DORMANT_DEVICE_IDS = ["dark-1", "dark-2", "dark-3"];
const ABSORBED_ALERT_IDS = FLEET.absorbed.map((a) => a.id);

type Hyg = {
  dormant: { total: number; deviceIds: string[]; alertIds?: string[] };
  rollup?: {
    title: string; severity: string; estateShare: number; alertCount: number;
    longestDarkSeconds: number; darkness: { label: string; devices: number }[];
    neverSeenDevices: number;
  };
};

/** hygiene payload WITH the server's authoritative per-alert classification. */
const hygAuthoritative = (): Hyg => ({
  dormant: { total: DORMANT_DEVICE_IDS.length, deviceIds: [...DORMANT_DEVICE_IDS], alertIds: [...ABSORBED_ALERT_IDS] },
  rollup: {
    title: "Dormant canvases", severity: "warning", estateShare: 0.4,
    alertCount: ABSORBED_ALERT_IDS.length, longestDarkSeconds: 923 * 86400,
    darkness: [{ label: "1–3 months", devices: 2 }, { label: "over a year", devices: 1 }],
    neverSeenDevices: 0,
  },
});

/** The legacy payload: dormant DEVICES only, no per-alert ids. */
const hygDeviceOnly = (): Hyg => {
  const h = hygAuthoritative();
  delete h.dormant.alertIds;
  return h;
};

// ─── the alerts sandbox ──────────────────────────────────────────────────────

type Bands = {
  band: string;
  dormIds: Set<string>;
  incidents: Alert[];
  dormant: Alert[];
  authoritative: boolean;
  scoped: Alert[];
};

type AlertsApi = {
  alertBands: () => Bands;
  renderAlertWidget: () => void;
  renderAlertFilters: () => void;
  renderAlerts: () => void;
  renderAlertBands: () => void;
};

// Order matters: these are `const` arrows and `function`s in one scope, so the
// consts must precede their first *call*, which happens only inside the
// renderers. Listed in source order for readability.
const ALERT_DECLS = [
  "esc", "ago", "SEV", "thumbFor",
  "dormantIdSet", "NEVER_ABSORBED", "isDormantAlert", "alertBands",
  "renderAlertBands", "renderAlertFilters", "renderAlerts", "renderAlertWidget",
] as const;

type AlertHarness = {
  api: AlertsApi;
  S: Record<string, unknown>;
  el: (id: string) => El;
  /** Every severity count the Alerts-tab chips printed, keyed by severity. */
  chipCounts: () => Record<string, number>;
  /** The band pills rendered above the list, keyed by band. */
  pillCounts: () => Record<string, number>;
};

const alertHarness = async (state: Record<string, unknown>): Promise<AlertHarness> => {
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
    alerts: [], devices: [], hyg: null, aband: "incidents", sev: "all", ...state,
  };
  const api = sandbox<AlertsApi>(
    script, ALERT_DECLS,
    "const { document, S, openDevice, switchTab } = ctx;\nconst $ = (s) => document.querySelector(s);",
    { document, S, openDevice: (): void => {}, switchTab: (): void => {} },
  );
  const chipCounts = (): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const c of el("fp").children) {
      const m = /<b>(\d+)<\/b>\s*([a-z]+)/.exec(c.innerHTML);
      assert.ok(m, `a severity chip did not render "<b>N</b> severity": ${c.innerHTML}`);
      out[m[2] as string] = Number(m[1]);
    }
    return out;
  };
  const pillCounts = (): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const m of el("abands").innerHTML.matchAll(/data-aband="([a-z]+)"[^>]*>\s*<b>(\d+)<\/b>/g)) {
      out[m[1] as string] = Number(m[2]);
    }
    return out;
  };
  return { api, S, el, chipCounts, pillCounts };
};

const sum = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);

// ─────────────────────────────────────────────────────────────────────────────
// 0. The harness is really running the console's code
// ─────────────────────────────────────────────────────────────────────────────

test("the console-invariant harness lifts and runs the real console source", async () => {
  // If this file ever tests a stub of its own making, every assertion below is
  // theatre. So: prove the lifted text came from console.html, and that the
  // renderers actually wrote something.
  const script = await consoleScript();
  const src = declarationOf(script, "alertBands");
  assert.match(src, /^function alertBands\(\)/, "alertBands must still be a top-level function");
  assert.ok(src.trimEnd().endsWith("}"), "the lifted alertBands must be a complete function body");
  assert.ok(src.includes("alertIds"), "the lifted alertBands must be the version that reads alertIds");

  const h = await alertHarness({ alerts: ALL_ALERTS, hyg: hygAuthoritative() });
  h.api.renderAlerts();
  assert.notEqual(h.el("alist").innerHTML, "", "the lifted renderAlerts must actually render rows");
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. ONE band split feeds every surface
//
// Behavioural. The real property is not "no other function calls a helper", it
// is "the header count and the chip counts come from the same array". These
// tests run the renderers and compare the numbers they printed.
// ─────────────────────────────────────────────────────────────────────────────

test("the Overview header, its severity chips and the Alerts rows all count the same array", async () => {
  // The shipped bug: the header printed S.alerts.length (289) above chips
  // summing to 89, with nothing on screen saying the chips were incidents-only.
  const h = await alertHarness({ alerts: ALL_ALERTS, hyg: hygAuthoritative() });
  const { scoped, incidents, dormant } = h.api.alertBands();

  h.api.renderAlertWidget();
  h.api.renderAlertFilters();
  h.api.renderAlerts();

  // The Overview widget's own severity pills, parsed out of what it wrote.
  const widgetPills = [...h.el("walerts").innerHTML.matchAll(/data-sev="([a-z]+)"[^>]*>[\s\S]*?<b>(\d+)<\/b>/g)]
    .reduce<Record<string, number>>((o, m) => ({ ...o, [m[1] as string]: Number(m[2]) }), {});

  assert.equal(Number(h.el("wacount").textContent), scoped.length, "#wacount must report the band on screen");
  assert.equal(sum(widgetPills), scoped.length, "the Overview pills must sum to the header count");
  assert.equal(sum(h.chipCounts()), scoped.length, "the Alerts chips must sum to the header count");
  assert.equal(Number(h.el("acount").textContent), scoped.length, "#acount must report the same band");

  // And the split really is a split: nothing lost, nothing double-counted.
  assert.equal(incidents.length + dormant.length, ALL_ALERTS.length);
  assert.ok(scoped.length < ALL_ALERTS.length, "the fixture must exercise a non-empty dormant band");
});

test("switching to the dormant band moves the header, the chips and the rows together", async () => {
  // Half a fix is the dangerous state: a header that follows the band while the
  // chips keep counting incidents is the same lie with different numbers.
  const h = await alertHarness({ alerts: ALL_ALERTS, hyg: hygAuthoritative(), aband: "dormant" });
  const { scoped, band } = h.api.alertBands();
  assert.equal(band, "dormant");

  h.api.renderAlertWidget();
  h.api.renderAlertFilters();
  h.api.renderAlerts();

  assert.equal(Number(h.el("wacount").textContent), scoped.length);
  assert.equal(sum(h.chipCounts()), scoped.length);
  assert.equal(Number(h.el("acount").textContent), scoped.length);
  // The chips must be counting the DORMANT alerts, not the incidents again.
  assert.deepEqual(h.chipCounts(), { medium: 2, info: 1, critical: 0, high: 0 });
});

test("the band pills agree with the rows directly beneath them", async () => {
  // The pills used to be the server's snapshot (per alert) while the rows were
  // the client's filter (per device), so a pill contradicted the list under it.
  const h = await alertHarness({ alerts: ALL_ALERTS, hyg: hygAuthoritative(), devices: [] });
  const { incidents, dormant } = h.api.alertBands();
  h.api.renderAlertBands();
  assert.deepEqual(h.pillCounts(), { incidents: incidents.length, dormant: dormant.length });
});

test("the header never reports a band that excludes a row it is listing", async () => {
  // Sweep every band × severity-filter combination and assert the count printed
  // is never smaller than the rows rendered under it.
  for (const aband of ["incidents", "dormant"]) {
    for (const sev of ["all", "critical", "high", "medium", "info"]) {
      const h = await alertHarness({ alerts: ALL_ALERTS, hyg: hygAuthoritative(), aband, sev });
      h.api.renderAlertWidget();
      h.api.renderAlerts();
      const rows = (h.el("alist").innerHTML.match(/class="arow"/g) || []).length;
      const header = Number(h.el("wacount").textContent);
      assert.ok(
        rows <= header,
        `band=${aband} sev=${sev}: ${rows} row(s) rendered under a header of ${header}`,
      );
    }
  }
});

test("with hygiene unavailable the view degrades to one full list, not a blank one", async () => {
  const h = await alertHarness({ alerts: ALL_ALERTS, hyg: null });
  const b = h.api.alertBands();
  assert.equal(b.incidents.length, ALL_ALERTS.length, "everything must land in incidents");
  assert.equal(b.dormant.length, 0);
  h.api.renderAlertWidget();
  h.api.renderAlertFilters();
  h.api.renderAlerts();
  assert.equal(Number(h.el("wacount").textContent), ALL_ALERTS.length);
  assert.equal(sum(h.chipCounts()), ALL_ALERTS.length);
  assert.equal(h.el("abands").innerHTML, "", "no hygiene means no band pills to contradict");
});

test("no surface other than alertBands() derives the incident/dormant split", async () => {
  // STATIC. The behavioural tests above prove the four current surfaces agree;
  // this one is what stops a FIFTH surface from being added with its own copy
  // of the rule, which is how this broke all three times.
  const script = await consoleScript();
  const fns = topLevelFunctions(stripComments(script));
  assert.ok(fns.size > 20, `expected the console's top-level functions, found ${fns.size}`);

  // The band decision is spelled in exactly these tokens. Anywhere they appear
  // outside alertBands()/dormantIdSet() is a second copy of the rule. Scoped to
  // `dormant.*` on purpose: `r.deviceIds` on a remediation recommendation is an
  // unrelated field, and a check that fires on it would be deleted for crying
  // wolf. `S.alerts.filter` is the whole-fleet re-derivation and is owned by
  // nobody — alertBands() iterates S.alerts, it does not filter it.
  const owners: Record<string, string[]> = {
    "dormantIdSet(": ["alertBands"],
    "isDormantAlert(": ["alertBands"],
    "dormant.alertIds": ["alertBands"],
    "dormant.deviceIds": ["alertBands", "dormantIdSet"],
    "S.alerts.filter": [],
  };
  for (const [token, allowed] of Object.entries(owners)) {
    for (const [name, body] of fns) {
      if (allowed.includes(name)) continue;
      if (token === `${name}(`) continue;   // a function's own signature line
      assert.ok(
        !body.includes(token),
        `${name}() contains "${token}" — the band split belongs to alertBands() alone`,
      );
    }
  }

  // And every surface that shows a band-scoped number must consume it.
  for (const name of ["renderAlertWidget", "renderAlertFilters", "renderAlerts", "renderAlertBands"]) {
    const body = fns.get(name);
    assert.ok(body, `console.html no longer declares ${name}()`);
    assert.ok(body.includes("alertBands()"), `${name}() must take its split from alertBands()`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1b. The same invariant on the DEVICES table, where it broke first
//
// The original sighting: status chips summing to 248 above a header reading 250,
// because the chips came from the poll-time snapshot and the header from the
// rows. Same shape, different surface — so it gets the same behavioural test.
// ─────────────────────────────────────────────────────────────────────────────

type DevicesApi = {
  renderDeviceFilters: () => void;
  renderDevices: () => void;
  renderStatusWidget: () => void;
};

const DEVICE_DECLS = [
  "esc", "ago", "statusOrder", "SORTS", "renderDeviceFilters", "renderDevices", "renderStatusWidget",
] as const;

type Device = { id: string; name: string; status: string; deviceClass: string; lastOnlineTime: string };

const device = (id: string, status: string): Device => ({
  id, name: `Canvas ${id}`, status, deviceClass: "canvas",
  lastOnlineTime: new Date().toISOString(),
});

/** A fleet with every status the console knows, plus one it does not. */
const FLEET_DEVICES: Device[] = [
  ...Array.from({ length: 5 }, (_, i) => device(`on-${i}`, "online")),
  ...Array.from({ length: 3 }, (_, i) => device(`off-${i}`, "offline")),
  ...Array.from({ length: 2 }, (_, i) => device(`wrn-${i}`, "warning")),
  device("unk-0", "unknown"),
  // A status the console has no chip for by name. If statusOrder drops it, the
  // chips stop summing to All and the 248/250 bug is back in a new costume.
  device("retired-0", "retired"),
];

const deviceHarness = async (state: Record<string, unknown>): Promise<{
  api: DevicesApi; el: (id: string) => El; chips: () => Record<string, number>;
}> => {
  const script = await consoleScript();
  const els = new Map<string, El>();
  const el = (id: string): El => {
    const key = id.replace(/^#/, "");
    let e = els.get(key);
    if (!e) { e = new El(); els.set(key, e); }
    return e;
  };
  const body =
    `"use strict";\nconst { document, S, openDevice, switchTab } = ctx;\n` +
    `const $ = (s) => document.querySelector(s);\n` +
    DEVICE_DECLS.map((n) => declarationOf(script, n)).join("\n") +
    `\nreturn { renderDeviceFilters, renderDevices, renderStatusWidget };`;
  const api = new Function("ctx", body)({
    document: { querySelector: (sel: string): El => el(sel), createElement: (): El => new El() },
    S: {
      devices: [], cls: "all", q: "", sort: { key: "status", dir: 1 }, summary: null, ...state,
    },
    openDevice: (): void => {},
    switchTab: (): void => {},
  }) as DevicesApi;
  const chips = (): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const c of el("dfilters").children) {
      const m = /<b>(\d+)<\/b>\s*([A-Za-z]+)/.exec(c.innerHTML);
      assert.ok(m, `a status chip did not render "<b>N</b> label": ${c.innerHTML}`);
      out[m[2] as string] = Number(m[1]);
    }
    return out;
  };
  return { api, el, chips };
};

test("the device status chips sum to All, and All matches the table header", async () => {
  // 248 vs 250. Every status present in the rows must have a chip, or the
  // chips silently under-count the fleet they sit above.
  const h = await deviceHarness({ devices: FLEET_DEVICES });
  h.api.renderDeviceFilters();
  h.api.renderDevices();
  const chips = h.chips();
  const all = chips["All"];
  assert.equal(all, FLEET_DEVICES.length, "the All chip must count every row");
  const perStatus = Object.entries(chips).filter(([k]) => k !== "All");
  assert.equal(
    perStatus.reduce((a, [, n]) => a + n, 0), all,
    `status chips sum to ${perStatus.reduce((a, [, n]) => a + n, 0)} above an All of ${all}: ${JSON.stringify(chips)}`,
  );
  assert.equal(Number(h.el("dcount").textContent), FLEET_DEVICES.length);
  // Including the status the console was never taught about by name.
  assert.equal(chips["retired"], 1, "an unrecognised status must still get a chip");
});

test("each device status chip equals the rows that filtering to it renders", async () => {
  const first = await deviceHarness({ devices: FLEET_DEVICES });
  first.api.renderDeviceFilters();
  for (const [label, n] of Object.entries(first.chips())) {
    const cls = label === "All" ? "all" : label;
    const h = await deviceHarness({ devices: FLEET_DEVICES, cls });
    h.api.renderDevices();
    const rows = (h.el("dtable").innerHTML.match(/<tr class="r"/g) || []).length;
    assert.equal(rows, n, `the "${label}" chip says ${n} but the table renders ${rows} row(s)`);
  }
});

test("the Overview status widget counts the device rows, not the poll-time snapshot", async () => {
  // The snapshot is computed by a different status expression on a 5-minute
  // cadence. Reading it here is how the widget came to disagree with the table.
  const h = await deviceHarness({
    devices: FLEET_DEVICES,
    // A deliberately WRONG snapshot: if the widget reads it, the numbers move.
    summary: { snapshot: { statusCounts: { online: 999, offline: 999 }, telemetryCoverage: 0.5 } },
  });
  h.api.renderStatusWidget();
  const shown = [...h.el("wstatus").innerHTML.matchAll(/data-status="([a-z]+)"[\s\S]*?<span class="sv">([\d,]+)<\/span>/g)]
    .reduce<Record<string, number>>((o, m) => ({ ...o, [m[1] as string]: Number((m[2] as string).replace(/,/g, "")) }), {});
  const expected: Record<string, number> = {};
  for (const d of FLEET_DEVICES) expected[d.status] = (expected[d.status] ?? 0) + 1;
  assert.deepEqual(shown, expected, "the widget must count S.devices, not summary.snapshot");
  assert.equal(
    Object.values(shown).reduce((a, b) => a + b, 0), FLEET_DEVICES.length,
    "the widget's rows must sum to the fleet it is describing",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The severity chips count the SCOPED band, never S.alerts wholesale
// ─────────────────────────────────────────────────────────────────────────────

test("the severity chips count the band on screen, not every open alert", async () => {
  // The exact regression: renderAlertFilters read S.alerts directly, so it
  // printed the whole-fleet severity split above an incidents-only list.
  const h = await alertHarness({ alerts: ALL_ALERTS, hyg: hygAuthoritative() });
  const { scoped } = h.api.alertBands();
  h.api.renderAlertFilters();
  const chips = h.chipCounts();

  assert.equal(sum(chips), scoped.length);
  assert.notEqual(sum(chips), ALL_ALERTS.length, "counting every open alert is the bug");
  // Spelled out, so the failure message names the wrong number: incidents are
  // one critical + one medium + one info, plus the two held-back never-absorbed.
  assert.deepEqual(chips, { critical: 2, high: 1, medium: 1, info: 1 });
});

test("critical and high chips render at zero; the other severities do not", async () => {
  // Both halves of the never-absorbed valve must be visible even when empty:
  // "0 critical" alone only proves half of it.
  const h = await alertHarness({ alerts: [alert("M1", "live-1", "medium")], hyg: null });
  h.api.renderAlertFilters();
  assert.deepEqual(h.chipCounts(), { critical: 0, high: 0, medium: 1 });
});

test("a severity chip never claims more than the rows that severity renders", async () => {
  const h = await alertHarness({ alerts: ALL_ALERTS, hyg: hygAuthoritative() });
  h.api.renderAlertFilters();
  const chips = h.chipCounts();
  for (const [sev, n] of Object.entries(chips)) {
    const one = await alertHarness({ alerts: ALL_ALERTS, hyg: hygAuthoritative(), sev });
    one.api.renderAlerts();
    const rows = (one.el("alist").innerHTML.match(/class="arow"/g) || []).length;
    assert.equal(rows, n, `the "${sev}" chip says ${n} but filtering to it renders ${rows} row(s)`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The client must not re-implement the server's band rule
// ─────────────────────────────────────────────────────────────────────────────

test("the server's per-alert classification wins over the client's device guess", async () => {
  // Constructed so the two rules DISAGREE: the server absorbed only the three
  // medium/info alerts, and held back the critical and the high that sit on the
  // same dormant devices. Banding by device id would sweep both away.
  const h = await alertHarness({ alerts: ALL_ALERTS, hyg: hygAuthoritative() });
  const b = h.api.alertBands();
  assert.equal(b.authoritative, true, "alertIds present means the server's answer is in use");
  assert.deepEqual(b.dormant.map((a) => a.id).sort(), [...ABSORBED_ALERT_IDS].sort());
  // The held-back pair is on dormant devices and must still be in the queue.
  for (const held of FLEET.heldBack) {
    assert.ok(
      b.incidents.some((a) => a.id === held.id),
      `${held.severity} ${held.id} is on a dormant device but was not held back into incidents`,
    );
    assert.ok(b.dormIds.has(held.deviceId), "the fixture must put it on a dormant DEVICE");
  }
});

test("the device-based fallback still applies the NEVER_ABSORBED exemption", async () => {
  // A fallback that bands purely by device is a different product: it defeats
  // the safety valve exactly when it matters, on the first dormant critical.
  const h = await alertHarness({ alerts: ALL_ALERTS, hyg: hygDeviceOnly() });
  const b = h.api.alertBands();
  assert.equal(b.authoritative, false, "no alertIds means the fallback path");
  for (const held of FLEET.heldBack) {
    assert.ok(
      b.incidents.some((a) => a.id === held.id),
      `the fallback absorbed a ${held.severity} alert; critical and high are never absorbed`,
    );
  }
  // Everything else on a dormant device is absorbed, as the server would.
  assert.deepEqual(b.dormant.map((a) => a.id).sort(), [...ABSORBED_ALERT_IDS].sort());
  // Both paths must produce the SAME bands for this payload — otherwise the
  // console shows one product with alertIds and another without.
  const auth = await alertHarness({ alerts: ALL_ALERTS, hyg: hygAuthoritative() });
  assert.deepEqual(
    b.dormant.map((a) => a.id).sort(),
    auth.api.alertBands().dormant.map((a) => a.id).sort(),
    "the fallback must not classify differently from the server",
  );
});

test("a malformed alertIds falls back rather than banding everything as dormant", async () => {
  // `alertIds: null` from a partial payload must not become `new Set(null)`
  // (a throw) nor an empty set applied as authoritative (which would silently
  // empty the dormant band and dump 200 dormant alerts into the queue).
  const hyg = hygAuthoritative() as unknown as { dormant: Record<string, unknown> };
  hyg.dormant.alertIds = null;
  const h = await alertHarness({ alerts: ALL_ALERTS, hyg });
  const b = h.api.alertBands();
  assert.equal(b.authoritative, false, "a non-array alertIds is not an authoritative answer");
  assert.deepEqual(b.dormant.map((a) => a.id).sort(), [...ABSORBED_ALERT_IDS].sort());
});

test("NEVER_ABSORBED is exactly critical and high, matching the server's rule", async () => {
  // STATIC-ish: the set is a plain literal, so this reads its value from the
  // console and pins it. If the server's valve widens, both must move together.
  const script = await consoleScript();
  const decl = declarationOf(script, "NEVER_ABSORBED");
  const s = new Function(`${decl}\nreturn NEVER_ABSORBED;`)() as Set<string>;
  assert.deepEqual([...s].sort(), ["critical", "high"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Nothing claims a reading it did not take
//
// The Network subtab had its own copy of "why is this empty" and told 137
// offline canvases they had declined to answer a signal request nobody sent.
// ─────────────────────────────────────────────────────────────────────────────

const FALSE_CLAIMS = ["did not answer the signal request", "does not report clock sync"] as const;

type NetApi = {
  tabNetwork: (d: unknown) => string;
  whyNoReading: (tm: unknown, field: string) => string;
};

const NET_DECLS = [
  "esc", "ago", "dur", "WINDOW_HOURS", "kv", "na",
  "OFFLINE_UNASKED", "whyNoReading", "networkDerived", "isReachable", "dataUsageChart", "tabNetwork",
] as const;

const netHarness = async (): Promise<NetApi & { OFFLINE_UNASKED: string }> => {
  const script = await consoleScript();
  const body =
    `"use strict";\nconst { S } = ctx;\n` +
    NET_DECLS.map((n) => declarationOf(script, n)).join("\n") +
    `\nreturn { tabNetwork, whyNoReading, OFFLINE_UNASKED };`;
  // `S.dev._net` is `{}` on a failed read and `undefined` before one; it is
  // never null, so the reachable-branch stub is an empty object.
  return new Function("ctx", body)({ S: { dev: { _net: {} } } }) as NetApi & { OFFLINE_UNASKED: string };
};

const netDevice = (telemetry: unknown, status: string): unknown => ({
  id: "d1", name: "Canvas 1", status,
  latest: { presence: status, observedAt: new Date().toISOString() },
  settings: {}, lastOnlineTime: new Date().toISOString(),
  _health: null, _telemetry: telemetry,
});

test("an offline screen is told it was never asked, not that it refused to answer", async () => {
  // Behavioural: renders the real Network subtab for an offline device and reads
  // the HTML back. This is the 137-canvas bug, reproduced and pinned.
  const api = await netHarness();
  const html = api.tabNetwork(netDevice({ offline: true, read: [], rssiDbm: null, ntpOffsetMs: null }, "offline"));
  assert.ok(html.includes(api.OFFLINE_UNASKED), "an offline screen must say it cannot be asked");
  for (const claim of FALSE_CLAIMS) {
    assert.ok(!html.includes(claim), `an offline screen was told: "${claim}" — it was never asked`);
  }
});

test("a screen that WAS asked and answered nothing still gets the specific reason", async () => {
  // The mirror image, so the fix above cannot be "delete the specific strings":
  // an online screen we did command must keep its precise explanation.
  const api = await netHarness();
  const html = api.tabNetwork(netDevice({ offline: false, read: ["x"], rssiDbm: null, ntpOffsetMs: null }, "online"));
  for (const claim of FALSE_CLAIMS) {
    assert.ok(html.includes(claim), `an online, commanded screen lost its specific reason: "${claim}"`);
  }
  assert.ok(!html.includes(api.OFFLINE_UNASKED), "an online screen must not claim it is offline");
});

test("whyNoReading distinguishes still-reading, never-asked and asked-and-silent", async () => {
  const api = await netHarness();
  const field = "this hardware does not report it";
  // Still reading: callers render "reading…", so the field passes through.
  assert.equal(api.whyNoReading(undefined, field), field);
  // Never asked.
  assert.equal(api.whyNoReading({ offline: true, read: [] }, field), api.OFFLINE_UNASKED);
  assert.equal(api.whyNoReading({ offline: true, read: ["x"] }, field), api.OFFLINE_UNASKED);
  // Asked, got nothing back.
  assert.match(api.whyNoReading({ offline: false, read: [] }, field), /did not answer the request/);
  // Asked, answered, but this hardware has no such input.
  assert.equal(api.whyNoReading({ offline: false, read: ["x"] }, field), field);
});

test("the retracted claims exist only as arguments to whyNoReading", async () => {
  // STATIC, and the honest version of "these strings are gone". They are NOT
  // gone: they are still the right answer for a screen that was commanded and
  // answered. What must never come back is a surface printing them
  // unconditionally. So: every occurrence must sit inside a whyNoReading() call,
  // which the behavioural test above proves returns OFFLINE_UNASKED when offline.
  const src = await consoleHtml();
  const comments = commentRanges(src);
  for (const claim of FALSE_CLAIMS) {
    const at = [...src.matchAll(new RegExp(claim, "g"))].map((m) => m.index as number);
    assert.ok(at.length > 0, `"${claim}" vanished; if it was retracted, retire this check deliberately`);
    for (const i of at) {
      if (comments.some(([a, b]) => i >= a && i < b)) continue;
      assert.match(
        src.slice(Math.max(0, i - 120), i), /whyNoReading\([^)]*$/,
        `"${claim}" is rendered outside whyNoReading() at offset ${i} — that is the 137-canvas bug`,
      );
    }
  }
});

test("every copy of the offline-unasked sentence is textually identical to the constant", async () => {
  // STATIC drift guard. The Network "as the screen sees it" block spells the
  // sentence as a literal rather than referencing OFFLINE_UNASKED, so a reword
  // of the constant would leave two different sentences for one fact. This does
  // not fail today; it fails the moment they diverge.
  const src = await consoleHtml();
  const api = await netHarness();
  const found = new Set([...src.matchAll(/The screen is offline, so it cannot be[ a-z]*/g)].map((m) => m[0]));
  assert.deepEqual(
    [...found], [api.OFFLINE_UNASKED],
    "the offline-unasked sentence is worded more than one way; OFFLINE_UNASKED is the single source",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Auth prompt safety
//
// Fully behavioural. askForToken touches only window.prompt, sessionStorage and
// one banner element, all of which stub in three lines — so there is no excuse
// for asserting this one by grep.
// ─────────────────────────────────────────────────────────────────────────────

type AuthApi = {
  askForToken: (rejected: string | null) => Promise<string | null>;
  AUTH_MAX_ATTEMPTS: number;
  peek: () => { TOKEN: string; AUTH_ATTEMPTS: number; AUTH_LOCKED: string | null; pending: boolean };
  banner: () => string;
};

const AUTH_DECLS = [
  "esc", "TOKEN", "AUTH_MAX_ATTEMPTS", "AUTH_PROMPT", "AUTH_REJECTED", "AUTH_ATTEMPTS", "AUTH_LOCKED",
  "lockAuth", "askForToken",
] as const;

/**
 * Every askForToken test is bounded. The failure mode this section exists to
 * prevent is "every waiter hangs forever"; without a timeout the test suite
 * REPRODUCES the hang instead of reporting it, and an unbounded CI run is not a
 * test result. Verified: with resolve() moved out of the `finally`, these fail
 * on the timeout with a named test rather than wedging the runner.
 */
const AUTH_TIMEOUT = { timeout: 5_000 } as const;

/** A fresh, isolated copy of the auth module per test. */
const authHarness = async (
  prompt: ((msg: string, dflt: string) => string | null) | undefined,
  stored: string,
): Promise<AuthApi> => {
  const script = await consoleScript();
  const banner = new El();
  const store = new Map<string, string>(stored ? [["vfi_token", stored]] : []);
  const body =
    `"use strict";\nconst { document, window, sessionStorage } = ctx;\n` +
    `const $ = (s) => document.querySelector(s);\n` +
    AUTH_DECLS.map((n) => declarationOf(script, n)).join("\n") +
    `\nreturn { askForToken, AUTH_MAX_ATTEMPTS,` +
    ` peek: () => ({ TOKEN, AUTH_ATTEMPTS, AUTH_LOCKED, pending: AUTH_PROMPT !== null }) };`;
  const api = new Function("ctx", body)({
    document: { querySelector: (): El => banner },
    window: prompt ? { prompt } : {},
    sessionStorage: {
      getItem: (k: string): string | null => store.get(k) ?? null,
      setItem: (k: string, v: string): void => void store.set(k, v),
    },
  }) as Omit<AuthApi, "banner">;
  return { ...api, banner: (): string => banner.innerHTML };
};

test("fifteen concurrent 401s under one rejected token raise exactly one prompt", AUTH_TIMEOUT, async () => {
  // load() fires 15 requests in one Promise.all. The old latch was "a prompt is
  // open", cleared in the same callback that resolved it, so handlers queued
  // BEHIND the blocking modal woke to a cleared flag and opened another:
  // measured, 2–3 modals and 3–6 of 15 requests stranded. Keyed on the token
  // being replaced, this is timing-independent — which is why the test can
  // assert exactly one, not "usually one".
  let prompts = 0;
  const api = await authHarness(() => {
    prompts += 1;
    return "good-token";
  }, "stale-token");
  const results = await Promise.all(
    Array.from({ length: 15 }, () => api.askForToken("stale-token")),
  );
  assert.equal(prompts, 1, `15 concurrent 401s raised ${prompts} prompts`);
  assert.deepEqual(new Set(results), new Set(["good-token"]), "every waiter must get the new token");
  assert.equal(api.peek().TOKEN, "good-token");
  assert.equal(api.peek().pending, false, "the latch must be released");
});

test("a 401 that arrives after the token already moved on is never prompted", AUTH_TIMEOUT, async () => {
  // The stranding bug's other half: a request that 401'd under the old token but
  // woke after a successful prompt must be handed the live token to retry with,
  // not a second modal and not a thrown Unauthorized.
  let prompts = 0;
  const api = await authHarness(() => {
    prompts += 1;
    return "unused";
  }, "current-token");
  assert.equal(await api.askForToken("token-from-before"), "current-token");
  assert.equal(prompts, 0, "no prompt is needed when TOKEN has already been replaced");
});

test("a prompt() that throws resolves every waiter instead of hanging them forever", AUTH_TIMEOUT, async () => {
  // An embedded webview, or a pane with dialogs suppressed, THROWS on
  // window.prompt. Unguarded that skipped resolve() and left every api() call
  // awaiting forever behind a blank page. resolve() lives in a `finally`.
  const api = await authHarness(() => {
    throw new Error("dialogs are suppressed");
  }, "stale-token");
  const results = await Promise.all([
    api.askForToken("stale-token"),
    api.askForToken("stale-token"),
    api.askForToken("stale-token"),
  ]);
  assert.deepEqual(results, [null, null, null], "a throwing prompt must still settle every waiter");
  assert.equal(api.peek().pending, false, "the latch must not be left held by a throw");
  assert.match(api.peek().AUTH_LOCKED ?? "", /cannot show a token prompt/);
  assert.match(api.banner(), /Not authenticated/, "and it must be said where it cannot be missed");
});

test("a browser with no prompt() at all is locked out, not left waiting", AUTH_TIMEOUT, async () => {
  const api = await authHarness(undefined, "stale-token");
  assert.equal(await api.askForToken("stale-token"), null);
  assert.match(api.peek().AUTH_LOCKED ?? "", /cannot show a token prompt/);
});

test("AUTH_MAX_ATTEMPTS caps the prompts, and every token typed was actually tried", AUTH_TIMEOUT, async () => {
  // QA drove the uncapped version to 121 prompts and a >45 s frozen renderer.
  // The cap is checked BEFORE prompting, so the operator gets exactly
  // AUTH_MAX_ATTEMPTS asks and each token they typed was really sent.
  let prompts = 0;
  const api = await authHarness(() => {
    prompts += 1;
    return `wrong-${prompts}`;
  }, "stale-token");
  const results: (string | null)[] = [];
  for (let i = 0; i < api.AUTH_MAX_ATTEMPTS + 3; i++) {
    // Each round the previously entered token is the one now being rejected.
    results.push(await api.askForToken(api.peek().TOKEN));
  }
  assert.equal(prompts, api.AUTH_MAX_ATTEMPTS, `expected ${api.AUTH_MAX_ATTEMPTS} prompts, got ${prompts}`);
  assert.equal(api.peek().AUTH_ATTEMPTS, api.AUTH_MAX_ATTEMPTS);
  assert.deepEqual(results.slice(api.AUTH_MAX_ATTEMPTS), [null, null, null], "past the cap it must stop asking");
  assert.match(api.peek().AUTH_LOCKED ?? "", /tokens in a row were rejected/);
  assert.match(api.banner(), /nothing below will load/, "the lockout must be visible, not silent");
});

test("re-entering the same rejected token still spends an attempt and still caps", AUTH_TIMEOUT, async () => {
  // The retry test in api() is `got !== sent`, so an operator pasting the same
  // wrong token cannot spin: it counts against the cap like any other.
  let prompts = 0;
  const api = await authHarness(() => {
    prompts += 1;
    return "same-wrong-token";
  }, "same-wrong-token");
  for (let i = 0; i < api.AUTH_MAX_ATTEMPTS + 2; i++) await api.askForToken("same-wrong-token");
  assert.equal(prompts, api.AUTH_MAX_ATTEMPTS);
  assert.match(api.peek().AUTH_LOCKED ?? "", /tokens in a row were rejected/);
});

test("a dismissed or blank prompt is a decision, and stops the asking", AUTH_TIMEOUT, async () => {
  for (const [answer, why] of [[null, /dismissed/], ["   ", /empty token/]] as const) {
    let prompts = 0;
    const api = await authHarness(() => {
      prompts += 1;
      return answer;
    }, "stale-token");
    assert.equal(await api.askForToken("stale-token"), null);
    assert.equal(await api.askForToken("stale-token"), null, "a locked console must not ask again");
    assert.equal(prompts, 1);
    assert.match(api.peek().AUTH_LOCKED ?? "", why);
  }
});

test("the prompt is keyed on the rejected token, not on wall-clock timing", async () => {
  // STATUS: structural, and stated as such. The behavioural tests above pin the
  // OBSERVABLE consequence (exactly one prompt for 15 concurrent 401s, no
  // prompt once TOKEN has moved on), which is the property that matters. This
  // adds the one thing behaviour cannot show: that no timer-based latch has
  // been reintroduced alongside it, since a time-keyed latch can pass the
  // concurrency test on a fast machine and fail on a loaded one.
  const script = await consoleScript();
  const src = stripComments(declarationOf(script, "askForToken"));
  assert.match(src, /TOKEN !== rejected/, "the latch must compare the live token with the rejected one");
  assert.match(src, /AUTH_REJECTED = rejected/, "the in-flight prompt must record which token it replaces");
  assert.match(src, /finally\s*\{/, "resolve() must be in a finally so a throw cannot strand waiters");
  assert.match(src, /AUTH_ATTEMPTS >= AUTH_MAX_ATTEMPTS/, "the cap must be checked before prompting");
  // Date.now()/performance.now() inside the latch is the pattern that failed.
  assert.ok(!/Date\.now\(\)|performance\.now\(\)/.test(src), "askForToken must not key on wall-clock time");
});
