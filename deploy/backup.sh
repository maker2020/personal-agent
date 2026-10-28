#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${1:-$ROOT/backups/$STAMP}"
mkdir -p "$DEST"
docker compose --project-directory "$ROOT" exec -T postgres pg_dump -U hearth hearth > "$DEST/hearth.sql"
echo "wrote $DEST/hearth.sql"
