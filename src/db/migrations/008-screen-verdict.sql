-- 008 — screen-check verdicts (verification slow lane)
--
-- Why this table exists: on 2026-09-01 the platform reported
-- `is_black_screen = true` in every status sample for device 1000152 while an
-- on-demand screenshot showed a live dashboard, and our engine dutifully raised
-- a CRITICAL from it. `verifyBlackScreenClaim` (src/intelligence/screen-verify.ts)
-- can settle that question by asking the panel itself — but asking costs a
-- synchronous device command, and the alerting engine runs every ~450s over the
-- whole fleet and must stay pure over stored data. So the asking happens in a
-- slow lane and lands here; the engine only ever READS these rows.
--
-- Append-only, one row per verification attempt, latest-per-device semantics —
-- the same shape as device_telemetry and device_schedule. History matters here
-- more than usual: a persistent disagreement between the platform flag and the
-- panel is itself the finding, and overwriting would erase the pattern.
--
-- Every column that could not be read is NULL, never false. `platform_claim`
-- NULL means we held no readable is_black_screen sample; `device_is_black` NULL
-- means the panel did not answer, which is neither agreement nor refutation.
-- `verbs_read` records which verbs actually answered, so a NULL can always be
-- distinguished from a "no".
CREATE TABLE IF NOT EXISTS device_screen_verdict (
  device_id              text        NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  observed_at            timestamptz NOT NULL DEFAULT now(),
  platform_claim         boolean,
  device_is_black        boolean,
  device_is_showing_logo boolean,
  verdict                text        NOT NULL,
  detail                 text        NOT NULL DEFAULT '',
  verbs_read             text[]      NOT NULL DEFAULT '{}',
  PRIMARY KEY (device_id, observed_at)
);

-- The engine reads exactly one row per device (the newest) on every cycle, and
-- the lane's rotation orders by the same column, so index precisely that.
CREATE INDEX IF NOT EXISTS device_screen_verdict_latest_idx
  ON device_screen_verdict (device_id, observed_at DESC);
