#!/usr/bin/env bash
# Compose files and profiles shared by install.sh and upgrade.sh.

hearth_env_value() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  grep -E "^${key}=" "$file" | head -n 1 | cut -d= -f2- || true
}

# Prints one compose argument per line: -f files, then --profile names.
hearth_compose_arguments() {
  local root="$1"
  local env_file="$root/.env"
  printf '%s\n' -f "$root/docker-compose.yml"
  if [[ -f "$root/docker-compose.local.yml" ]]; then
    printf '%s\n' -f "$root/docker-compose.local.yml"
  fi
  local sip
  sip="$(hearth_env_value "$env_file" SIP_ENABLED)"
  if [[ "$sip" == "1" && -f "$root/docker-compose.pstn.yml" ]]; then
    printf '%s\n' -f "$root/docker-compose.pstn.yml"
  fi
  if [[ -n "${HEARTH_COMPOSE_FILES:-}" ]]; then
    local item
    local old_ifs="$IFS"
    IFS=':'
    for item in $HEARTH_COMPOSE_FILES; do
      if [[ -n "$item" && -f "$item" ]]; then
        printf '%s\n' -f "$item"
      fi
    done
    IFS="$old_ifs"
  fi
  local proxy domain turn
  proxy="$(hearth_env_value "$env_file" HEARTH_PROXY)"
  domain="$(hearth_env_value "$env_file" HEARTH_DOMAIN)"
  turn="$(hearth_env_value "$env_file" TURN_ENABLED)"
  if [[ -n "$domain" && "$proxy" != "external" && "$proxy" != "none" ]]; then
    printf '%s\n' --profile tls
  fi
  if [[ "$turn" == "1" ]]; then
    printf '%s\n' --profile turn
  fi
}
