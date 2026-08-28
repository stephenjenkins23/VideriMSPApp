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
