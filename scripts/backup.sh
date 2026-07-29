#!/usr/bin/env bash
# Online SQLite backup via VACUUM INTO — safe while the server runs.
# Usage: scripts/backup.sh          (from anywhere; paths are relative
#                                    to the repository root)
# Cron:  17 3 * * * /opt/play-money-casino/scripts/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

export DB_PATH="${DB_PATH:-./data/app.db}"
export DEST="backups/app-$(date +%Y%m%d-%H%M%S).db"

if [ ! -f "$DB_PATH" ]; then
  echo "no database at $DB_PATH — nothing to back up" >&2
  exit 1
fi

mkdir -p backups

node --input-type=module <<'EOF'
import Database from "better-sqlite3";
const db = new Database(process.env.DB_PATH, { readonly: true });
// DEST is generated above (timestamp only) — no quoting hazards.
db.exec("VACUUM INTO '" + process.env.DEST + "'");
db.close();
EOF

echo "backup written: $DEST"
