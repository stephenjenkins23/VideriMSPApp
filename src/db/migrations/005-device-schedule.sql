-- Fleet-wide scheduled proof-of-play (slow lane). Latest-per-device semantics.
--
-- Persists the platform SCHEDULE we read per canvas from the publisher's v1
-- events endpoint, so gap detection can run over the WHOLE fleet from stored
-- rows instead of live-sampling a bounded batch on every request. Each row is
-- the "scheduled now" snapshot as of `fetched_at`: `scheduled_items` is the set
-- of events whose window covered the fetch instant, `scheduled_count` its size,
-- and `has_active_schedule` whether anything was scheduled at all. `fetched_at`
-- carries how old that snapshot is, so it is never presented as live.
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
