#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
git pull --ff-only
docker build -f Dockerfile.sandbox -t hearth-sandbox:local .
args=(docker compose -f docker-compose.yml)
if [[ -f .env ]] && grep -q '^SIP_ENABLED=1$' .env; then
  args+=(-f docker-compose.pstn.yml)
fi
if [[ -n "${HEARTH_DOMAIN:-}" ]]; then
  args+=(--profile tls)
fi
"${args[@]}" up -d --build
echo "upgraded"
