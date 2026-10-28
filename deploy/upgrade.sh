#!/usr/bin/env bash
set -euo pipefail

# Retry a command. GitHub fetches from mainland China often fail once and succeed next.
hearth_retry() {
  local max="$1"
  shift
  local attempt=1
  local delay="${HEARTH_RETRY_DELAY:-3}"
  while true; do
    if "$@"; then
      return 0
    fi
    if [[ "$attempt" -ge "$max" ]]; then
      echo "hearth-upgrade: failed after ${max} attempts: $*" >&2
      return 1
    fi
    echo "hearth-upgrade: attempt ${attempt}/${max} failed, retrying" >&2
    if [[ "$delay" != "0" ]]; then
      sleep $((attempt * delay))
    fi
    attempt=$((attempt + 1))
  done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  cd "$ROOT"
  hearth_retry 5 git pull --ff-only
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
fi
