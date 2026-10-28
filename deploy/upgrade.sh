#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
git pull --ff-only
# shellcheck disable=SC1091
source "$ROOT/deploy/compose-args.sh"
env_get() {
  local key="$1"
  [[ -f .env ]] || return 0
  grep -E "^${key}=" .env | head -n 1 | cut -d= -f2- || true
}
docker build -f Dockerfile.sandbox \
  --build-arg "HEARTH_IMAGE_PREFIX=$(env_get HEARTH_IMAGE_PREFIX)" \
  --build-arg "APT_MIRROR=$(env_get HEARTH_APT_MIRROR)" \
  -t hearth-sandbox:local .
mapfile -t parts < <(hearth_compose_arguments "$ROOT")
docker compose --project-directory "$ROOT" "${parts[@]}" up -d --build
echo "upgraded"
