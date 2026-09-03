/**
 * All SQL writes live here.
 *
 * Two things this file is careful about:
 *
 * 1. **Multi-row inserts.** A per-device round trip would be 1,247 queries per
 *    tick. Everything is chunked into multi-row statements, sized to stay under
 *    Postgres's 65,535-parameter limit.
 *
 * 2. **Idempotency.** Every write is an upsert or an ON CONFLICT DO NOTHING, so
 *    a retried batch or an overlapping tick cannot corrupt anything or double
 *    count. The poller assumes it will be restarted mid-run.
 *
 * 3. **Retired devices are excluded from every fleet-wide read.** A row with
 *    `retired_at` set is a device the platform no longer has (soft-deleted by the
 *    discovery reconcile, see pipeline/pollers/retirement.ts). It stays for its
 *    history, but it must never inflate a count, be polled, be alerted on, or be
 *    measured for SLA. Lookups BY ID deliberately still resolve — a deep link to a
 *    retired device should show its last known state, not a 404.
 */

import type { Pool, PoolClient } from "pg";
import type { Device, HealthSample, DataUsageDay, FleetSnapshot, Severity } from "../domain/types.js";
import type { DiscoveredKey } from "../videri/adapter.js";

/** Postgres caps a statement at 65,535 bound parameters. */
const MAX_PARAMS = 60_000;

const chunkForColumns = <T>(rows: T[], columnsPerRow: number): T[][] => {
  const perChunk = Math.max(1, Math.floor(MAX_PARAMS / columnsPerRow));
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += perChunk) out.push(rows.slice(i, i + perChunk));
  return out;
};

/** Builds `($1,$2,$3),($4,$5,$6)` for a multi-row VALUES clause. */
const placeholders = (rowCount: number, columnCount: number): string =>
  Array.from(
    { length: rowCount },
    (_, r) => `(${Array.from({ length: columnCount }, (_, c) => `$${r * columnCount + c + 1}`).join(",")})`,
  ).join(",");

/**
 * ── device action log (audit trail) ─────────────────────────────────────────
 *
 * `device_action_log` records what WE did — every attempted device write, with
 * the value we asked for, the value we read back, and how it ended. See
 * migrations/009-device-action-log.sql.
 */

/**
 * Closed outcome vocabulary, matched by a CHECK constraint on the table.
 *
 * `refused` means the device was never touched (we declined); `failed` means we
 * tried and it did not work. Collapsing the two would make "everything that
 * failed" a question with no honest answer.
 */
export type DeviceActionOutcome =
  | "applied"
  | "verified"
  | "no_change"
  | "rolled_back"
  | "rollback_failed"
  | "refused"
  | "failed";

export const DEVICE_ACTION_OUTCOMES: readonly DeviceActionOutcome[] = [
  "applied", "verified", "no_change", "rolled_back", "rollback_failed",
  "refused", "failed",
] as const;

/**
 * Default retention for the audit log: two years, with a one-year floor.
 * See `pruneDeviceActionLog` for why this lives apart from `pruneTimeSeries`.
 */
export const AUDIT_RETAIN_DAYS = 730;
export const AUDIT_MIN_RETAIN_DAYS = 365;

export interface DeviceActionEntry {
  /** Our operation vocabulary: 'brightness_write' | 'device_command' | … */
  action: string;
  /** What actually went on the wire, when there was a wire call at all. */
  verb?: string | null;
  deviceId: string;
  /** Requested and read-back values as text. NULL = not applicable or UNREADABLE. */
  requestedValue?: string | null;
  observedValue?: string | null;
  params?: Record<string, unknown>;
  detail?: Record<string, unknown>;
  outcome: DeviceActionOutcome;
  /** Who or what initiated it. No user model exists yet; see resolveActor(). */
  actor: string;
  actorIp?: string | null;
  startedAt: Date;
  finishedAt?: Date;
  durationMs?: number | null;
  error?: string | null;
}

export interface DeviceActionRow {
  id: number;
  action: string;
  verb: string | null;
  deviceId: string;
  /** Null when the device row is gone — the audit row outlives it by design. */
  deviceName: string | null;
  requestedValue: string | null;
  observedValue: string | null;
  params: Record<string, unknown>;
  detail: Record<string, unknown>;
  outcome: DeviceActionOutcome;
  actor: string;
  actorIp: string | null;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number | null;
  error: string | null;
}

export interface DeviceActionFilters {
  deviceId?: string | undefined;
  actor?: string | undefined;
  /** Any of these outcomes. Empty/absent means every outcome. */
  outcome?: DeviceActionOutcome[] | undefined;
  action?: string | undefined;
  /** Half-open window [since, until) on `started_at`. */
  since?: Date | undefined;
  until?: Date | undefined;
  page: number;
  limit: number;
}

interface DeviceActionSqlRow {
  id: string;
  action: string;
  verb: string | null;
  device_id: string;
  device_name: string | null;
  requested_value: string | null;
  observed_value: string | null;
  params: Record<string, unknown> | null;
  detail: Record<string, unknown> | null;
  outcome: string;
  actor: string;
  actor_ip: string | null;
  started_at: Date;
  finished_at: Date;
  duration_ms: number | null;
  error: string | null;
}

export interface EvaluationDevice {
  id: string;
  name: string | null;
  location: string | null;
  firmwareCurrent: string | null;
  firmwareLatest: string | null;
  components: Record<string, { current: string | null; latest: string | null }>;
  lastOnlineTime: Date | null;
}

export interface EvaluationSample {
  observedAt: Date;
  source: string;
  presence: string | null;
  isScreenOn: boolean | null;
  isBlackScreen: boolean | null;
  showingLogo: boolean | null;
  downloading: boolean | null;
  pingQuality: string | null;
  playbackQuality: string | null;
  nowPlayingType: string | null;
  nowPlayingId: string | null;
  cpuPercent: number | null;
  ramPercent: number | null;
  temperatureC: number | null;
  wifiSignalDbm: number | null;
  packetLossPercent: number | null;
  jitterMs: number | null;
  ntpSyncPercent: number | null;
  storagePercent: number | null;
}

interface EvaluationJoinRow {
  id: string;
  name: string | null;
  location: string | null;
  firmware_current: string | null;
  firmware_latest: string | null;
  last_online_time: Date | null;
  observed_at: Date | null;
  source: string | null;
  presence: string | null;
  is_screen_on: boolean | null;
  is_black_screen: boolean | null;
  showing_logo: boolean | null;
  downloading: boolean | null;
  ping_quality: string | null;
  playback_quality: string | null;
  now_playing_type: string | null;
  now_playing_id: string | null;
  components: Record<string, { current: string | null; latest: string | null }> | null;
  cpu_percent: string | number | null;
  ram_percent: string | number | null;
  temperature_c: string | number | null;
  wifi_signal_dbm: string | number | null;
  packet_loss_percent: string | number | null;
  jitter_ms: string | number | null;
  ntp_sync_percent: string | number | null;
  storage_percent: string | number | null;
}

/** One `poller_runs` row as the pipeline-health check reads it. */
export interface PollerRunHistoryRow {
  poller: string;
  startedAt: Date;
  durationMs: number;
  devicesTargeted: number;
  rowsWritten: number;
  batchesOk: number;
  batchesFailed: number;
  telemetryYield: number | null;
}

export interface OpenAlertRow {
  id: string;
  device_id: string;
  rule_id: string;
  severity: string;
  title: string;
  evidence: string;
  opened_at: Date;
  last_fired_at: Date;
  acknowledged_at: Date | null;
}

export interface SlaAggregateRow {
  deviceId: string;
  name: string | null;
  observedBuckets: number;
  onlineBuckets: number;
  expectedBuckets: number;
  longestGapSeconds: number;
  stalenessSeconds: number | null;
}

export interface SettingsTargetRow {
  id: string;
  deviceId: string;
  deviceJid: string | null;
  playerId: string | null;
  deviceClass: string;
}

export interface ComplianceInputRow {
  id: string;
  deviceClass: string;
  assignedTemplateId: string | null;
  settings: unknown;
  settingsAgeSeconds: number;
}

export interface PollTarget {
  /** Canvas UUID — our primary key. */
  id: string;
  /** Physical device id, required by canvas-status. */
  deviceId: string;
  /** XMPP JID, required for routing. Null means this device cannot be polled. */
  deviceJid: string | null;
}

export class Repository {
  constructor(private readonly pool: Pool) {}

  // ── devices ───────────────────────────────────────────────────────────────

  private static readonly DEVICE_COLUMNS = [
    "id", "device_id", "device_jid", "name", "device_class", "model_type",
    "product_name", "vendor", "serial_no", "tenant_code", "group_id", "group_name",
    "account_name", "location", "latitude", "longitude", "timezone", "orientation",
    "screen_width", "screen_height", "firmware_current", "firmware_latest",
    "license_status", "license_expiration", "first_activated", "last_online_time",
    "status_changed_time", "tags", "components", "firmware_build_id",
    "firmware_incremental_version", "metafields", "city",
  ] as const;

  async upsertDevices(devices: Device[]): Promise<number> {
    if (devices.length === 0) return 0;
    const cols = Repository.DEVICE_COLUMNS;
    let written = 0;

    for (const chunk of chunkForColumns(devices, cols.length)) {
      const values = chunk.flatMap((d) => [
        d.id, d.deviceId, d.deviceJid, d.name, d.deviceClass, d.modelType,
        d.productName, d.vendor, d.serialNo, d.tenantCode, d.groupId, d.groupName,
        d.accountName, d.location, d.latitude, d.longitude, d.timezone, d.orientation,
        d.screenWidth, d.screenHeight, d.firmwareCurrent, d.firmwareLatest,
        d.licenseStatus, nullableTimestamp(d.licenseExpiration),
        nullableTimestamp(d.firstActivated), nullableTimestamp(d.lastOnlineTime),
        nullableTimestamp(d.statusChangedTime), d.tags,
        JSON.stringify(d.components ?? {}), d.firmwareBuildId,
        d.firmwareIncrementalVersion,
        JSON.stringify(d.metafields ?? {}), d.city,
      ]);

      // Every column except id is refreshed; first_seen_at is deliberately not
      // touched so we keep a true "when did we first observe this device".
      const updates = cols
        .filter((c) => c !== "id")
        .map((c) => `${c} = EXCLUDED.${c}`)
        .join(", ");

      const result = await this.pool.query(
        `INSERT INTO devices (${cols.join(",")})
         VALUES ${placeholders(chunk.length, cols.length)}
         ON CONFLICT (id) DO UPDATE SET ${updates}, last_synced_at = now()`,
        values,
      );
      written += result.rowCount ?? 0;
    }
    return written;
  }

  /**
   * The registry split by retirement state, for the discovery reconcile.
   *
   * Both halves are needed: `active` is the set a sweep's absence could retire,
   * `retired` is the set a sweep's presence must bring back. Returning ids only
   * (not rows) keeps this a few KB at fleet scale.
   */
  async deviceRetirementState(): Promise<{ active: string[]; retired: string[] }> {
    const { rows } = await this.pool.query<{ id: string; retired: boolean }>(
      `SELECT id, retired_at IS NOT NULL AS retired FROM devices ORDER BY id`,
    );
    const active: string[] = [];
    const retired: string[] = [];
    for (const row of rows) (row.retired ? retired : active).push(row.id);
    return { active, retired };
  }

  /**
   * Apply a retirement plan. Soft only — there is no DELETE path here by design.
   *
   * Both statements are idempotent and guarded on the current state, so re-running
   * a tick cannot double-count and a concurrent poll cannot flip a row twice. The
   * returned counts are rows actually CHANGED, not rows asked about.
   */
  async applyRetirement(
    retire: readonly string[],
    unretire: readonly string[],
  ): Promise<{ retired: number; unretired: number }> {
    let retired = 0;
    let unretired = 0;
    if (retire.length > 0) {
      const { rowCount } = await this.pool.query(
        `UPDATE devices SET retired_at = now()
          WHERE id = ANY($1::text[]) AND retired_at IS NULL`,
        [retire],
      );
      retired = rowCount ?? 0;
    }
    if (unretire.length > 0) {
      const { rowCount } = await this.pool.query(
        `UPDATE devices SET retired_at = NULL
          WHERE id = ANY($1::text[]) AND retired_at IS NOT NULL`,
        [unretire],
      );
      unretired = rowCount ?? 0;
    }
    return { retired, unretired };
  }

  /**
   * Everything sync_command needs to address one device.
   *
   * `player_id` is a THIRD identifier, distinct from both our row id and
   * device_id, and it is learned from a command response rather than the device
   * list. Passing device_id works on the first call, so a device we have never
   * commanded is still addressable.
   */
  async commandTarget(id: string): Promise<
    { deviceId: string; deviceJid: string | null; playerId: string | null } | null
  > {
    const { rows } = await this.pool.query<{
      device_id: string | null; device_jid: string | null; player_id: string | null;
    }>(
      `SELECT device_id, device_jid, player_id FROM devices WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row || !row.device_id) return null;
    return { deviceId: row.device_id, deviceJid: row.device_jid, playerId: row.player_id };
  }

  /**
   * Devices worth asking the screenshot CDN about.
   *
   * Keyed by hardware serial, so a device without one is unaddressable there and
   * is excluded rather than returned as a broken tile.
   */
  async screenshotTargets(onlineOnly: boolean, limit: number): Promise<
    Array<{
      id: string; name: string | null; serialNo: string | null;
      deviceClass: string; online: boolean;
      isBlackScreen: boolean | null; showingLogo: boolean | null;
      nowPlayingId: string | null; requestedAt: string | null;
    }>
  > {
    // Latest reading carries the content-state flags (is_black_screen, showing_logo)
    // that let the wall surface anomalies alongside the image. A device that is
    // black or on the logo is what an operator actually wants to see first.
    const { rows } = await this.pool.query<{
      id: string; name: string | null; serial_no: string | null;
      device_class: string; online: boolean;
      is_black_screen: boolean | null; showing_logo: boolean | null;
      now_playing_id: string | null; screenshot_requested_at: Date | null;
    }>(
      `SELECT d.id, d.name, d.serial_no, d.device_class, d.screenshot_requested_at,
              EXISTS (SELECT 1 FROM health_samples h
                       WHERE h.device_id = d.id AND h.presence = 'online'
                         AND h.observed_at > now() - interval '30 minutes') AS online,
              latest.is_black_screen, latest.showing_logo, latest.now_playing_id
         FROM devices d
         LEFT JOIN LATERAL (
           SELECT is_black_screen, showing_logo, now_playing_id
             FROM health_samples h WHERE h.device_id = d.id
            ORDER BY observed_at DESC LIMIT 1
         ) latest ON true
        WHERE d.serial_no IS NOT NULL AND d.retired_at IS NULL
        ORDER BY online DESC, d.last_online_time DESC NULLS LAST
        LIMIT $1`,
      [limit * (onlineOnly ? 3 : 1)],
    );
    const mapped = rows.map((r) => ({
      id: r.id, name: r.name, serialNo: r.serial_no,
      deviceClass: r.device_class, online: r.online,
      isBlackScreen: r.is_black_screen, showingLogo: r.showing_logo,
      nowPlayingId: r.now_playing_id,
      requestedAt: r.screenshot_requested_at?.toISOString() ?? null,
    }));
    return (onlineOnly ? mapped.filter((d) => d.online) : mapped).slice(0, limit);
  }

  /**
   * The next batch to ask for a fresh capture, oldest-request-first.
   *
   * Online only — an offline device cannot capture. Ordering by
   * `screenshot_requested_at ASC NULLS FIRST` means devices never asked go first,
   * then the least-recently-asked, so the sweep round-robins through the online
   * estate without a stored cursor.
   */
  async evidenceCaptureTargets(batchSize: number): Promise<
    Array<{ id: string; deviceId: string; deviceJid: string | null; playerId: string | null }>
  > {
    const { rows } = await this.pool.query<{
      id: string; device_id: string; device_jid: string | null; player_id: string | null;
    }>(
      `SELECT d.id, d.device_id, d.device_jid, d.player_id
         FROM devices d
        WHERE d.device_jid IS NOT NULL
          AND d.retired_at IS NULL
          AND EXISTS (SELECT 1 FROM health_samples h
                       WHERE h.device_id = d.id AND h.presence = 'online'
                         AND h.observed_at > now() - interval '30 minutes')
        ORDER BY d.screenshot_requested_at ASC NULLS FIRST
        LIMIT $1`,
      [batchSize],
    );
    return rows.map((r) => ({
      id: r.id, deviceId: r.device_id, deviceJid: r.device_jid, playerId: r.player_id,
    }));
  }

  /**
   * A single device's capture target, for the drawer's on-demand "capture fresh"
   * button — the one-device sibling of `evidenceCaptureTargets`.
   *
   * Returns null when the device cannot honestly be captured: unknown id, no
   * `device_jid` (nothing to route the capture command to), or no `serial_no`
   * (the CDN key the fresh frame is stored under — without it we could ask for a
   * capture but never read it back). The route turns that null into a specific
   * 4xx rather than attempting a capture it cannot complete. No online gate here:
   * an operator staring at one device's drawer may well be trying to wake a
   * flaky one, and pollEvidenceCapture already degrades to a timeout if it is
   * offline — which is more useful than refusing outright.
   */
  async evidenceCaptureTarget(deviceId: string): Promise<
    { id: string; deviceId: string; deviceJid: string | null; playerId: string | null; serialNo: string | null } | null
  > {
    const { rows } = await this.pool.query<{
      id: string; device_id: string; device_jid: string | null;
      player_id: string | null; serial_no: string | null;
    }>(
      `SELECT d.id, d.device_id, d.device_jid, d.player_id, d.serial_no
         FROM devices d
        WHERE d.id = $1
        LIMIT 1`,
      [deviceId],
    );
    const r = rows[0];
    if (!r || !r.device_jid || !r.serial_no) return null;
    return {
      id: r.id, deviceId: r.device_id, deviceJid: r.device_jid,
      playerId: r.player_id, serialNo: r.serial_no,
    };
  }

  /**
   * The next batch of devices to read runtime telemetry from, stalest-first.
   *
   * The slow-lane sibling of `evidenceCaptureTargets`: same round-robin idea,
   * different cursor. Instead of a `screenshot_requested_at` column on `devices`
   * we order by the newest `device_telemetry.observed_at` we already hold, NULLS
   * FIRST — so a device we have never read goes to the front, then the one read
   * longest ago. Reading a device inserts a fresh row, which moves it to the back
   * of the queue for free, so a full sweep of the online estate completes in
   * (online / batch) ticks and then loops.
   *
   * Online only — an offline device answers no demo_command and would burn the
   * per-field timeouts to learn nothing — and `device_jid` required, since that
   * is what routes the command.
   */
  async telemetrySlowLaneTargets(batchSize: number): Promise<
    Array<{ id: string; deviceId: string; deviceJid: string | null; playerId: string | null }>
  > {
    const { rows } = await this.pool.query<{
      id: string; device_id: string; device_jid: string | null; player_id: string | null;
    }>(
      `SELECT d.id, d.device_id, d.device_jid, d.player_id
         FROM devices d
         LEFT JOIN LATERAL (
           SELECT observed_at FROM device_telemetry t
            WHERE t.device_id = d.id
            ORDER BY observed_at DESC LIMIT 1
         ) latest ON true
        WHERE d.device_jid IS NOT NULL
          AND d.retired_at IS NULL
          AND EXISTS (SELECT 1 FROM health_samples h
                       WHERE h.device_id = d.id AND h.presence = 'online'
                         AND h.observed_at > now() - interval '30 minutes')
        ORDER BY latest.observed_at ASC NULLS FIRST
        LIMIT $1`,
      [batchSize],
    );
    return rows.map((r) => ({
      id: r.id, deviceId: r.device_id, deviceJid: r.device_jid, playerId: r.player_id,
    }));
  }

  /** Persist a runtime-telemetry reading (demo_command slow lane). */
  async saveTelemetry(
    deviceId: string,
    t: {
      cpuPercent: number | null; ramUsedPercent: number | null;
      ramTotalGb: number | null; ramFreeGb: number | null;
      storageUsedPercent: number | null; storageTotalMb: number | null;
      rssiDbm: number | null; ntpOffsetMs: number | null;
      ntpReach: number | null; ntpServer: string | null; read: string[];
    },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO device_telemetry
         (device_id, cpu_percent, ram_used_percent, ram_total_gb, ram_free_gb,
          storage_used_percent, storage_total_mb, rssi_dbm, ntp_offset_ms,
          ntp_reach, ntp_server, fields_read)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [deviceId, t.cpuPercent, t.ramUsedPercent, t.ramTotalGb, t.ramFreeGb,
       t.storageUsedPercent, t.storageTotalMb, t.rssiDbm, t.ntpOffsetMs,
       t.ntpReach, t.ntpServer, t.read],
    );
  }

  /**
   * The next batch of devices to read a schedule for, stalest-persisted first.
   *
   * The schedule slow-lane sibling of `telemetrySlowLaneTargets`: same round-robin
   * idea (order by the newest `device_schedule.observed_at` we already hold, NULLS
   * FIRST, so a device we have never fetched a schedule for goes to the front),
   * but NOT online-only. A canvas has a platform schedule whether or not it is
   * currently reachable — the publisher's per-canvas events endpoint is a control-
   * plane read, not a device command — so every device is a candidate and gap
   * detection can cover the whole fleet, not just the estate that happens to be
   * online right now. Fetching a device inserts a fresh row, moving it to the back
   * of the queue, so repeated ticks sweep the fleet in (total / batch) ticks.
   */
  async scheduleSlowLaneTargets(
    batchSize: number,
  ): Promise<Array<{ id: string; name: string | null }>> {
    const { rows } = await this.pool.query<{ id: string; name: string | null }>(
      `SELECT d.id, d.name
         FROM devices d
         LEFT JOIN LATERAL (
           SELECT observed_at FROM device_schedule s
            WHERE s.device_id = d.id
            ORDER BY observed_at DESC LIMIT 1
         ) latest ON true
        WHERE d.retired_at IS NULL
        ORDER BY latest.observed_at ASC NULLS FIRST, d.id
        LIMIT $1`,
      [batchSize],
    );
    return rows.map((r) => ({ id: r.id, name: r.name }));
  }

  /** Persist a "scheduled now" snapshot read from the publisher (schedule slow lane). */
  async saveSchedule(
    deviceId: string,
    s: {
      date: string;
      scheduledCount: number;
      hasActiveSchedule: boolean;
      scheduledItems: unknown[];
      fetchedAt: Date;
    },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO device_schedule
         (device_id, schedule_date, scheduled_count, has_active_schedule,
          scheduled_items, fetched_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [
        deviceId, s.date, s.scheduledCount, s.hasActiveSchedule,
        JSON.stringify(s.scheduledItems), s.fetchedAt,
      ],
    );
  }

  /**
   * The next batch of devices whose black-screen CLAIM is worth verifying.
   *
   * Deliberately the narrowest target set in the codebase, because the cost of a
   * wrong one is measured in wall-clock seconds. Two filters do the work:
   *
   *   reachable — the LATEST presence sample must be `online`, the same idiom
   *     `listSettingsTargets` uses. Measured 2026-09-01: 8 of the 9 devices
   *     flagged `is_black_screen = true` were offline, and an unanswered
   *     demo_command verb costs ~11s of timeout against ~0.6s when answered. So
   *     verifying the flagged fleet would spend ~90s to learn nothing, while
   *     verifying the reachable subset costs about a second. Note this is the
   *     STRICT reading of online — not `telemetrySlowLaneTargets`' "was online
   *     in the last 30 minutes" — because a claim is only refutable by a panel
   *     that can answer right now.
   *
   *   claiming black — the newest READABLE `is_black_screen` sample must be
   *     true. There is nothing to verify otherwise, and `verifyBlackScreenClaim`
   *     would return `no-claim`; spending a device command to hear that would be
   *     pure waste. Samples where the flag is NULL are skipped rather than read
   *     as false, so an unreadable flag never masquerades as "not black".
   *
   * Rotation is stalest-verdict-first (NULLS FIRST, so a never-verified device
   * leads), and saving a verdict moves the device to the back of the queue for
   * free — the same cursor trick as the telemetry and schedule lanes.
   *
   * `claimObservedAt` comes back with the target so the lane persists the exact
   * sample it tested against, rather than re-reading a row that may have moved.
   */
  async screenVerifyTargets(batchSize: number): Promise<
    Array<{
      id: string;
      deviceId: string;
      deviceJid: string | null;
      playerId: string | null;
      name: string | null;
      platformClaim: boolean;
      claimObservedAt: Date;
    }>
  > {
    const { rows } = await this.pool.query<{
      id: string; device_id: string; device_jid: string | null;
      player_id: string | null; name: string | null;
      is_black_screen: boolean; claim_observed_at: Date;
    }>(
      `SELECT d.id, d.device_id, d.device_jid, d.player_id, d.name,
              claim.is_black_screen, claim.observed_at AS claim_observed_at
         FROM devices d
         JOIN LATERAL (
           SELECT presence FROM health_samples
            WHERE device_id = d.id ORDER BY observed_at DESC LIMIT 1
         ) hs ON hs.presence = 'online'
         JOIN LATERAL (
           SELECT is_black_screen, observed_at FROM health_samples
            WHERE device_id = d.id AND is_black_screen IS NOT NULL
            ORDER BY observed_at DESC LIMIT 1
         ) claim ON claim.is_black_screen
         LEFT JOIN LATERAL (
           SELECT observed_at FROM device_screen_verdict v
            WHERE v.device_id = d.id
            ORDER BY observed_at DESC LIMIT 1
         ) latest ON true
        WHERE d.device_id IS NOT NULL
          AND d.device_jid IS NOT NULL
          AND d.retired_at IS NULL
        ORDER BY latest.observed_at ASC NULLS FIRST, d.id
        LIMIT $1`,
      [batchSize],
    );
    return rows.map((r) => ({
      id: r.id,
      deviceId: r.device_id,
      deviceJid: r.device_jid,
      playerId: r.player_id,
      name: r.name,
      platformClaim: r.is_black_screen,
      claimObservedAt: r.claim_observed_at,
    }));
  }

  /** Persist one screen-check verdict (verification slow lane). */
  async saveScreenVerdict(
    deviceId: string,
    v: {
      platformClaim: boolean | null;
      deviceIsBlack: boolean | null;
      deviceIsShowingLogo: boolean | null;
      verdict: string;
      detail: string;
      verbsRead: string[];
      observedAt: Date;
    },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO device_screen_verdict
         (device_id, observed_at, platform_claim, device_is_black,
          device_is_showing_logo, verdict, detail, verbs_read)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (device_id, observed_at) DO NOTHING`,
      [deviceId, v.observedAt, v.platformClaim, v.deviceIsBlack,
       v.deviceIsShowingLogo, v.verdict, v.detail, v.verbsRead],
    );
  }

  /**
   * The newest verdict per device, for the alerting engine.
   *
   * One query for the whole fleet rather than one per device: the engine already
   * loads every device's samples in a single call and must not turn into N+1
   * round-trips just to learn whether a claim was checked. Retired devices are
   * excluded, matching `loadEvaluationInput`.
   *
   * `detail` is deliberately NOT returned. The engine writes its own evidence
   * sentence from the verdict and the two timestamps; carrying a second prose
   * field would give the same alert two competing narratives.
   */
  async latestScreenVerdicts(): Promise<
    Map<string, { verdict: string; observedAt: Date; deviceIsBlack: boolean | null }>
  > {
    const { rows } = await this.pool.query<{
      device_id: string; verdict: string; observed_at: Date; device_is_black: boolean | null;
    }>(
      `SELECT d.id AS device_id, v.verdict, v.observed_at, v.device_is_black
         FROM devices d
         JOIN LATERAL (
           SELECT verdict, observed_at, device_is_black
             FROM device_screen_verdict
            WHERE device_id = d.id
            ORDER BY observed_at DESC LIMIT 1
         ) v ON true
        WHERE d.retired_at IS NULL`,
    );
    return new Map(
      rows.map((r) => [
        r.device_id,
        { verdict: r.verdict, observedAt: r.observed_at, deviceIsBlack: r.device_is_black },
      ]),
    );
  }

  /** Latest cached telemetry for one device, if any. */
  async latestTelemetry(deviceId: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.pool.query(
      `SELECT observed_at, cpu_percent, ram_used_percent, ram_total_gb, ram_free_gb,
              storage_used_percent, storage_total_mb, rssi_dbm, ntp_offset_ms,
              ntp_reach, ntp_server, fields_read
         FROM device_telemetry WHERE device_id = $1
        ORDER BY observed_at DESC LIMIT 1`,
      [deviceId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      observedAt: (r["observed_at"] as Date).toISOString(),
      cpuPercent: r["cpu_percent"], ramUsedPercent: r["ram_used_percent"],
      ramTotalGb: r["ram_total_gb"] === null ? null : Number(r["ram_total_gb"]),
      ramFreeGb: r["ram_free_gb"] === null ? null : Number(r["ram_free_gb"]),
      storageUsedPercent: r["storage_used_percent"], storageTotalMb: r["storage_total_mb"],
      rssiDbm: r["rssi_dbm"],
      ntpOffsetMs: r["ntp_offset_ms"] === null ? null : Number(r["ntp_offset_ms"]),
      ntpReach: r["ntp_reach"], ntpServer: r["ntp_server"],
      read: r["fields_read"] ?? [],
    };
  }

  /** Advance the rotation cursor for every device we attempted this tick. */
  async markScreenshotRequested(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const { rowCount } = await this.pool.query(
      `UPDATE devices SET screenshot_requested_at = now() WHERE id = ANY($1::text[])`,
      [ids],
    );
    return rowCount ?? 0;
  }

  /** Devices we can actually poll — canvas-status needs both identifiers. */
  async listPollTargets(): Promise<PollTarget[]> {
    const { rows } = await this.pool.query<{ id: string; device_id: string; device_jid: string | null }>(
      `SELECT id, device_id, device_jid
         FROM devices
        WHERE device_id IS NOT NULL
          AND retired_at IS NULL
        ORDER BY id`,
    );
    return rows.map((r) => ({ id: r.id, deviceId: r.device_id, deviceJid: r.device_jid }));
  }

  // ── health samples ────────────────────────────────────────────────────────

  private static readonly HEALTH_COLUMNS = [
    "device_id", "observed_at", "source", "presence", "is_screen_on",
    "is_black_screen", "showing_logo", "downloading", "software_update_status",
    "ping_quality", "playback_quality", "now_playing_type", "now_playing_id",
    "cpu_percent", "ram_percent",
    "temperature_c", "wifi_signal_dbm", "packet_loss_percent", "jitter_ms",
    "ntp_sync_percent", "storage_percent", "uptime_seconds", "provenance",
  ] as const;

  async insertHealthSamples(samples: HealthSample[], source: "status" | "metrics"): Promise<number> {
    if (samples.length === 0) return 0;
    const cols = Repository.HEALTH_COLUMNS;
    let written = 0;

    for (const chunk of chunkForColumns(samples, cols.length)) {
      const values = chunk.flatMap((s) => [
        s.deviceId, s.observedAt, source,
        s.presence.value, s.isScreenOn.value, s.isBlackScreen.value,
        s.showingLogo.value, s.downloading.value, s.softwareUpdateStatus.value,
        s.pingQuality.value, s.playbackQuality.value,
        s.nowPlayingType.value, s.nowPlayingId.value,
        // An ambiguous unit is NOT written as a value. A number that might be
        // 100x wrong would poison every trend and threshold downstream; the
        // provenance blob preserves it for later reprocessing.
        ambiguousSafe(s.cpuPercent), ambiguousSafe(s.ramPercent),
        ambiguousSafe(s.temperatureC), ambiguousSafe(s.wifiSignalDbm),
        ambiguousSafe(s.packetLossPercent), ambiguousSafe(s.jitterMs),
        ambiguousSafe(s.ntpSyncPercent), ambiguousSafe(s.storagePercent),
        ambiguousSafe(s.uptimeSeconds),
        JSON.stringify(provenanceOf(s)),
      ]);

      const result = await this.pool.query(
        `INSERT INTO health_samples (${cols.join(",")})
         VALUES ${placeholders(chunk.length, cols.length)}
         ON CONFLICT (device_id, observed_at, source) DO NOTHING`,
        values,
      );
      written += result.rowCount ?? 0;
    }
    return written;
  }

  // ── raw payload retention ─────────────────────────────────────────────────

  async storeRawPayloads(
    entries: Array<{ deviceId: string; source: string; payload: unknown }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    for (const chunk of chunkForColumns(entries, 3)) {
      await this.pool.query(
        `INSERT INTO raw_payloads (device_id, source, payload)
         VALUES ${placeholders(chunk.length, 3)}`,
        chunk.flatMap((e) => [e.deviceId, e.source, JSON.stringify(e.payload)]),
      );
    }
  }

  /** Keep the raw table bounded — it exists for reprocessing, not forever. */
  /**
   * Retention for the tables that grow with time, not with fleet size.
   *
   * This did not exist while the poller daemon was broken, because nothing grew.
   * With continuous collection running, `health_samples` gains ~122k rows/day
   * (measured 2026-08-27), `compliance_results` ~5k/day and `poller_runs` ~1k/day
   * — unbounded, and `MAX(observed_at)` runs on every API request.
   *
   * Two different retention semantics, and the difference matters:
   *
   *  - Pure time series (`health_samples`, `poller_runs`, resolved `alerts`):
   *    rows older than the window are simply gone.
   *  - Latest-state tables (`device_settings`, `compliance_results`): the NEWEST
   *    row per device is kept **regardless of age**. An offline device stops
   *    being polled, so its last-known config only exists as an old row — a naive
   *    time prune would silently erase the drawer's "last known configuration"
   *    for exactly the devices someone is trying to diagnose.
   *
   * Open alerts are never touched, whatever their age.
   */
  async pruneTimeSeries(opts: {
    samplesDays?: number;
    pollerRunsDays?: number;
    resolvedAlertsDays?: number;
    snapshotsDays?: number;
    /**
     * fleet_snapshots was previously NEVER pruned — `snapshotsDays` governs
     * device_settings and compliance_results, not this table, so it grew without
     * bound (938 rows inside one week of partial uptime; ~288/day when the
     * daemon is up, each carrying a jsonb blob).
     *
     * Defaulted to match `samplesDays` rather than the shorter snapshot window:
     * these rows are the deepest COMPUTED history we hold, and a trend window
     * can legitimately reach back as far as the raw samples do. Pruning them
     * sooner than the samples they summarise would be the wrong asymmetry.
     */
    fleetSnapshotsDays?: number;
  } = {}): Promise<Record<string, number>> {
    const {
      samplesDays = 90,
      pollerRunsDays = 14,
      resolvedAlertsDays = 180,
      snapshotsDays = 30,
      fleetSnapshotsDays = 90,
    } = opts;
    const deleted: Record<string, number> = {};

    const run = async (label: string, sql: string, params: unknown[]): Promise<void> => {
      const { rowCount } = await this.pool.query(sql, params);
      deleted[label] = rowCount ?? 0;
    };

    await run("health_samples",
      `DELETE FROM health_samples WHERE observed_at < now() - ($1::text || ' days')::interval`,
      [String(samplesDays)]);
    await run("poller_runs",
      `DELETE FROM poller_runs WHERE started_at < now() - ($1::text || ' days')::interval`,
      [String(pollerRunsDays)]);
    await run("fleet_snapshots",
      `DELETE FROM fleet_snapshots WHERE computed_at < now() - ($1::text || ' days')::interval`,
      [String(fleetSnapshotsDays)]);
    await run("alerts_resolved",
      `DELETE FROM alerts
        WHERE resolved_at IS NOT NULL
          AND resolved_at < now() - ($1::text || ' days')::interval`,
      [String(resolvedAlertsDays)]);
    await run("device_settings",
      `DELETE FROM device_settings ds
        WHERE ds.observed_at < now() - ($1::text || ' days')::interval
          AND ds.observed_at < (SELECT MAX(observed_at) FROM device_settings
                                 WHERE device_id = ds.device_id)`,
      [String(snapshotsDays)]);
    await run("compliance_results",
      `DELETE FROM compliance_results cr
        WHERE cr.evaluated_at < now() - ($1::text || ' days')::interval
          AND cr.evaluated_at < (SELECT MAX(evaluated_at) FROM compliance_results
                                  WHERE device_id = cr.device_id)`,
      [String(snapshotsDays)]);
    return deleted;
  }

  async pruneRawPayloads(retainDays = 14): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM raw_payloads WHERE fetched_at < now() - $1::interval`,
      [`${retainDays} days`],
    );
    return rowCount ?? 0;
  }

  // ── discovered telemetry vocabulary ───────────────────────────────────────

  /**
   * Accumulates the telemetry vocabulary the API does not document. Sample
   * values are capped at five per key, and `mapped_to` is never overwritten so a
   * human decision about a key's meaning survives every subsequent poll.
   */
  async recordDiscoveredKeys(keys: DiscoveredKey[]): Promise<void> {
    if (keys.length === 0) return;
    for (const key of keys) {
      await this.pool.query(
        `INSERT INTO discovered_keys (container, key, inferred_type, sample_values)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (container, key) DO UPDATE
           SET last_seen_at  = now(),
               observations  = discovered_keys.observations + 1,
               inferred_type = COALESCE(discovered_keys.inferred_type, EXCLUDED.inferred_type),
               sample_values = CASE
                 WHEN jsonb_array_length(discovered_keys.sample_values) < 5
                   THEN discovered_keys.sample_values || EXCLUDED.sample_values
                 ELSE discovered_keys.sample_values
               END`,
        [key.container, key.key, key.inferredType, JSON.stringify([key.sampleValue])],
      );
    }
  }

  // ── data usage ────────────────────────────────────────────────────────────

  async upsertDataUsage(days: DataUsageDay[]): Promise<number> {
    if (days.length === 0) return 0;
    let written = 0;
    for (const chunk of chunkForColumns(days, 4)) {
      const result = await this.pool.query(
        `INSERT INTO data_usage_days (device_id, date, rx_bytes, tx_bytes)
         VALUES ${placeholders(chunk.length, 4)}
         ON CONFLICT (device_id, date) DO UPDATE
           SET rx_bytes = EXCLUDED.rx_bytes, tx_bytes = EXCLUDED.tx_bytes`,
        chunk.flatMap((d) => [d.deviceId, d.date, d.rxBytes, d.txBytes]),
      );
      written += result.rowCount ?? 0;
    }
    return written;
  }

  // ── observability ─────────────────────────────────────────────────────────

  async recordPollerRun(run: {
    poller: string;
    startedAt: Date;
    durationMs: number;
    devicesTargeted: number;
    rowsWritten: number;
    batchesOk: number;
    batchesFailed: number;
    telemetryYield: number | null;
    errors: string[];
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO poller_runs
         (poller, started_at, duration_ms, devices_targeted, rows_written,
          batches_ok, batches_failed, telemetry_yield, errors)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [
        run.poller, run.startedAt, Math.round(run.durationMs), run.devicesTargeted,
        run.rowsWritten, run.batchesOk, run.batchesFailed, run.telemetryYield,
        JSON.stringify(run.errors.slice(0, 25)),
      ],
    );
  }

  async saveFleetSnapshot(snapshot: FleetSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO fleet_snapshots (computed_at, snapshot) VALUES ($1, $2::jsonb)
       ON CONFLICT (computed_at) DO UPDATE SET snapshot = EXCLUDED.snapshot`,
      [snapshot.computedAt, JSON.stringify(snapshot)],
    );
  }

  // ── alerting ──────────────────────────────────────────────────────────────

  /**
   * Devices plus a bounded window of recent samples, in one query.
   *
   * The LATERAL cap matters: a 6-hour window at 60-second polling would be ~360
   * rows per device, or ~450k rows across the fleet, pulled every evaluation
   * cycle. Capping per device keeps memory predictable regardless of how long
   * the pollers have been running.
   */
  async loadEvaluationInput(
    windowSeconds: number,
    maxSamplesPerDevice = 240,
  ): Promise<Map<string, { device: EvaluationDevice; samples: EvaluationSample[] }>> {
    const { rows } = await this.pool.query<EvaluationJoinRow>(
      `SELECT d.id, d.name, d.location, d.firmware_current, d.firmware_latest,
              d.last_online_time,
              s.observed_at, s.source, s.presence, s.is_screen_on, s.is_black_screen,
              s.showing_logo, s.downloading, s.ping_quality, s.playback_quality,
              s.now_playing_type, s.now_playing_id, d.components,
              s.cpu_percent, s.ram_percent, s.temperature_c, s.wifi_signal_dbm,
              s.packet_loss_percent, s.jitter_ms, s.ntp_sync_percent, s.storage_percent
         FROM devices d
         LEFT JOIN LATERAL (
           SELECT * FROM health_samples
            WHERE device_id = d.id
              AND observed_at > now() - ($1::text || ' seconds')::interval
            ORDER BY observed_at DESC
            LIMIT $2
         ) s ON TRUE
        WHERE d.retired_at IS NULL`,
      [String(Math.round(windowSeconds)), maxSamplesPerDevice],
    );

    const grouped = new Map<string, { device: EvaluationDevice; samples: EvaluationSample[] }>();
    for (const row of rows) {
      let entry = grouped.get(row.id);
      if (!entry) {
        entry = {
          device: {
            id: row.id,
            name: row.name,
            location: row.location,
            firmwareCurrent: row.firmware_current,
            firmwareLatest: row.firmware_latest,
            components: row.components ?? {},
            lastOnlineTime: row.last_online_time,
          },
          samples: [],
        };
        grouped.set(row.id, entry);
      }
      // LEFT JOIN LATERAL yields one all-null sample row for a device with no
      // samples at all — that is a device to evaluate, not a sample to keep.
      if (row.observed_at === null) continue;
      entry.samples.push({
        observedAt: row.observed_at,
        source: row.source ?? "unknown",
        presence: row.presence,
        isScreenOn: row.is_screen_on,
        isBlackScreen: row.is_black_screen,
        showingLogo: row.showing_logo,
        downloading: row.downloading,
        pingQuality: row.ping_quality,
        playbackQuality: row.playback_quality,
        nowPlayingType: row.now_playing_type,
        nowPlayingId: row.now_playing_id,
        cpuPercent: numeric(row.cpu_percent),
        ramPercent: numeric(row.ram_percent),
        temperatureC: numeric(row.temperature_c),
        wifiSignalDbm: numeric(row.wifi_signal_dbm),
        packetLossPercent: numeric(row.packet_loss_percent),
        jitterMs: numeric(row.jitter_ms),
        ntpSyncPercent: numeric(row.ntp_sync_percent),
        storagePercent: numeric(row.storage_percent),
      });
    }
    return grouped;
  }

  /**
   * Age in seconds of the newest sample we hold, per source, plus overall.
   * `null` means we hold nothing at all.
   *
   * This measures OUR collection, not the fleet. It exists so the alerting
   * engine can tell "the devices went dark" apart from "we stopped looking".
   */
  async collectionAgeSeconds(): Promise<{ overall: number | null; bySource: Record<string, number> }> {
    const { rows } = await this.pool.query<{ source: string; age_seconds: string }>(
      `SELECT source,
              EXTRACT(EPOCH FROM (now() - MAX(observed_at))) AS age_seconds
         FROM health_samples
        WHERE observed_at <= now()
        GROUP BY source`,
    );
    const bySource: Record<string, number> = {};
    for (const r of rows) bySource[r.source] = Math.max(0, Math.round(Number(r.age_seconds)));
    const ages = Object.values(bySource);
    return { overall: ages.length === 0 ? null : Math.min(...ages), bySource };
  }

  async loadOpenAlerts(): Promise<Map<string, OpenAlertRow>> {
    const { rows } = await this.pool.query<OpenAlertRow>(
      `SELECT id, device_id, rule_id, severity, title, evidence,
              opened_at, last_fired_at, acknowledged_at
         FROM alerts WHERE resolved_at IS NULL`,
    );
    return new Map(rows.map((r) => [`${r.device_id}:${r.rule_id}`, r]));
  }

  async openAlert(alert: {
    deviceId: string;
    ruleId: string;
    severity: string;
    title: string;
    evidence: string;
    videriAlertUuid?: string | null;
  }): Promise<boolean> {
    // The partial unique index on (device_id, rule_id) WHERE resolved_at IS NULL
    // makes this idempotent: two concurrent evaluation passes cannot produce
    // duplicate open alerts for the same condition.
    const { rowCount } = await this.pool.query(
      `INSERT INTO alerts (device_id, rule_id, severity, title, evidence, videri_alert_uuid)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (device_id, rule_id) WHERE resolved_at IS NULL DO NOTHING`,
      [alert.deviceId, alert.ruleId, alert.severity, alert.title, alert.evidence,
       alert.videriAlertUuid ?? null],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Refresh evidence and push out the resolution clock. */
  async touchAlerts(updates: Array<{ id: string; evidence: string; severity: string }>): Promise<number> {
    let updated = 0;
    for (const chunkOf of chunkForColumns(updates, 3)) {
      const result = await this.pool.query(
        `UPDATE alerts AS a
            SET evidence = v.evidence, severity = v.severity, last_fired_at = now()
           FROM (VALUES ${placeholders(chunkOf.length, 3)}) AS v(id, evidence, severity)
          WHERE a.id = v.id::uuid AND a.resolved_at IS NULL`,
        chunkOf.flatMap((u) => [u.id, u.evidence, u.severity]),
      );
      updated += result.rowCount ?? 0;
    }
    return updated;
  }

  /** Resolve only alerts whose condition has been clear long enough. */
  async resolveStaleAlerts(
    candidates: Array<{ id: string; clearForSeconds: number }>,
  ): Promise<number> {
    let resolved = 0;
    for (const candidate of candidates) {
      const { rowCount } = await this.pool.query(
        `UPDATE alerts
            SET resolved_at = now()
          WHERE id = $1::uuid
            AND resolved_at IS NULL
            AND last_fired_at < now() - ($2::text || ' seconds')::interval`,
        [candidate.id, String(Math.round(candidate.clearForSeconds))],
      );
      resolved += rowCount ?? 0;
    }
    return resolved;
  }

  /**
   * Every open alert, reduced to what classification needs.
   *
   * The FULL open set, deliberately unpaginated. Alert hygiene computes the
   * severity chips and the dormancy rollup from this, and a chip computed from
   * one page is a chip that lies the moment there is a second page — that is the
   * exact bug that made the list untrustworthy before.
   *
   * Retired devices are excluded like everywhere else: a soft-deleted device
   * must not inflate a count. Its alerts stay in the table for history.
   */
  async openAlertFacts(): Promise<
    Array<{ id: string; deviceId: string; ruleId: string; severity: Severity; openedAt: Date }>
  > {
    const { rows } = await this.pool.query<{
      id: string; device_id: string; rule_id: string; severity: string; opened_at: Date;
    }>(
      `SELECT a.id, a.device_id, a.rule_id, a.severity, a.opened_at
         FROM alerts a
         JOIN devices d ON d.id = a.device_id
        WHERE a.resolved_at IS NULL AND d.retired_at IS NULL`,
    );
    return rows.map((r) => ({
      id: r.id,
      deviceId: r.device_id,
      ruleId: r.rule_id,
      severity: r.severity as Severity,
      openedAt: r.opened_at,
    }));
  }

  /**
   * Open alerts sitting on RETIRED devices — the ones `openAlertFacts` excludes.
   *
   * Counted rather than ignored so the discrepancy can never be silent. Any
   * surface that shows a hygiene total next to a raw `/api/alerts` total needs
   * this number to reconcile the two, and "the sums do not add up and nobody
   * knows why" is precisely how trust in the alert list was lost before.
   */
  async openAlertsOnRetiredDevices(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM alerts a JOIN devices d ON d.id = a.device_id
        WHERE a.resolved_at IS NULL AND d.retired_at IS NOT NULL`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * How long each active device has been dark, from the registry.
   *
   * `last_online_time` is Videri's own timestamp, maintained independently of our
   * polling, so it dates an outage that started long before we existed — which is
   * the only way to bucket a device that has been dark since 2023. NULL is kept
   * as NULL and counted separately: "never recorded online" is a fact about the
   * platform's records, not a zero-length outage.
   */
  async estateDarkness(): Promise<{
    activeDevices: number;
    neverSeenDevices: number;
    devices: Array<{ deviceId: string; lastOnlineTime: Date | null }>;
  }> {
    const { rows } = await this.pool.query<{ id: string; last_online_time: Date | null }>(
      `SELECT id, last_online_time FROM devices WHERE retired_at IS NULL`,
    );
    return {
      activeDevices: rows.length,
      neverSeenDevices: rows.filter((r) => r.last_online_time === null).length,
      devices: rows.map((r) => ({ deviceId: r.id, lastOnlineTime: r.last_online_time })),
    };
  }

  /**
   * Recent `poller_runs` history, newest first, capped per lane.
   *
   * Per-lane cap rather than a flat LIMIT: `status` runs every two minutes and
   * would otherwise crowd every slow lane out of the window, leaving exactly the
   * lanes most likely to stall with no history to judge them by.
   */
  async pollerRunHistory({
    lookbackHours = 72,
    runsPerLane = 40,
  }: { lookbackHours?: number; runsPerLane?: number } = {}): Promise<PollerRunHistoryRow[]> {
    const { rows } = await this.pool.query<{
      poller: string; started_at: Date; duration_ms: number; devices_targeted: number;
      rows_written: number; batches_ok: number; batches_failed: number;
      telemetry_yield: string | number | null;
    }>(
      `SELECT poller, started_at, duration_ms, devices_targeted, rows_written,
              batches_ok, batches_failed, telemetry_yield
         FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY poller ORDER BY started_at DESC) AS rn
             FROM poller_runs
            WHERE started_at > now() - ($1::text || ' hours')::interval
         ) ranked
        WHERE rn <= $2
        ORDER BY poller, started_at DESC`,
      [String(Math.round(lookbackHours)), runsPerLane],
    );
    return rows.map((r) => ({
      poller: r.poller,
      startedAt: r.started_at,
      durationMs: Number(r.duration_ms),
      devicesTargeted: Number(r.devices_targeted),
      rowsWritten: Number(r.rows_written),
      batchesOk: Number(r.batches_ok),
      batchesFailed: Number(r.batches_failed),
      telemetryYield: numeric(r.telemetry_yield),
    }));
  }

  async acknowledgeAlert(id: string, by: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE alerts SET acknowledged_at = now(), acknowledged_by = $2
        WHERE id = $1::uuid AND acknowledged_at IS NULL AND resolved_at IS NULL`,
      [id, by],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Seed rule definitions without clobbering operator tuning. */
  async seedRuleDefinitions(rules: Array<{ id: string; definition: unknown }>): Promise<number> {
    let inserted = 0;
    for (const rule of rules) {
      const { rowCount } = await this.pool.query(
        `INSERT INTO alert_rule_definitions (id, definition)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [rule.id, JSON.stringify(rule.definition)],
      );
      inserted += rowCount ?? 0;
    }
    return inserted;
  }

  async loadRuleDefinitions(): Promise<unknown[]> {
    const { rows } = await this.pool.query<{ definition: unknown; enabled: boolean }>(
      `SELECT definition, enabled FROM alert_rule_definitions`,
    );
    return rows.map((r) => ({ ...(r.definition as object), enabled: r.enabled }));
  }

  // ── compliance / slow lane ────────────────────────────────────────────────

  /**
   * Devices worth a settings poll: online only.
   *
   * An offline device burns the full ~10s command timeout to return nothing.
   * With roughly 110 of 250 online, filtering here is the difference between a
   * 7-minute cycle and a 40-minute one.
   */
  async listSettingsTargets(onlineOnly = true): Promise<SettingsTargetRow[]> {
    const { rows } = await this.pool.query<SettingsTargetRow>(
      `SELECT d.id, d.device_id AS "deviceId", d.device_jid AS "deviceJid",
              d.player_id AS "playerId", d.device_class AS "deviceClass"
         FROM devices d
         ${onlineOnly ? `JOIN LATERAL (
           SELECT presence FROM health_samples
            WHERE device_id = d.id ORDER BY observed_at DESC LIMIT 1
         ) hs ON hs.presence = 'online'` : ""}
        WHERE d.device_id IS NOT NULL AND d.device_jid IS NOT NULL
          AND d.retired_at IS NULL
        ORDER BY d.id`,
    );
    return rows;
  }

  async insertDeviceSettings(
    entries: Array<{ deviceId: string; deviceClass: string; settings: unknown }>,
  ): Promise<number> {
    if (entries.length === 0) return 0;
    let written = 0;
    for (const chunkOf of chunkForColumns(entries, 3)) {
      const result = await this.pool.query(
        `INSERT INTO device_settings (device_id, settings, device_class)
         VALUES ${placeholders(chunkOf.length, 3)}
         ON CONFLICT (device_id, observed_at) DO NOTHING`,
        chunkOf.flatMap((e) => [e.deviceId, JSON.stringify(e.settings), e.deviceClass]),
      );
      written += result.rowCount ?? 0;
    }
    return written;
  }

  /** Cache the real numeric player_id learned from a command response. */
  async updatePlayerIds(entries: Array<{ deviceId: string; playerId: string }>): Promise<number> {
    let updated = 0;
    for (const e of entries) {
      const { rowCount } = await this.pool.query(
        `UPDATE devices SET player_id = $2 WHERE id = $1 AND player_id IS DISTINCT FROM $2`,
        [e.deviceId, e.playerId],
      );
      updated += rowCount ?? 0;
    }
    return updated;
  }

  /**
   * Latest cached settings per device, with age.
   *
   * Age travels with the row because compliance is only as fresh as the slow-lane
   * poll behind it — a 100% score computed from three-day-old settings is a
   * different claim from one computed from an hour ago, and the UI must be able
   * to say which it is.
   */
  async loadComplianceInput(): Promise<ComplianceInputRow[]> {
    const { rows } = await this.pool.query<{
      id: string;
      device_class: string;
      assigned_template_id: string | null;
      settings: unknown;
      settings_age_seconds: string | null;
    }>(
      `SELECT d.id, d.device_class, a.template_id AS assigned_template_id,
              s.settings,
              EXTRACT(EPOCH FROM (now() - s.observed_at))::text AS settings_age_seconds
         FROM devices d
         LEFT JOIN device_template_assignments a ON a.device_id = d.id
         LEFT JOIN LATERAL (
           SELECT settings, observed_at FROM device_settings
            WHERE device_id = d.id ORDER BY observed_at DESC LIMIT 1
         ) s ON TRUE
        WHERE d.retired_at IS NULL`,
    );
    return rows.map((r) => ({
      id: r.id,
      deviceClass: r.device_class,
      assignedTemplateId: r.assigned_template_id,
      settings: r.settings,
      settingsAgeSeconds: Math.round(Number(r.settings_age_seconds ?? 0)),
    }));
  }

  async insertComplianceResults(
    results: Array<{
      deviceId: string; templateId: string; score: number;
      checksTotal: number; checksPassed: number; checksNotApplicable: number;
      drift: unknown; settingsAgeSeconds: number;
    }>,
  ): Promise<number> {
    if (results.length === 0) return 0;
    const cols = 8;
    let written = 0;
    for (const chunkOf of chunkForColumns(results, cols)) {
      const r = await this.pool.query(
        `INSERT INTO compliance_results
           (device_id, template_id, score, checks_total, checks_passed, checks_na,
            drift, settings_age_seconds)
         VALUES ${placeholders(chunkOf.length, cols)}
         ON CONFLICT (device_id, evaluated_at) DO NOTHING`,
        chunkOf.flatMap((e) => [
          e.deviceId, e.templateId, e.score, e.checksTotal, e.checksPassed,
          e.checksNotApplicable, JSON.stringify(e.drift), e.settingsAgeSeconds,
        ]),
      );
      written += r.rowCount ?? 0;
    }
    return written;
  }

  async seedComplianceTemplates(
    templates: Array<{ id: string; name: string; definition: unknown }>,
  ): Promise<number> {
    let inserted = 0;
    for (const t of templates) {
      const { rowCount } = await this.pool.query(
        `INSERT INTO compliance_templates (id, name, definition)
         VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO NOTHING`,
        [t.id, t.name, JSON.stringify(t.definition)],
      );
      inserted += rowCount ?? 0;
    }
    return inserted;
  }

  // ── SLA measurement coverage ──────────────────────────────────────────────

  /**
   * Per-device coverage aggregates for an SLA window.
   *
   * Computed in SQL rather than by pulling samples: a 24h window at 60s polling
   * is ~360k rows across 250 devices, and we only need per-bucket counts. The
   * bucket grid is generated so absent buckets are genuinely counted as absent —
   * a device that never reported has zero observed buckets rather than being
   * missing from the result set entirely.
   */
  async loadSlaAggregates(
    windowHours: number,
    bucketSeconds: number,
  ): Promise<SlaAggregateRow[]> {
    const { rows } = await this.pool.query<{
      device_id: string;
      name: string | null;
      observed_buckets: string;
      online_buckets: string;
      expected_buckets: string;
      longest_gap_seconds: string;
      staleness_seconds: string | null;
    }>(
      `WITH params AS (
         SELECT ($1::text || ' hours')::interval  AS win,
                ($2::text || ' seconds')::interval AS bucket,
                now() AS now_ts
       ),
       grid AS (
         SELECT generate_series(
                  date_bin((SELECT bucket FROM params), (SELECT now_ts - win FROM params), TIMESTAMPTZ '2000-01-01'),
                  (SELECT now_ts FROM params),
                  (SELECT bucket FROM params)
                ) AS bucket_start
       ),
       expected AS (SELECT count(*)::int AS n FROM grid),
       per_bucket AS (
         SELECT hs.device_id,
                date_bin((SELECT bucket FROM params), hs.observed_at, TIMESTAMPTZ '2000-01-01') AS b,
                bool_or(hs.presence = 'online') AS was_online
           FROM health_samples hs, params
          WHERE hs.observed_at > params.now_ts - params.win
          GROUP BY 1, 2
       ),
       gaps AS (
         SELECT device_id,
                COALESCE(MAX(gap_seconds), 0) AS longest_gap_seconds
           FROM (
             SELECT device_id,
                    EXTRACT(EPOCH FROM (b - LAG(b) OVER (PARTITION BY device_id ORDER BY b)))
                      AS gap_seconds
               FROM per_bucket
           ) g
          GROUP BY device_id
       )
       SELECT d.id AS device_id,
              d.name,
              COALESCE(pb.observed, 0)::text        AS observed_buckets,
              COALESCE(pb.online, 0)::text          AS online_buckets,
              (SELECT n FROM expected)::text        AS expected_buckets,
              COALESCE(gp.longest_gap_seconds, 0)::text AS longest_gap_seconds,
              EXTRACT(EPOCH FROM (now() - lat.newest))::text AS staleness_seconds
         FROM devices d
         LEFT JOIN (
           SELECT device_id,
                  count(*) AS observed,
                  count(*) FILTER (WHERE was_online) AS online
             FROM per_bucket GROUP BY device_id
         ) pb ON pb.device_id = d.id
         LEFT JOIN gaps gp ON gp.device_id = d.id
         LEFT JOIN LATERAL (
           SELECT MAX(observed_at) AS newest FROM health_samples WHERE device_id = d.id
         ) lat ON TRUE
        WHERE d.retired_at IS NULL
        ORDER BY d.id`,
      [String(windowHours), String(bucketSeconds)],
    );

    return rows.map((r) => ({
      deviceId: r.device_id,
      name: r.name,
      observedBuckets: Number(r.observed_buckets),
      onlineBuckets: Number(r.online_buckets),
      expectedBuckets: Number(r.expected_buckets),
      longestGapSeconds: Math.round(Number(r.longest_gap_seconds)),
      stalenessSeconds:
        r.staleness_seconds === null ? null : Math.round(Number(r.staleness_seconds)),
    }));
  }

  /**
   * Buckets in which NOT A SINGLE device reported.
   *
   * This is the collector-failure detector. One device going quiet is a device
   * fault; the entire fleet going quiet at the same instant is our pipeline. The
   * distinction is invisible in a per-device uptime query and completely changes
   * who is responsible for the gap.
   */
  async loadFleetBlindWindows(
    windowHours: number,
    bucketSeconds: number,
  ): Promise<Array<{ from: Date; to: Date; durationSeconds: number; devicesReporting: number }>> {
    const { rows } = await this.pool.query<{ bucket_start: Date; devices_reporting: string }>(
      `WITH params AS (
         SELECT ($1::text || ' hours')::interval AS win,
                ($2::text || ' seconds')::interval AS bucket, now() AS now_ts
       ),
       grid AS (
         SELECT generate_series(
                  date_bin((SELECT bucket FROM params), (SELECT now_ts - win FROM params), TIMESTAMPTZ '2000-01-01'),
                  (SELECT now_ts FROM params),
                  (SELECT bucket FROM params)
                ) AS bucket_start
       )
       SELECT g.bucket_start,
              COUNT(DISTINCT hs.device_id)::text AS devices_reporting
         FROM grid g
         CROSS JOIN params p
         LEFT JOIN health_samples hs
                ON hs.observed_at >= g.bucket_start
               AND hs.observed_at <  g.bucket_start + p.bucket
        GROUP BY g.bucket_start
       HAVING COUNT(DISTINCT hs.device_id) = 0
        ORDER BY g.bucket_start`,
      [String(windowHours), String(bucketSeconds)],
    );

    // Merge adjacent empty buckets into single windows — twelve consecutive
    // silent buckets is one 12-bucket outage, not twelve incidents.
    const merged: Array<{ from: Date; to: Date; durationSeconds: number; devicesReporting: number }> = [];
    for (const row of rows) {
      const start = row.bucket_start;
      const end = new Date(start.getTime() + bucketSeconds * 1000);
      const last = merged[merged.length - 1];
      if (last && Math.abs(last.to.getTime() - start.getTime()) < 1000) {
        last.to = end;
        last.durationSeconds += bucketSeconds;
      } else {
        merged.push({ from: start, to: end, durationSeconds: bucketSeconds, devicesReporting: 0 });
      }
    }
    return merged;
  }

  /** Update one rule definition. Returns false when the id does not exist. */
  async updateRuleDefinition(id: string, definition: unknown, enabled?: boolean): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE alert_rule_definitions
          SET definition = $2::jsonb,
              enabled = COALESCE($3, enabled),
              updated_at = now()
        WHERE id = $1`,
      [id, JSON.stringify(definition), enabled ?? null],
    );
    return (rowCount ?? 0) > 0;
  }

  async setRuleEnabled(id: string, enabled: boolean): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE alert_rule_definitions SET enabled = $2, updated_at = now() WHERE id = $1`,
      [id, enabled],
    );
    return (rowCount ?? 0) > 0;
  }

  // ── device action log (audit trail) ────────────────────────────────────────

  /**
   * Record one attempted action on one device. Never throws.
   *
   * This is called from inside the device-write paths, which means a broken
   * audit insert must not break or mask the write itself: a failed brightness
   * rollback reported as a 500 "logging failed" would hide the one outcome an
   * operator has to see. So every failure is swallowed HERE — no call site can
   * forget the `.catch()` — and returned as `{ id: null, error }` for the caller
   * to log through its own logger (routes use `request.log.error`).
   *
   * Returning the error rather than console-logging it keeps this file free of
   * IO it does not own, and makes "a logging failure does not break the device
   * operation" assertable in a unit test.
   */
  async recordDeviceAction(
    entry: DeviceActionEntry,
  ): Promise<{ id: number | null; error: string | null }> {
    try {
      const { rows } = await this.pool.query<{ id: string }>(
        `INSERT INTO device_action_log
           (action, verb, device_id, requested_value, observed_value, params, detail,
            outcome, actor, actor_ip, started_at, finished_at, duration_ms, error)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id`,
        [
          entry.action,
          entry.verb ?? null,
          entry.deviceId,
          entry.requestedValue ?? null,
          entry.observedValue ?? null,
          JSON.stringify(entry.params ?? {}),
          JSON.stringify(entry.detail ?? {}),
          entry.outcome,
          entry.actor,
          entry.actorIp ?? null,
          entry.startedAt,
          entry.finishedAt ?? new Date(),
          entry.durationMs ?? null,
          entry.error ?? null,
        ],
      );
      return { id: rows[0] ? Number(rows[0].id) : null, error: null };
    } catch (error) {
      return { id: null, error: (error as Error).message };
    }
  }

  /**
   * One page of the audit log, newest first, plus the span of the MATCHED set.
   *
   * The span comes back with the count in a single aggregate query rather than
   * being derived from the page: a caller looking at page 1 of 40 still needs to
   * know how far back the match reaches, and an audit answer that silently
   * describes only the visible rows is the sort of half-truth this table exists
   * to prevent.
   *
   * `deviceName` is a LEFT JOIN precisely because there is no foreign key — a
   * row whose device has since been removed upstream is still a valid audit row
   * and comes back with a null name rather than disappearing from the result.
   */
  async listDeviceActions(filters: DeviceActionFilters): Promise<{
    items: DeviceActionRow[];
    totalItems: number;
    oldestAt: Date | null;
    newestAt: Date | null;
  }> {
    const where: string[] = [];
    const values: unknown[] = [];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };

    if (filters.deviceId) where.push(`l.device_id = ${bind(filters.deviceId)}`);
    if (filters.actor) where.push(`l.actor = ${bind(filters.actor)}`);
    if (filters.outcome) where.push(`l.outcome = ANY(${bind(filters.outcome)}::text[])`);
    if (filters.action) where.push(`l.action = ${bind(filters.action)}`);
    // Half-open [since, until): an audit window that includes both endpoints
    // double-counts a row when two windows are read back to back.
    if (filters.since) where.push(`l.started_at >= ${bind(filters.since)}`);
    if (filters.until) where.push(`l.started_at < ${bind(filters.until)}`);
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const totals = await this.pool.query<{ n: string; oldest: Date | null; newest: Date | null }>(
      `SELECT count(*)::text AS n, MIN(l.started_at) AS oldest, MAX(l.started_at) AS newest
         FROM device_action_log l ${clause}`,
      // A copy: the same array then gains LIMIT/OFFSET for the page query, and a
      // shared reference is the sort of aliasing that only bites under a retry.
      [...values],
    );
    const totalItems = Number(totals.rows[0]?.n ?? 0);

    const offset = (filters.page - 1) * filters.limit;
    const { rows } = await this.pool.query<DeviceActionSqlRow>(
      `SELECT l.id::text AS id, l.action, l.verb, l.device_id, d.name AS device_name,
              l.requested_value, l.observed_value, l.params, l.detail, l.outcome,
              l.actor, l.actor_ip, l.started_at, l.finished_at, l.duration_ms, l.error
         FROM device_action_log l
         LEFT JOIN devices d ON d.id = l.device_id
         ${clause}
        ORDER BY l.started_at DESC, l.id DESC
        LIMIT ${bind(filters.limit)} OFFSET ${bind(offset)}`,
      values,
    );

    return {
      items: rows.map((r) => ({
        id: Number(r.id),
        action: r.action,
        verb: r.verb,
        deviceId: r.device_id,
        deviceName: r.device_name,
        requestedValue: r.requested_value,
        observedValue: r.observed_value,
        params: r.params ?? {},
        detail: r.detail ?? {},
        outcome: r.outcome as DeviceActionOutcome,
        actor: r.actor,
        actorIp: r.actor_ip,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        durationMs: r.duration_ms,
        error: r.error,
      })),
      totalItems,
      oldestAt: totals.rows[0]?.oldest ?? null,
      newestAt: totals.rows[0]?.newest ?? null,
    };
  }

  /**
   * Rows in the whole log, ignoring every filter.
   *
   * Read only when a filtered page comes back empty, so the endpoint can say
   * WHICH kind of empty it is: "we have logged nothing yet" and "your filter
   * matched nothing" are different answers, and conflating them is how an
   * operator concludes a write was never recorded when it was.
   */
  async deviceActionLogSize(): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM device_action_log`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Prune the audit log. Deliberately NOT part of `pruneTimeSeries`.
   *
   * `pruneTimeSeries` trims measurement history — samples, poller runs, computed
   * snapshots — on 14-90 day windows, and it runs nightly and unattended. An
   * audit trail is not measurement history: it is the record of what we did to
   * someone else's estate, and it is the last thing that should be deleted by
   * the same unattended code path that trims CPU readings. Keeping it out of
   * that method means no future tweak to a metrics window can shorten it by
   * accident, and adding a table to that method's label map cannot silently pick
   * up this one.
   *
   * The default is TWO YEARS, and there is a hard floor: a caller cannot prune
   * the audit log to a metrics-style window even by asking. The bound exists
   * only as a ceiling against unbounded growth (at the observed write rate —
   * single-digit writes per day — two years is a few thousand rows), in the same
   * spirit as the `fleet_snapshots` bound, which is honestly a ceiling that has
   * never yet deleted a live row.
   *
   * Nothing calls this today: the nightly retention task lives in
   * pipeline/run-poller.ts and wiring it there is a deliberate, separate decision
   * for a human to take, not a default that starts deleting audit rows two years
   * from now because a table existed.
   */
  async pruneDeviceActionLog(retainDays = AUDIT_RETAIN_DAYS): Promise<number> {
    if (retainDays < AUDIT_MIN_RETAIN_DAYS) {
      throw new Error(
        `Refusing to prune the device action log to ${retainDays} days. The audit ` +
          `trail of our own writes is bounded at no less than ${AUDIT_MIN_RETAIN_DAYS} ` +
          `days (default ${AUDIT_RETAIN_DAYS}); a metrics-length window here would ` +
          `destroy the only record of what we changed on a customer's estate.`,
      );
    }
    const { rowCount } = await this.pool.query(
      `DELETE FROM device_action_log WHERE started_at < now() - ($1::text || ' days')::interval`,
      [String(retainDays)],
    );
    return rowCount ?? 0;
  }

  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns the value only when its unit is unambiguous. See the note in
 * insertHealthSamples — writing a possibly-100x-wrong number is worse than
 * writing nothing, because everything downstream would silently inherit it.
 */
function ambiguousSafe(observed: { value: number | null; ambiguous?: string }): number | null {
  return observed.ambiguous ? null : observed.value;
}

/** Compact provenance record: which fields resolved, and from where. */
function provenanceOf(sample: HealthSample): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, observed] of Object.entries(sample)) {
    if (!observed || typeof observed !== "object" || !("provenance" in observed)) continue;
    const o = observed as { provenance: { kind: string; sourceKey?: string }; ambiguous?: string };
    if (o.provenance.kind === "inferred") {
      out[field] = { key: o.provenance.sourceKey, ...(o.ambiguous ? { ambiguous: true } : {}) };
    } else if (o.provenance.kind === "unavailable") {
      out[field] = { unavailable: true };
    }
  }
  return out;
}

/**
 * pg returns double precision as a JS number but numeric/decimal as a string.
 * Coercing here keeps that detail out of the evaluation logic, where a string
 * would silently break every comparator.
 */
function numeric(value: string | number | null): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

const nullableTimestamp = (value: string | null): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
