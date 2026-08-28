/**
 * Settings field audit — `npm run audit:settings`
 *
 * Answers one question per device class: **does `ops_get_settings` actually
 * return the fields we build on?**
 *
 * Our compliance templates and control surfaces name specific fields. Until now
 * that mapping came from a single captured TCL response, which proves what one
 * device answered once — not what the fleet answers, and not whether a Canvas
 * answers the same way. A template that checks a field the device never returns
 * scores every device "unknown" and looks like a fleet problem; a control that
 * writes a field the device does not have fails at the worst moment.
 *
 * So this walks real devices of every class and reports three sets:
 *   REQUESTED AND PRESENT   — safe to build on
 *   REQUESTED BUT MISSING   — our template/UI is wrong for this class
 *   RETURNED BUT UNUSED     — capability we are leaving on the floor
 *
 * Read-only. `ops_get_settings` reads configuration; nothing here writes.
 */

import { VideriAuth } from "../videri/auth.js";
import { config } from "../config.js";
import { DEFAULT_TEMPLATES } from "../compliance/templates.js";

interface DeviceRec {
  id: string;
  deviceId: string;
  name: string;
  jid: string | null;
  productName: string | null;
  presence: string | null;
}

interface ClassReport {
  deviceClass: string;
  productNames: Set<string>;
  attempted: number;
  answered: number;
  failures: Map<string, number>;
  /** field -> how many answering devices returned it */
  fieldCounts: Map<string, number>;
  /** field -> a sample value, for type/range sanity */
  samples: Map<string, unknown>;
  containerKeys: Set<string>;
}

/** Every field any compliance template or control surface depends on. */
function requestedFields(): Map<string, string[]> {
  const byField = new Map<string, string[]>();
  for (const tpl of DEFAULT_TEMPLATES) {
    for (const c of tpl.checks) {
      // `color_table_offsets.r` is a path into a nested object; the top-level
      // key is what the device must return.
      const top = c.field.split(".")[0]!;
      const users = byField.get(top) ?? [];
      users.push(`${tpl.id}:${c.field}`);
      byField.set(top, users);
    }
  }
  return byField;
}

/** Classify like the adapter does, so the report lines up with the product. */
function classify(productName: string | null): string {
  if (!productName) return "unknown";
  const h = productName.toLowerCase();
  if (h.includes("tcl")) return "tcl";
  if (h.includes("allsee") || h.includes("all-see")) return "allsee";
  if (/spark|canvas|\bv\d+\w*\b|\bvq\b|\bthe [45]\b|^h\d/.test(h)) return "canvas";
  return "unknown";
}

function flattenTop(obj: Record<string, unknown>, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    out.set(key, v);
    // One level deep only — `color_table_offsets.r` is the deepest path used.
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        out.set(`${key}.${k2}`, v2);
      }
    }
  }
  return out;
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array[${v.length}]${v.length ? " e.g. " + JSON.stringify(v[0]) : ""}`;
  if (typeof v === "object") return `object{${Object.keys(v as object).join(",")}}`;
  const s = JSON.stringify(v);
  return `${typeof v} ${s.length > 40 ? s.slice(0, 40) + "…" : s}`;
}

async function main(): Promise<void> {
  const perClassLimit = Number(process.argv[2] ?? 6);
  const auth = new VideriAuth();
  const token = await auth.token();
  const base = config.VIDERI_API_BASE.replace(/\/$/, "");
  const tenant = config.VIDERI_TENANT;

  const headers = {
    authorization: `Bearer ${token}`,
    "x-tenant": tenant,
    "content-type": "application/json",
  };

  // ── inventory ──────────────────────────────────────────────────────────────
  const devices: DeviceRec[] = [];
  for (const assigned of ["true", "false"]) {
    const res = await fetch(
      `${base}/canvas-service/canvases?assigned_to_group=${assigned}` +
        `&with_status=true&page=0&size=500`,
      { headers },
    );
    if (!res.ok) {
      console.error(`inventory (assigned=${assigned}) failed: ${res.status}`);
      continue;
    }
    const body = (await res.json()) as { content?: unknown[] };
    for (const raw of body.content ?? []) {
      const d = raw as Record<string, unknown>;
      devices.push({
        // `id` is the integer canvas id; `device_id` and `xmpp_jid` are the
        // separate identifiers sync_command actually addresses.
        id: String(d["id"] ?? ""),
        deviceId: (d["device_id"] as string) ?? String(d["id"] ?? ""),
        name: String(d["name"] ?? "(unnamed)"),
        jid: (d["xmpp_jid"] as string) ?? null,
        productName: (d["product_name"] as string) ?? null,
        presence: (d["presence_status"] as string) ?? null,
      });
    }
  }

  const online = devices.filter(
    (d) => d.jid && String(d.presence ?? "").toLowerCase().includes("online"),
  );

  // ── pick a sample per class, preferring online devices ─────────────────────
  const byClass = new Map<string, DeviceRec[]>();
  for (const d of online) {
    const c = classify(d.productName);
    const list = byClass.get(c) ?? [];
    if (list.length < perClassLimit) list.push(d);
    byClass.set(c, list);
  }

  console.log(`Fleet: ${devices.length} devices, ${online.length} online with a JID.`);
  console.log(
    `Sampling up to ${perClassLimit} online device(s) per class: ` +
      [...byClass].map(([c, l]) => `${c}=${l.length}`).join(", ") + "\n",
  );

  const requested = requestedFields();
  const reports: ClassReport[] = [];

  for (const [deviceClass, sample] of byClass) {
    const rep: ClassReport = {
      deviceClass,
      productNames: new Set(),
      attempted: 0,
      answered: 0,
      failures: new Map(),
      fieldCounts: new Map(),
      samples: new Map(),
      containerKeys: new Set(),
    };

    for (const d of sample) {
      rep.attempted += 1;
      rep.productNames.add(d.productName ?? "(null)");
      try {
        const res = await fetch(`${base}/messaging-websocket/messaging/sync_command`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            device_id: d.deviceId,
            device_jid: d.jid,
            player_id: d.deviceId,
            command_name: "ops_get_settings",
            command_params: {},
            message_id: crypto.randomUUID(),
          }),
        });
        if (!res.ok) {
          const key = `HTTP ${res.status}`;
          rep.failures.set(key, (rep.failures.get(key) ?? 0) + 1);
          continue;
        }
        const body = (await res.json()) as {
          response_code?: string;
          others?: Record<string, unknown>;
        };
        if (body.response_code !== "SUCCESS") {
          const key = body.response_code ?? "no response_code";
          rep.failures.set(key, (rep.failures.get(key) ?? 0) + 1);
          continue;
        }
        for (const k of Object.keys(body.others ?? {})) rep.containerKeys.add(k);
        const props = body.others?.["system_properties"];
        if (!props || typeof props !== "object") {
          rep.failures.set("SUCCESS but no system_properties",
            (rep.failures.get("SUCCESS but no system_properties") ?? 0) + 1);
          continue;
        }
        rep.answered += 1;
        for (const [k, v] of flattenTop(props as Record<string, unknown>)) {
          rep.fieldCounts.set(k, (rep.fieldCounts.get(k) ?? 0) + 1);
          if (!rep.samples.has(k)) rep.samples.set(k, v);
        }
      } catch (error) {
        const key = (error as Error).message.slice(0, 48);
        rep.failures.set(key, (rep.failures.get(key) ?? 0) + 1);
      }
    }
    reports.push(rep);
  }

  // ── report ─────────────────────────────────────────────────────────────────
  const allRequested = [...requested.keys()].sort();
  for (const rep of reports) {
    console.log("=".repeat(78));
    console.log(`CLASS ${rep.deviceClass.toUpperCase()}  (${[...rep.productNames].join(", ")})`);
    console.log(
      `  ${rep.answered}/${rep.attempted} device(s) answered ops_get_settings` +
        (rep.failures.size
          ? `; failures: ${[...rep.failures].map(([k, n]) => `${k}×${n}`).join(", ")}`
          : ""),
    );
    if (rep.answered === 0) {
      console.log("  No response — nothing can be said about this class's fields.\n");
      continue;
    }
    console.log(`  response containers: ${[...rep.containerKeys].join(", ")}`);

    const present: string[] = [];
    const partial: string[] = [];
    const missing: string[] = [];
    for (const f of allRequested) {
      const n = rep.fieldCounts.get(f) ?? 0;
      if (n === rep.answered) present.push(f);
      else if (n > 0) partial.push(`${f} (${n}/${rep.answered})`);
      else missing.push(f);
    }

    console.log(`\n  REQUESTED AND PRESENT on all ${rep.answered} (${present.length}/${allRequested.length}):`);
    for (const f of present) console.log(`    ok   ${f} = ${describe(rep.samples.get(f))}`);
    if (partial.length) {
      console.log(`\n  REQUESTED, INCONSISTENT within the class (${partial.length}) -- a template cannot rely on these:`);
      for (const f of partial) console.log(`    ??   ${f}`);
    }
    if (missing.length) {
      console.log(`\n  REQUESTED BUT NEVER RETURNED (${missing.length}) -- our template is wrong for this class:`);
      for (const f of missing) console.log(`    GAP  ${f}  <- used by ${requested.get(f)!.join(", ")}`);
    }

    const unused = [...rep.fieldCounts.keys()]
      .filter((f) => !f.includes(".") && !requested.has(f))
      .sort();
    if (unused.length) {
      console.log(`\n  RETURNED BUT UNUSED (${unused.length}) -- available capability we do not surface:`);
      for (const f of unused) {
        console.log(`    ---  ${f} = ${describe(rep.samples.get(f))} (${rep.fieldCounts.get(f)}/${rep.answered})`);
      }
    }
    console.log("");
  }

  // ── cross-class comparison ─────────────────────────────────────────────────
  const answering = reports.filter((r) => r.answered > 0);
  if (answering.length > 1) {
    console.log("=".repeat(78));
    console.log("CROSS-CLASS: which fields are class-specific?\n");
    const union = new Set<string>();
    for (const r of answering) for (const f of r.fieldCounts.keys()) if (!f.includes(".")) union.add(f);
    const header = answering.map((r) => r.deviceClass.padEnd(9)).join("");
    console.log(`  ${"field".padEnd(32)}${header}`);
    for (const f of [...union].sort()) {
      const cells = answering
        .map((r) => ((r.fieldCounts.get(f) ?? 0) > 0 ? "yes" : "NO ").padEnd(9))
        .join("");
      const universal = answering.every((r) => (r.fieldCounts.get(f) ?? 0) > 0);
      console.log(`  ${f.padEnd(32)}${cells}${universal ? "" : "  <- class-specific"}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
