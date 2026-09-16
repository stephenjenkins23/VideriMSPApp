/**
 * The SCOPED export (US-8.4.2), asserted against the console's own source.
 *
 * Same technique as console-invariants.test.ts, and the properties here are the
 * ones that make an export safe to put in a ticket or a spreadsheet:
 *
 *   1. THE FILE IS THE LIST ON SCREEN. exportDeviceRows() is the third copy of
 *      the device predicate (both renderers hold the other two, and the comment
 *      in renderDeviceFilters() says why they are copies). So the pin here is
 *      behavioural: the export's row set must be IDENTICAL to the row set the
 *      table rendered, from the same state. That is the "count the thing you
 *      filter" invariant, which has broken three times in this file.
 *
 *   2. THE FILE STATES ITS OWN SCOPE. An export whose basis is unstated becomes
 *      a wrong number in someone's spreadsheet a week later. The filters, the
 *      site, the band, the search, the row count, the generation timestamp and
 *      the data's age must all be INSIDE the artefact, in both formats, from
 *      one object — so the CSV preamble and the JSON header cannot disagree.
 *
 *   3. IT REFUSES WHAT IT CANNOT CLAIM. No availability, uptime or SLA figure
 *      appears in any artefact, and the refusal carries the live collector
 *      coverage that causes it. A clean-looking availability number over the
 *      38-hour hole in our own collection is the one thing this must not ship.
 *
 *   4. TRUNCATION IS VISIBLE. A short collection makes every count in the file
 *      a lower bound, and the file says so — hitting a cap must never be
 *      indistinguishable from having it all (the apiAll bug).
 *
 *   5. HONEST NULLS. An unreadable value is an empty CSV cell and a JSON null,
 *      never 0 and never the string "null", and the preamble says which.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ─── lifting the console's own declarations ──────────────────────────────────

const consoleScript = async (): Promise<string> => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = await readFile(join(here, "..", "..", "public", "console.html"), "utf8");
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

class El {
  innerHTML = "";
  textContent = "";
  className = "";
  title = "";
  readonly children: El[] = [];
  readonly attrs: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly classList = { toggle: (): void => {}, contains: (): boolean => false,
                         add: (): void => {}, remove: (): void => {} };
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

/** Source order. The renderers are lifted alongside the export so one state
 *  can be rendered AND exported in the same tick and the two compared. */
const EXPORT_DECLS = [
  "esc", "ago", "dur", "statusOrder", "SEV", "COLLECTION_NOUN", "SORTS",
  "dormantIdSet", "NEVER_ABSORBED", "isDormantAlert", "alertBands",
  "CSV_EOL", "csvField", "toCsvText", "CSV_FORMULA_LEAD", "csvFormulaRisk",
  "EXPORT_DEVICE_COLUMNS", "EXPORT_ALERT_COLUMNS", "EXPORT_ADVISORY_COLUMNS",
  "exportDeviceRows", "exportRefusals", "exportSet",
  "exportCsvText", "exportJsonText", "exportSlug",
  "renderDeviceFilters", "renderDevices",
] as const;

type Scope = {
  dataset: string;
  title: string;
  tenant: string;
  generatedAt: string;
  scopeLabel: string;
  filters: [string, string][];
  rowCount: number;
  sourceCount: number;
  sourceNoun: string;
  rowsShownOnScreen: number | null;
  collectionShortfall: unknown;
  dataAsOf: string | null;
  dataAgeSeconds: number | null;
  caveats: string[];
  refusals: string[];
};
type ExportSet = {
  kind: string;
  dataset: string;
  scope: Scope;
  rows: { id: string }[];
  objects: Record<string, unknown>[];
  cells: unknown[][];
  columns: [string, unknown][];
};
type ExportApi = {
  exportSet: (kind: string, s?: unknown) => ExportSet;
  exportDeviceRows: (s: unknown) => { id: string }[];
  exportCsvText: (set: ExportSet) => string;
  exportJsonText: (set: ExportSet) => string;
  exportRefusals: (s: unknown) => string[];
  csvField: (v: unknown) => string;
  csvFormulaRisk: (rows: unknown[][]) => boolean;
  renderDeviceFilters: () => void;
  renderDevices: () => void;
};

type Device = Record<string, unknown> & { id: string };

const device = (id: string, over?: Record<string, unknown>): Device => ({
  id,
  name: `Canvas ${id}`,
  location: `Room ${id}`,
  deviceClass: "canvas",
  status: "online",
  lastOnlineTime: "2026-09-16T08:00:00.000Z",
  firmwareBehind: false,
  site: { id: "site-a", name: "Kungsgatan" },
  groupName: "Kungsgatan Left",
  openAlerts: { total: 0 },
  latest: { nowPlayingId: "ad-1", observedAt: "2026-09-16T08:00:00.000Z" },
  ...(over || {}),
});

const alert = (id: string, over?: Record<string, unknown>): Record<string, unknown> => ({
  id,
  deviceId: "d1",
  deviceName: "Canvas d1",
  severity: "critical",
  ruleId: "offline-4h",
  title: "offline for 4 hours",
  openedAt: "2026-09-15T08:00:00.000Z",
  lastFiredAt: "2026-09-16T08:00:00.000Z",
  ...(over || {}),
});

const baseState = (over?: Record<string, unknown>): Record<string, unknown> => ({
  view: "devices",
  devices: [],
  alerts: [],
  alertsSup: [],
  compliance: [],
  hyg: null,
  sup: null,
  remediation: null,
  q: "", cls: "all", dsite: "all", sort: { key: "name", dir: 1 }, dids: null,
  aband: "incidents", sev: "all", aq: "", arule: "all", aage: "all", asort: "sev",
  trunc: {},
  dsites: { available: true, groupsRead: 10 },
  // A live coverage figure, so the refusal sentence can quote it rather than a
  // remembered number.
  sla: { fleetCollectionCoverage: 0.774, windowHours: 24, bucketSeconds: 300 },
  fresh: { newestSampleAt: "2026-09-16T08:00:00.000Z", ageSeconds: 240, state: "lagging" },
  ...(over || {}),
});

const harness = async (state?: Record<string, unknown>): Promise<ExportApi & {
  S: Record<string, unknown>;
  el: (id: string) => El;
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
  const S = baseState(state);
  const body =
    `"use strict";\nconst { document, S, openDevice, switchTab, urlSync } = ctx;\n` +
    `const $ = (s) => document.querySelector(s);\n` +
    EXPORT_DECLS.map((n) => declarationOf(script, n)).join("\n") +
    `\nreturn { exportSet, exportDeviceRows, exportCsvText, exportJsonText, exportRefusals, ` +
    `csvField, csvFormulaRisk, renderDeviceFilters, renderDevices };`;
  const api = new Function("ctx", body)({
    document: { querySelector: (sel: string): El => el(sel), createElement: (): El => new El() },
    S,
    openDevice: (): void => {},
    switchTab: (): void => {},
    urlSync: (): void => {},
  }) as ExportApi;
  return { ...api, S, el };
};

/** The device ids the table actually rendered, in rendered order. */
const renderedIds = (html: string): string[] =>
  [...html.matchAll(/<tr class="r" data-id="([^"]+)"/g)].map((m) => m[1] as string);

const csvDataLines = (csv: string): string[] =>
  csv.split("\r\n").filter((l) => l !== "" && !l.startsWith("#"));

// ─────────────────────────────────────────────────────────────────────────────
// 0. The harness is really running the console's code
// ─────────────────────────────────────────────────────────────────────────────

test("the export harness lifts and runs the real console source", async () => {
  const script = await consoleScript();
  const src = declarationOf(script, "exportSet");
  assert.match(src, /^function exportSet\(kind, s\)/, "exportSet must still be a top-level function");
  assert.ok(src.includes("scopeLabel"), "the lifted exportSet must be the one that builds a scope");
  const h = await harness({ devices: [device("d1"), device("d2")] });
  const set = h.exportSet("devices");
  assert.equal(set.rows.length, 2);
  assert.ok(h.exportCsvText(set).length > 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. The file is the list on screen
// ─────────────────────────────────────────────────────────────────────────────

test("the device export holds exactly the rows the device table rendered", async () => {
  // THE pin for the third copy of the predicate. If the export and the table
  // ever disagree about what "on screen" means, this fails rather than an
  // operator's spreadsheet quietly containing a different fleet.
  const devices = [
    device("d1", { status: "offline", site: { id: "site-a", name: "Kungsgatan" } }),
    device("d2", { status: "offline", site: { id: "site-b", name: "Barcelona" } }),
    device("d3", { status: "online", site: { id: "site-a", name: "Kungsgatan" } }),
    device("d4", { status: "offline", site: null, name: "Kungsgatan spare" }),
    device("d5", { status: "warning", site: { id: "site-a", name: "Kungsgatan" } }),
  ];
  for (const state of [
    {},
    { cls: "offline" },
    { dsite: "site-a" },
    { dsite: "unplaced" },
    { q: "kungsgatan" },
    { cls: "offline", dsite: "site-a" },
    { q: "kungsgatan", cls: "offline" },
    { dids: { ids: new Set(["d2", "d5"]), label: "two devices from a finding" } },
    { sort: { key: "status", dir: -1 } },
  ]) {
    const h = await harness({ devices, ...state });
    h.renderDeviceFilters();
    h.renderDevices();
    const table = renderedIds(h.el("#dtable").innerHTML);
    const exported = h.exportSet("devices").rows.map((d) => d.id);
    assert.deepEqual(exported, table,
      `the export and the table disagree under ${JSON.stringify(state)} — ` +
      `the file must be the list on screen, in the same order`);
    assert.equal(
      h.el("#dcount").textContent.replace("+", ""), String(exported.length),
      `the header count and the exported row count must be the same number under ` +
      `${JSON.stringify(state)}`);
  }
});

test("the alert export holds exactly the rows the alert queue filtered", async () => {
  const h = await harness({
    view: "alerts",
    devices: [device("d1"), device("d2")],
    alerts: [
      alert("a1", { severity: "critical", deviceId: "d1" }),
      alert("a2", { severity: "medium", deviceId: "d2", ruleId: "showing-logo" }),
      alert("a3", { severity: "info", deviceId: "d2", ruleId: "showing-logo" }),
    ],
    sev: "medium",
  });
  const set = h.exportSet("alerts");
  assert.deepEqual(set.rows.map((a) => a.id), ["a2"],
    "the export must apply the severity chip exactly as the list does");
  assert.equal(set.scope.rowCount, 1);
  assert.equal(set.scope.sourceCount, 3, "and state the band it was drawn from");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The file states its own scope — in both formats, from one object
// ─────────────────────────────────────────────────────────────────────────────

test("the CSV states the filters, the site, the search, the count and the timestamp", async () => {
  const h = await harness({
    devices: [device("d1", { status: "offline" }), device("d2", { status: "online" })],
    cls: "offline", dsite: "site-a", q: "kungs",
  });
  const set = h.exportSet("devices");
  const csv = h.exportCsvText(set);
  assert.match(csv, /^# Videri Fleet Intelligence — Devices, as filtered on screen/);
  assert.match(csv, /# THIS FILE IS SCOPED\./);
  assert.match(csv, /# Filter — site: Kungsgatan \(id site-a\)/);
  assert.match(csv, /# Filter — status: offline/);
  assert.match(csv, /# Filter — search: "kungs"/);
  assert.match(csv, /# Filter — sort: name, ascending/);
  assert.match(csv, new RegExp(`# Rows in this file: ${set.rows.length}\\b`));
  assert.match(csv, /# Drawn from: 2 device\(s\) loaded by this console/);
  assert.match(csv, /# Generated at: \d{4}-\d{2}-\d{2}T[\d:.]+Z \(absolute, UTC\)/);
  assert.match(csv, /# Data as of: 2026-09-16T08:00:00\.000Z \(240 s \/ 4 min old at generation, lagging\)/);
  assert.match(csv, /# This file is a SNAPSHOT of that moment/);
  assert.match(csv, /# Tenant: VIDERISALES/);
  // The header row is on the first non-comment line, and the body follows it.
  const lines = csvDataLines(csv);
  assert.match(lines[0] as string, /^device_id,name,location,site,site_id,customer,/);
  assert.equal(lines.length - 1, set.rows.length, "one data line per exported row");
});

test("the JSON carries the same scope object and the same rows as the CSV", async () => {
  const h = await harness({
    devices: [device("d1", { status: "offline" }), device("d2")],
    cls: "offline",
  });
  const set = h.exportSet("devices");
  const doc = JSON.parse(h.exportJsonText(set)) as {
    scope: Scope; columns: string[]; rows: Record<string, unknown>[];
  };
  assert.deepEqual(doc.scope, JSON.parse(JSON.stringify(set.scope)),
    "the JSON scope block must be the same object the CSV preamble was written from");
  assert.equal(doc.rows.length, doc.scope.rowCount);
  assert.deepEqual(doc.columns, set.columns.map(([h2]) => h2));
  // Same columns in both formats: the CSV header line and the JSON keys.
  const header = (csvDataLines(h.exportCsvText(set))[0] as string).split(",");
  assert.deepEqual(header, doc.columns);
  assert.deepEqual(Object.keys(doc.rows[0] as Record<string, unknown>), doc.columns);
});

test("site and customer columns are present, and the file says they are one axis", async () => {
  const h = await harness({ devices: [device("d1")] });
  const set = h.exportSet("devices");
  const cols = set.columns.map(([c]) => c);
  for (const c of ["site", "site_id", "customer", "site_note"]) {
    assert.ok(cols.includes(c), `the device export must carry a "${c}" column`);
  }
  const csv = h.exportCsvText(set);
  assert.match(csv, /a site IS the customer unit here/,
    "the equivalence must be stated, not left for the reader to assume");
  assert.equal((set.objects[0] as Record<string, unknown>).customer, "Kungsgatan");
});

test("an alert export does not claim a site scope the alert queue never applied", async () => {
  // The device tab is filtered to a site; the alert queue has no site filter at
  // all. A file that looks scoped and is not is the whole failure mode here.
  const h = await harness({
    devices: [device("d1")], alerts: [alert("a1")], dsite: "site-a", cls: "offline",
  });
  const set = h.exportSet("alerts");
  const names = set.scope.filters.map(([k]) => k);
  assert.ok(!names.includes("site"), `an alert export must not list a site filter: ${names.join(", ")}`);
  assert.ok(!names.includes("status"), "nor the device status chip");
  assert.ok(set.scope.caveats.some((c) => /no site filter on screen/.test(c)),
    "and it must say so out loud");
  assert.match(h.exportCsvText(set), /NOT scoped to a site/);
});

test("the advisory export states that the Actions view has no filter", async () => {
  const h = await harness({
    view: "actions",
    devices: [device("d1")],
    remediation: {
      devicesConsidered: 248,
      recommendations: [
        { id: "r1", kind: "auto-safe", severity: "high", category: "display",
          symptom: "black screen", action: "set brightness", rationale: "because",
          confidence: 0.9, deviceIds: ["d1"], deviceLabel: "Canvas d1" },
      ],
    },
  });
  const set = h.exportSet("advisories");
  assert.equal(set.scope.rowCount, 1);
  assert.match(set.scope.scopeLabel, /every recommendation the engine returned/);
  assert.ok(set.scope.caveats.some((c) => /248 device\(s\) considered/.test(c)),
    "the ranking's denominator must travel with the file");
  assert.equal((set.objects[0] as Record<string, unknown>).one_click, true);
  assert.equal((set.objects[0] as Record<string, unknown>).site, "Kungsgatan");
});

test("an advisory export from a service that did not answer says so, and is not an empty estate", async () => {
  const h = await harness({ view: "actions", remediation: null });
  const set = h.exportSet("advisories");
  assert.equal(set.scope.rowCount, 0);
  assert.ok(set.scope.caveats.some((c) => /did not respond/.test(c) && /not because the estate/.test(c)),
    `"we could not ask" must not be exported as "nothing to do": ${set.scope.caveats.join(" | ")}`);
});

test("an export that matched nothing says the filters excluded everything", async () => {
  const h = await harness({ devices: [device("d1")], cls: "offline" });
  const set = h.exportSet("devices");
  assert.equal(set.rows.length, 0);
  assert.ok(set.scope.caveats.some((c) => /No row matched this scope/.test(c)));
  // The header row still ships, so an empty file is readable rather than blank.
  assert.equal(csvDataLines(h.exportCsvText(set)).length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. It refuses what it cannot claim
// ─────────────────────────────────────────────────────────────────────────────

test("no artefact states an availability, uptime or SLA figure", async () => {
  const h = await harness({ devices: [device("d1")], alerts: [alert("a1")] });
  for (const kind of ["devices", "alerts", "advisories"]) {
    const set = h.exportSet(kind);
    for (const [col] of set.columns) {
      assert.ok(!/uptime|availab|sla/i.test(col),
        `${kind} export carries a "${col}" column — no availability figure may be exported ` +
        `while our own collector's coverage is what it is`);
    }
    const csv = h.exportCsvText(set);
    assert.match(csv, /NO AVAILABILITY, UPTIME OR SLA FIGURE IS STATED IN THIS FILE/);
    assert.match(csv, /77\.4% of the measured window/,
      "the refusal must quote the LIVE coverage figure that causes it");
    assert.match(csv, /SCHEDULED, NOT CONFIRMED/);
  }
});

test("a coverage of exactly zero is stated as NO observation, not as 0.0%", async () => {
  // Found in the browser against the local database, whose newest sample is
  // twelve days old: the refusal printed "0.0% of the measured window", which
  // reads as a measurement of the estate. It is the absence of one.
  const h = await harness({
    devices: [device("d1")],
    sla: { fleetCollectionCoverage: 0, windowHours: 24, bucketSeconds: 300 },
  });
  const first = h.exportRefusals(h.S)[0] as string;
  assert.match(first, /observed NONE of the measured window/);
  assert.ok(!first.includes("0.0%"), `a zero must not be dressed as a percentage: ${first}`);
  assert.match(h.exportCsvText(h.exportSet("devices")), /observed NONE of the measured window/);
});

test("with no coverage payload the refusal gets stronger, not weaker", async () => {
  // A missing denominator is a bigger reason to refuse than a bad one.
  const h = await harness({ devices: [device("d1")], sla: null });
  const refusals = h.exportRefusals(h.S);
  assert.match(refusals[0] as string, /NO AVAILABILITY, UPTIME OR SLA FIGURE/);
  assert.match(refusals[0] as string, /did not answer/);
  assert.match(refusals[0] as string, /denominator is unknown/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Truncation is visible
// ─────────────────────────────────────────────────────────────────────────────

test("a short collection makes every exported count a stated lower bound", async () => {
  const h = await harness({
    devices: [device("d1"), device("d2")],
    trunc: { devices: { loaded: 2, total: 248, capped: true, cap: 2000,
                        pagesFetched: 1, pagesAvailable: 2 } },
  });
  const set = h.exportSet("devices");
  const said = set.scope.caveats.join(" | ");
  assert.match(said, /holds 2 of 248 devices/);
  assert.match(said, /246 /);
  assert.match(said, /LOWER BOUND/);
  assert.match(said, /2000-row paging cap was hit/);
  assert.ok(set.scope.collectionShortfall, "the shortfall itself travels with the file");
  assert.match(h.exportCsvText(set), /# NOTE: This console holds 2 of 248 devices/);
});

test("a complete collection claims no shortfall", async () => {
  const h = await harness({ devices: [device("d1")] });
  const set = h.exportSet("devices");
  assert.equal(set.scope.collectionShortfall, null);
  assert.ok(!set.scope.caveats.some((c) => /LOWER BOUND/.test(c)),
    "a complete walk must not carry a truncation warning — a false alarm gets ignored");
});

test("the file says when it holds more rows than the screen drew", async () => {
  // The table caps at 200; the file does not. Stated, so nobody reconciles 200
  // against 250 and assumes the export was cut too.
  const devices = Array.from({ length: 250 }, (_, i) => device(`d${i}`));
  const h = await harness({ devices });
  const set = h.exportSet("devices");
  assert.equal(set.rows.length, 250);
  assert.ok(set.scope.caveats.some((c) => /first 200 matches; this file contains all 250/.test(c)),
    `the on-screen cap must be stated: ${set.scope.caveats.join(" | ")}`);
  assert.equal(set.scope.rowsShownOnScreen, 200);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Honest nulls, and an RFC 4180 file a spreadsheet will not mangle
// ─────────────────────────────────────────────────────────────────────────────

test("an unreadable value is an empty cell and a JSON null, never a zero", async () => {
  const h = await harness({
    devices: [device("d1", {
      site: { id: null, name: null, reason: "no site reported by the platform" },
      location: null, latest: null, firmwareBehind: null, openAlerts: null,
    })],
  });
  const set = h.exportSet("devices");
  const row = set.objects[0] as Record<string, unknown>;
  for (const col of ["site", "site_id", "customer", "location", "screen_state",
                     "now_playing_id", "open_alerts_total", "firmware_behind"]) {
    assert.equal(row[col], null, `${col} must be null when it could not be read, never 0`);
  }
  assert.equal(row.site_note, "no site reported by the platform",
    "and the reason the site is empty travels in its own column");
  const line = csvDataLines(h.exportCsvText(set))[1] as string;
  assert.ok(!/(^|,)0(,|$)/.test(line), `no unreadable value may render as 0: ${line}`);
  assert.ok(!line.includes("null"), `no cell may render the string "null": ${line}`);
  assert.match(h.exportCsvText(set), /An empty cell or a JSON null means the value could not be read/);
});

test("a site axis that could not be READ is distinguished from a device with no site", async () => {
  const h = await harness({
    devices: [device("d1", { site: null })],
    dsites: { available: false, reason: "the group hierarchy could not be read" },
  });
  const row = h.exportSet("devices").objects[0] as Record<string, unknown>;
  assert.equal(row.site, null);
  assert.equal(row.site_note, "the group hierarchy could not be read",
    "\"we could not read the hierarchy\" and \"this canvas is in no group\" are different facts");
});

test("csvField quotes what must be quoted and preserves what a reader would eat", async () => {
  const h = await harness();
  assert.equal(h.csvField(null), "");
  assert.equal(h.csvField(undefined), "");
  assert.equal(h.csvField(0), "0", "a REAL zero is still a zero");
  assert.equal(h.csvField("plain"), "plain");
  assert.equal(h.csvField("a,b"), '"a,b"');
  assert.equal(h.csvField('say "hi"'), '"say ""hi"""');
  assert.equal(h.csvField("Mana Right "), '"Mana Right "',
    "a trailing space is part of the name on the platform and must survive the file");
  assert.equal(h.csvField("line\nbreak"), '"line\nbreak"');
  assert.equal(h.csvField(true), "true");
  assert.equal(h.csvField(Number.NaN), "", "a non-finite number is not a number");
});

test("a formula-looking value is disclosed and left unmodified", async () => {
  // Mutating a device name to make a spreadsheet behave is the quiet
  // falsification this codebase refuses, so the risk is stated instead.
  const h = await harness({ devices: [device("d1", { name: "=cmd|calc" })] });
  const set = h.exportSet("devices");
  const csv = h.exportCsvText(set);
  assert.match(csv, /# WARNING: at least one value begins with =/);
  assert.ok(csv.includes("=cmd|calc"), "the value itself must be untouched");
  assert.ok(h.csvFormulaRisk(set.cells));
});

test("the artefact is CRLF, header-first after the preamble", async () => {
  const h = await harness({ devices: [device("d1")] });
  const csv = h.exportCsvText(h.exportSet("devices"));
  assert.ok(csv.includes("\r\n"), "Excel is the reader and it wants CRLF");
  assert.ok(csv.endsWith("\r\n"));
  assert.ok(!/[^\r]\n/.test(csv), "no bare LF may survive in an RFC 4180 file");
});

test("a preamble value cannot inject a data row", async () => {
  // A device name is interpolated into the "# Filter — search" line; a newline
  // in it would otherwise appear as a row of its own.
  const h = await harness({ devices: [device("d1")], q: "kungs\r\nd1,evil" });
  const csv = h.exportCsvText(h.exportSet("devices"));
  const preamble = csv.split("\r\n").filter((l) => l.startsWith("#"));
  assert.ok(csv.split("\r\n").every((l) => l.startsWith("#") || !l.includes("evil")
    || l.startsWith("device_id")), "an injected line must stay inside the preamble");
  assert.ok(preamble.some((l) => l.includes("evil")),
    "and the value is still shown in full, collapsed onto its own comment line");
});
