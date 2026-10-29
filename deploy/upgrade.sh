#!/usr/bin/env bash
set -euo pipefail

# An existing --mirror cn install has the apt/image mirrors but not the speech URLs.
hearth_prepare_speech_env() {
  local file="${1:-.env}"
  [[ -f "$file" ]] || return 0
  local apt prefix
  apt="$(grep -E '^HEARTH_APT_MIRROR=' "$file" | head -n 1 | cut -d= -f2- || true)"
  prefix="$(grep -E '^HEARTH_IMAGE_PREFIX=' "$file" | head -n 1 | cut -d= -f2- || true)"
  if [[ "$apt" != *aliyun.com* && "$prefix" != *tencentyun.com* ]]; then
    return 0
  fi
  hearth_append_env "$file" PIP_INDEX_URL "https://mirrors.aliyun.com/pypi/simple"
  hearth_append_env "$file" HEARTH_VOSK_MODEL_URL "https://hf-mirror.com/localstack/vosk-models/resolve/main/vosk-model-small-cn-0.22.zip"
}

hearth_append_env() {
  local file="$1" key="$2" value="$3"
  if grep -qE "^${key}=" "$file"; then
    return 0
  fi
  printf '%s=%s\n' "$key" "$value" >> "$file"
}

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
  source "$ROOT/deploy/vosk-model.sh"
  # shellcheck disable=SC1091
  source "$ROOT/deploy/compose-args.sh"
  env_get() {
    local key="$1"
    [[ -f .env ]] || return 0
    grep -E "^${key}=" .env | head -n 1 | cut -d= -f2- || true
  }
  hearth_prepare_speech_env "$ROOT/.env"
  hearth_fetch_vosk_model "$(env_get HEARTH_VOSK_MODEL_DIR)" "$(env_get HEARTH_VOSK_MODEL_URL)"
  docker build -f Dockerfile.sandbox \
    --build-arg "HEARTH_IMAGE_PREFIX=$(env_get HEARTH_IMAGE_PREFIX)" \
    --build-arg "APT_MIRROR=$(env_get HEARTH_APT_MIRROR)" \
    -t hearth-sandbox:local .
  mapfile -t parts < <(hearth_compose_arguments "$ROOT")
  docker compose --project-directory "$ROOT" "${parts[@]}" up -d --build
  echo "upgraded"
fi
