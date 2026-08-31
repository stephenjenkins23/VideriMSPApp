-- 007 — device retirement (soft delete)
--
-- The devices table is an accumulating registry: every discovery sweep upserts,
-- nothing ever removes. Measured 2026-08-31: 250 rows in the DB against 249
-- devices in the live API. Row 1035066 ("Spark Bridge 2026 2") was last synced
-- four days behind the fleet maximum and no longer appears in `/canvases` at all
-- — so every fleet-wide total we publish was inflated by a device that does not
-- exist.
--
-- Soft delete, NEVER a hard DELETE: the health-sample history behind a
-- decommissioned device is the only record that it was ever there, the deletion
-- is irreversible, and a device absent from one sweep may simply be a device the
-- platform failed to list. `retired_at` is reversible in one UPDATE.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS retired_at timestamptz;

-- Every fleet count filters on `retired_at IS NULL`, so index exactly that.
CREATE INDEX IF NOT EXISTS devices_active_idx ON devices (id) WHERE retired_at IS NULL;
