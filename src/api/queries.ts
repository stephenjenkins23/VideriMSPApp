/**
 * Read queries for the API.
 *
 * Separate from Repository, which is write-shaped (upserts, batching,
 * idempotency). These are read-shaped: pagination, filtering, sorting.
 *
 * Two rules run through all of them:
 *
 * 1. **Serve from pre-computed rollups where they exist.** The fleet summary
 *    comes from `fleet_snapshots`, not a live aggregate. The platform has no
 *    aggregation endpoint above device level, so pre-computing is where the speed
 *    advantage over a direct-to-API client actually comes from.
 *
 * 2. **Never coerce an unreadable metric to zero.** `null` travels all the way to
 *    the client, and the response says which metrics are unavailable so the UI
 *    can grey out a tile instead of drawing a reassuring flat line at zero.
 *
 * 3. **Retired devices are excluded by default.** `devices.retired_at` marks a row
 *    for a device the platform no longer has (soft-deleted by the discovery
 *    reconcile). Every list, count and intelligence feed filters it out via
 *    `ACTIVE_DEVICES`; the single exception is `device(id)`, which still resolves a
 *    retired row so a deep link shows the last known state — with `retiredAt` in
 *    the payload so the UI can say the device is gone rather than implying it is
 *    live.
 */

import type { Pool } from "pg";
import type { DeviceView } from "../intelligence/remediation.js";
// Site resolution is REUSED, never reimplemented: the depth-1 tree walk, its
// termination rules and the group index all live in group-hierarchy.ts. Only the
// pure parts are imported here — the IO (GroupSiteCache) belongs to the route.
import { resolveSite, type GroupIndex } from "../videri/services/group-hierarchy.js";
import type { ScheduledEvent } from "../intelligence/proof-of-play.js";
import type { DeviceBucketCounts, UsageDay } from "../intelligence/trends.js";

export interface DeviceListFilters {
  page: number;
  limit: number;
  status?: string | undefined;
  deviceClass?: string | undefined;
  groupId?: string | undefined;
  /**
   * Site filter, already translated into the group ids that roll up to the
   * requested site(s) — see `groupIdsForSites`.
   *
   * The translation happens in the route because the site dimension is NOT in
   * Postgres: it is the depth-1 ancestor of a device's group in the `rpm
   * /v1/groups` tree. What reaches SQL is therefore a set of `group_id` values,
   * which is also what makes the predicate legal in both statements below.
   *
   * `undefined` means unfiltered. An empty array means "explicitly filtered, and
   * nothing matches" — see the fail-closed note in `devices()`.
   */
  siteGroupIds?: string[] | undefined;
  search?: string | undefined;
  /**
   * Group ids whose SITE NAME matched `search`, OR-ed into the text search so
   * "NYC Office" finds the devices at that site. Resolved in the route, for the
   * same reason as `siteGroupIds`.
   */
  searchSiteGroupIds?: string[] | undefined;
  sort: "name" | "last_seen" | "alerts";
  direction: "asc" | "desc";
}

/**
 * The group hierarchy as one request sees it.
 *
 * `index: null` is the honest "we could not read the tree" — never an empty
 * index, which would resolve every device to no site and look like a tenant with
 * no groups. `reason` then says why, and travels all the way to the client.
 */
export interface SiteResolution {
  index: GroupIndex | null;
  /** Why the index is null, or why it may be incomplete. Null when fully read. */
  reason: string | null;
}

/**
 * A device's place in the customer/site axis.
 *
 * Always an object, never null, because "unresolved" has to be SAYABLE. About 15
 * of 248 devices on this tenant carry no group at all; they stay visible in every
 * list with `resolved: false` and a reason, and are never bucketed into an
 * "Other" that reads like a real place.
 *
 * Invariant, relied on by the UI: whenever `name` is null there IS a `reason`, so
 * the site cell always has something true to print.
 */
export interface DeviceSite {
  /** The depth-1 ancestor group's uuid (`SiteRef.uuid`). Null when unresolved. */
  id: string | null;
  /** The site's display name. Null when unresolved, or when the group is unnamed. */
  name: string | null;
  resolved: boolean;
  /** Why there is no name to show. Null only when `name` is a usable label. */
  reason: string | null;
}

/** Stated when the server has no credentials, so there is no tree to read at all. */
export const NO_HIERARCHY_REASON =
  "No Videri credentials are configured, so the group hierarchy could not be read " +
  "and no device could be placed at a site.";

/**
 * Pure: one device's site, or an honest reason there is none.
 *
 * The four null cases stay distinguishable on purpose — a technician reading
 * "not in any group" acts differently from one reading "we could not read the
 * hierarchy", and collapsing them into one blank cell is the failure this
 * whole projection exists to fix.
 */
export function deviceSite(
  hierarchy: SiteResolution,
  groupId: string | null | undefined,
): DeviceSite {
  if (hierarchy.index === null) {
    return {
      id: null, name: null, resolved: false,
      reason: hierarchy.reason ?? NO_HIERARCHY_REASON,
    };
  }
  if (!groupId) {
    return {
      id: null, name: null, resolved: false,
      reason: "This device is in no group, so it cannot be placed at a site.",
    };
  }
  const site = resolveSite(hierarchy.index, groupId);
  if (!site) {
    // Two different facts, kept apart: a group we never read vs. a group that
    // sits at the tenant root and so has no site level beneath it.
    return {
      id: null, name: null, resolved: false,
      reason: hierarchy.index.has(groupId)
        ? "This device's group is at the top of the hierarchy, so there is no site below it."
        : `This device's group is not in the group hierarchy we read, so no site could be ` +
          `resolved.${hierarchy.reason ? ` ${hierarchy.reason}` : ""}`,
    };
  }
  return {
    id: site.uuid,
    name: site.name,
    resolved: true,
    // A resolved site CAN be nameless — one group comes back with a populated
    // uuid and an empty display name. Resolved, but with nothing to print.
    reason: site.name === null
      ? "This site has no display name on the platform; it is identified by group id only."
      : null,
  };
}

/**
 * Pure: every group id that rolls up to one of `siteIds`.
 *
 * This is how a site filter becomes a SQL predicate. It walks the index with the
 * shared `resolveSite`, so the filter can never disagree with the site shown on
 * a row. A site's own group id is included — `resolveSite` of a depth-1 group is
 * itself, so a device attached directly to the site group is not lost.
 *
 * Sorted, so the bound parameter is deterministic whatever order the platform
 * listed the groups in.
 */
export function groupIdsForSites(
  index: GroupIndex,
  siteIds: readonly string[],
): string[] {
  const wanted = new Set(siteIds);
  if (wanted.size === 0) return [];
  const matched: string[] = [];
  for (const groupId of index.keys()) {
    const site = resolveSite(index, groupId);
    if (site && wanted.has(site.uuid)) matched.push(groupId);
  }
  return matched.sort();
}

/**
 * Pure: the site uuids whose display name contains `term`, case-insensitively.
 *
 * Substring, to mirror the `ILIKE '%term%'` the text columns get — searching
 * "NYC" has to find "NYC Office". Nameless sites can never match, which is
 * correct: there is no name to have matched.
 */
export function sitesMatchingName(index: GroupIndex, term: string): string[] {
  const needle = term.trim().toLowerCase();
  if (needle === "") return [];
  const hits = new Set<string>();
  for (const groupId of index.keys()) {
    const site = resolveSite(index, groupId);
    if (site?.name && site.name.toLowerCase().includes(needle)) hits.add(site.uuid);
  }
  return [...hits].sort();
}

export interface DeviceListItem {
  id: string;
  name: string | null;
  location: string | null;
  /**
   * From the tenant's CITY metafield. Present on 100% of devices on VIDERISALES
   * but carrying only two distinct values, so a consumer must check cardinality
   * before treating it as a grouping dimension.
   */
  city: string | null;
  /**
   * The customer/site axis, projected onto every row.
   *
   * `groupId` is the join key — NEVER `groupName`. Device 1000015 carries a
   * populated group_id and an EMPTY group_name while the hierarchy names that
   * group correctly, and two sibling groups may share a display name, so a name
   * is not an identity. `groupName` here is display text only.
   */
  groupId: string | null;
  groupName: string | null;
  accountName: string | null;
  tags: string[];
  /** Resolved from the group tree. Always present; see DeviceSite. */
  site: DeviceSite;
  deviceClass: string;
  modelType: string | null;
  status: string;
  lastOnlineTime: string | null;
  firmwareCurrent: string | null;
  firmwareLatest: string | null;
  firmwareBehind: boolean;
  openAlerts: { critical: number; high: number; medium: number; info: number; total: number };
  /** Latest readings. `null` means unreadable, never zero. */
  latest: {
    observedAt: string | null;
    presence: string | null;
    isScreenOn: boolean | null;
    isBlackScreen: boolean | null;
    showingLogo: boolean | null;
    cpuPercent: number | null;
    ramPercent: number | null;
    temperatureC: number | null;
    wifiSignalDbm: number | null;
    storagePercent: number | null;
    ntpOffsetMs: number | null;
    /**
     * When the HARDWARE fields above were read. Separate from `observedAt`
     * because they come from the slow lane (~2 h) not the status feed (~2 min),
     * and a UI must be able to age them independently. Null when no slow-lane
     * reading exists for this device.
     */
    hardwareObservedAt: string | null;
  };
}

const num = (v: string | number | null): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * `settings->>'…'` always hands back text, so booleans arrive as "true"/"false"
 * (and occasionally "1"/"0"). Anything else — empty string, "unknown", a typo —
 * is `null`, not `false`: an unreadable flag must not become a confident "no".
 */
const bool = (v: unknown): boolean | null => {
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  return null;
};

/** Text passthrough that treats blank as absent — an empty setting is not a value. */
const text = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" ? null : s;
};

/**
 * Derived status. The platform gives presence only; the warning and alert tiers
 * are our product decision (docs/02 §2), so the definition lives here in one
 * place rather than being re-derived per endpoint.
 */
const STATUS_SQL = `
  CASE
    WHEN hs.presence IS NULL                  THEN 'unknown'
    WHEN hs.presence <> 'online'              THEN 'offline'
    WHEN hs.is_black_screen IS TRUE           THEN 'alert'
    WHEN hs.showing_logo IS TRUE              THEN 'warning'
    WHEN hs.is_screen_on IS FALSE             THEN 'warning'
    ELSE 'online'
  END`;

/** Most recent sample per device, whichever poller produced it. */
const LATEST_SAMPLE_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT observed_at, presence, is_screen_on, is_black_screen, showing_logo,
           cpu_percent, ram_percent, temperature_c, wifi_signal_dbm
      FROM health_samples
     WHERE device_id = d.id
     ORDER BY observed_at DESC
     LIMIT 1
  ) hs ON TRUE`;

/**
 * Most recent SLOW-LANE hardware reading per device.
 *
 * A second lateral rather than more columns on the first, because the two
 * answer different questions on different clocks. `health_samples` is the
 * status feed (~2 min, carries presence and screen flags, and structurally
 * carries NO hardware values — that is why the slow lane exists).
 * `device_telemetry` is the per-device demo_command sweep (~2 h) and is the only
 * place CPU/RAM/storage/signal live.
 *
 * Reading hardware from `health_samples` alone is why `/api/devices` returned
 * null CPU/RAM/signal for all 248 devices while `/api/pipeline/status` reported
 * ~100 readable. The availability query was fixed for exactly this reason and
 * this one was missed.
 *
 * `observed_at` comes back deliberately: a 2-hour-old hardware reading beside a
 * 2-minute-old presence reading is legitimate, but the consumer must be able to
 * tell them apart rather than assuming one age for the whole row.
 */
const LATEST_TELEMETRY_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT observed_at, cpu_percent, ram_used_percent, storage_used_percent,
           rssi_dbm, ntp_offset_ms
      FROM device_telemetry
     WHERE device_id = d.id
     ORDER BY observed_at DESC
     LIMIT 1
  ) dt ON TRUE`;

/**
 * The active-fleet predicate. Aliased `d` everywhere it is used.
 *
 * Named rather than inlined so "which queries exclude retired devices?" is
 * answerable by grepping one identifier — the question that matters when a fleet
 * count is wrong by one.
 */
const ACTIVE_DEVICES = `d.retired_at IS NULL`;

const ALERT_COUNTS_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE severity = 'critical') AS critical,
           COUNT(*) FILTER (WHERE severity = 'high')     AS high,
           COUNT(*) FILTER (WHERE severity = 'medium')   AS medium,
           COUNT(*) FILTER (WHERE severity = 'info')     AS info,
           COUNT(*)                                      AS total
      FROM alerts
     WHERE device_id = d.id AND resolved_at IS NULL
  ) al ON TRUE`;

export class ReadQueries {
  constructor(private readonly pool: Pool) {}

  /** The Overview tab. Served from the pre-computed snapshot. */
  async fleetSummary(): Promise<{ snapshot: unknown; computedAt: string } | null> {
    const { rows } = await this.pool.query<{ computed_at: Date; snapshot: unknown }>(
      `SELECT computed_at, snapshot FROM fleet_snapshots ORDER BY computed_at DESC LIMIT 1`,
    );
    const row = rows[0];
    return row ? { snapshot: row.snapshot, computedAt: row.computed_at.toISOString() } : null;
  }

  /**
   * The device list.
   *
   * `hierarchy` carries the group tree so each row can be projected onto the
   * site axis. It is a parameter rather than something this class fetches because
   * reading the tree is IO against the control plane, and these are read queries
   * over Postgres — the route owns the cache (see routes/devices.ts).
   */
  async devices(
    filters: DeviceListFilters,
    hierarchy: SiteResolution = { index: null, reason: NO_HIERARCHY_REASON },
  ): Promise<{ items: DeviceListItem[]; totalItems: number }> {
    // Retired devices are never listed: they no longer exist upstream, and a list
    // that includes them makes every total one too many.
    const where: string[] = [ACTIVE_DEVICES];
    const params: unknown[] = [];

    if (filters.deviceClass) {
      params.push(filters.deviceClass);
      where.push(`d.device_class = $${params.length}`);
    }
    if (filters.groupId) {
      params.push(filters.groupId);
      where.push(`d.group_id = $${params.length}`);
    }
    // The site filter, as a plain `devices` column predicate.
    //
    // TWO reasons it is written this way. First, site is derived from the group
    // tree, which is not in Postgres, so the route hands us the group ids it
    // rolls up to. Second, the COUNT and LIST statements below select from
    // DIFFERENT FROM clauses — the count omits the telemetry lateral — so a
    // predicate written against a lateral alias would compile in one and raise
    // `missing FROM-clause entry` in the other. That exact shape once 500'd a
    // live endpoint while stub tests passed. `d.group_id` is a real column on
    // the one table both statements share, so the same predicate is legal in
    // both and they agree by construction.
    //
    // FAIL CLOSED, matching the `deviceIds` decision on /api/alerts: an
    // explicitly supplied site filter that resolves to no groups matches
    // NOTHING. A filter whose whole job is to narrow must not fail open into the
    // entire fleet — and that includes the case where the hierarchy could not be
    // read at all, where returning every device as if the filter had been
    // honoured would be a lie the caller cannot detect.
    if (filters.siteGroupIds) {
      params.push(filters.siteGroupIds);
      where.push(`d.group_id = ANY($${params.length}::text[])`);
    }
    if (filters.search) {
      params.push(`%${filters.search}%`);
      const i = params.length;
      // group_name and account_name join the text search as DISPLAY TEXT. This
      // is not a join — the standing "join on group_id, never group_name" rule
      // is about identity, and searching a label is not claiming one.
      const clauses = [
        `d.name ILIKE $${i}`, `d.location ILIKE $${i}`, `d.id ILIKE $${i}`,
        `d.device_id ILIKE $${i}`, `d.model_type ILIKE $${i}`, `d.serial_no ILIKE $${i}`,
        `d.group_name ILIKE $${i}`, `d.account_name ILIKE $${i}`,
      ];
      // Site names live in the group tree, not in any column, so a search that
      // should match a site arrives pre-resolved to group ids. Skipped when empty
      // only to avoid binding a parameter that could never match anything.
      if (filters.searchSiteGroupIds && filters.searchSiteGroupIds.length > 0) {
        params.push(filters.searchSiteGroupIds);
        clauses.push(`d.group_id = ANY($${params.length}::text[])`);
      }
      where.push(`(${clauses.join(" OR ")})`);
    }
    // Status is derived, so it filters on the computed expression rather than a
    // column — it has to be applied after the lateral joins.
    if (filters.status) {
      params.push(filters.status);
      where.push(`${STATUS_SQL} = $${params.length}`);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const dir = filters.direction === "asc" ? "ASC" : "DESC";
    const orderSql =
      filters.sort === "name"
        ? `d.name ${dir} NULLS LAST`
        : filters.sort === "alerts"
          ? `al.total ${dir}, d.name ASC`
          : `d.last_online_time ${dir} NULLS LAST`;

    const countPromise = this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM devices d ${LATEST_SAMPLE_LATERAL} ${ALERT_COUNTS_LATERAL} ${whereSql}`,
      params,
    );

    const offset = (filters.page - 1) * filters.limit;
    const rowsPromise = this.pool.query(
      `SELECT d.id, d.name, d.location, d.device_class, d.model_type, d.city,
              d.group_id, d.group_name, d.account_name, d.tags,
              d.last_online_time, d.firmware_current, d.firmware_latest,
              ${STATUS_SQL} AS status,
              hs.observed_at, hs.presence, hs.is_screen_on, hs.is_black_screen,
              hs.showing_logo, hs.cpu_percent, hs.ram_percent, hs.temperature_c,
              hs.wifi_signal_dbm,
              dt.observed_at AS hw_observed_at, dt.cpu_percent AS dt_cpu,
              dt.ram_used_percent AS dt_ram, dt.storage_used_percent AS dt_storage,
              dt.rssi_dbm AS dt_rssi, dt.ntp_offset_ms AS dt_ntp,
              al.critical, al.high, al.medium, al.info, al.total
         FROM devices d ${LATEST_SAMPLE_LATERAL} ${LATEST_TELEMETRY_LATERAL}
              ${ALERT_COUNTS_LATERAL} ${whereSql}
        ORDER BY ${orderSql}
        LIMIT ${filters.limit} OFFSET ${offset}`,
      params,
    );

    const [countResult, rowsResult] = await Promise.all([countPromise, rowsPromise]);

    return {
      totalItems: Number(countResult.rows[0]?.count ?? 0),
      items: rowsResult.rows.map((r) => this.#toListItem(r, hierarchy)),
    };
  }

  async device(
    id: string,
    hierarchy: SiteResolution = { index: null, reason: NO_HIERARCHY_REASON },
  ): Promise<DeviceListItem | null> {
    const { rows } = await this.pool.query(
      `SELECT d.id, d.name, d.location, d.device_class, d.model_type, d.city,
              d.last_online_time, d.firmware_current, d.firmware_latest,
              ${STATUS_SQL} AS status,
              hs.observed_at, hs.presence, hs.is_screen_on, hs.is_black_screen,
              hs.showing_logo, hs.cpu_percent, hs.ram_percent, hs.temperature_c,
              hs.wifi_signal_dbm,
              al.critical, al.high, al.medium, al.info, al.total,
              d.serial_no, d.vendor, d.product_name, d.timezone, d.orientation,
              d.screen_width, d.screen_height, d.latitude, d.longitude,
              d.license_status, d.license_expiration, d.group_id, d.group_name,
              d.account_name, d.tags, d.first_seen_at, d.last_synced_at,
              d.metafields, d.city, d.retired_at
         FROM devices d ${LATEST_SAMPLE_LATERAL} ${ALERT_COUNTS_LATERAL}
        -- Deliberately NOT filtered on retired_at: a lookup by id should show a
        -- retired device's last known state (with retiredAt set) rather than 404.
        WHERE d.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      ...this.#toListItem(row, hierarchy),
      // Detail-only fields ride along; the list shape is a strict subset.
      ...({
        serialNo: row.serial_no, vendor: row.vendor, productName: row.product_name,
        timezone: row.timezone, orientation: row.orientation,
        screenWidth: row.screen_width, screenHeight: row.screen_height,
        latitude: num(row.latitude), longitude: num(row.longitude),
        licenseStatus: row.license_status,
        licenseExpiration: row.license_expiration?.toISOString() ?? null,
        // groupId/groupName/accountName/tags and `site` come from the list
        // projection above — one source of truth, so the drawer and the row can
        // never disagree about which customer and site a device belongs to.
        // Tenant-defined, so passed through verbatim rather than mapped.
        metafields: row.metafields ?? {},
        city: row.city ?? null,
        firstSeenAt: row.first_seen_at?.toISOString() ?? null,
        lastSyncedAt: row.last_synced_at?.toISOString() ?? null,
        // Non-null = the platform no longer lists this device; it is kept for its
        // history and excluded from every fleet count. Surfaced so the drawer can
        // say so instead of showing a stale device as if it were live.
        retiredAt: row.retired_at?.toISOString() ?? null,
      } as Record<string, unknown>),
    };
  }

  /**
   * Recent samples for a device, bucketed.
   *
   * Reports per-metric availability alongside the series, so the UI can tell
   * "this metric reads zero" from "we cannot read this metric" — the distinction
   * the whole data model exists to preserve.
   */
  async deviceHealth(
    id: string,
    windowHours: number,
    bucketMinutes: number,
  ): Promise<{
    points: Array<Record<string, unknown>>;
    availability: Record<string, boolean>;
  }> {
    const { rows } = await this.pool.query(
      `SELECT time_bucket(($3::text || ' minutes')::interval, observed_at) AS bucket,
              AVG(cpu_percent)         AS cpu_percent,
              AVG(ram_percent)         AS ram_percent,
              AVG(temperature_c)       AS temperature_c,
              AVG(wifi_signal_dbm)     AS wifi_signal_dbm,
              AVG(ntp_sync_percent)    AS ntp_sync_percent,
              AVG(packet_loss_percent) AS packet_loss_percent,
              -- NOT AVG: playback_quality and ping_quality are opaque TEXT
              -- with an undocumented vocabulary ("unavailable", "no"), not a
              -- scale. Averaging them raised "function avg(text) does not
              -- exist" and 500d this endpoint. The modal value per bucket is
              -- the honest summary of a categorical signal.
              MODE() WITHIN GROUP (ORDER BY playback_quality) AS playback_quality,
              MODE() WITHIN GROUP (ORDER BY ping_quality)     AS ping_quality,
              COUNT(*)                 AS samples,
              -- Two denominators, deliberately. samples counts every row in
              -- the bucket, but metrics-source rows carry NO presence field —
              -- dividing online rows by ALL rows made a fully-online hour read
              -- as ~70% online and paint amber. Presence math must only ever
              -- divide by rows that actually observed presence.
              COUNT(*) FILTER (WHERE presence IS NOT NULL) AS presence_samples,
              COUNT(*) FILTER (WHERE presence = 'online') AS online_samples
         FROM health_samples
        WHERE device_id = $1
          AND observed_at > now() - ($2::text || ' hours')::interval
        GROUP BY 1 ORDER BY 1`,
      [id, String(windowHours), String(bucketMinutes)],
    );

    /** Genuinely numeric, so averageable and chartable. */
    const metrics = [
      "cpu_percent", "ram_percent", "temperature_c", "wifi_signal_dbm",
      "ntp_sync_percent", "packet_loss_percent",
    ] as const;

    /** Categorical strings — reported as-is, never plotted on a numeric axis. */
    const categorical = ["playback_quality", "ping_quality"] as const;

    /** The platform's string null. A field full of these is not a reading. */
    const isAbsent = (v: unknown): boolean =>
      v === null || v === undefined || v === "unavailable" || v === "";

    const availability: Record<string, boolean> = {};
    for (const metric of metrics) {
      availability[metric] = rows.some((r) => num(r[metric]) !== null);
    }
    for (const field of categorical) {
      availability[field] = rows.some((r) => !isAbsent(r[field]));
    }

    return {
      availability,
      points: rows.map((r) => {
        const point: Record<string, unknown> = {
          bucket: (r["bucket"] as Date).toISOString(),
          samples: Number(r["samples"]),
          presenceSamples: Number(r["presence_samples"]),
          onlineSamples: Number(r["online_samples"]),
        };
        for (const metric of metrics) point[metric] = num(r[metric]);
        for (const field of categorical) {
          point[field] = isAbsent(r[field]) ? null : String(r[field]);
        }
        return point;
      }),
    };
  }

  /**
   * The rest of what a device drawer shows: component versions, the cached
   * settings snapshot, and the latest compliance verdict.
   *
   * Deliberately one query per concern but a single call, because the UI's
   * requirement is one click to everything about a device — and a drawer that
   * fires five requests shows five different loading states.
   *
   * `settings` is returned with its age. Compliance is only as fresh as the
   * slow-lane settings poll behind it, and a drawer that hides that invites
   * someone to act on a configuration read hours ago.
   */
  async deviceContext(id: string): Promise<{
    components: Array<{ name: string; current: string | null; latest: string | null; behind: boolean }>;
    settings: Record<string, unknown> | null;
    settingsAgeSeconds: number | null;
    compliance: Record<string, unknown> | null;
    dataUsage: Array<{ date: string; rxBytes: number; txBytes: number }>;
  }> {
    const [comp, settings, compliance, usage] = await Promise.all([
      this.pool.query(`SELECT components FROM devices WHERE id = $1`, [id]),
      this.pool.query(
        `SELECT settings, EXTRACT(EPOCH FROM (now() - observed_at))::int AS age_seconds
           FROM device_settings WHERE device_id = $1
          ORDER BY observed_at DESC LIMIT 1`,
        [id],
      ),
      this.pool.query(
        `SELECT template_id, score, checks_total, checks_passed, checks_na, drift,
                settings_age_seconds, evaluated_at
           FROM compliance_results WHERE device_id = $1
          ORDER BY evaluated_at DESC LIMIT 1`,
        [id],
      ),
      // The platform's only structured time series. Daily granularity, so 30
      // rows is a month — ordered oldest-first for direct charting.
      this.pool.query<{ date: Date; rx_bytes: string; tx_bytes: string }>(
        `SELECT date, rx_bytes, tx_bytes FROM data_usage_days
          WHERE device_id = $1 AND date > current_date - 31
          ORDER BY date ASC`,
        [id],
      ),
    ]);

    const raw = (comp.rows[0]?.["components"] ?? {}) as Record<
      string,
      { current?: string | null; latest?: string | null }
    >;
    const components = Object.entries(raw)
      .map(([name, v]) => ({
        name,
        current: v?.current ?? null,
        latest: v?.latest ?? null,
        // Absence of a "latest" is not evidence of being up to date.
        behind: Boolean(v?.current && v?.latest && v.current !== v.latest),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const sRow = settings.rows[0];
    const cRow = compliance.rows[0];
    return {
      components,
      settings: (sRow?.["settings"] as Record<string, unknown>) ?? null,
      settingsAgeSeconds: sRow ? Number(sRow["age_seconds"]) : null,
      dataUsage: usage.rows.map((r) => ({
        date: r.date.toISOString().slice(0, 10),
        rxBytes: Number(r.rx_bytes),
        txBytes: Number(r.tx_bytes),
      })),
      compliance: cRow
        ? {
            templateId: cRow["template_id"],
            score: Number(cRow["score"]),
            checksTotal: Number(cRow["checks_total"]),
            checksPassed: Number(cRow["checks_passed"]),
            checksNotApplicable: Number(cRow["checks_na"]),
            drift: cRow["drift"] ?? [],
            settingsAgeSeconds: cRow["settings_age_seconds"] === null
              ? null : Number(cRow["settings_age_seconds"]),
            evaluatedAt: (cRow["evaluated_at"] as Date).toISOString(),
          }
        : null,
    };
  }

  async alerts(filters: {
    page: number;
    limit: number;
    severity?: string | undefined;
    state: "open" | "resolved" | "all";
    deviceId?: string | undefined;
    /** Many-device filter, used by the dormant rollup drilldown. */
    deviceIds?: string[] | undefined;
  }): Promise<{ items: Array<Record<string, unknown>>; totalItems: number }> {
    const where: string[] = [
      // A retired device's alerts must appear in neither the list nor the count.
      // Written as NOT EXISTS rather than `d.retired_at IS NULL`: the COUNT query
      // below selects from `alerts` alone with no devices join, so an alias-based
      // filter would compile here and fail there — the exact shape of the bug that
      // once 500'd a live endpoint while stub tests passed. This mismatch is also
      // why the list reported 306 open while the repository's own invariant said 304.
      `NOT EXISTS (SELECT 1 FROM devices rd
                    WHERE rd.id = a.device_id AND rd.retired_at IS NOT NULL)`,
    ];
    const params: unknown[] = [];

    if (filters.state === "open") where.push(`a.resolved_at IS NULL`);
    if (filters.state === "resolved") where.push(`a.resolved_at IS NOT NULL`);
    if (filters.severity) {
      params.push(filters.severity);
      where.push(`a.severity = $${params.length}`);
    }
    // Same NOT-EXISTS discipline as above: this predicate must work in the
    // COUNT query, which has no devices join.
    if (filters.deviceIds) {
      // An explicitly supplied filter that resolves to NOTHING must match
      // nothing — not everything. `deviceIds=,%20,,` passes the route's length
      // check and transforms to [], and treating that as "no filter" made the
      // dormant drilldown render every open alert. Failing open is the wrong
      // direction for a filter whose whole job is to narrow.
      params.push(filters.deviceIds);
      where.push(`a.device_id = ANY($${params.length}::text[])`);
    }
    if (filters.deviceId) {
      params.push(filters.deviceId);
      where.push(`a.device_id = $${params.length}`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const [countResult, rowsResult] = await Promise.all([
      this.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM alerts a ${whereSql}`,
        params,
      ),
      this.pool.query(
        `SELECT a.id, a.device_id, d.name AS device_name, d.location,
                a.rule_id, a.severity, a.title, a.evidence,
                a.opened_at, a.last_fired_at, a.acknowledged_at, a.acknowledged_by,
                a.resolved_at, a.videri_alert_uuid
           FROM alerts a
           LEFT JOIN devices d ON d.id = a.device_id
           ${whereSql}
          ORDER BY CASE a.severity
                     WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                     WHEN 'medium' THEN 2 ELSE 3 END,
                   a.opened_at DESC
          LIMIT ${filters.limit} OFFSET ${(filters.page - 1) * filters.limit}`,
        params,
      ),
    ]);

    return {
      totalItems: Number(countResult.rows[0]?.count ?? 0),
      items: rowsResult.rows.map((r) => ({
        id: r["id"],
        deviceId: r["device_id"],
        deviceName: r["device_name"],
        location: r["location"],
        ruleId: r["rule_id"],
        severity: r["severity"],
        title: r["title"],
        evidence: r["evidence"],
        openedAt: (r["opened_at"] as Date).toISOString(),
        lastFiredAt: (r["last_fired_at"] as Date).toISOString(),
        acknowledgedAt: (r["acknowledged_at"] as Date | null)?.toISOString() ?? null,
        acknowledgedBy: r["acknowledged_by"],
        resolvedAt: (r["resolved_at"] as Date | null)?.toISOString() ?? null,
        videriAlertUuid: r["videri_alert_uuid"],
      })),
    };
  }

  /**
   * Latest compliance verdict per device.
   *
   * `settingsAgeSeconds` rides along deliberately: a 100% score computed from
   * three-day-old settings is a different claim from one computed an hour ago,
   * and the UI must be able to say which it is.
   */
  async compliance(filters: {
    page: number;
    limit: number;
    band?: "compliant" | "minor-drift" | "non-compliant" | undefined;
  }): Promise<{ items: Array<Record<string, unknown>>; totalItems: number }> {
    const bandClause =
      filters.band === "compliant"
        ? "AND cr.score >= 95"
        : filters.band === "minor-drift"
          ? "AND cr.score >= 75 AND cr.score < 95"
          : filters.band === "non-compliant"
            ? "AND cr.score < 75"
            : "";

    const [countResult, rowsResult] = await Promise.all([
      this.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM devices d
           JOIN LATERAL (
             SELECT * FROM compliance_results
              WHERE device_id = d.id ORDER BY evaluated_at DESC LIMIT 1
           ) cr ON TRUE
          WHERE ${ACTIVE_DEVICES} ${bandClause}`,
      ),
      this.pool.query(
        `SELECT d.id, d.name, d.device_class, cr.template_id, cr.score,
                cr.checks_total, cr.checks_passed, cr.checks_na,
                cr.drift, cr.settings_age_seconds, cr.evaluated_at
           FROM devices d
           JOIN LATERAL (
             SELECT * FROM compliance_results
              WHERE device_id = d.id ORDER BY evaluated_at DESC LIMIT 1
           ) cr ON TRUE
          WHERE ${ACTIVE_DEVICES} ${bandClause}
          ORDER BY cr.score ASC, d.name
          LIMIT ${filters.limit} OFFSET ${(filters.page - 1) * filters.limit}`,
      ),
    ]);

    return {
      totalItems: Number(countResult.rows[0]?.count ?? 0),
      items: rowsResult.rows.map((r) => ({
        deviceId: r["id"],
        name: r["name"],
        deviceClass: r["device_class"],
        templateId: r["template_id"],
        score: Number(r["score"]),
        band:
          Number(r["score"]) >= 95 ? "compliant"
          : Number(r["score"]) >= 75 ? "minor-drift" : "non-compliant",
        checksTotal: Number(r["checks_total"]),
        checksPassed: Number(r["checks_passed"]),
        checksNotApplicable: Number(r["checks_na"]),
        drift: r["drift"],
        settingsAgeSeconds: r["settings_age_seconds"] === null ? null : Number(r["settings_age_seconds"]),
        evaluatedAt: (r["evaluated_at"] as Date).toISOString(),
      })),
    };
  }

  /**
   * Assemble the per-device facts the remediation engine reasons over (Epic 1).
   *
   * One query, four laterals — the latest screen-state, the latest slow-lane
   * telemetry, the latest settings snapshot (live panel state and the device's
   * on/off schedule), and the latest compliance verdict (for drift). Unbounded
   * like `compliance()` above:
   * the engine must see the whole fleet to rank across it, and every join is a
   * cheap latest-row lookup. Honest nulls throughout — a metric we never read
   * arrives as null and the engine produces no recommendation from it.
   *
   * `group_id` rides along as the join key into the group hierarchy (the site
   * dimension venue correlation clusters on). `site` itself is left null here —
   * resolving it needs the group tree, which is control-plane IO and belongs to
   * the route, not to a SQL read. NEVER select group_name for this purpose: one
   * device has a group_id with an empty group_name.
   *
   * `settings->>'brightness'` is projected as the SCHEDULED/base value only. The
   * engine decides darkness from `current_brightness` + `display_on`, and decides
   * whether darkness is expected from `brightness_schedule_enabled`,
   * `turn_on_time`/`turn_off_time` and `devices.timezone` — so all of those must
   * ride along together or the display rules go blind (and, historically, wrong).
   */
  async remediationDevices(): Promise<DeviceView[]> {
    const { rows } = await this.pool.query(
      `SELECT d.id, d.name, d.city, d.group_id, d.firmware_current, d.firmware_latest,
              ${STATUS_SQL} AS status,
              d.last_online_time, d.timezone,
              hs.is_black_screen, hs.showing_logo, hs.is_screen_on,
              tel.observed_at AS telemetry_observed_at, tel.cpu_percent,
              tel.ram_used_percent, tel.storage_used_percent, tel.rssi_dbm,
              tel.ntp_offset_ms,
              (st.settings ->> 'brightness') AS brightness_raw,
              (st.settings ->> 'current_brightness') AS current_brightness_raw,
              (st.settings ->> 'display_on') AS display_on,
              (st.settings ->> 'brightness_schedule_enabled') AS brightness_schedule_enabled,
              (st.settings ->> 'auto_brightness_enabled') AS auto_brightness_enabled,
              (st.settings ->> 'turn_on_time') AS turn_on_time,
              (st.settings ->> 'turn_off_time') AS turn_off_time,
              cr.drift
         FROM devices d
         ${LATEST_SAMPLE_LATERAL}
         LEFT JOIN LATERAL (
           SELECT observed_at, cpu_percent, ram_used_percent, storage_used_percent,
                  rssi_dbm, ntp_offset_ms
             FROM device_telemetry
            WHERE device_id = d.id
            ORDER BY observed_at DESC LIMIT 1
         ) tel ON TRUE
         LEFT JOIN LATERAL (
           SELECT settings FROM device_settings
            WHERE device_id = d.id
            ORDER BY observed_at DESC LIMIT 1
         ) st ON TRUE
         LEFT JOIN LATERAL (
           SELECT drift FROM compliance_results
            WHERE device_id = d.id
            ORDER BY evaluated_at DESC LIMIT 1
         ) cr ON TRUE
        WHERE ${ACTIVE_DEVICES}`,
    );

    return rows.map((r) => {
      const current = r["firmware_current"] as string | null;
      const latest = r["firmware_latest"] as string | null;
      const hasTelemetry = r["telemetry_observed_at"] != null;
      const rawDrift = (r["drift"] ?? []) as Array<Record<string, unknown>>;
      return {
        id: r["id"] as string,
        name: (r["name"] as string | null) ?? null,
        status: r["status"] as string,
        lastOnlineTime: (r["last_online_time"] as Date | null)?.toISOString() ?? null,
        city: (r["city"] as string | null) ?? null,
        groupId: (r["group_id"] as string | null) ?? null,
        // Resolved by the caller from the group tree; null here is "not yet
        // resolved", which the engine treats as "site unknown" either way.
        site: null,
        firmwareCurrent: current,
        // `behind` means only that the two STRINGS DIFFER. Verified 2026-09-02:
      // `firmware_latest` holds exactly ONE distinct value across the whole fleet
      // (7.0.14-release-1712-587ccc82) spanning six device classes — canvas 191,
      // spark-bridge 33, unknown 9, allsee 7, tcl 5, allsee-shelf 4. A TCL panel
      // and an AllSee shelf label do not share a firmware build with a Videri
      // Canvas, so this reads as one tenant-wide value rather than a per-model
      // target. 36 of the 130 devices we flag behind (28%) are non-canvas, and
      // ALL 5 TCL devices are flagged behind — almost certainly an artefact
      // rather than five upgrade opportunities.
      // So the flag is literally true and the INFERENCE ("an upgrade exists for
      // this device") is not safe off-Canvas. Do not build an upgrade action on
      // it without confirming per-model semantics — docs/14 B15, docs/22 Ask 8.
      // NOTE the firmware-cohort correlation is NOT affected: it keys on the
      // CURRENT version ("devices running build X are failing"), which stands
      // whatever `latest` says.
      firmwareBehind: Boolean(current && latest && current !== latest),
        screen: {
          isBlackScreen: (r["is_black_screen"] as boolean | null) ?? null,
          showingLogo: (r["showing_logo"] as boolean | null) ?? null,
          // The status feed's own view of panel power — the SECOND opinion the
          // blank-cause classifier needs. It is a real boolean column, so `?? null`
          // only maps a missing/NULL sample to unread; it never invents a `false`,
          // and a false here is a genuine "the feed says the screen is off".
          // Verified 2026-09-02: 5 reachable devices report is_screen_on=true while
          // the settings poll reports display_on=false. Without this field those 5
          // silently became "panel off, restore brightness".
          isScreenOn: (r["is_screen_on"] as boolean | null) ?? null,
          // now_playing_id is not projected by the shared latest-sample lateral
          // and the status poller does not yet write it, so it is always null
          // here. No remediation rule reads it; wired as null until a content
          // rule (and the poller write) needs it.
          nowPlayingId: null,
        },
        telemetry: hasTelemetry
          ? {
              observedAt: (r["telemetry_observed_at"] as Date).toISOString(),
              cpuPercent: num(r["cpu_percent"] as string | number | null),
              ramUsedPercent: num(r["ram_used_percent"] as string | number | null),
              storageUsedPercent: num(r["storage_used_percent"] as string | number | null),
              rssiDbm: num(r["rssi_dbm"] as string | number | null),
              ntpOffsetMs: num(r["ntp_offset_ms"] as string | number | null),
            }
          : null,
        // The stored drift rows are full CheckResults; the engine only needs the
        // identity fields, passed through verbatim.
        drift: rawDrift.map((c) => ({
          kind: String(c["kind"] ?? ""),
          label: String(c["label"] ?? ""),
          field: String(c["field"] ?? ""),
        })),
        // The scheduled/base value the platform holds — NOT live panel output.
        brightnessRaw: num(r["brightness_raw"] as string | number | null),
        // Live panel state + the device's own schedule, which together decide
        // whether a dark screen is a fault (intelligence/screen-state.ts).
        currentBrightnessRaw: num(r["current_brightness_raw"] as string | number | null),
        displayOn: bool(r["display_on"]),
        brightnessScheduleEnabled: bool(r["brightness_schedule_enabled"]),
        autoBrightnessEnabled: bool(r["auto_brightness_enabled"]),
        turnOnTime: text(r["turn_on_time"]),
        turnOffTime: text(r["turn_off_time"]),
        // The device's OWN zone: "0900"–"0500" means nothing without it, and
        // assuming UTC would misjudge every schedule by its offset.
        timezone: text(r["timezone"]),
      };
    });
  }

  /**
   * A bounded batch of devices carrying a recent screen-state reading, for the
   * scheduled proof-of-play join (Epic 3).
   *
   * Only devices with a health sample inside `windowHours` are eligible — a
   * device we have not heard from has no screen-state to judge a schedule
   * against, and inventing one would be exactly the fabricated-null this system
   * refuses. The batch is capped (the route fans out one publisher call per
   * device to read its schedule, so this must stay bounded), ordered
   * freshest-first, and the *total* eligible count is returned alongside so the
   * caller can report truncation honestly rather than silently dropping the tail.
   */
  async popScreenState(
    limit: number,
    windowHours = 24,
  ): Promise<{
    devices: Array<{
      id: string;
      name: string | null;
      isScreenOn: boolean | null;
      isBlackScreen: boolean | null;
      showingLogo: boolean | null;
      screenObservedAt: string | null;
    }>;
    eligibleTotal: number;
  }> {
    const eligibleFrom = `
       FROM devices d ${LATEST_SAMPLE_LATERAL}
      WHERE ${ACTIVE_DEVICES}
        AND hs.observed_at IS NOT NULL
        AND hs.observed_at > now() - ($1::text || ' hours')::interval`;

    const [countResult, rowsResult] = await Promise.all([
      this.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count ${eligibleFrom}`,
        [String(windowHours)],
      ),
      this.pool.query(
        `SELECT d.id, d.name, hs.is_screen_on, hs.is_black_screen, hs.showing_logo,
                hs.observed_at
           ${eligibleFrom}
          ORDER BY hs.observed_at DESC
          LIMIT ${Number(limit)}`,
        [String(windowHours)],
      ),
    ]);

    return {
      eligibleTotal: Number(countResult.rows[0]?.count ?? 0),
      devices: rowsResult.rows.map((r) => ({
        id: r["id"] as string,
        name: (r["name"] as string | null) ?? null,
        isScreenOn: (r["is_screen_on"] as boolean | null) ?? null,
        isBlackScreen: (r["is_black_screen"] as boolean | null) ?? null,
        showingLogo: (r["showing_logo"] as boolean | null) ?? null,
        screenObservedAt: (r["observed_at"] as Date | null)?.toISOString() ?? null,
      })),
    };
  }

  /**
   * Fleet-wide persisted schedules joined with the latest screen-state, for the
   * scheduled proof-of-play gap detector (Epic 4, US-4.5).
   *
   * The slow-lane schedule poller (`schedule-slowlane`) stores a per-canvas
   * "scheduled now" snapshot in `device_schedule`; this reads the LATEST snapshot
   * per device and joins the latest screen-state we hold. Unlike `popScreenState`
   * — which live-samples a bounded batch and fans out one publisher call each —
   * this touches only our own tables, so it can cover EVERY device that has a
   * persisted schedule with no outbound calls and no cap.
   *
   * `INNER JOIN` on `device_schedule`: a device with no persisted schedule is not
   * returned (there is nothing to judge). Screen-state is a `LEFT JOIN` — a
   * scheduled device we cannot see is reported as unknown by the engine, never a
   * fabricated gap. `fetchedAt` rides along so the caller can report how stale the
   * snapshot is rather than presenting it as live. `fleetDevices` is the honest
   * denominator for coverage (how many of the fleet have a schedule yet).
   */
  async popPersistedSchedules(): Promise<{
    devices: Array<{
      id: string;
      name: string | null;
      scheduledItems: ScheduledEvent[];
      scheduledCount: number;
      scheduleObservedAt: string;
      fetchedAt: string;
      isScreenOn: boolean | null;
      isBlackScreen: boolean | null;
      showingLogo: boolean | null;
      screenObservedAt: string | null;
    }>;
    fleetDevices: number;
  }> {
    const [rowsResult, countResult] = await Promise.all([
      this.pool.query(
        `SELECT d.id, d.name,
                sch.scheduled_items, sch.scheduled_count,
                sch.observed_at AS schedule_observed_at, sch.fetched_at,
                hs.is_screen_on, hs.is_black_screen, hs.showing_logo,
                hs.observed_at AS screen_observed_at
           FROM devices d
           JOIN LATERAL (
             SELECT scheduled_items, scheduled_count, observed_at, fetched_at
               FROM device_schedule s
              WHERE s.device_id = d.id
              ORDER BY observed_at DESC LIMIT 1
           ) sch ON TRUE
           ${LATEST_SAMPLE_LATERAL}
          WHERE ${ACTIVE_DEVICES}
          ORDER BY sch.observed_at ASC`,
      ),
      // The coverage denominator is the ACTIVE fleet — counting retired rows here
      // would make coverage look permanently short of 100%.
      this.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM devices d WHERE ${ACTIVE_DEVICES}`,
      ),
    ]);

    return {
      fleetDevices: Number(countResult.rows[0]?.count ?? 0),
      devices: rowsResult.rows.map((r) => ({
        id: r["id"] as string,
        name: (r["name"] as string | null) ?? null,
        // jsonb comes back already parsed; guard the odd null/non-array row.
        scheduledItems: Array.isArray(r["scheduled_items"])
          ? (r["scheduled_items"] as ScheduledEvent[])
          : [],
        scheduledCount: Number(r["scheduled_count"] ?? 0),
        scheduleObservedAt: (r["schedule_observed_at"] as Date).toISOString(),
        fetchedAt: (r["fetched_at"] as Date).toISOString(),
        isScreenOn: (r["is_screen_on"] as boolean | null) ?? null,
        isBlackScreen: (r["is_black_screen"] as boolean | null) ?? null,
        showingLogo: (r["showing_logo"] as boolean | null) ?? null,
        screenObservedAt: (r["screen_observed_at"] as Date | null)?.toISOString() ?? null,
      })),
    };
  }

  async alertRules(): Promise<Array<Record<string, unknown>>> {
    const { rows } = await this.pool.query<{
      id: string; definition: Record<string, unknown>; enabled: boolean; updated_at: Date;
    }>(`SELECT id, definition, enabled, updated_at FROM alert_rule_definitions ORDER BY id`);
    return rows.map((r) => ({
      ...r.definition,
      id: r.id,
      enabled: r.enabled,
      updatedAt: r.updated_at.toISOString(),
    }));
  }

  async latestBrief(): Promise<Record<string, unknown> | null> {
    const { rows } = await this.pool.query<{
      generated_at: Date; window_hours: number; brief: unknown; model: string | null;
    }>(
      `SELECT generated_at, window_hours, brief, model
         FROM briefs ORDER BY generated_at DESC LIMIT 1`,
    );
    const row = rows[0];
    return row
      ? {
          generatedAt: row.generated_at.toISOString(),
          windowHours: row.window_hours,
          model: row.model,
          brief: row.brief,
        }
      : null;
  }

  /**
   * The latest generated AI action plan (US-5.2). Same contract as latestBrief:
   * never generated on request, and the row's `generated_at` rides along so the
   * endpoint can say how old the plan is rather than implying it is live.
   */
  async latestActionPlan(): Promise<Record<string, unknown> | null> {
    const { rows } = await this.pool.query<{
      generated_at: Date; window_hours: number; plan: unknown; model: string | null;
    }>(
      `SELECT generated_at, window_hours, plan, model
         FROM action_plans ORDER BY generated_at DESC LIMIT 1`,
    );
    const row = rows[0];
    return row
      ? {
          generatedAt: row.generated_at.toISOString(),
          windowHours: row.window_hours,
          model: row.model,
          plan: row.plan,
        }
      : null;
  }

  /** Fleet-wide telemetry availability — drives the "why is this empty" UI. */
  /**
   * Which hardware inputs we can actually read, per device.
   *
   * THIS DRIVES A CUSTOMER-FACING CLAIM, so the window matters more than it
   * looks. It previously counted non-null fields in `health_samples` alone
   * within ONE HOUR. But the batch metrics feed carries no hardware fields at
   * all, and the per-device values live in `device_telemetry`, written by a slow
   * lane that sweeps roughly every two hours — so the count was a structural
   * 0-of-249 forever, and the console turned that windowing artefact into
   * "these have no data source on this platform, so rules reading them can never
   * fire". On the same page load the Overview tile read "Hardware telemetry 44%
   * of fleet" and the trends engine was fitting storage slopes for 107 devices.
   *
   * That is exactly the mistake this project exists not to make: concluding the
   * platform cannot do something from the way we happened to look. So this now
   * unions BOTH sources over each one's own realistic window, exactly as
   * `computeFleetSnapshot` already did.
   *
   * The two schemas name the same capabilities differently, which is why the
   * mapping is written out rather than inferred:
   *   ram_percent      <- device_telemetry.ram_used_percent
   *   storage_percent  <- device_telemetry.storage_used_percent
   *   wifi_signal_dbm  <- device_telemetry.rssi_dbm
   *   ntp_sync_percent <- device_telemetry.ntp_offset_ms
   * `temperature_c` and `playback_quality` have NO column in device_telemetry
   * and no verb that returns them, so they stay false there — those two are the
   * genuinely sourceless fields, and after this fix they are the only ones the
   * console should be describing as such.
   *
   * The denominator is the ACTIVE fleet, not "devices we happen to have a row
   * for", so a thin sweep reads as low coverage rather than as full coverage of
   * a small sample.
   */
  async telemetryAvailability(): Promise<Record<string, { readable: number; total: number }>> {
    const { rows } = await this.pool.query<Record<string, string>>(
      `WITH readings AS (
         SELECT device_id,
                cpu_percent      IS NOT NULL AS cpu_percent,
                ram_percent      IS NOT NULL AS ram_percent,
                temperature_c    IS NOT NULL AS temperature_c,
                wifi_signal_dbm  IS NOT NULL AS wifi_signal_dbm,
                ntp_sync_percent IS NOT NULL AS ntp_sync_percent,
                storage_percent  IS NOT NULL AS storage_percent,
                playback_quality IS NOT NULL AS playback_quality
           FROM health_samples
          WHERE observed_at > now() - interval '1 hour'
         UNION ALL
         SELECT device_id,
                cpu_percent          IS NOT NULL,
                ram_used_percent     IS NOT NULL,
                FALSE,
                rssi_dbm             IS NOT NULL,
                ntp_offset_ms        IS NOT NULL,
                storage_used_percent IS NOT NULL,
                FALSE
           FROM device_telemetry
          WHERE observed_at > now() - interval '3 hours'
       )
       SELECT (SELECT COUNT(*)::text FROM devices WHERE retired_at IS NULL) AS total,
              COUNT(DISTINCT device_id) FILTER (WHERE cpu_percent)::text      AS cpu_percent,
              COUNT(DISTINCT device_id) FILTER (WHERE ram_percent)::text      AS ram_percent,
              COUNT(DISTINCT device_id) FILTER (WHERE temperature_c)::text    AS temperature_c,
              COUNT(DISTINCT device_id) FILTER (WHERE wifi_signal_dbm)::text  AS wifi_signal_dbm,
              COUNT(DISTINCT device_id) FILTER (WHERE ntp_sync_percent)::text AS ntp_sync_percent,
              COUNT(DISTINCT device_id) FILTER (WHERE storage_percent)::text  AS storage_percent,
              COUNT(DISTINCT device_id) FILTER (WHERE playback_quality)::text AS playback_quality
         FROM readings
        WHERE device_id IN (SELECT id FROM devices WHERE retired_at IS NULL)`,
    );
    const row = rows[0] ?? {};
    const total = Number(row["total"] ?? 0);
    const out: Record<string, { readable: number; total: number }> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === "total") continue;
      out[key] = { readable: Number(value ?? 0), total };
    }
    return out;
  }

  // ── trend intelligence reads (Epic 7) ──────────────────────────────────────
  //
  // Deliberately their OWN queries rather than extra columns bolted onto
  // LATEST_SAMPLE_LATERAL. That lateral serves "latest state per device" and a
  // trend needs "every bucket in a window" — a different shape entirely. The last
  // time a new endpoint borrowed a shared join it got a payload missing the one
  // column it needed and shipped a 500 to production, so these stand alone.
  //
  // All three are dumb reads: they aggregate, they do not judge. Every gate,
  // slope and verdict lives in the pure engine (src/intelligence/trends.ts) where
  // it can be tested without a database.

  /**
   * Presence bucketed into fixed windows, for ONE availability window.
   *
   * `source = 'status'` is load-bearing: the 300s metrics poller writes rows with
   * a NULL presence (it carries no presence at all on this platform — 0 of
   * ~160k metrics rows have one), so including it would add "observed" buckets in
   * which we in fact learned nothing about whether the device was up.
   *
   * Buckets, not raw rows, because when the status poller stalls and then catches
   * up it can write a dozen rows for one device inside one minute, and a dozen
   * rows from one minute is not a dozen observations of a week.
   *
   * The `fleet` row is the count of DISTINCT buckets in which any device reported
   * — the collector's own uptime for the window. It is returned from the same CTE
   * as the per-device rows so the two can never disagree about which buckets
   * existed, and it is the denominator that stops this feature reporting our
   * downtime as the fleet's.
   */
  async availabilityBuckets(
    fromIso: string,
    toIso: string,
    bucketSeconds: number,
  ): Promise<{ devices: DeviceBucketCounts[]; fleetObservedBuckets: number }> {
    const { rows } = await this.pool.query<{
      scope: string;
      device_id: string | null;
      buckets: string;
      online_buckets: string | null;
    }>(
      `WITH bucketed AS (
         SELECT hs.device_id,
                time_bucket(make_interval(secs => $3::int), hs.observed_at) AS bucket,
                BOOL_OR(hs.presence = 'online') AS online
           FROM health_samples hs
           JOIN devices d ON d.id = hs.device_id AND ${ACTIVE_DEVICES}
          WHERE hs.source = 'status'
            AND hs.presence IS NOT NULL
            AND hs.observed_at >= $1::timestamptz
            AND hs.observed_at <  $2::timestamptz
          GROUP BY hs.device_id, bucket
       )
       SELECT 'device'                                    AS scope,
              device_id,
              COUNT(*)::text                              AS buckets,
              COUNT(*) FILTER (WHERE online)::text        AS online_buckets
         FROM bucketed
        GROUP BY device_id
       UNION ALL
       SELECT 'fleet'                                     AS scope,
              NULL::text                                  AS device_id,
              COUNT(DISTINCT bucket)::text                AS buckets,
              NULL::text                                  AS online_buckets
         FROM bucketed`,
      [fromIso, toIso, bucketSeconds],
    );

    const devices: DeviceBucketCounts[] = [];
    let fleetObservedBuckets = 0;
    for (const row of rows) {
      if (row.scope === "fleet") {
        fleetObservedBuckets = Number(row.buckets);
        continue;
      }
      if (!row.device_id) continue;
      devices.push({
        deviceId: row.device_id,
        observedBuckets: Number(row.buckets),
        onlineBuckets: Number(row.online_buckets ?? 0),
      });
    }
    return { devices, fleetObservedBuckets };
  }

  /**
   * Raw storage readings per device over a window, oldest first.
   *
   * Returns the POINTS, not a slope: gap detection, span gates and the least
   * squares fit are pure logic and belong in the engine. At the current volume
   * (~2.7k telemetry rows in total) returning raw points is cheaper than the
   * round trips a SQL-side regression would need, and it keeps the honesty rules
   * in one testable place.
   *
   * `storage_used_percent IS NOT NULL` filters at the source: an unreadable
   * metric is absent, never a zero, and a zero would flatten a real fill rate.
   */
  async storageSeries(
    fromIso: string,
    toIso: string,
  ): Promise<Array<{ deviceId: string; points: Array<{ observedAt: string; percent: number }> }>> {
    const { rows } = await this.pool.query<{
      device_id: string;
      observed_at: Date;
      storage_used_percent: number;
    }>(
      `SELECT t.device_id, t.observed_at, t.storage_used_percent
         FROM device_telemetry t
         JOIN devices d ON d.id = t.device_id AND ${ACTIVE_DEVICES}
        WHERE t.storage_used_percent IS NOT NULL
          AND t.observed_at >= $1::timestamptz
          AND t.observed_at <  $2::timestamptz
        ORDER BY t.device_id, t.observed_at`,
      [fromIso, toIso],
    );

    const byDevice = new Map<string, Array<{ observedAt: string; percent: number }>>();
    for (const row of rows) {
      const points = byDevice.get(row.device_id) ?? [];
      points.push({
        observedAt: row.observed_at.toISOString(),
        percent: Number(row.storage_used_percent),
      });
      byDevice.set(row.device_id, points);
    }
    return [...byDevice].map(([deviceId, points]) => ({ deviceId, points }));
  }

  /**
   * Daily rx+tx per device for the last `days` days of the FEED, not of the clock.
   *
   * The bound is `MAX(date) - days`, deliberately: this poller runs daily and has
   * been observed running three days behind, so anchoring on `now()` would return
   * an empty recent window and the engine would read the poller's lag as fleet
   * silence. `date` is platform-supplied and still untrusted here — the engine
   * sanitises it (`sanitizeUsageDates`) before deriving anything from it.
   *
   * Not filtered to active devices: a retired device's traffic history is part of
   * the feed's daily quorum, and dropping it would make the feed look thinner
   * than it is on exactly the days that matter.
   */
  async usageDays(days: number): Promise<UsageDay[]> {
    const { rows } = await this.pool.query<{ device_id: string; date: string; bytes: string }>(
      `SELECT u.device_id,
              to_char(u.date, 'YYYY-MM-DD')          AS date,
              (u.rx_bytes + u.tx_bytes)::text        AS bytes
         FROM data_usage_days u
        WHERE u.date > (SELECT MAX(date) FROM data_usage_days) - ($1::int - 1)
        ORDER BY u.device_id, u.date`,
      [days],
    );
    return rows.map((row) => ({
      deviceId: row.device_id,
      date: row.date,
      bytes: Number(row.bytes),
    }));
  }

  /**
   * The active fleet's identity columns, for labelling trends and resolving sites.
   *
   * `group_id` and never `group_name`: the hierarchy joins on the id, and device
   * 1000015 has a populated group_id with an empty group_name.
   */
  async trendDevices(): Promise<Array<{ id: string; name: string | null; groupId: string | null }>> {
    const { rows } = await this.pool.query<{
      id: string;
      name: string | null;
      group_id: string | null;
    }>(
      `SELECT d.id, d.name, d.group_id
         FROM devices d
        WHERE ${ACTIVE_DEVICES}
        ORDER BY d.id`,
    );
    return rows.map((row) => ({ id: row.id, name: row.name, groupId: row.group_id }));
  }

  #toListItem(r: Record<string, unknown>, hierarchy: SiteResolution): DeviceListItem {
    const current = r["firmware_current"] as string | null;
    const latest = r["firmware_latest"] as string | null;
    const groupId = (r["group_id"] as string | null) ?? null;
    return {
      id: r["id"] as string,
      name: (r["name"] as string | null) ?? null,
      location: (r["location"] as string | null) ?? null,
      city: (r["city"] as string | null) ?? null,
      groupId,
      // Display text. The identity is `groupId`; one device has a valid id and an
      // empty name here, which is exactly why nothing joins on this field.
      groupName: (r["group_name"] as string | null) ?? null,
      accountName: (r["account_name"] as string | null) ?? null,
      tags: (r["tags"] as string[] | null) ?? [],
      site: deviceSite(hierarchy, groupId),
      deviceClass: r["device_class"] as string,
      modelType: (r["model_type"] as string | null) ?? null,
      status: r["status"] as string,
      lastOnlineTime: (r["last_online_time"] as Date | null)?.toISOString() ?? null,
      firmwareCurrent: current,
      firmwareLatest: latest,
      // `behind` means only that the two STRINGS DIFFER. Verified 2026-09-02:
      // `firmware_latest` holds exactly ONE distinct value across the whole fleet
      // (7.0.14-release-1712-587ccc82) spanning six device classes — canvas 191,
      // spark-bridge 33, unknown 9, allsee 7, tcl 5, allsee-shelf 4. A TCL panel
      // and an AllSee shelf label do not share a firmware build with a Videri
      // Canvas, so this reads as one tenant-wide value rather than a per-model
      // target. 36 of the 130 devices we flag behind (28%) are non-canvas, and
      // ALL 5 TCL devices are flagged behind — almost certainly an artefact
      // rather than five upgrade opportunities.
      // So the flag is literally true and the INFERENCE ("an upgrade exists for
      // this device") is not safe off-Canvas. Do not build an upgrade action on
      // it without confirming per-model semantics — docs/14 B15, docs/22 Ask 8.
      // NOTE the firmware-cohort correlation is NOT affected: it keys on the
      // CURRENT version ("devices running build X are failing"), which stands
      // whatever `latest` says.
      firmwareBehind: Boolean(current && latest && current !== latest),
      openAlerts: {
        critical: Number(r["critical"] ?? 0),
        high: Number(r["high"] ?? 0),
        medium: Number(r["medium"] ?? 0),
        info: Number(r["info"] ?? 0),
        total: Number(r["total"] ?? 0),
      },
      latest: {
        observedAt: (r["observed_at"] as Date | null)?.toISOString() ?? null,
        presence: (r["presence"] as string | null) ?? null,
        isScreenOn: (r["is_screen_on"] as boolean | null) ?? null,
        isBlackScreen: (r["is_black_screen"] as boolean | null) ?? null,
        showingLogo: (r["showing_logo"] as boolean | null) ?? null,
        // Hardware fields: slow lane FIRST, status feed as fallback.
        //
        // The order is the fix, not a preference. The status feed structurally
        // carries no hardware values, so reading it first returned null for
        // every device while the slow lane held ~100 real readings. `??` and not
        // `||` throughout: a genuine 0% CPU or a 0 dBm signal must survive, and
        // `||` would discard both as falsy.
        cpuPercent: num(r["dt_cpu"] as string | number | null)
          ?? num(r["cpu_percent"] as string | number | null),
        ramPercent: num(r["dt_ram"] as string | number | null)
          ?? num(r["ram_percent"] as string | number | null),
        // Temperature has no source on any model and no device_telemetry column,
        // so it stays status-feed-only and stays null. Do not invent a fallback.
        temperatureC: num(r["temperature_c"] as string | number | null),
        wifiSignalDbm: num(r["dt_rssi"] as string | number | null)
          ?? num(r["wifi_signal_dbm"] as string | number | null),
        storagePercent: num(r["dt_storage"] as string | number | null),
        ntpOffsetMs: num(r["dt_ntp"] as string | number | null),
        hardwareObservedAt: (r["hw_observed_at"] as Date | null)?.toISOString() ?? null,
      },
    };
  }
}
