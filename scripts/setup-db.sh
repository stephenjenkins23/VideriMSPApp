#!/usr/bin/env bash
# Create the VFI database and apply the schema.
#
#   ./scripts/setup-db.sh                                  # local default
#   DATABASE_URL=postgres://... ./scripts/setup-db.sh       # explicit target
#
# Idempotent: safe to re-run. TimescaleDB is used if present, skipped if not.
set -euo pipefail

DB_NAME="${DB_NAME:-vfi}"
DB_USER="${DB_USER:-vfi}"
DB_PASS="${DB_PASS:-vfi}"
URL="${DATABASE_URL:-postgres://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}}"

command -v psql >/dev/null || {
  echo "psql not found. Install with:  brew install postgresql@16" >&2
  echo "then:                          brew services start postgresql@16" >&2
  exit 1
}

echo "→ ensuring role and database exist"
psql postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 \
  || psql postgres -c "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}' SUPERUSER;"
psql postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
  || psql postgres -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"

echo "→ applying schema"
psql "$URL" -v ON_ERROR_STOP=1 -f "$(dirname "$0")/../src/db/schema.sql"

echo "→ verifying"
psql "$URL" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" \
  | xargs -I{} echo "   {} tables created"
psql "$URL" -tAc "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname='timescaledb')
                              THEN 'timescaledb: enabled' ELSE 'timescaledb: not installed (using date_bin shim)' END"

echo
echo "Ready. DATABASE_URL=${URL}"
