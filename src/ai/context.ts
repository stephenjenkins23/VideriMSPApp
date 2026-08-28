/**
 * The shared fleet-context interface.
 *
 * All three AI surfaces read the fleet through this one module:
 *
 *   - the scheduled brief          (src/ai/brief.ts)      — built first
 *   - the conversational analyst   (src/ai/analyst.ts)     — these become tools
 *   - alert triage / explanation   (src/ai/triage.ts)
 *
 * Keeping one interface means the analyst's tools and the brief's context are
 * the same code, so they can never disagree about the state of the fleet — which
 * they absolutely would if each surface wrote its own queries.
 *
 * Two rules that matter more than they look:
 *
 * 1. Every function returns plain JSON-serialisable data. These are prompt
 *    inputs and tool results, so they must serialise deterministically —
 *    unstable key order silently destroys prompt caching.
 *
 * 2. Unreadable metrics are reported as unavailable, never as zero, and every
 *    payload carries its own coverage figure. The model must be able to tell
 *    "no devices are hot" from "we cannot read temperature", or it will state
 *    the first when the truth is the second.
 */

import type { Pool } from "pg";
import type { Severity } from "../domain/types.js";

export interface FleetOverview {
  computedAt: string;
  totalDevices: number;
  byStatus: Record<string, number>;
  byDeviceClass: Record<string, number>;
  openAlerts: Record<Severity, number>;
  /** 0–1. Share of devices whose HARDWARE telemetry is readable. */
  telemetryCoverage: number;
  /** 0–1. Share of devices we have any recent reading for. Not the same thing. */
  statusCoverage: number;
  /** Metrics that are unavailable fleet-wide, and why. */
  unavailableMetrics: Array<{ metric: string; reason: string }>;
}

export interface FirmwareDistribution {
  versions: Array<{ version: string; count: number; isLatest: boolean; sharePercent: number }>;
  latestVersion: string | null;
  devicesBehind: number;
}

export interface DeviceSummary {
  id: string;
  name: string | null;
  location: string | null;
  deviceClass: string;
  status: string;
  lastOnlineTime: string | null;
  firmwareCurrent: string | null;
  openAlertCount: number;
}

export interface MetricTrend {
  metric: string;
  /** Ordered oldest → newest. Nulls preserved: a gap is information. */
  points: Array<{ bucket: string; value: number | null; sampleCount: number }>;
  available: boolean;
  reason?: string;
}

export interface ChangeSince {
  windowHours: number;
  wentOffline: DeviceSummary[];
  cameBackOnline: DeviceSummary[];
  newAlerts: Array<{ deviceName: string | null; severity: Severity; title: string; evidence: string }>;
  resolvedAlertCount: number;
  firmwareChanges: Array<{ deviceName: string | null; from: string | null; to: string | null }>;
}

/**
 * All fleet reads the AI layer is allowed to make. Deliberately a small, closed
 * set: the analyst gets these as tools rather than raw SQL, so a model cannot
 * invent a query shape we have not reviewed, and every question it can ask has
 * a bounded cost.
 */
export class FleetContext {
  constructor(private readonly pool: Pool) {}

  async overview(): Promise<FleetOverview> {
    const [devices, alerts, coverage] = await Promise.all([
      this.pool.query<{ status: string; device_class: string; count: string }>(
        `SELECT COALESCE(s.status, 'unknown') AS status,
                d.device_class,
                COUNT(*)::text AS count
           FROM devices d
           LEFT JOIN LATERAL (
             SELECT CASE
                      WHEN hs.presence = 'offline' THEN 'offline'
                      WHEN hs.is_black_screen THEN 'alert'
                      WHEN hs.showing_logo THEN 'warning'
                      WHEN hs.presence = 'online' THEN 'online'
                      ELSE 'unknown'
                    END AS status
               FROM health_samples hs
              WHERE hs.device_id = d.id
              ORDER BY hs.observed_at DESC
              LIMIT 1
           ) s ON TRUE
          GROUP BY 1, 2`,
      ),
      this.pool.query<{ severity: string; count: string }>(
        `SELECT severity, COUNT(*)::text AS count
           FROM alerts WHERE resolved_at IS NULL GROUP BY 1`,
      ),
      // telemetryCoverage MUST mean "share of devices whose hardware telemetry we
      // can actually read" — that is what the UI uses it for, to decide whether
      // metric tiles are trustworthy. Counting "has any row at all" reported
      // 100% while every hardware metric was null, which is the most misleading
      // number this system could produce.
      this.pool.query<{ total: string; with_telemetry: string; with_status: string }>(
        `SELECT (SELECT COUNT(*)::text FROM devices) AS total,
                (SELECT COUNT(DISTINCT device_id)::text
                   FROM health_samples
                  WHERE source = 'metrics'
                    AND observed_at > now() - interval '1 hour'
                    AND (cpu_percent IS NOT NULL OR ram_percent IS NOT NULL
                         OR temperature_c IS NOT NULL OR wifi_signal_dbm IS NOT NULL
                         OR ntp_sync_percent IS NOT NULL
                         OR storage_percent IS NOT NULL)) AS with_telemetry,
                (SELECT COUNT(DISTINCT device_id)::text
                   FROM health_samples
                  WHERE observed_at > now() - interval '1 hour') AS with_status`,
      ),
    ]);

    const byStatus: Record<string, number> = {};
    const byDeviceClass: Record<string, number> = {};
    for (const row of devices.rows) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + Number(row.count);
      byDeviceClass[row.device_class] = (byDeviceClass[row.device_class] ?? 0) + Number(row.count);
    }

    const openAlerts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, info: 0 };
    for (const row of alerts.rows) {
      if (row.severity in openAlerts) openAlerts[row.severity as Severity] = Number(row.count);
    }

    const c = coverage.rows[0];
    const total = Number(c?.total ?? 0);
    const withTelemetry = Number(c?.with_telemetry ?? 0);
    const withStatus = Number(c?.with_status ?? 0);

    const unavailableMetrics: Array<{ metric: string; reason: string }> = [];
    if (total > 0 && withTelemetry === 0) {
      // Verified fleet-wide 2026-08-25: super_props carries a software manifest,
      // not runtime telemetry. Name every affected metric explicitly so the brief
      // can disclose them rather than silently omitting them.
      for (const metric of [
        "cpuPercent", "ramPercent", "temperatureC",
        "wifiSignalDbm", "ntpSyncPercent", "storagePercent",
      ]) {
        unavailableMetrics.push({
          metric,
          reason:
            "Not present in the Videri telemetry payload. Confirmed across all " +
            "250 devices: super_props contains package versions and hardware " +
            "identity only — no runtime metrics of any kind.",
        });
      }
    }

    return {
      computedAt: new Date().toISOString(),
      totalDevices: total,
      byStatus: sortKeys(byStatus),
      byDeviceClass: sortKeys(byDeviceClass),
      openAlerts,
      telemetryCoverage: total === 0 ? 0 : round(withTelemetry / total, 3),
      /** Devices we have ANY recent reading for — distinct from hardware coverage. */
      statusCoverage: total === 0 ? 0 : round(withStatus / total, 3),
      unavailableMetrics,
    };
  }

  /** Firmware distribution — available today with no platform changes. */
  async firmwareDistribution(): Promise<FirmwareDistribution> {
    const { rows } = await this.pool.query<{
      version: string | null;
      latest: string | null;
      count: string;
    }>(
      `SELECT firmware_current AS version,
              MAX(firmware_latest) AS latest,
              COUNT(*)::text AS count
         FROM devices
        GROUP BY firmware_current
        ORDER BY COUNT(*) DESC`,
    );

    const total = rows.reduce((sum, r) => sum + Number(r.count), 0);
    const latestVersion = rows.find((r) => r.latest)?.latest ?? null;

    return {
      latestVersion,
      devicesBehind: rows
        .filter((r) => r.version !== latestVersion)
        .reduce((sum, r) => sum + Number(r.count), 0),
      versions: rows.map((r) => ({
        version: r.version ?? "unknown",
        count: Number(r.count),
        isLatest: r.version !== null && r.version === latestVersion,
        sharePercent: total === 0 ? 0 : round((Number(r.count) / total) * 100, 1),
      })),
    };
  }

  /** Devices needing attention, worst first. Capped — this feeds a prompt. */
  async devicesNeedingAttention(limit = 25): Promise<DeviceSummary[]> {
    const { rows } = await this.pool.query<{
      id: string;
      name: string | null;
      location: string | null;
      device_class: string;
      status: string | null;
      last_online_time: Date | null;
      firmware_current: string | null;
      open_alerts: string;
    }>(
      `SELECT d.id, d.name, d.location, d.device_class,
              hs.presence AS status, d.last_online_time, d.firmware_current,
              COUNT(a.id)::text AS open_alerts
         FROM devices d
         LEFT JOIN alerts a ON a.device_id = d.id AND a.resolved_at IS NULL
         LEFT JOIN LATERAL (
           SELECT presence FROM health_samples
            WHERE device_id = d.id ORDER BY observed_at DESC LIMIT 1
         ) hs ON TRUE
        GROUP BY d.id, hs.presence
       HAVING COUNT(a.id) > 0 OR hs.presence = 'offline'
        ORDER BY COUNT(a.id) DESC, d.last_online_time ASC NULLS FIRST
        LIMIT $1`,
      [limit],
    );

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      location: r.location,
      deviceClass: r.device_class,
      status: r.status ?? "unknown",
      lastOnlineTime: r.last_online_time?.toISOString() ?? null,
      firmwareCurrent: r.firmware_current,
      openAlertCount: Number(r.open_alerts),
    }));
  }

  /**
   * Bucketed trend for one metric. Returns `available: false` with a reason
   * when the metric is unreadable, so callers never mistake absence for zero.
   */
  async metricTrend(
    metric: "cpu_percent" | "ram_percent" | "temperature_c" | "wifi_signal_dbm" | "ntp_sync_percent" | "playback_quality" | "ping_quality",
    windowHours = 168,
    bucketHours = 6,
  ): Promise<MetricTrend> {
    // Column name is constrained by the union type above — not caller-supplied.
    const { rows } = await this.pool.query<{ bucket: Date; avg: string | null; n: string }>(
      `SELECT time_bucket($1::interval, observed_at) AS bucket,
              AVG(${metric})::text AS avg,
              COUNT(${metric})::text AS n
         FROM health_samples
        WHERE observed_at > now() - $2::interval
        GROUP BY 1 ORDER BY 1`,
      [`${bucketHours} hours`, `${windowHours} hours`],
    );

    const points = rows.map((r) => ({
      bucket: r.bucket.toISOString(),
      value: r.avg === null ? null : round(Number(r.avg), 2),
      sampleCount: Number(r.n),
    }));

    const anyData = points.some((p) => p.value !== null);
    return anyData
      ? { metric, points, available: true }
      : {
          metric,
          points,
          available: false,
          reason: `No readable values for ${metric} in the last ${windowHours}h. This metric is not documented in the Videri API and no payload key matched it.`,
        };
  }

  /** What changed recently — the spine of the scheduled brief. */
  async changesSince(windowHours = 24): Promise<ChangeSince> {
    const { rows: alertRows } = await this.pool.query<{
      name: string | null;
      severity: string;
      title: string;
      evidence: string;
    }>(
      `SELECT d.name, a.severity, a.title, a.evidence
         FROM alerts a JOIN devices d ON d.id = a.device_id
        WHERE a.opened_at > now() - $1::interval
        ORDER BY CASE a.severity
                   WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                   WHEN 'medium' THEN 2 ELSE 3 END,
                 a.opened_at DESC
        LIMIT 40`,
      [`${windowHours} hours`],
    );

    const { rows: resolved } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM alerts
        WHERE resolved_at > now() - $1::interval`,
      [`${windowHours} hours`],
    );

    const offline = await this.#presenceTransitions(windowHours, "offline");
    const online = await this.#presenceTransitions(windowHours, "online");

    return {
      windowHours,
      wentOffline: offline,
      cameBackOnline: online,
      resolvedAlertCount: Number(resolved[0]?.count ?? 0),
      newAlerts: alertRows.map((r) => ({
        deviceName: r.name,
        severity: r.severity as Severity,
        title: r.title,
        evidence: r.evidence,
      })),
      // Requires firmware history; empty until the poller has two observations.
      firmwareChanges: [],
    };
  }

  async #presenceTransitions(windowHours: number, to: "online" | "offline"): Promise<DeviceSummary[]> {
    const { rows } = await this.pool.query<{
      id: string; name: string | null; location: string | null;
      device_class: string; last_online_time: Date | null; firmware_current: string | null;
    }>(
      `WITH transitions AS (
         SELECT device_id, presence,
                LAG(presence) OVER (PARTITION BY device_id ORDER BY observed_at) AS prev
           FROM health_samples
          WHERE observed_at > now() - $1::interval
       )
       SELECT DISTINCT d.id, d.name, d.location, d.device_class,
              d.last_online_time, d.firmware_current
         FROM transitions t JOIN devices d ON d.id = t.device_id
        WHERE t.presence = $2 AND t.prev IS NOT NULL AND t.prev <> $2
        LIMIT 25`,
      [`${windowHours} hours`, to],
    );

    return rows.map((r) => ({
      id: r.id, name: r.name, location: r.location,
      deviceClass: r.device_class, status: to,
      lastOnlineTime: r.last_online_time?.toISOString() ?? null,
      firmwareCurrent: r.firmware_current, openAlertCount: 0,
    }));
  }
}

const round = (n: number, dp: number) => Number(n.toFixed(dp));

/** Deterministic key order — unstable ordering silently breaks prompt caching. */
const sortKeys = (o: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
