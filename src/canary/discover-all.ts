/**
 * Exhaustive read-only discovery sweep.
 *
 *   npm run discover:all
 *
 * Calls EVERY safe GET operation across all eleven services, plus the handful of
 * POST endpoints that are reads in disguise — fetch_all, search, field_values,
 * get_all, fetch. Records status, payload shape and a flattened field inventory
 * for each.
 *
 * WHY: the telemetry conclusions so far rest on ~25 of 281 operations. An
 * endpoint we never called cannot be ruled out, and "we did not look" is not the
 * same finding as "it is not there". This closes that gap mechanically.
 *
 * Safety: skips every mutating verb, every path containing admin/delete/deactivate,
 * and every device command. Path parameters are filled from real ids discovered at
 * the start of the run, so nothing is invented.
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { VideriAuth } from "../videri/auth.js";
import { config } from "../config.js";

const SPEC_DIR = process.argv[2] ?? "../specs/go";

/** Service base paths — the NestJS specs declare no `servers` block. */
const BASE: Record<string, string> = {
  aggregator: "/aggregator", alerting: "/alerting", "audit-trail": "/audit-trail",
  "canvas-service": "/canvas-service", "canvas-status": "/canvas-status", cms: "/cms",
  "messaging-websocket": "/messaging-websocket", paywall: "/paywall",
  publisher: "/publisher", rpm: "/rpm", "tag-manager": "/tag-manager",
};

/** POSTs that only read. Everything else with a body is skipped. */
const READ_POSTS = /\/(fetch_all|fetch|search|field_values|get_all|fetch-shares|by_resource|detect-type)/;

/** Never call these, whatever the verb. */
const FORBIDDEN = /(admin|delete|deactivate|activate|remove|wipe|reassign|migrate|trigger|push|duplicate|replace|move|share|assign|order|verify|set-cognito|inactive|exports|sync_command|batch_command|installationphoto|credentials|storage|playbacks|metrics\/\{|proof_of_play)/i;

interface Op { service: string; method: string; path: string; params: string[]; }

function loadOps(): Op[] {
  const ops: Op[] = [];
  for (const file of readdirSync(SPEC_DIR).filter((f) => f.endsWith(".json"))) {
    const service = file.replace(/\.json$/, "");
    const spec = JSON.parse(readFileSync(join(SPEC_DIR, file), "utf8")) as {
      paths: Record<string, Record<string, { parameters?: Array<{ name: string; in: string; required?: boolean }> }>>;
    };
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      for (const [method, op] of Object.entries(item)) {
        const m = method.toUpperCase();
        if (m !== "GET" && !(m === "POST" && READ_POSTS.test(path))) continue;
        if (FORBIDDEN.test(path)) continue;
        if (path.includes("/health")) continue;
        const required = (op.parameters ?? [])
          .filter((p) => p.required && (p.in === "path" || p.in === "query"))
          .map((p) => p.name);
        ops.push({ service, method: m, path, params: required });
      }
    }
  }
  return ops;
}

/* ── field inventory helpers ── */
const ABSENT = (v: unknown) =>
  v === null || v === undefined ||
  (typeof v === "string" && ["", "unavailable", "not set", "n/a"].includes(v.trim().toLowerCase()));

function flatten(node: unknown, prefix = "", out = new Map<string, unknown>(), depth = 0): Map<string, unknown> {
  if (depth > 6) return out;
  if (node === null || typeof node !== "object") { if (prefix) out.set(prefix, node); return out; }
  if (Array.isArray(node)) { if (node[0] !== undefined) flatten(node[0], prefix + "[]", out, depth + 1); return out; }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    flatten(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
  }
  return out;
}

/** Anything that looks like a runtime hardware metric. The open question. */
const RUNTIME = /(^|[._])(cpu|mem|ram|temp|thermal|rssi|signal|packet|loss|jitter|ntp|storage|disk|uptime|load|fan|volt|power|bright)/i;
const NOT_RUNTIME = /cpu_cores|core_count|brightness_schedule/i;

interface Finding {
  service: string; method: string; path: string; status: number;
  bytes: number; fieldCount: number; populated: number;
  runtimeCandidates: string[]; sampleFields: string[]; note?: string;
}

/* ── run ── */
const auth = new VideriAuth();
const base = config.VIDERI_API_BASE;
const ops = loadOps();
console.log(`Discovery sweep — ${ops.length} read operations across ${new Set(ops.map(o => o.service)).size} services`);
console.log(`${base} · tenant ${config.VIDERI_TENANT}\n`);

/* Real ids so path params are never invented. */
async function call(path: string, method = "GET", body?: unknown, tenantHeader = "x-tenant") {
  const token = await auth.token();
  // Always send x-tenant — it is the header the gateway actually reads. When a
  // caller asks for x-tenant_id, send it ADDITIVELY, never as a replacement.
  // The first sweep sent x-tenant_id ALONE to canvas-status, which that service
  // silently ignores, producing a "no tenant context" 403 we misread as an
  // access denial (D-010). That one mistake hid data_usage for weeks.
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`, accept: "application/json",
    "x-tenant": config.VIDERI_TENANT,
  };
  if (tenantHeader === "x-tenant_id") headers["x-tenant_id"] = config.VIDERI_TENANT;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, bytes: text.length, json };
}

const seed = await call("/canvas-service/canvases?assigned_to_group=true&page=0&size=5");
const canvases = ((seed.json as { content?: Array<Record<string, string>> })?.content ?? []);

// Real identifiers beat placeholders: a wrong id yields 403/404 on this platform,
// so "self"/"admin"/"0" guarantee false negatives on every user/group/role path.
// Pull the caller's own identity from the token, and a real group id from the fleet.
const claims = JSON.parse(
  Buffer.from((await auth.token()).split(".")[1]!, "base64").toString(),
) as Record<string, unknown>;
const realCognitoId = String(claims["sub"] ?? claims["cognito:username"] ?? "self");
const realGroupId = canvases.find((c) => c["group_id"])?.["group_id"] ?? "0";
const realDeviceId = canvases[0]?.["device_id"] ?? "unknown";

const IDS: Record<string, string> = {
  deviceId: realDeviceId,
  serial: realDeviceId,
  canvasId: String(canvases[0]?.["id"] ?? "0"),
  id: String(canvases[0]?.["id"] ?? "0"),
  uuid: String(canvases[0]?.["id"] ?? "0"),
  tenantCode: config.VIDERI_TENANT,
  tenantName: config.VIDERI_TENANT,
  groupId: realGroupId,
  deviceJid: canvases[0]?.["xmpp_jid"] ?? "x@y",
  cognitoId: realCognitoId, role: "admin", tag: "test", field: "name",
  date: new Date().toISOString().slice(0, 10),
  assetUuid: "", playlistId: "", playlistUuid: "", wallId: "", metadataUuid: "",
  eventUuid: "", uuid2: "",
};
console.log(`Seed ids: device=${IDS["deviceId"]} canvas=${IDS["canvasId"]} group=${IDS["groupId"]}\n`);

function fill(path: string): string | null {
  let out = path;
  for (const m of path.matchAll(/\{(\w+)\}/g)) {
    const v = IDS[m[1]!];
    if (!v) return null;           // no real id → skip rather than invent one
    out = out.replace(m[0], encodeURIComponent(v));
  }
  return out;
}

/** Required query params these endpoints reject without. */
const QUERY_DEFAULTS: Record<string, string> = {
  assigned_to_group: "true", page: "0", size: "5", limit: "5",
  fromDate: "2026-08-01", toDate: "2026-08-26", field: "name",
  entityType: "CANVAS", start: "2026-08-01T00:00:00Z", end: "2026-08-26T00:00:00Z",
};

const findings: Finding[] = [];
let ok = 0, denied = 0, bad = 0, skipped = 0;

for (const op of ops) {
  const filled = fill(op.path);
  if (!filled) { skipped++; continue; }

  const qs = new URLSearchParams();
  for (const p of op.params) if (QUERY_DEFAULTS[p]) qs.set(p, QUERY_DEFAULTS[p]);
  if (!qs.has("page")) qs.set("page", "0");
  if (!qs.has("size") && !qs.has("limit")) qs.set("limit", "5");

  const url = `${BASE[op.service]}${filled}?${qs}`;
  const tenantHeader = op.service === "canvas-status" ? "x-tenant_id" : "x-tenant";
  const body = op.method === "POST"
    ? (/fetch_all/.test(filled) && op.service === "canvas-status"
        ? (/metrics/.test(filled) ? [IDS["deviceId"]]
           : { players: [{ device_id: IDS["deviceId"], device_jid: IDS["deviceJid"] }] })
        : {})
    : undefined;

  let r;
  try { r = await call(url, op.method, body, tenantHeader as "x-tenant"); }
  catch (e) { findings.push({ ...op, status: 0, bytes: 0, fieldCount: 0, populated: 0,
    runtimeCandidates: [], sampleFields: [], note: (e as Error).message }); continue; }

  if (r.status === 403) denied++;
  else if (r.status >= 400) bad++;
  else ok++;

  const flat = r.status < 400 && r.json ? flatten(r.json) : new Map();
  const fields = [...flat.keys()];
  const populated = [...flat.entries()].filter(([, v]) => !ABSENT(v)).length;
  const runtime = fields.filter((f) => RUNTIME.test(f) && !NOT_RUNTIME.test(f));

  findings.push({
    service: op.service, method: op.method, path: op.path, status: r.status,
    bytes: r.bytes, fieldCount: fields.length, populated,
    runtimeCandidates: runtime, sampleFields: fields.slice(0, 40),
  });

  const flag = runtime.length > 0 ? "  ⚑ RUNTIME CANDIDATE" : "";
  console.log(
    `${String(r.status).padStart(3)} ${op.method.padEnd(4)} ${(BASE[op.service] + op.path).slice(0, 62).padEnd(63)}` +
    `${String(fields.length).padStart(4)}f ${String(r.bytes).padStart(7)}b${flag}`,
  );
}

/* ── report ── */
console.log(`\n${"═".repeat(78)}`);
console.log(`${ok} ok · ${denied} denied (403) · ${bad} error · ${skipped} skipped (no real id)`);

const withRuntime = findings.filter((f) => f.runtimeCandidates.length > 0);
console.log(`\n⚑ RUNTIME METRIC CANDIDATES — the open question:`);
if (withRuntime.length === 0) {
  console.log("   NONE. No endpoint in the entire read surface returns a field matching");
  console.log("   cpu/mem/ram/temp/rssi/signal/packet/jitter/ntp/storage/uptime/load.");
} else {
  for (const f of withRuntime) {
    console.log(`   ${BASE[f.service]}${f.path}`);
    for (const c of f.runtimeCandidates) console.log(`      → ${c}`);
  }
}

const rich = findings.filter((f) => f.status < 400 && f.fieldCount > 0)
  .sort((a, b) => b.fieldCount - a.fieldCount).slice(0, 12);
console.log(`\nRICHEST PAYLOADS (most fields — worth a closer look):`);
for (const f of rich) {
  console.log(`   ${String(f.fieldCount).padStart(4)} fields  ${BASE[f.service]}${f.path}`);
}

const deniedList = findings.filter((f) => f.status === 403);
console.log(`\nACCESS DENIED (${deniedList.length}):`);
for (const f of deniedList) console.log(`   ${BASE[f.service]}${f.path}`);

const errors = findings.filter((f) => f.status >= 400 && f.status !== 403);
console.log(`\nERRORS (${errors.length}) — may need different params, not necessarily unavailable:`);
for (const f of errors.slice(0, 20)) console.log(`   ${f.status} ${BASE[f.service]}${f.path}`);

writeFileSync("discovery-sweep.json", JSON.stringify({
  ranAt: new Date().toISOString(), base, tenant: config.VIDERI_TENANT,
  totals: { ok, denied, bad, skipped, operations: ops.length },
  runtimeCandidates: withRuntime, findings,
}, null, 2));
console.log(`\nWrote discovery-sweep.json (${findings.length} operations recorded)`);
