#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
git pull --ff-only
docker build -f Dockerfile.sandbox -t hearth-sandbox:local .
if [[ -n "${HEARTH_DOMAIN:-}" ]]; then
  docker compose --profile tls up -d --build
else
  docker compose up -d --build
fi
echo "upgraded"
