-- Rotating screenshot-capture cursor. Safe to re-run.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS screenshot_requested_at timestamptz;
CREATE INDEX IF NOT EXISTS devices_shot_cursor_idx
  ON devices (screenshot_requested_at ASC NULLS FIRST);
