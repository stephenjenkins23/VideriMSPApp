/**
 * Gap validation harness — `npm run validate-gaps`
 *
 * Every gap claimed in docs/06-DATA-INVENTORY.md is re-checked here against the
 * live API. The point is that a gap nobody can reproduce is just an assertion:
 * this turns each claim into a check with an exact call and an observed result,
 * so the platform team can verify or refute it independently.
 *
 * It is also a regression detector in the other direction. If Videri starts
 * returning CPU, or populates `geo`, or grants `data_usage`, a check flips from
 * CONFIRMED to RESOLVED and we find out from our own tooling rather than by
 * accident months later.
 *
 * Read-only throughout: GETs, plus one deliberately malformed GET to demonstrate
 * a required-parameter claim. No device commands, no writes.
 */

import { VideriAuth } from "../videri/auth.js";
import { config } from "../config.js";

type Verdict = "CONFIRMED" | "RESOLVED" | "INCONCLUSIVE";

interface Check {
  id: string;
  claim: string;
  /** Reproducible call, for anyone re-running this by hand. */
  call: string;
  category: "absent-data" | "access-denied" | "empty" | "sentinel" | "contract" | "vocabulary";
  run: (ctx: Ctx) => Promise<{ verdict: Verdict; observed: string }>;
}

interface Ctx {
  get: (path: string, tenantHeader?: "x-tenant" | "x-tenant_id") => Promise<{ status: number; body: unknown }>;
  deviceIds: string[];
}

const RUNTIME_METRIC_PATTERN =
  /cpu.*(usage|load|pct|percent)|(^|_)mem|ram|temp|thermal|rssi|signal|packet|jitter|ntp|storage|disk|uptime/i;

const ABSENT = (v: unknown): boolean =>
  v === null || v === undefined ||
  (typeof v === "string" && ["unavailable", "", "not set", "n/a"].includes(v.trim().toLowerCase()));

const flatten = (o: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> => {
  if (o === null || typeof o !== "object" || Array.isArray(o)) {
    if (prefix) out[prefix] = o;
    return out;
  }
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
};

/**
 * Both assignment sets, paged to completion.
 *
 * This used to request page 0 at size=200 and stop, which returned 216 of 250
 * devices — the assigned set alone is 234. Coverage percentages computed on a
 * page-ordered truncation is precisely the method fault this harness exists to
 * catch, so it must not commit it: every figure here covers the whole fleet or
 * it is not a coverage figure.
 */
async function sampleFleet(ctx: Ctx, size = 200): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const assigned of [true, false]) {
    for (let page = 0; page < 25; page += 1) {
      const res = await ctx.get(
        `/canvas-service/canvases?assigned_to_group=${assigned}&page=${page}&size=${size}`,
      );
      if (res.status !== 200) break;
      const body = res.body as { content?: Array<Record<string, unknown>>; totalPages?: number };
      const content = body.content ?? [];
      out.push(...content);
      const totalPages = typeof body.totalPages === "number" ? body.totalPages : 1;
      if (content.length === 0 || page + 1 >= totalPages) break;
    }
  }
  return out;
}

const CHECKS: Check[] = [
  {
    id: "GAP-01",
    category: "absent-data",
    claim: "No runtime hardware telemetry (CPU / RAM / temperature / signal / packet loss / jitter / NTP / storage) exists in the metrics payload.",
    call: "GET /canvas-status/metrics/fetch/{deviceId}  — sampled across multiple devices",
    async run(ctx) {
      const hits: string[] = [];
      let sampled = 0;
      for (const id of ctx.deviceIds.slice(0, 8)) {
        const res = await ctx.get(`/canvas-status/metrics/fetch/${encodeURIComponent(id)}`, "x-tenant_id");
        if (res.status !== 200) continue;
        sampled += 1;
        const payload = res.body as Record<string, unknown>;
        const keys = {
          ...flatten(payload["super_props"] ?? {}),
          ...flatten(payload["status"] ?? {}),
        };
        for (const key of Object.keys(keys)) {
          // cpu_cores is a static core COUNT, not utilisation — exclude it.
          if (/^cpu_cores$/i.test(key)) continue;
          if (RUNTIME_METRIC_PATTERN.test(key)) hits.push(`${id}:${key}`);
        }
      }
      if (sampled === 0) return { verdict: "INCONCLUSIVE", observed: "no device returned metrics" };
      return hits.length === 0
        ? { verdict: "CONFIRMED", observed: `${sampled} devices sampled, 0 runtime-metric keys found` }
        : { verdict: "RESOLVED", observed: `runtime keys now present: ${hits.slice(0, 6).join(", ")}` };
    },
  },
  {
    id: "GAP-02",
    category: "absent-data",
    claim:
      "Map-grade coordinates are sparsely populated (~35% of devices), so a pinned " +
      "fleet map can only cover a subset.",
    call: "GET /canvas-service/canvases?assigned_to_group={true,false}&size=200 (all pages)",
    async run(ctx) {
      const content = await sampleFleet(ctx);
      if (content.length === 0) return { verdict: "INCONCLUSIVE", observed: "no devices returned" };
      const n = content.length;
      // Reported separately. The previous version counted "geo OR location" and
      // labelled the result "geo.coordinates" — the two happen to coincide on
      // this tenant, so the number was right by luck and the predicate was not.
      const withGeo = content.filter((c) => {
        const geo = c["geo"] as { coordinates?: { latitude?: unknown } } | null | undefined;
        return !ABSENT(geo?.coordinates?.latitude);
      }).length;
      const withLocation = content.filter((c) => !ABSENT(c["location"])).length;
      const pct = Math.round((withGeo / n) * 100);
      if (pct >= 90) {
        return { verdict: "RESOLVED", observed: `geo on ${pct}% of ${n} devices — pinned fleet map fully viable` };
      }
      return {
        verdict: "CONFIRMED",
        observed:
          `geo.coordinates.latitude on ${withGeo}/${n} (${pct}%); ` +
          `location string on ${withLocation}/${n} ` +
          `(${Math.round((withLocation / n) * 100)}%) and adds no device geo does not already cover. ` +
          `A pinned map must state its own coverage.`,
      };
    },
  },
  {
    id: "GAP-13",
    category: "vocabulary",
    claim:
      "metadata metafields are the only fleet-wide custom dimension, but on this " +
      "tenant they are near-constant placeholder data — so they do NOT deliver " +
      "fleet geography, despite 100% coverage.",
    call: "GET /canvas-service/canvases?...&size=200 — metadata[].metafieldName + value",
    async run(ctx) {
      const content = await sampleFleet(ctx);
      if (content.length === 0) return { verdict: "INCONCLUSIVE", observed: "no devices returned" };
      const n = content.length;

      // Coverage AND cardinality. Measuring only coverage is how this check got
      // published claiming "grouping the fleet by city is viable at 100%" when
      // CITY holds one value on 249 of 250 devices. A field present everywhere
      // and constant everywhere carries exactly no information, and the two
      // measurements have to travel together or the first one lies.
      const values = new Map<string, Map<string, number>>();
      let withAny = 0;
      for (const c of content) {
        const meta = c["metadata"] as Array<{ metafieldName?: string; value?: unknown }> | null | undefined;
        if (!Array.isArray(meta) || meta.length === 0) continue;
        withAny += 1;
        for (const f of meta) {
          if (!f?.metafieldName || ABSENT(f.value)) continue;
          const byValue = values.get(f.metafieldName) ?? new Map<string, number>();
          const v = String(f.value).trim();
          byValue.set(v, (byValue.get(v) ?? 0) + 1);
          values.set(f.metafieldName, byValue);
        }
      }

      const describe = (name: string): string => {
        const byValue = values.get(name);
        if (!byValue) return `${name} absent`;
        const total = [...byValue.values()].reduce((a, b) => a + b, 0);
        const top = Math.max(...byValue.values());
        return `${name} on ${total}/${n}, ${byValue.size} distinct, top value ${Math.round((top / total) * 100)}%`;
      };

      const city = values.get("CITY");
      const cityTotal = city ? [...city.values()].reduce((a, b) => a + b, 0) : 0;
      const cityDistinct = city ? city.size : 0;
      const cityTop = city ? Math.max(...city.values()) : 0;
      const usableGeography = cityDistinct >= 3 && cityTop / Math.max(1, cityTotal) < 0.9;

      if (usableGeography) {
        return {
          verdict: "RESOLVED",
          observed:
            `CITY now carries real geography: ${describe("CITY")}. ` +
            `Fleet grouping by city is genuinely usable.`,
        };
      }
      return {
        verdict: "CONFIRMED",
        observed:
          `metadata on ${withAny}/${n} devices across ${values.size} metafields, but ` +
          `${describe("CITY")} and ${describe("NAME")} — placeholder data, not geography. ` +
          `100% coverage with 1-2 distinct values groups the fleet into one bucket. ` +
          `The mechanism is real; the values on this tenant are not.`,
      };
    },
  },
  {
    id: "GAP-03",
    category: "sentinel",
    claim: 'License fields and playback_quality are effectively absent (<5% coverage). Other lifecycle fields ARE populated — last_online_time on ~93%.',
    call: "GET /canvas-service/canvases?assigned_to_group=true&size=50",
    async run(ctx) {
      const content = await sampleFleet(ctx);
      if (content.length === 0) return { verdict: "INCONCLUSIVE", observed: "no devices returned" };
      const coverage = (f: string) =>
        Math.round((content.filter((c) => !ABSENT(c[f])).length / Math.max(1, content.length)) * 100);

      // Genuinely absent (<5%) versus genuinely available — measured across 216
      // devices, after a 3-device sample produced a false "always empty" claim.
      const absentFields = ["license_expiration", "license_status", "playback_quality", "account_name"];
      const availableFields = ["last_online_time", "core_services_status", "presence_status"];

      const stillAbsent = absentFields.filter((f) => coverage(f) < 5);
      const stillAvailable = availableFields.filter((f) => coverage(f) >= 80);
      const detail =
        `n=${content.length} · ` +
        [...absentFields, ...availableFields].map((f) => `${f} ${coverage(f)}%`).join("; ");

      if (stillAbsent.length === absentFields.length && stillAvailable.length === availableFields.length) {
        return { verdict: "CONFIRMED", observed: detail };
      }
      return {
        verdict: "RESOLVED",
        observed: `coverage shifted — ${detail}`,
      };
    },
  },
  {
    id: "GAP-04",
    category: "contract",
    claim:
      "RETRACTED. data_usage is not denied — it requires the x-tenant header. " +
      "canvas-status silently ignores x-tenant_id, and the resulting " +
      "no-tenant-context 403 was misread as a permissions wall.",
    call: "GET /canvas-status/data_usage/{serial} — with x-tenant, NOT x-tenant_id",
    async run(ctx) {
      const id = ctx.deviceIds[0];
      if (!id) return { verdict: "INCONCLUSIVE", observed: "no device id available" };
      // Both header forms deliberately, because the DIFFERENCE is the finding.
      const withTenant = await ctx.get(`/canvas-status/data_usage/${encodeURIComponent(id)}`, "x-tenant");
      const withTenantId = await ctx.get(`/canvas-status/data_usage/${encodeURIComponent(id)}`, "x-tenant_id");
      if (withTenant.status !== 200) {
        return {
          verdict: "CONFIRMED",
          observed: `x-tenant also returns ${withTenant.status} — access may genuinely be withheld now`,
        };
      }
      const body = withTenant.body as { daily_aggregation?: unknown[] } | null;
      const days = Array.isArray(body?.daily_aggregation) ? body.daily_aggregation.length : 0;
      return {
        verdict: "RESOLVED",
        observed:
          `x-tenant -> 200 with ${days} daily row(s); x-tenant_id -> ${withTenantId.status}. ` +
          `The 403 was our header, not their permissions.`,
      };
    },
  },
  {
    id: "GAP-05",
    category: "access-denied",
    claim: "canvas_count is denied to a tenant admin.",
    call: "GET /canvas-service/canvas_count/{tenantCode}",
    async run(ctx) {
      const res = await ctx.get(`/canvas-service/canvas_count/${config.VIDERI_TENANT}`);
      return res.status === 403
        ? { verdict: "CONFIRMED", observed: "HTTP 403" }
        : { verdict: res.status === 200 ? "RESOLVED" : "INCONCLUSIVE", observed: `HTTP ${res.status}` };
    },
  },
  {
    id: "GAP-06",
    category: "access-denied",
    claim: "Asset storage statistics are denied to a tenant admin.",
    call: "GET /cms/api/v1/assets/statistics/storage",
    async run(ctx) {
      const res = await ctx.get("/cms/api/v1/assets/statistics/storage");
      return res.status === 403
        ? { verdict: "CONFIRMED", observed: "HTTP 403" }
        : { verdict: res.status === 200 ? "RESOLVED" : "INCONCLUSIVE", observed: `HTTP ${res.status}` };
    },
  },
  {
    id: "GAP-07",
    category: "empty",
    claim: "The aggregator — the platform's only pre-aggregation layer — returns no rows for this tenant.",
    call: "GET /aggregator/api/v1/metrics/account-groups?limit=5",
    async run(ctx) {
      const res = await ctx.get("/aggregator/api/v1/metrics/account-groups?limit=5");
      if (res.status !== 200) return { verdict: "INCONCLUSIVE", observed: `HTTP ${res.status}` };
      const meta = (res.body as { meta?: { totalItems?: number } }).meta;
      const total = meta?.totalItems ?? 0;
      return total === 0
        ? { verdict: "CONFIRMED", observed: "totalItems = 0" }
        : { verdict: "RESOLVED", observed: `totalItems = ${total}` };
    },
  },
  {
    id: "GAP-08",
    category: "vocabulary",
    claim: 'The platform detects exactly two alert types: "offline" and "showingLogo".',
    call: "GET /alerting/api/v1/alerts?limit=200",
    async run(ctx) {
      const res = await ctx.get("/alerting/api/v1/alerts?page=1&limit=200");
      if (res.status !== 200) return { verdict: "INCONCLUSIVE", observed: `HTTP ${res.status}` };
      const rows = ((res.body as { data?: Array<{ alertType?: string }> }).data ?? []);
      const types = [...new Set(rows.map((r) => r.alertType).filter(Boolean))].sort();
      const known = new Set(["offline", "showingLogo"]);
      const extra = types.filter((t) => !known.has(t!));
      return extra.length === 0
        ? { verdict: "CONFIRMED", observed: `n=${rows.length}, types = [${types.join(", ")}]` }
        : { verdict: "RESOLVED", observed: `new types: ${extra.join(", ")}` };
    },
  },
  {
    id: "GAP-09",
    category: "vocabulary",
    claim: "Platform alerts carry no severity field, so severity cannot be sourced from the platform.",
    call: "GET /alerting/api/v1/alerts?limit=5",
    async run(ctx) {
      const res = await ctx.get("/alerting/api/v1/alerts?page=1&limit=5");
      if (res.status !== 200) return { verdict: "INCONCLUSIVE", observed: `HTTP ${res.status}` };
      const rows = ((res.body as { data?: Array<Record<string, unknown>> }).data ?? []);
      const first = rows[0];
      if (!first) return { verdict: "INCONCLUSIVE", observed: "no alerts returned" };
      const hasSeverity = Object.keys(first).some((k) => /severity|priority|level/i.test(k));
      return hasSeverity
        ? { verdict: "RESOLVED", observed: `fields: ${Object.keys(first).join(", ")}` }
        : { verdict: "CONFIRMED", observed: `no severity-like field among: ${Object.keys(first).join(", ")}` };
    },
  },
  {
    id: "GAP-10",
    category: "contract",
    claim: "GET /canvases requires assigned_to_group, and neither value returns the whole fleet.",
    call: "GET /canvas-service/canvases (no params), then with true and false",
    async run(ctx) {
      const bare = await ctx.get("/canvas-service/canvases?page=0&size=1");
      const yes = await ctx.get("/canvas-service/canvases?assigned_to_group=true&page=0&size=1");
      const no = await ctx.get("/canvas-service/canvases?assigned_to_group=false&page=0&size=1");
      const total = (r: { body: unknown }) => (r.body as { totalElements?: number }).totalElements ?? 0;
      const required = bare.status === 400;
      const split = total(yes) > 0 && total(no) > 0;
      return required && split
        ? {
            verdict: "CONFIRMED",
            observed: `without param → 400; true → ${total(yes)}, false → ${total(no)} (disjoint, sum ${total(yes) + total(no)})`,
          }
        : { verdict: "INCONCLUSIVE", observed: `bare ${bare.status}; true ${total(yes)}; false ${total(no)}` };
    },
  },
  {
    id: "GAP-12",
    category: "empty",
    claim: 'ping_quality is populated on every device but always returns the same value ("no") — present, but zero information.',
    call: "GET /canvas-service/canvases?assigned_to_group=true&size=100",
    async run(ctx) {
      const content = await sampleFleet(ctx);
      if (content.length === 0) return { verdict: "INCONCLUSIVE", observed: "no devices returned" };
      const values = new Set(content.map((c) => String(c["ping_quality"])));
      return values.size <= 1
        ? {
            verdict: "CONFIRMED",
            observed: `${content.length} devices, ${values.size} distinct value: ${[...values].join(", ")}`,
          }
        : { verdict: "RESOLVED", observed: `now varies: ${[...values].slice(0, 5).join(", ")}` };
    },
  },
  {
    id: "GAP-11",
    category: "contract",
    claim:
      "RETRACTED. Screenshots ARE readable — from a public CDN mirror keyed by " +
      "hardware serial, not from the API host. Every read path under " +
      "api.go.videri.com really is closed, which is why probing only that host " +
      "produced the wrong conclusion.",
    call: "GET https://cdn.go.videri.com/videri-production-canvas-service/screenshots/{serial}.jpg",
    async run(ctx) {
      const serial = ctx.deviceIds[0];
      if (!serial) return { verdict: "INCONCLUSIVE", observed: "no device serial available" };

      // The original probes: still closed, and still worth asserting so the
      // retraction is precise about WHAT was wrong rather than blanket.
      const apiPaths = [
        `/canvas-service/canvas/screenshots/${serial}`,
        `/canvas-status/screenshots/${serial}`,
      ];
      const apiResults: string[] = [];
      for (const path of apiPaths) {
        const res = await ctx.get(path);
        apiResults.push(`${path.split("/").slice(-2).join("/")}→${res.status}`);
      }

      // The path that actually works. No auth header — it is a public mirror.
      const cdn = `https://cdn.go.videri.com/videri-production-canvas-service/screenshots/${encodeURIComponent(serial)}.jpg`;
      let cdnStatus = 0, lastModified: string | null = null, bytes = 0;
      try {
        const res = await fetch(cdn, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
        cdnStatus = res.status;
        lastModified = res.headers.get("last-modified");
        bytes = Number(res.headers.get("content-length")) || 0;
      } catch (error) {
        return { verdict: "INCONCLUSIVE", observed: `CDN unreachable: ${(error as Error).message}` };
      }

      if (cdnStatus !== 200) {
        return {
          verdict: "CONFIRMED",
          observed: `CDN returned ${cdnStatus}; API paths ${apiResults.join(" ")}`,
        };
      }
      const ageDays = lastModified
        ? Math.round((Date.now() - new Date(lastModified).getTime()) / 86400000)
        : null;
      return {
        verdict: "RESOLVED",
        observed:
          `CDN 200, ${bytes} bytes, last modified ${lastModified ?? "unknown"} ` +
          `(${ageDays ?? "?"} days old). API host still closed: ${apiResults.join(" ")}. ` +
          `Retrieval is solved; freshness is the remaining problem.`,
      };
    },
  },
];

// ── runner ──────────────────────────────────────────────────────────────────

const auth = new VideriAuth();
const base = config.VIDERI_API_BASE;

async function get(path: string, tenantHeader: "x-tenant" | "x-tenant_id" = "x-tenant") {
  const token = await auth.token();
  const res = await fetch(`${base}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      [tenantHeader]: config.VIDERI_TENANT,
    },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

console.log(`Gap validation — ${base} — tenant ${config.VIDERI_TENANT}`);
console.log(`${new Date().toISOString()}\n`);

// Collect device ids once; several checks need them.
const pool = await get("/canvas-service/canvases?assigned_to_group=true&page=0&size=50");
const deviceIds = ((pool.body as { content?: Array<{ device_id?: string }> }).content ?? [])
  .map((c) => c.device_id)
  .filter((d): d is string => Boolean(d));
console.log(`device sample: ${deviceIds.length} ids\n`);

const ctx: Ctx = { get, deviceIds };
const results: Array<{ check: Check; verdict: Verdict; observed: string }> = [];

for (const check of CHECKS) {
  process.stdout.write(`${check.id}  `);
  try {
    const outcome = await check.run(ctx);
    results.push({ check, ...outcome });
    console.log(`${outcome.verdict.padEnd(13)} ${outcome.observed}`);
  } catch (error) {
    results.push({ check, verdict: "INCONCLUSIVE", observed: (error as Error).message });
    console.log(`INCONCLUSIVE  ${(error as Error).message}`);
  }
}

const confirmed = results.filter((r) => r.verdict === "CONFIRMED").length;
const resolved = results.filter((r) => r.verdict === "RESOLVED").length;
const inconclusive = results.filter((r) => r.verdict === "INCONCLUSIVE").length;

console.log(
  `\n${confirmed} confirmed · ${resolved} resolved · ${inconclusive} inconclusive` +
    ` (of ${results.length})`,
);
if (resolved > 0) {
  console.log(
    "\nRESOLVED means the platform now provides something we documented as missing —\n" +
      "update docs/06-DATA-INVENTORY.md and revisit the affected VFI surface.",
  );
}

// Machine-readable, for diffing between runs.
const report = {
  ranAt: new Date().toISOString(),
  base,
  tenant: config.VIDERI_TENANT,
  summary: { confirmed, resolved, inconclusive },
  checks: results.map((r) => ({
    id: r.check.id,
    category: r.check.category,
    claim: r.check.claim,
    call: r.check.call,
    verdict: r.verdict,
    observed: r.observed,
  })),
};
const { writeFileSync } = await import("node:fs");
writeFileSync("gap-validation.json", JSON.stringify(report, null, 2));
console.log("\nWrote gap-validation.json");

process.exit(resolved > 0 ? 2 : 0);
