/**
 * Fleet snapshot computation.
 *
 * Pre-computing these rollups is most of the perceived speed advantage over a
 * direct-to-API client: the platform has no aggregation endpoint above device
 * level, so a client without a store must fan out N calls per page view. We do
 * it once per tick and serve from a table.
 */

import type { Pool } from "pg";
import type { Repository } from "../db/repository.js";
import type { FleetSnapshot, DeviceStatus, Severity } from "../domain/types.js";

export async function computeFleetSnapshot(pool: Pool, repo: Repository): Promise<FleetSnapshot> {
  const [statusRows, classRows, firmwareRows, alertRows, coverageRows] = await Promise.all([
    pool.query<{ status: string | null; count: string }>(
      `SELECT hs.presence AS status, COUNT(*)::text AS count
         FROM devices d
         LEFT JOIN LATERAL (
           SELECT presence FROM health_samples
            WHERE device_id = d.id ORDER BY observed_at DESC LIMIT 1
         ) hs ON TRUE
        GROUP BY 1`,
    ),
    pool.query<{ device_class: string; count: string }>(
      `SELECT device_class, COUNT(*)::text AS count FROM devices GROUP BY 1`,
    ),
    pool.query<{ version: string | null; latest: string | null; count: string }>(
      `SELECT firmware_current AS version, MAX(firmware_latest) AS latest, COUNT(*)::text AS count
         FROM devices GROUP BY firmware_current ORDER BY COUNT(*) DESC`,
    ),
    pool.query<{ severity: string; count: string }>(
      `SELECT severity, COUNT(*)::text AS count
         FROM alerts WHERE resolved_at IS NULL GROUP BY 1`,
    ),
    // Coverage counts devices for which the METRICS poller resolved at least one
    // hardware value recently — not merely devices we have any row for. Those
    // are different questions and conflating them would overstate coverage.
    pool.query<{ total: string; covered: string }>(
      // "Covered" = a device we have a recent HARDWARE telemetry reading for.
      // The batch metrics feed (source='metrics' in health_samples) never carries
      // CPU/RAM/signal, so on its own this is structurally ~0. The slow-lane
      // poller writes the real per-device telemetry into device_telemetry, so a
      // device counts as covered if EITHER source has a recent non-null field.
      // As the slow lane sweeps, coverage climbs from 0 — honestly, per device.
      `SELECT (SELECT COUNT(*)::text FROM devices) AS total,
              (SELECT COUNT(*)::text FROM (
                 SELECT device_id FROM health_samples
                  WHERE source = 'metrics'
                    AND observed_at > now() - interval '1 hour'
                    AND (cpu_percent IS NOT NULL OR ram_percent IS NOT NULL
                         OR temperature_c IS NOT NULL OR wifi_signal_dbm IS NOT NULL
                         OR ntp_sync_percent IS NOT NULL)
                 UNION
                 SELECT device_id FROM device_telemetry
                  WHERE observed_at > now() - interval '3 hours'
                    AND (cpu_percent IS NOT NULL OR ram_used_percent IS NOT NULL
                         OR storage_used_percent IS NOT NULL OR rssi_dbm IS NOT NULL
                         OR ntp_offset_ms IS NOT NULL)
               ) AS covered_devices) AS covered`,
    ),
  ]);

  const byStatus: Record<DeviceStatus, number> = {
    online: 0, warning: 0, alert: 0, offline: 0, unknown: 0,
  };
  for (const row of statusRows.rows) {
    const key: DeviceStatus =
      row.status === "online" ? "online" : row.status === "offline" ? "offline" : "unknown";
    byStatus[key] += Number(row.count);
  }

  const byDeviceClass: Record<string, number> = {};
  for (const row of classRows.rows) byDeviceClass[row.device_class] = Number(row.count);

  const latest = firmwareRows.rows.find((r) => r.latest)?.latest ?? null;
  const firmwareDistribution = firmwareRows.rows.map((r) => ({
    version: r.version ?? "unknown",
    count: Number(r.count),
    isLatest: r.version !== null && r.version === latest,
  }));

  const openAlertsBySeverity: Record<Severity, number> = {
    critical: 0, high: 0, medium: 0, info: 0,
  };
  for (const row of alertRows.rows) {
    if (row.severity in openAlertsBySeverity) {
      openAlertsBySeverity[row.severity as Severity] = Number(row.count);
    }
  }

  const total = Number(coverageRows.rows[0]?.total ?? 0);
  const covered = Number(coverageRows.rows[0]?.covered ?? 0);

  const snapshot: FleetSnapshot = {
    computedAt: new Date(),
    totalDevices: total,
    byStatus,
    byDeviceClass,
    firmwareDistribution,
    openAlertsBySeverity,
    telemetryCoverage: total === 0 ? 0 : Number((covered / total).toFixed(3)),
  };

  await repo.saveFleetSnapshot(snapshot);
  return snapshot;
}
