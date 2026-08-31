-- Videri Fleet Intelligence — schema
--
-- Postgres 15+ with TimescaleDB. The history in here is the product's moat:
-- the platform serves current state only, so anything we don't persist is gone.
-- See docs/03-BUILD-STRATEGY.md §2.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── TimescaleDB is OPTIONAL ───────────────────────────────────────────────────
-- At this fleet size (250 devices ≈ 72k rows/day) plain Postgres is entirely
-- adequate; Timescale earns its keep an order of magnitude later. So we install
-- it if available and degrade cleanly if not, rather than making a heavyweight
-- dependency a precondition for running anything.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') THEN
    CREATE EXTENSION IF NOT EXISTS timescaledb;
    RAISE NOTICE 'TimescaleDB present — hypertables and compression enabled.';
  ELSE
    RAISE NOTICE 'TimescaleDB not available — using plain Postgres (fine at this scale).';
  END IF;
END $$;

-- ── Devices: current state, upserted every discovery poll ────────────────────
CREATE TABLE IF NOT EXISTS devices (
  id                  text PRIMARY KEY,
  device_id           text,
  device_jid          text,
  name                text,
  device_class        text NOT NULL DEFAULT 'unknown',
  model_type          text,
  product_name        text,
  vendor              text,
  serial_no           text,

  tenant_code         text,
  group_id            text,
  group_name          text,
  account_name        text,

  location            text,
  latitude            double precision,
  longitude           double precision,
  timezone            text,

  orientation         text,
  screen_width        integer,
  screen_height       integer,

  /* core_services_versions is a MAP of component → {current, latest}; up to 16
     com.videri.* packages per device. Stored whole so per-component drift is
     queryable, with the summary pair kept alongside for list views. */
  components          jsonb NOT NULL DEFAULT '{}',
  firmware_build_id   text,
  firmware_incremental_version text,
  firmware_current    text,
  firmware_latest     text,

  license_status      text,
  license_expiration  timestamptz,

  first_activated     timestamptz,
  last_online_time    timestamptz,
  status_changed_time timestamptz,

  tags                text[] NOT NULL DEFAULT '{}',
  /* Tenant-defined metafields from canvases.metadata[]. Populated on 250/250
     devices on this tenant and carrying NAME and CITY on every one, which makes
     it the only fleet-wide location source: geo.coordinates reaches just 35%.
     Stored as a flat {name: value} map. The vocabulary is tenant-defined, so
     nothing here may assume a given key exists. */
  metafields          jsonb NOT NULL DEFAULT '{}',
  /* When we last asked this device to capture a fresh screenshot (get_screenshot:=true).
     Drives the rotating evidence sweep: least-recently-asked devices go first, so
     the whole online estate refreshes over one sweep cycle and then loops. */
  screenshot_requested_at timestamptz,
  /* Extracted from metafields for indexing, because grouping the fleet by city
     is the whole point of reading them. NULL when the tenant does not set CITY. */
  city                text,

  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_synced_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS devices_group_idx        ON devices (group_id);
CREATE INDEX IF NOT EXISTS devices_class_idx        ON devices (device_class);
CREATE INDEX IF NOT EXISTS devices_firmware_idx     ON devices (firmware_current);
CREATE INDEX IF NOT EXISTS devices_last_online_idx  ON devices (last_online_time DESC);

-- ── Health samples: the time series ──────────────────────────────────────────
-- Nullable numerics throughout. NULL means "we could not read it", which is
-- distinct from 0 and must stay distinct all the way to the UI.
CREATE TABLE IF NOT EXISTS health_samples (
  device_id             text        NOT NULL,
  observed_at           timestamptz NOT NULL,
  /* Which poller produced this row. The status poller runs every 60s and
     carries presence/screen state only; the metrics poller runs every 300s and
     carries the untyped telemetry. Without this discriminator, a presence-only
     row is indistinguishable from a metrics row whose CPU was unreadable — and
     that distinction is the whole basis of our honesty guarantee. */
  source                text        NOT NULL DEFAULT 'metrics',

  presence              text,
  is_screen_on          boolean,
  is_black_screen       boolean,
  showing_logo          boolean,
  downloading           boolean,
  software_update_status text,
  /* TEXT, not numeric: the live API returns strings such as "no" and
     "unavailable" with an undocumented vocabulary (docs/05 §4). */
  ping_quality          text,
  playback_quality      text,
  /* From status.current — what the device is playing right now. */
  now_playing_type      text,
  now_playing_id        text,

  cpu_percent           double precision,
  ram_percent           double precision,
  temperature_c         double precision,
  wifi_signal_dbm       double precision,
  packet_loss_percent   double precision,
  jitter_ms             double precision,
  ntp_sync_percent      double precision,
  storage_percent       double precision,
  uptime_seconds        bigint,

  /* Which fields were inferred vs documented, for this row. Lets us answer
     "when did Videri change the payload shape?" retrospectively. */
  provenance            jsonb,

  PRIMARY KEY (device_id, observed_at, source)
);

-- Hypertable + compression only when Timescale is installed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('health_samples', 'observed_at', if_not_exists => TRUE);
    EXECUTE 'ALTER TABLE health_samples SET (timescaledb.compress,
             timescaledb.compress_segmentby = ''device_id'')';
    PERFORM add_compression_policy('health_samples', INTERVAL '14 days', if_not_exists => TRUE);
  END IF;
END $$;

-- Plain-Postgres fallback for time_bucket().
--
-- The application calls time_bucket(interval, timestamptz) for all bucketed
-- trend queries. Timescale provides it natively; without Timescale we define an
-- identical shim over date_bin (Postgres 14+). This keeps every query in
-- src/ai/context.ts and src/api/queries.ts working unchanged on either setup —
-- the alternative was branching the SQL, which would mean two query paths and
-- only one of them ever tested.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    CREATE OR REPLACE FUNCTION time_bucket(bucket interval, ts timestamptz)
      RETURNS timestamptz
      LANGUAGE sql IMMUTABLE PARALLEL SAFE
      AS $fn$ SELECT date_bin(bucket, ts, TIMESTAMPTZ '2000-01-01') $fn$;
  END IF;
END $$;

-- Without hypertable partitioning this index carries the time-range queries.
CREATE INDEX IF NOT EXISTS health_samples_time_idx
  ON health_samples (observed_at DESC);
CREATE INDEX IF NOT EXISTS health_samples_device_time_idx
  ON health_samples (device_id, observed_at DESC);

-- ── Raw payload retention ────────────────────────────────────────────────────
-- We keep the untransformed response for a window. If a mapping in adapter.ts
-- turns out to be wrong, we reprocess history instead of losing it — the whole
-- reason this table exists is that we are guessing at an undocumented schema.
CREATE TABLE IF NOT EXISTS raw_payloads (
  id           bigserial   PRIMARY KEY,
  device_id    text        NOT NULL,
  source       text        NOT NULL,        -- 'metrics_fetch' | 'status_fetch' | ...
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  payload      jsonb       NOT NULL
);

CREATE INDEX IF NOT EXISTS raw_payloads_device_time_idx
  ON raw_payloads (device_id, fetched_at DESC);

-- ── Discovered telemetry vocabulary ──────────────────────────────────────────
-- Populated automatically by the adapter every time it meets a key it has not
-- seen. This is how we build the schema documentation the API does not provide:
-- run the poller for a day, then read this table.
CREATE TABLE IF NOT EXISTS discovered_keys (
  container     text NOT NULL,   -- 'super_props' | 'status'
  key           text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  observations  bigint NOT NULL DEFAULT 1,
  sample_values jsonb  NOT NULL DEFAULT '[]',
  inferred_type text,
  /* Set once a human decides what this key means. */
  mapped_to     text,
  PRIMARY KEY (container, key)
);

-- ── Data usage: daily rx/tx, the platform's only real history ────────────────
CREATE TABLE IF NOT EXISTS data_usage_days (
  device_id text NOT NULL,
  date      date NOT NULL,
  rx_bytes  bigint NOT NULL,
  tx_bytes  bigint NOT NULL,
  PRIMARY KEY (device_id, date)
);

-- ── Alerts: ours, not Videri's ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_rules (
  id                    text PRIMARY KEY,
  name                  text NOT NULL,
  enabled               boolean NOT NULL DEFAULT true,
  severity              text NOT NULL,
  metric                text NOT NULL,
  comparator            text NOT NULL,
  threshold             jsonb NOT NULL,
  sustained_for_seconds integer NOT NULL DEFAULT 0,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alerts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id          text NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  rule_id            text NOT NULL,
  severity           text NOT NULL,
  title              text NOT NULL,
  evidence           text NOT NULL,
  opened_at          timestamptz NOT NULL DEFAULT now(),
  /* Last tick on which the rule actually fired. Resolution waits until the
     condition has been clear for the rule's clearForSeconds — without this,
     a metric oscillating around its threshold opens and closes an alert every
     tick, and flapping is the main reason operators mute alerting entirely. */
  last_fired_at      timestamptz NOT NULL DEFAULT now(),
  acknowledged_at    timestamptz,
  acknowledged_by    text,
  resolved_at        timestamptz,
  videri_alert_uuid  text
);

-- One open alert per device per rule. Re-firing updates instead of duplicating.
CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_unique
  ON alerts (device_id, rule_id) WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS alerts_open_idx
  ON alerts (severity, opened_at DESC) WHERE resolved_at IS NULL;

-- ── Fleet snapshots: pre-computed rollups ────────────────────────────────────
-- Serving these from a table rather than fanning out N API calls per page view
-- is most of the perceived speed advantage over a direct-to-API client.
CREATE TABLE IF NOT EXISTS fleet_snapshots (
  computed_at timestamptz PRIMARY KEY DEFAULT now(),
  snapshot    jsonb NOT NULL
);

-- ── Contract canary results ──────────────────────────────────────────────────
-- Our early-warning system for upstream breaking changes.
CREATE TABLE IF NOT EXISTS canary_runs (
  id         bigserial PRIMARY KEY,
  ran_at     timestamptz NOT NULL DEFAULT now(),
  passed     boolean NOT NULL,
  findings   jsonb NOT NULL
);

-- ── Poller run log ───────────────────────────────────────────────────────────
-- One row per poller tick. Cheap, and it answers the questions that otherwise
-- require guessing: is the pipeline actually running, is it keeping up, which
-- batches are failing, and how much of the fleet did we manage to read.
CREATE TABLE IF NOT EXISTS poller_runs (
  id              bigserial   PRIMARY KEY,
  poller          text        NOT NULL,
  started_at      timestamptz NOT NULL,
  finished_at     timestamptz NOT NULL DEFAULT now(),
  duration_ms     integer     NOT NULL,
  devices_targeted integer    NOT NULL DEFAULT 0,
  rows_written    integer     NOT NULL DEFAULT 0,
  batches_ok      integer     NOT NULL DEFAULT 0,
  batches_failed  integer     NOT NULL DEFAULT 0,
  /* Share of targeted devices for which at least one inferred metric resolved.
     Trending toward zero means Videri changed the payload under us. */
  telemetry_yield real,
  errors          jsonb       NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS poller_runs_poller_time_idx
  ON poller_runs (poller, started_at DESC);

-- ── Alert rule storage ───────────────────────────────────────────────────────
-- DEFAULT_RULES in src/alerting/rules.ts seeds this table on first run. After
-- that the table wins: operators tune thresholds through the UI, and a code
-- deploy must not silently revert their tuning.
CREATE TABLE IF NOT EXISTS alert_rule_definitions (
  id          text        PRIMARY KEY,
  definition  jsonb       NOT NULL,
  enabled     boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Generated AI briefs ──────────────────────────────────────────────────────
-- The read API serves the most recent brief rather than generating one per
-- request: generation costs a model call and takes seconds, and every viewer
-- should see the same brief anyway.
CREATE TABLE IF NOT EXISTS briefs (
  id           bigserial   PRIMARY KEY,
  generated_at timestamptz NOT NULL DEFAULT now(),
  window_hours integer     NOT NULL,
  brief        jsonb       NOT NULL,
  /* Snapshot of the data the brief was generated from, so a claim can always be
     traced back to what was true at the time. */
  bundle       jsonb,
  model        text,
  input_tokens integer,
  output_tokens integer
);

CREATE INDEX IF NOT EXISTS briefs_generated_idx ON briefs (generated_at DESC);

-- ── Device settings (slow lane) ───────────────────────────────────────────────
-- Populated by ops_get_settings, one device at a time over the command channel.
-- Kept separate from health_samples because the access pattern is completely
-- different: minutes not seconds, per-device not batched, and the payload is a
-- configuration snapshot rather than a metric reading.
CREATE TABLE IF NOT EXISTS device_settings (
  device_id     text        NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  observed_at   timestamptz NOT NULL DEFAULT now(),
  /* Whole settings object as returned. Config surfaces differ by device class,
     so a fixed column set would either lose fields or be mostly null. */
  settings      jsonb       NOT NULL,
  device_class  text        NOT NULL DEFAULT 'unknown',
  /* Which command produced it, for provenance. */
  source        text        NOT NULL DEFAULT 'ops_get_settings',
  PRIMARY KEY (device_id, observed_at)
);

CREATE INDEX IF NOT EXISTS device_settings_latest_idx
  ON device_settings (device_id, observed_at DESC);

-- The real player_id is a separate numeric identifier returned in command
-- responses — NOT the device id. Cached here after the first successful command
-- so later calls address the device correctly.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS player_id text;

-- ── Compliance ────────────────────────────────────────────────────────────────
-- Templates define expected configuration per device class. Seeded from
-- src/compliance/templates.ts on first run; the table wins afterwards so
-- operator tuning survives a deploy.
CREATE TABLE IF NOT EXISTS compliance_templates (
  id          text        PRIMARY KEY,
  name        text        NOT NULL,
  definition  jsonb       NOT NULL,
  enabled     boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Which template each device is held to. Absent = use the class default.
CREATE TABLE IF NOT EXISTS device_template_assignments (
  device_id   text PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
  template_id text NOT NULL,
  assigned_by text,
  assigned_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS compliance_results (
  device_id     text        NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  evaluated_at  timestamptz NOT NULL DEFAULT now(),
  template_id   text        NOT NULL,
  /* 0-100 weighted pass rate over APPLICABLE checks only. */
  score         integer     NOT NULL,
  checks_total  integer     NOT NULL,
  checks_passed integer     NOT NULL,
  /* Checks skipped because the field does not exist on this hardware — counted
     separately so a Canvas is never penalised for lacking HDMI settings. */
  checks_na     integer     NOT NULL DEFAULT 0,
  /* Per-check detail: field, expected, actual, verdict. */
  drift         jsonb       NOT NULL DEFAULT '[]',
  /* Age of the settings snapshot this verdict was computed from. Compliance is
     only as fresh as the slow-lane poll behind it, and the UI must say so. */
  settings_age_seconds integer,
  PRIMARY KEY (device_id, evaluated_at)
);

CREATE INDEX IF NOT EXISTS compliance_results_latest_idx
  ON compliance_results (device_id, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS compliance_results_score_idx
  ON compliance_results (score);

-- Runtime telemetry read via demo_command (slow lane). Latest-per-device semantics.
CREATE TABLE IF NOT EXISTS device_telemetry (
  device_id            text        NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  observed_at          timestamptz NOT NULL DEFAULT now(),
  cpu_percent          integer,
  ram_used_percent     integer,
  ram_total_gb         numeric,
  ram_free_gb          numeric,
  storage_used_percent integer,
  storage_total_mb     integer,
  rssi_dbm             integer,
  ntp_offset_ms        numeric,
  ntp_reach            integer,
  ntp_server           text,
  fields_read          text[]      NOT NULL DEFAULT '{}',
  PRIMARY KEY (device_id, observed_at)
);
CREATE INDEX IF NOT EXISTS device_telemetry_latest_idx
  ON device_telemetry (device_id, observed_at DESC);

-- Fleet-wide scheduled proof-of-play (slow lane). Latest-per-device semantics.
-- Persisted "scheduled now" snapshot per canvas from publisher v1 events, so gap
-- detection runs over the whole fleet from stored rows. `fetched_at` carries how
-- old the snapshot is; it is never presented as live.
CREATE TABLE IF NOT EXISTS device_schedule (
  device_id           text        NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  observed_at         timestamptz NOT NULL DEFAULT now(),
  schedule_date       date        NOT NULL,
  scheduled_count     integer     NOT NULL DEFAULT 0,
  has_active_schedule boolean      NOT NULL DEFAULT false,
  scheduled_items     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  fetched_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, observed_at)
);
CREATE INDEX IF NOT EXISTS device_schedule_latest_idx
  ON device_schedule (device_id, observed_at DESC);

-- ── Generated AI action plans (US-5.2) ───────────────────────────────────────
-- Kept separate from `briefs`: the payloads differ (a plan stores the structured
-- intelligence it was built from, not a fleet bundle), and both endpoints serve
-- "the most recent row" — one table with two row-types would have the brief
-- endpoint returning plans. `input` is the snapshot every item traces back to.
CREATE TABLE IF NOT EXISTS action_plans (
  id            bigserial   PRIMARY KEY,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  window_hours  integer     NOT NULL,
  plan          jsonb       NOT NULL,
  input         jsonb,
  model         text,
  input_tokens  integer,
  output_tokens integer
);
CREATE INDEX IF NOT EXISTS action_plans_generated_idx ON action_plans (generated_at DESC);
