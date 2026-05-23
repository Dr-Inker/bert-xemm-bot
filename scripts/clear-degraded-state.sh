#!/usr/bin/env bash
# Clear poisoned bot state. Run when intentionally resetting after a known issue.
# Truncates orders/fills/hedges/kill_events; clears degraded flag.
# Preserves basis_samples (next observer run appends clean rows).

set -euo pipefail

DB="${1:-/var/lib/bert-xemm-bot/state.db}"

if [ ! -f "$DB" ]; then
  echo "DB not found: $DB" >&2
  exit 1
fi

echo "Clearing degraded state in $DB"
sqlite3 "$DB" <<'SQL'
DELETE FROM kill_events;
DELETE FROM hedges;
DELETE FROM fills;
DELETE FROM orders;
INSERT INTO flags(key, value) VALUES('degraded', '0')
  ON CONFLICT(key) DO UPDATE SET value='0';
SQL

echo "Done. State after cleanup:"
sqlite3 "$DB" "SELECT 'kill_events', COUNT(*) FROM kill_events
               UNION ALL SELECT 'hedges', COUNT(*) FROM hedges
               UNION ALL SELECT 'fills', COUNT(*) FROM fills
               UNION ALL SELECT 'orders', COUNT(*) FROM orders
               UNION ALL SELECT 'degraded_flag', COUNT(*) FROM flags WHERE key='degraded' AND value='0';"
