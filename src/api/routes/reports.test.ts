/**
 * Estate report tests — `node --test dist/api/routes/reports.test.js`
 *
 * This is the one artefact in the product that leaves the building, so the
 * properties guarded here are the ones where a wrong answer still LOOKS like a
 * report:
 *
 *   - a scope that silently drops screens under-counts a customer's estate, and
 *     the 16 site-less screens are exactly the ones a group-id predicate cannot
 *     select. Hence `inScope` is asserted for all three scopes;
 *   - a closed window double-counts a fault when two adjacent reports are run
 *     back to back, and both would look right in isolation;
 *   - a bare number implies coverage we do not have, so EVERY figure is walked
 *     and asserted to carry a basis and a denominator;
 *   - a CSV that eats a trailing space or breaks on an embedded newline hands the
 *     customer a name that is not the name on the platform, or a table with a
 *     fabricated row;
 *   - an empty table that says nothing reads as a data error, not a quiet estate;
 *   - and promoting a readable-but-not-SLA-grade dimension into a claimed number
 *     is a bug this product has already shipped once.
 *
 * All pure: fixtures in, report out. No database, no network, no wall clock
 * beyond the `generatedAt` we pass in.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { DeviceListItem } from "../queries.js";
import type { DeviceActionRow } from "../../db/repository.js";
import type { ClassifiedDimension, MeasurabilityAssessment } from "../../sla/measurability.js";
import {
  CSV_SECTIONS,
  alertWindowRole,
  bucketsInWindow,
  buildEstateReport,
  buildWindow,
  csvField,
  filenameSlug,
  hasFormulaRisk,
  inScope,
  renderCsv,
  toCsv,
  toReportAlert,
  type EstateReport,
  type EstateReportInputs,
  type ReportAlertInput,
  type ReportScope,
} from "./reports.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const SITE_A = "site-aaa";
const SITE_B = "site-bbb";

const device = (over: Partial<DeviceListItem> & { id: string }): DeviceListItem => ({
  name: `Screen ${over.id}`,
  location: null,
  city: null,
  groupId: "group-1",
  groupName: "Group 1",
  accountName: null,
  tags: [],
  site: over.site ?? { id: SITE_A, name: "Videri Sales", resolved: true, reason: null },
  deviceClass: "display",
  modelType: "TM55N",
  status: "online",
  lastOnlineTime: "2026-09-01T00:00:00.000Z",
  firmwareCurrent: "1.0.0",
  firmwareLatest: "1.0.0",
  firmwareBehind: false,
  openAlerts: { critical: 0, high: 0, medium: 0, info: 0, total: 0 },
  latest: {
    observedAt: "2026-09-01T00:00:00.000Z",
    presence: "online",
    isScreenOn: true,
    isBlackScreen: false,
    showingLogo: false,
    cpuPercent: null,
    ramPercent: null,
    temperatureC: null,
    wifiSignalDbm: null,
    storagePercent: null,
    ntpOffsetMs: null,
    hardwareObservedAt: null,
  },
  ...over,
});

const UNPLACED_SITE = {
  id: null,
  name: null,
  resolved: false,
  reason: "This device is in no group, so it cannot be placed at a site.",
} as const;

const scopeFor = (kind: ReportScope["kind"], siteId: string | null = null): ReportScope => ({
  kind,
  siteId,
  siteName: kind === "site" ? "Videri Sales" : null,
  label: kind === "site" ? "Videri Sales" : kind === "unplaced" ? "Unplaced screens" : "Whole estate",
  statement: "test scope",
  hierarchy: {
    available: true,
    ageSeconds: 0,
    groupsRead: 94,
    groupsTotal: 94,
    truncated: false,
    reason: null,
    groupsMatched: kind === "site" ? 3 : null,
  },
});

const dimension = (
  id: string,
  grade: ClassifiedDimension["grade"],
): ClassifiedDimension => ({
  id,
  dimension: id,
  grade,
  reason: `${id} is ${grade}`,
  slaImpact: `${id} impact`,
  coverage: { readableDevices: 42, fleetSize: 100, share: 0.42 },
  cadenceSeconds: 23_000,
  shortfalls: grade === "sla-grade" ? [] : ["coverage below the bar"],
  permanent: false,
  persisted: true,
  basis: "test",
});

const measurability = (dims: ClassifiedDimension[]): MeasurabilityAssessment => ({
  fleetSize: 100,
  dimensions: dims,
  slaGrade: dims.filter((d) => d.grade === "sla-grade"),
  readable: dims.filter((d) => d.grade === "readable"),
  unmeasurable: dims.filter((d) => d.grade === "unmeasurable"),
  bars: { minCoverageShare: 0.95, maxCadenceSeconds: 900 },
  fromLiveCapability: true,
  summary: "test assessment",
});

const WINDOW_FROM = "2026-08-28T00:00:00.000Z";
const WINDOW_TO = "2026-09-04T00:00:00.000Z";

const inputs = (over: Partial<EstateReportInputs> = {}): EstateReportInputs => ({
  generatedAt: "2026-09-04T12:00:00.000Z",
  scope: scopeFor("site", SITE_A),
  window: buildWindow(WINDOW_FROM, WINDOW_TO, 300),
  devices: [device({ id: "1" })],
  devicesTruncated: false,
  fleetScreens: 248,
  presence: [{ deviceId: "1", observedBuckets: 2016, onlineBuckets: 2000 }],
  collectorObservedBuckets: 2016,
  alerts: [],
  alertsTruncated: false,
  actions: [],
  actionsTruncated: false,
  actionsLogSize: 0,
  configSnapshotDeviceIds: new Set(["1"]),
  schedule: {
    snapshotDeviceIds: new Set(["1"]),
    scheduledDeviceIds: new Set(["1"]),
    oldestSnapshotAt: "2026-09-04T06:00:00.000Z",
  },
  measurability: measurability([
    dimension("presence", "sla-grade"),
    dimension("storage", "readable"),
    dimension("temperature", "unmeasurable"),
  ]),
  ...over,
});

const alert = (over: Partial<ReportAlertInput> & { id: string; openedAt: string }): ReportAlertInput => ({
  deviceId: "1",
  deviceName: "Screen 1",
  ruleId: "device-offline",
  severity: "high",
  title: "Screen offline",
  lastFiredAt: over.openedAt,
  acknowledgedAt: null,
  resolvedAt: null,
  ...over,
});

const action = (over: Partial<DeviceActionRow> & { id: number }): DeviceActionRow => ({
  action: "brightness_write",
  verb: "set_brightness",
  deviceId: "1",
  deviceName: "Screen 1",
  requestedValue: "70%",
  observedValue: "70%",
  params: {},
  detail: {},
  outcome: "verified",
  actor: "api:stephen",
  actorIp: null,
  startedAt: new Date("2026-08-30T10:00:00.000Z"),
  finishedAt: new Date("2026-08-30T10:00:03.000Z"),
  durationMs: 3000,
  error: null,
  ...over,
});

// ── 1. per-site scoping, including the unplaced cohort ───────────────────────

test("a site scope selects only that site's screens", () => {
  const devices = [
    device({ id: "1" }),
    device({ id: "2", site: { id: SITE_B, name: "NYC Office", resolved: true, reason: null } }),
    device({ id: "3", site: { ...UNPLACED_SITE } }),
  ];
  const selected = devices.filter((d) => inScope(d, { kind: "site", siteId: SITE_A }));
  assert.deepEqual(selected.map((d) => d.id), ["1"]);
});

test("the unplaced cohort is a scope, and the ONLY scope that holds site-less screens", () => {
  const devices = [
    device({ id: "1" }),
    device({ id: "2", site: { ...UNPLACED_SITE } }),
    device({
      id: "3",
      site: {
        id: null, name: null, resolved: false,
        reason: "This device's group is at the top of the hierarchy, so there is no site below it.",
      },
    }),
  ];
  assert.deepEqual(
    devices.filter((d) => inScope(d, { kind: "unplaced", siteId: null })).map((d) => d.id),
    ["2", "3"],
    "every unresolved reason lands in the unplaced cohort, not just the no-group one",
  );
  // The load-bearing property: no site scope can ever capture them, so if the
  // unplaced scope did not exist they would be uncountable.
  for (const siteId of [SITE_A, SITE_B]) {
    assert.equal(
      devices.filter((d) => inScope(d, { kind: "site", siteId })).some((d) => !d.site.resolved),
      false,
    );
  }
});

test("a fleet scope is the exact union of every site scope and the unplaced cohort", () => {
  const devices = [
    device({ id: "1" }),
    device({ id: "2", site: { id: SITE_B, name: "NYC Office", resolved: true, reason: null } }),
    device({ id: "3", site: { ...UNPLACED_SITE } }),
  ];
  const union = new Set([
    ...devices.filter((d) => inScope(d, { kind: "site", siteId: SITE_A })).map((d) => d.id),
    ...devices.filter((d) => inScope(d, { kind: "site", siteId: SITE_B })).map((d) => d.id),
    ...devices.filter((d) => inScope(d, { kind: "unplaced", siteId: null })).map((d) => d.id),
  ]);
  const fleet = devices.filter((d) => inScope(d, { kind: "fleet", siteId: null })).map((d) => d.id);
  assert.equal(union.size, fleet.length, "no screen is double-counted or dropped");
  assert.deepEqual([...union].sort(), [...fleet].sort());
});

test("an unplaced report never invents a site and says why each screen is unplaced", () => {
  const report = buildEstateReport(
    inputs({
      scope: scopeFor("unplaced"),
      devices: [device({ id: "9", site: { ...UNPLACED_SITE } })],
      presence: [{ deviceId: "9", observedBuckets: 2016, onlineBuckets: 2016 }],
      configSnapshotDeviceIds: new Set(["9"]),
      schedule: { snapshotDeviceIds: new Set(["9"]), scheduledDeviceIds: new Set(), oldestSnapshotAt: null },
    }),
  );
  assert.equal(report.estate.screens.value, 1);
  assert.equal(report.estate.unplacedScreensInScope.value, 1);
  const row = report.estate.inventory[0]!;
  assert.equal(row.siteName, null, "no fabricated site name");
  assert.equal(row.siteResolved, false);
  assert.match(row.siteNote!, /no group/, "the row carries the reason it is unplaced");
});

test("a site scope reports zero unplaced screens by construction, and says so", () => {
  const report = buildEstateReport(inputs());
  assert.equal(report.estate.unplacedScreensInScope.value, 0);
  assert.match(report.estate.unplacedScreensInScope.basis, /by construction/);
  assert.match(report.estate.unplacedScreensInScope.basis, /scope=unplaced/);
});

// ── 2. window boundaries: half-open, no double counting ──────────────────────

test("the window is half-open on openedAt: the boundary instant belongs to the later window", () => {
  const first = buildWindow("2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z", 300);
  const second = buildWindow("2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", 300);
  const boundary = alert({ id: "a", openedAt: "2026-09-01T00:00:00.000Z" });
  // Opened AT the earlier window's exclusive upper bound: it is not in that
  // window at all, and it is new in the next one. That is the whole point of
  // the half-open bound.
  assert.equal(alertWindowRole(boundary, first), "outside");
  assert.equal(alertWindowRole(boundary, second), "opened-in-window");
  // And an alert that predates a window and is still open IS carried in.
  assert.equal(
    alertWindowRole(alert({ id: "b", openedAt: "2026-07-01T00:00:00.000Z" }), first),
    "carried-in",
  );
});

test("two adjacent reports never double-count a fault", () => {
  const august = buildWindow("2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z", 300);
  const september = buildWindow("2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", 300);
  const alerts = [
    alert({ id: "before", openedAt: "2026-07-15T00:00:00.000Z", resolvedAt: "2026-07-16T00:00:00.000Z" }),
    alert({ id: "in-august", openedAt: "2026-08-15T00:00:00.000Z" }),
    alert({ id: "boundary", openedAt: "2026-09-01T00:00:00.000Z" }),
    alert({ id: "in-september", openedAt: "2026-09-20T00:00:00.000Z" }),
  ];
  const run = (w: ReturnType<typeof buildWindow>) =>
    buildEstateReport(inputs({ window: w, alerts })).faults.openedInWindow.value;
  assert.equal(run(august), 1);
  assert.equal(run(september), 2);
  assert.equal(run(august) + run(september), 3, "each of the three in-range faults counted once");
});

test("a carried-in alert is listed as outstanding but never counted as a new fault", () => {
  const window = buildWindow("2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", 300);
  const report = buildEstateReport(
    inputs({ window, alerts: [alert({ id: "old", openedAt: "2026-05-01T00:00:00.000Z" })] }),
  );
  assert.equal(report.faults.openedInWindow.value, 0);
  assert.equal(report.faults.stillOpen.value, 1);
  assert.equal(report.faults.alerts[0]!.role, "carried-in");
  assert.match(report.faults.statement, /carried in/);
});

test("resolvedInWindow is half-open too, and an alert resolved in-window but opened earlier is not 'new'", () => {
  const window = buildWindow("2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", 300);
  const report = buildEstateReport(
    inputs({
      window,
      alerts: [
        alert({ id: "x", openedAt: "2026-08-20T00:00:00.000Z", resolvedAt: "2026-09-05T00:00:00.000Z" }),
        alert({ id: "edge", openedAt: "2026-08-20T00:00:00.000Z", resolvedAt: "2026-10-01T00:00:00.000Z" }),
      ],
    }),
  );
  assert.equal(report.faults.openedInWindow.value, 0);
  assert.equal(report.faults.resolvedInWindow.value, 1, "the 10-01 resolution belongs to the next window");
});

test("actions are scoped and the window statement names both bounds", () => {
  const report = buildEstateReport(
    inputs({
      devices: [device({ id: "1" })],
      actions: [action({ id: 1 }), action({ id: 2, deviceId: "other-site-device" })],
    }),
  );
  assert.equal(report.changes.total.value, 1, "an action on another site's screen is not ours to report");
  assert.match(report.window.statement, /NOT including/);
  assert.match(report.window.statement, /half-open/);
});

test("bucket counting aligns to the bucket grid, so coverage can never exceed the window", () => {
  assert.equal(bucketsInWindow("2026-09-01T00:00:00.000Z", "2026-09-01T01:00:00.000Z", 300), 12);
  // An unaligned start still counts the bucket it lands inside.
  assert.equal(bucketsInWindow("2026-09-01T00:02:00.000Z", "2026-09-01T01:00:00.000Z", 300), 12);
  assert.equal(bucketsInWindow("2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z", 300), 1);
});

// ── 3. every figure carries what it was computed from ────────────────────────

interface FoundFigure { path: string; value: unknown; basis: unknown; coverage: Record<string, unknown> }

/** Walk the report and collect anything shaped like a Figure. */
function findFigures(node: unknown, path = "$"): FoundFigure[] {
  if (Array.isArray(node)) return node.flatMap((v, i) => findFigures(v, `${path}[${i}]`));
  if (node === null || typeof node !== "object") return [];
  const record = node as Record<string, unknown>;
  const isFigure = "value" in record && "basis" in record && "coverage" in record;
  const here = isFigure
    ? [{ path, value: record["value"], basis: record["basis"], coverage: record["coverage"] as Record<string, unknown> }]
    : [];
  return [...here, ...Object.entries(record).flatMap(([k, v]) => findFigures(v, `${path}.${k}`))];
}

test("every figure in the report states its basis and its denominator", () => {
  const report = buildEstateReport(inputs());
  const figures = findFigures(report);
  assert.ok(figures.length >= 20, `expected the report to be figure-heavy, found ${figures.length}`);
  const units = new Set(["screens", "time-buckets", "alerts", "actions", "dimensions"]);
  for (const f of figures) {
    assert.equal(typeof f.basis, "string", `${f.path}: basis must be a sentence`);
    assert.ok((f.basis as string).length > 30, `${f.path}: basis is too short to be honest`);
    assert.ok(f.coverage, `${f.path}: no coverage block`);
    assert.equal(typeof f.coverage["note"], "string");
    assert.ok((f.coverage["note"] as string).length > 10, `${f.path}: coverage note is not a sentence`);
    assert.ok(units.has(f.coverage["unit"] as string), `${f.path}: unit ${String(f.coverage["unit"])}`);
    const measured = f.coverage["measured"] as number;
    const inScopeCount = f.coverage["inScope"] as number;
    assert.equal(typeof measured, "number");
    assert.equal(typeof inScopeCount, "number");
    const expectedShare = inScopeCount === 0 ? null : Number((measured / inScopeCount).toFixed(4));
    assert.equal(f.coverage["share"], expectedShare, `${f.path}: share disagrees with its own counts`);
  }
});

test("a partially measured figure names the screens it could NOT measure", () => {
  const report = buildEstateReport(
    inputs({
      devices: [device({ id: "1" }), device({ id: "2" }), device({ id: "3" })],
      // Only screen 1 was ever observed.
      presence: [{ deviceId: "1", observedBuckets: 2016, onlineBuckets: 2016 }],
      configSnapshotDeviceIds: new Set(["1"]),
      schedule: { snapshotDeviceIds: new Set(["1"]), scheduledDeviceIds: new Set(["1"]), oldestSnapshotAt: null },
    }),
  );
  assert.equal(report.availability.screensObserved.value, 1);
  assert.equal(report.availability.screensNeverObserved.value, 2);
  assert.match(report.availability.screensNeverObserved.basis, /not zero/);
  assert.equal(report.availability.screensReachable.coverage.measured, 1);
  assert.equal(report.availability.screensReachable.coverage.inScope, 3);
  assert.match(report.configuration.screensWithSnapshot.basis, /UNASSESSED/);
  assert.ok(
    report.limitations.some((l) => /2 of 3 screen\(s\) produced no presence reading/.test(l)),
    "the unobserved screens are named in the limitations, not just omitted",
  );
});

test("an unobservable screen gets a null uptime, never a zero", () => {
  const report = buildEstateReport(inputs({ presence: [] }));
  assert.equal(report.availability.screens[0]!.observedUptime, null);
  assert.equal(report.availability.observedUptimeClaimable.value, null);
  assert.match(report.availability.statement, /no uptime can be asserted/);
  assert.equal(report.estate.inventory[0]!.observedUptime, null);
});

test("collector coverage is reported tenant-wide and separately from uptime", () => {
  const report = buildEstateReport(inputs({ collectorObservedBuckets: 1008 }));
  assert.equal(report.availability.collectorCoverage.coverage.unit, "time-buckets");
  assert.equal(report.availability.collectorCoverage.value, 0.5);
  assert.match(report.availability.collectorCoverage.basis, /not a customer outage/);
  assert.ok(report.limitations.some((l) => /50\.0% of this window's time buckets/.test(l)));
});

// ── 4. CSV escaping ─────────────────────────────────────────────────────────

test("csvField quotes what has to be quoted and nothing else", () => {
  assert.equal(csvField("Lobby"), "Lobby");
  assert.equal(csvField("Lobby, Main"), '"Lobby, Main"');
  assert.equal(csvField('He said "hi"'), '"He said ""hi"""');
  assert.equal(csvField("Line1\nLine2"), '"Line1\nLine2"');
  assert.equal(csvField("Line1\r\nLine2"), '"Line1\r\nLine2"');
  assert.equal(csvField("[Bracketed Name]"), "[Bracketed Name]", "brackets need no quoting");
});

test("a trailing space survives the round trip — this fleet has names that end in one", () => {
  assert.equal(csvField("Center Spark 5 "), '"Center Spark 5 "');
  assert.equal(csvField(" leading"), '" leading"');
});

test("an unreadable value is an EMPTY cell, never a zero and never the word null", () => {
  assert.equal(csvField(null), "");
  assert.equal(csvField(undefined), "");
  assert.equal(csvField(0), "0", "a real zero still prints as zero");
  assert.equal(csvField(false), "false");
  assert.equal(csvField(Number.NaN), "");
});

/** Minimal RFC 4180 reader, so the escaping is verified by parsing it back. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i += 1; continue; }
      field += ch; i += 1; continue;
    }
    if (ch === '"' && field === "") { quoted = true; i += 1; continue; }
    if (ch === ",") { row.push(field); field = ""; i += 1; continue; }
    if (ch === "\r" && text[i + 1] === "\n") {
      row.push(field); rows.push(row); row = []; field = ""; i += 2; continue;
    }
    field += ch; i += 1;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

test("a device name containing a comma, a quote and a newline cannot forge a row", () => {
  const nasty = 'Lobby, "Main"\nDownstairs ';
  const report = buildEstateReport(
    inputs({ devices: [device({ id: "1", name: nasty }), device({ id: "2" })] }),
  );
  const csv = renderCsv(report, "devices", { preamble: false });
  const rows = parseCsv(csv);
  assert.equal(rows.length, 3, "one header plus exactly two data rows");
  assert.equal(rows[1]![1], nasty, "the name round-trips byte for byte, trailing space included");
  assert.equal(rows[0]!.length, rows[1]!.length, "the nasty row has the same arity as the header");
});

test("toCsv uses CRLF and emits a header even with no rows", () => {
  const text = toCsv(["a", "b"], []);
  assert.equal(text, "a,b\r\n");
  assert.equal(toCsv(["a"], [["x"], ["y"]]), "a\r\nx\r\ny\r\n");
});

test("a formula-leading value is reported, not rewritten", () => {
  assert.equal(hasFormulaRisk([["=1+1"]]), true);
  assert.equal(hasFormulaRisk([["-Lobby"]]), true);
  assert.equal(hasFormulaRisk([["Lobby"], [null]]), false);
  const report = buildEstateReport(inputs({ devices: [device({ id: "1", name: "=SUM(A1:A9)" })] }));
  const csv = renderCsv(report, "devices");
  assert.match(csv, /# WARNING: at least one value begins with/);
  assert.ok(csv.includes("=SUM(A1:A9)"), "the value itself is untouched");
});

test("the CSV preamble makes the file self-describing, and can be switched off", () => {
  const report = buildEstateReport(inputs());
  const withPreamble = renderCsv(report, "devices");
  assert.match(withPreamble, /# Videri Fleet Intelligence — estate report, "devices" table/);
  assert.match(withPreamble, /# Scope: Videri Sales \(site site-aaa\)/);
  assert.match(withPreamble, /# Screens in scope: 1/);
  assert.match(withPreamble, new RegExp(`# Window: ${WINDOW_FROM} up to \\(not including\\) ${WINDOW_TO}`));
  assert.match(withPreamble, /# Generated at: 2026-09-04T12:00:00.000Z/);
  assert.match(withPreamble, /# An empty cell means the value could not be read/);
  assert.match(withPreamble, /# Playback is scheduled, not confirmed/);
  const bare = renderCsv(report, "devices", { preamble: false });
  assert.equal(bare.startsWith("device_id,"), true, "machine mode puts the header on line 1");
});

test("every CSV section renders, and its header arity matches every row", () => {
  const report = buildEstateReport(
    inputs({
      alerts: [alert({ id: "a1", openedAt: "2026-08-30T00:00:00.000Z" })],
      actions: [action({ id: 1 })],
    }),
  );
  for (const section of CSV_SECTIONS) {
    const rows = parseCsv(renderCsv(report, section, { preamble: false }));
    assert.ok(rows.length >= 2, `${section}: expected at least a header and a row`);
    for (const row of rows) assert.equal(row.length, rows[0]!.length, `${section}: ragged row`);
  }
});

test("filenameSlug never produces a path or an empty name", () => {
  assert.equal(filenameSlug("Sara's Office"), "sara-s-office");
  assert.equal(filenameSlug("../../etc/passwd"), "etc-passwd");
  assert.equal(filenameSlug("!!!"), "scope");
});

// ── 5. honest empties ───────────────────────────────────────────────────────

test("a quiet site says 'no alerts in this window' and does not render an empty table", () => {
  const report = buildEstateReport(inputs({ alerts: [] }));
  assert.deepEqual(report.faults.alerts, []);
  assert.match(report.faults.emptyStatement!, /No alerts in this window/);
  assert.match(report.faults.emptyStatement!, /because the estate was quiet, not/);
  const csv = renderCsv(report, "alerts");
  assert.match(csv, /# NOTE: No alerts in this window/);
  assert.match(csv, /^# /, "the note is a comment, not a fake data row");
});

test("'no alerts' on an unobserved estate says which empty it is", () => {
  const report = buildEstateReport(inputs({ presence: [] }));
  assert.match(report.faults.emptyStatement!, /we also hold no readings/);
  assert.match(report.faults.emptyStatement!, /nothing was detected/);
});

test("'we changed nothing' distinguishes an empty log from a quiet estate", () => {
  const never = buildEstateReport(inputs({ actions: [], actionsLogSize: 0 }));
  assert.match(never.changes.emptyStatement!, /never written to a device under this build/);
  const quiet = buildEstateReport(inputs({ actions: [], actionsLogSize: 41 }));
  assert.match(quiet.changes.emptyStatement!, /Other estates were touched in this period/);
  assert.equal(quiet.changes.statement, "VFI made no changes to this estate in this window.");
});

test("a non-empty section carries no empty statement", () => {
  const report = buildEstateReport(
    inputs({
      alerts: [alert({ id: "a1", openedAt: "2026-08-30T00:00:00.000Z" })],
      actions: [action({ id: 1 })],
    }),
  );
  assert.equal(report.faults.emptyStatement, null);
  assert.equal(report.changes.emptyStatement, null);
  assert.equal(report.changes.total.value, 1);
  assert.deepEqual(report.changes.byOutcome.value, { verified: 1 });
});

test("an empty scope reports zero screens without claiming anything about them", () => {
  const report = buildEstateReport(
    inputs({
      devices: [],
      presence: [],
      configSnapshotDeviceIds: new Set(),
      schedule: { snapshotDeviceIds: new Set(), scheduledDeviceIds: new Set(), oldestSnapshotAt: null },
    }),
  );
  assert.equal(report.estate.screens.value, 0);
  assert.equal(report.availability.observedUptimeClaimable.value, null);
  assert.match(report.availability.statement, /No screens in scope/);
  assert.match(report.faults.emptyStatement!, /No screens in scope/);
  for (const f of findFigures(report)) {
    if ((f.coverage["inScope"] as number) === 0) {
      assert.equal(f.coverage["share"], null, `${f.path}: a zero denominator must give a null share`);
    }
  }
});

// ── 6. a readable dimension is never promoted into a claim ──────────────────

test("a readable-but-not-SLA-grade dimension never appears as a claimed number", () => {
  const dims = [
    dimension("presence", "sla-grade"),
    dimension("storage headroom", "readable"),
    dimension("wifi signal", "readable"),
    dimension("panel temperature", "unmeasurable"),
  ];
  const report = buildEstateReport(inputs({ measurability: measurability(dims) }));

  assert.deepEqual(report.claims.slaGrade.map((d) => d.dimension), ["presence"]);
  assert.deepEqual(
    report.claims.readableNotClaimable.map((d) => d.dimension),
    ["storage headroom", "wifi signal"],
  );
  assert.equal(report.claims.counts.value.slaGrade, 1);
  assert.equal(report.claims.counts.value.readableNotClaimable, 2);
  for (const d of report.claims.slaGrade) assert.equal(d.grade, "sla-grade");
  // The list a reader might mistake for a commitment must carry the warning.
  assert.match(report.claims.note, /must not be quoted|NOT something to promise|not something to promise/i);
  assert.ok(
    report.limitations.some(
      (l) => /readable per device but NOT to SLA grade/.test(l) && l.includes("storage headroom"),
    ),
    "each readable dimension is named in the limitations as un-promisable",
  );
});

test("no readable dimension leaks into the sla-grade list however the catalog is ordered", () => {
  const dims = [dimension("storage", "readable"), dimension("presence", "sla-grade")];
  const report = buildEstateReport(inputs({ measurability: measurability(dims) }));
  const claimed = new Set(report.claims.slaGrade.map((d) => d.id));
  for (const d of dims.filter((x) => x.grade !== "sla-grade")) {
    assert.equal(claimed.has(d.id), false, `${d.id} must not be claimable`);
  }
  assert.equal(report.claims.counts.value.slaGrade, report.claims.slaGrade.length);
});

test("an unprobed capability assessment under-claims and says so", () => {
  const assessment = { ...measurability([dimension("presence", "readable")]), fromLiveCapability: false };
  const report = buildEstateReport(inputs({ measurability: assessment }));
  assert.deepEqual(report.claims.slaGrade, []);
  assert.match(report.claims.counts.basis, /NO live capability sample/);
  assert.ok(report.limitations.some((l) => /nothing was promoted to SLA/.test(l)));
});

// ── 7. proof of play is never a playback claim ──────────────────────────────

test("content is reported as scheduled, not confirmed, at every level", () => {
  const report = buildEstateReport(inputs());
  assert.equal(report.content.claim, "scheduled, not confirmed");
  assert.match(report.content.basis, /Scheduled, not confirmed/);
  assert.match(report.content.basis, /no readable per-device render log/);
  assert.match(report.content.statement, /We cannot confirm playback/);
  assert.match(report.content.screensWithContentScheduled.basis, /NOT CONFIRMED/);
  assert.ok(
    report.limitations.some((l) => /Playback is NEVER confirmed/.test(l)),
    "the limitation is stated in the terms the POP engine uses",
  );
  const serialised = JSON.stringify(report);
  assert.equal(/"(confirmedPlay|playbackConfirmed|proofOfPlayConfirmed)"/.test(serialised), false);
});

test("a screen the schedule sweep has not reached is unknown, not empty", () => {
  const report = buildEstateReport(
    inputs({
      devices: [device({ id: "1" }), device({ id: "2" })],
      presence: [
        { deviceId: "1", observedBuckets: 2016, onlineBuckets: 2016 },
        { deviceId: "2", observedBuckets: 2016, onlineBuckets: 2016 },
      ],
      schedule: { snapshotDeviceIds: new Set(["1"]), scheduledDeviceIds: new Set(["1"]), oldestSnapshotAt: null },
    }),
  );
  assert.equal(report.content.screensWithScheduleSnapshot.value, 1);
  assert.equal(report.content.screensWithContentScheduled.coverage.measured, 1);
  assert.equal(report.content.screensWithContentScheduled.coverage.inScope, 2);
  assert.match(report.content.screensWithContentScheduled.coverage.note, /unknown, not empty/);
  assert.ok(report.limitations.some((l) => /schedule sweep yet/.test(l)));
});

// ── 8. odds and ends that would still LOOK like a report if wrong ───────────

test("toReportAlert drops a row it cannot place in time rather than inventing a timestamp", () => {
  assert.equal(toReportAlert({ id: "a", deviceId: "1", severity: "high" }), null);
  assert.equal(toReportAlert({ deviceId: "1", openedAt: "x", severity: "high" }), null);
  const ok = toReportAlert({
    id: "a", deviceId: "1", severity: "high", openedAt: "2026-09-01T00:00:00.000Z",
    deviceName: "Screen 1", title: "t", ruleId: "r", lastFiredAt: null,
    acknowledgedAt: null, resolvedAt: null,
  });
  assert.equal(ok?.openedAt, "2026-09-01T00:00:00.000Z");
});

test("alerts are ordered worst-first so the top of a customer's list is what mattered", () => {
  const report = buildEstateReport(
    inputs({
      alerts: [
        alert({ id: "i", openedAt: "2026-08-30T00:00:00.000Z", severity: "info" }),
        alert({ id: "c", openedAt: "2026-08-29T00:00:00.000Z", severity: "critical" }),
        alert({ id: "m", openedAt: "2026-08-31T00:00:00.000Z", severity: "medium" }),
      ],
    }),
  );
  assert.deepEqual(report.faults.alerts.map((a) => a.severity), ["critical", "medium", "info"]);
  assert.deepEqual(report.faults.openedBySeverity.value, { critical: 1, high: 0, medium: 1, info: 1 });
});

test("an alert on a screen outside the scope is not in the customer's report", () => {
  const report = buildEstateReport(
    inputs({
      devices: [device({ id: "1" })],
      alerts: [
        alert({ id: "mine", openedAt: "2026-08-30T00:00:00.000Z" }),
        alert({ id: "theirs", openedAt: "2026-08-30T00:00:00.000Z", deviceId: "999" }),
      ],
    }),
  );
  assert.deepEqual(report.faults.alerts.map((a) => a.id), ["mine"]);
  assert.equal(report.faults.openedInWindow.value, 1);
});

test("truncation is disclosed, never silent", () => {
  const report = buildEstateReport(
    inputs({ devicesTruncated: true, alertsTruncated: true, actionsTruncated: true }),
  );
  const text = report.limitations.join(" | ");
  assert.match(text, /screen list hit this report's page ceiling and is TRUNCATED/);
  assert.match(text, /alert list hit this report's page ceiling and is TRUNCATED/);
  assert.match(text, /action log read hit this report's page ceiling and is TRUNCATED/);
});

test("a stale site mapping is disclosed, because a screen may have moved", () => {
  const scope = scopeFor("site", SITE_A);
  const report = buildEstateReport(
    inputs({ scope: { ...scope, hierarchy: { ...scope.hierarchy, ageSeconds: 1500 } } }),
  );
  assert.ok(report.limitations.some((l) => /site-to-screen mapping was read .* ago/.test(l)));
});

test("a site that resolves to no groups says the report is empty by construction", () => {
  const scope = scopeFor("site", "no-such-site");
  const report = buildEstateReport(
    inputs({
      scope: { ...scope, hierarchy: { ...scope.hierarchy, groupsMatched: 0 } },
      devices: [],
      presence: [],
      configSnapshotDeviceIds: new Set(),
      schedule: { snapshotDeviceIds: new Set(), scheduledDeviceIds: new Set(), oldestSnapshotAt: null },
    }),
  );
  assert.ok(
    report.limitations.some((l) => /empty by construction/.test(l)),
    "a mistyped site id must not read as a customer with no screens",
  );
});

test("an unreadable hierarchy is stated, not left as blank site cells", () => {
  const report = buildEstateReport(
    inputs({
      scope: {
        ...scopeFor("site", SITE_A),
        hierarchy: {
          available: false, ageSeconds: null, groupsRead: 0, groupsTotal: null,
          truncated: false, reason: "No Videri credentials are configured.", groupsMatched: 0,
        },
      },
    }),
  );
  assert.ok(report.limitations.some((l) => /group hierarchy could not be read/.test(l)));
});

test("the report is self-describing: type, version, scope, window and generation time", () => {
  const report: EstateReport = buildEstateReport(inputs());
  assert.equal(report.reportType, "estate");
  assert.equal(report.formatVersion, 1);
  assert.equal(report.generatedAt, "2026-09-04T12:00:00.000Z");
  assert.equal(report.window.from, WINDOW_FROM);
  assert.equal(report.window.to, WINDOW_TO);
  assert.equal(report.window.halfOpen, true);
  assert.equal(report.scope.kind, "site");
  assert.match(report.title, /Estate report — Videri Sales/);
});

test("a point-in-time 'unknown' status is reconciled with the window view, not left to contradict it", () => {
  const report = buildEstateReport(
    inputs({
      devices: [device({ id: "1", status: "unknown" }), device({ id: "2" })],
      presence: [
        { deviceId: "1", observedBuckets: 2016, onlineBuckets: 2016 },
        { deviceId: "2", observedBuckets: 2016, onlineBuckets: 2016 },
      ],
      configSnapshotDeviceIds: new Set(["1", "2"]),
      schedule: {
        snapshotDeviceIds: new Set(["1", "2"]),
        scheduledDeviceIds: new Set(["1", "2"]),
        oldestSnapshotAt: null,
      },
    }),
  );
  assert.equal(report.estate.byStatus.value["unknown"], 1);
  assert.equal(report.availability.screensObserved.value, 2, "observed all week despite 'unknown'");
  assert.match(report.estate.byStatus.basis, /neither an outage NOR proof we never saw the screen/);
  assert.ok(
    report.limitations.some(
      (l) => /point-in-time status of "unknown"/.test(l) && /not against each other/.test(l),
    ),
    "the apparent contradiction between the two sections is explained, not left to the reader",
  );
});
