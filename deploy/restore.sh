#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FILE="${1:?sql dump path}"
docker compose --project-directory "$ROOT" exec -T postgres psql -U hearth -d hearth < "$FILE"
echo "restored $FILE"
