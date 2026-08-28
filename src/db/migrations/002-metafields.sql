-- Tenant-defined metafields, and city extracted for grouping.
-- Safe to re-run.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS metafields jsonb NOT NULL DEFAULT '{}';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS city text;
CREATE INDEX IF NOT EXISTS devices_city_idx ON devices (city) WHERE city IS NOT NULL;
