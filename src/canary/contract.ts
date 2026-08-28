/**
 * Contract canaries — our early-warning system for upstream breaking changes.
 *
 * We depend on things the Videri API does not promise: undocumented keys inside
 * `super_props`, prose-described payload shapes, response fields with no declared
 * units. None of that carries a compatibility guarantee, so a routine Videri
 * release can break us with no notice and no obligation.
 *
 * This suite asserts, against the live API, that everything we rely on is still
 * there. Run it on a schedule. The point is that WE find out from our own
 * alerting, not from a customer noticing the health page went blank.
 *
 * Read-only: no writes, no device commands.
 */

import type { VideriHttp } from "../videri/http.js";
import { MetricsAdapter, type RawCanvas, type RawMetricsPayload } from "../videri/adapter.js";
import type { SpringPage } from "../videri/http.js";

export interface CanaryFinding {
  severity: "critical" | "warn" | "info";
  check: string;
  message: string;
}

export interface CanaryResult {
  ranAt: string;
  passed: boolean;
  findings: CanaryFinding[];
  /** Inferred-metric keys that resolved, so we can diff run over run. */
  resolvedMetricKeys: Record<string, string>;
}

/** Documented `ResponseCanvas` fields the product actually depends on. */
const REQUIRED_CANVAS_FIELDS = [
  "id",
  "device_id",
  "name",
  "last_online_time",
  "presence_status",
  "group_id",
  "tenant_name",
] as const;

/** Fields we treat as dependable on the metrics/status payload. */
const EXPECTED_METRIC_FIELDS = [
  "device_id",
  "is_screen_on",
  "is_black_screen",
  "showing_logo",
  "presence",
] as const;

export async function runContractCanary(http: VideriHttp): Promise<CanaryResult> {
  const findings: CanaryFinding[] = [];
  const resolvedMetricKeys: Record<string, string> = {};

  // ── 1. Can we authenticate and list devices at all? ──
  let devices: RawCanvas[] = [];
  try {
    const page = await http.request<SpringPage<RawCanvas>>("canvasService", "/canvases", {
      query: { page: 0, size: 5 },
    });
    devices = page.content ?? [];
    if (devices.length === 0) {
      findings.push({
        severity: "warn",
        check: "canvases.list",
        message: "GET /canvases returned an empty page. Either the tenant has no devices or filtering changed.",
      });
    }
  } catch (error) {
    findings.push({
      severity: "critical",
      check: "canvases.list",
      message: `GET /canvases failed: ${(error as Error).message}`,
    });
    return { ranAt: new Date().toISOString(), passed: false, findings, resolvedMetricKeys };
  }

  // ── 2. Are the documented device fields still present? ──
  const sample = devices[0];
  if (sample) {
    for (const field of REQUIRED_CANVAS_FIELDS) {
      if (!(field in sample)) {
        findings.push({
          severity: "critical",
          check: `canvas.field.${field}`,
          message: `ResponseCanvas no longer includes "${field}". This is a documented field we depend on.`,
        });
      }
    }
    if (!("core_services_versions" in sample)) {
      findings.push({
        severity: "warn",
        check: "canvas.field.core_services_versions",
        message: "core_services_versions is absent — firmware distribution will stop working.",
      });
    }
  }

  // ── 3. The untyped payload: did our inferred keys survive? ──
  const withDeviceId = devices.find((d) => d.device_id);
  if (!withDeviceId?.device_id) {
    findings.push({
      severity: "warn",
      check: "metrics.fetch",
      message: "No device in the sample page had a device_id, so metrics could not be checked.",
    });
  } else {
    try {
      const raw = await http.request<RawMetricsPayload>(
        "canvasStatus",
        `/metrics/fetch/${encodeURIComponent(withDeviceId.device_id)}`,
        { tenantHeaderStyle: "x-tenant_id" },
      );

      for (const field of EXPECTED_METRIC_FIELDS) {
        if (!(field in raw)) {
          findings.push({
            severity: "warn",
            check: `metrics.field.${field}`,
            message: `Metrics payload no longer includes "${field}".`,
          });
        }
      }

      const hasContainers = Boolean(raw.super_props) || Boolean(raw.status);
      if (!hasContainers) {
        findings.push({
          severity: "critical",
          check: "metrics.containers",
          message:
            "Neither super_props nor status was present. Every inferred metric will be unavailable — " +
            "this is the change that silently empties the health dashboard.",
        });
      }

      // Record which keys our adapter actually resolved. Diffing this field
      // between runs is how we detect Videri renaming an undocumented key.
      const adapter = new MetricsAdapter();
      const health = adapter.toHealthSample(String(withDeviceId.id ?? "unknown"), raw);
      for (const [name, observed] of Object.entries(health)) {
        if (
          observed &&
          typeof observed === "object" &&
          "provenance" in observed &&
          (observed as { provenance: { kind: string; sourceKey?: string } }).provenance.kind === "inferred"
        ) {
          const p = (observed as { provenance: { sourceKey?: string } }).provenance;
          if (p.sourceKey) resolvedMetricKeys[name] = p.sourceKey;
        }
      }

      if (Object.keys(resolvedMetricKeys).length === 0 && hasContainers) {
        findings.push({
          severity: "info",
          check: "metrics.inference",
          message:
            "super_props/status were present but no candidate key matched any metric. " +
            "Run `npm run discover` to capture the real vocabulary and update adapter.ts.",
        });
      }
    } catch (error) {
      findings.push({
        severity: "critical",
        check: "metrics.fetch",
        message: `metrics/fetch failed: ${(error as Error).message}`,
      });
    }
  }

  // ── 4. Alerting: is the alertType vocabulary still just two values? ──
  try {
    const alerts = await http.request<{ data?: Array<{ alertType?: string }> }>(
      "alerting",
      "/api/v1/alerts",
      { query: { page: 1, limit: 50 } },
    );
    const types = new Set((alerts.data ?? []).map((a) => a.alertType).filter(Boolean));
    const known = new Set(["offline", "showingLogo"]);
    for (const t of types) {
      if (t && !known.has(t)) {
        findings.push({
          severity: "info",
          check: "alerting.alertType",
          message: `New alertType observed: "${t}". The platform's alert vocabulary has expanded beyond offline|showingLogo — worth reviewing whether our detection engine should defer to it.`,
        });
      }
    }
  } catch (error) {
    findings.push({
      severity: "warn",
      check: "alerting.list",
      message: `GET /alerts failed: ${(error as Error).message}`,
    });
  }

  return {
    ranAt: new Date().toISOString(),
    passed: !findings.some((f) => f.severity === "critical"),
    findings,
    resolvedMetricKeys,
  };
}

export function renderCanary(result: CanaryResult): string {
  const lines = [
    "",
    `CONTRACT CANARY — ${result.ranAt} — ${result.passed ? "PASS" : "FAIL"}`,
    "─".repeat(72),
  ];
  if (result.findings.length === 0) lines.push("  All contract assertions held.");
  for (const f of result.findings) {
    lines.push(`  [${f.severity.toUpperCase().padEnd(8)}] ${f.check}`, `             ${f.message}`);
  }
  const resolved = Object.entries(result.resolvedMetricKeys);
  if (resolved.length > 0) {
    lines.push("", "  Resolved metric keys (diff these between runs):");
    for (const [metric, key] of resolved) lines.push(`    ${metric.padEnd(20)} ← ${key}`);
  }
  lines.push("");
  return lines.join("\n");
}
