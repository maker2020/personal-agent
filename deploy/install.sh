#!/usr/bin/env bash
# One-click Hearth install for Ubuntu/Debian and CentOS/RHEL-family.
# From a checkout: sudo ./deploy/install.sh --deepseek-key "$DEEPSEEK_API_KEY" --domain agent.example.com
# From the network: curl -fsSL <raw install.sh> | sudo bash -s -- --repo https://github.com/maker2020/personal-agent.git --deepseek-key "$DEEPSEEK_API_KEY"
set -euo pipefail

PREFIX=/opt/hearth
REPO_URL="${HEARTH_REPO:-https://github.com/maker2020/personal-agent.git}"
DOMAIN=""
DEEPSEEK_KEY="${DEEPSEEK_API_KEY:-}"
DRY_RUN=0
NONINTERACTIVE=0
OS_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --deepseek-key) DEEPSEEK_KEY="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --noninteractive) NONINTERACTIVE=1; shift ;;
    --os) OS_OVERRIDE="$2"; shift 2 ;;
    -h|--help)
      echo "usage: install.sh [--prefix DIR] [--domain HOST] [--deepseek-key KEY] [--repo URL] [--dry-run] [--noninteractive]"
      exit 0
      ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { printf 'hearth-install: %s\n' "$*"; }
run() {
  if [[ "$DRY_RUN" == 1 ]]; then
    printf 'would run:'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

detect_os() {
  if [[ -n "$OS_OVERRIDE" ]]; then
    echo "$OS_OVERRIDE"
    return
  fi
  if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    case "${ID:-}${ID_LIKE:-}" in
      *rhel*|*centos*|*fedora*|*rocky*|*alma*) echo rhel; return ;;
      *debian*|*ubuntu*) echo debian; return ;;
    esac
    case "${ID:-}" in
      ubuntu|debian) echo debian; return ;;
      centos|rhel|rocky|almalinux|fedora) echo rhel; return ;;
    esac
  fi
  echo unknown
}

rand() {
  openssl rand -base64 48 | tr -d '/+=' | head -c 40
}

OS_FAMILY="$(detect_os)"
log "os family: $OS_FAMILY"

if [[ "$DRY_RUN" != 1 && "$(id -u)" -ne 0 ]]; then
  echo "run as root, or pass --dry-run" >&2
  exit 1
fi

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "docker compose already present"
    return
  fi
  case "$OS_FAMILY" in
    debian)
      run apt-get update
      run apt-get install -y ca-certificates curl git openssl
      run bash -c 'curl -fsSL https://get.docker.com | sh'
      ;;
    rhel)
      run dnf install -y ca-certificates curl git openssl
      run bash -c 'curl -fsSL https://get.docker.com | sh'
      ;;
    *)
      echo "unsupported OS family: $OS_FAMILY" >&2
      exit 1
      ;;
  esac
  run systemctl enable --now docker
}

if [[ -t 0 && -z "$DEEPSEEK_KEY" && "$NONINTERACTIVE" != 1 && "$DRY_RUN" != 1 ]]; then
  read -r -p "DeepSeek API key (DEEPSEEK_API_KEY): " DEEPSEEK_KEY
fi
if [[ -t 0 && -z "$DOMAIN" && "$NONINTERACTIVE" != 1 && "$DRY_RUN" != 1 ]]; then
  read -r -p "Public domain for HTTPS (empty to skip TLS): " DOMAIN
fi

install_docker

if [[ ! -f "$PREFIX/package.json" ]]; then
  run mkdir -p "$(dirname "$PREFIX")"
  run git clone --depth 1 "$REPO_URL" "$PREFIX"
fi

POSTGRES_PASSWORD="$(rand)"
ADMIN_PASSWORD="$(rand)"
INTERNAL_TOKEN="$(rand)"
ENV_FILE="$PREFIX/.env"

if [[ "$DRY_RUN" == 1 ]]; then
  mkdir -p "$PREFIX/deploy"
fi

umask 077
mkdir -p "$PREFIX/deploy/systemd"
if [[ -n "$DOMAIN" ]]; then
  PUBLIC_URL="https://${DOMAIN}"
  COOKIE_SECURE=1
else
  PUBLIC_URL="http://127.0.0.1:8787"
  COOKIE_SECURE=0
fi
cat > "$ENV_FILE" <<EOF
HEARTH_ENV=production
HEARTH_LOG_LEVEL=info
HEARTH_PUBLIC_URL=${PUBLIC_URL}
HEARTH_ADMIN_USER=owner
HEARTH_ADMIN_PASSWORD=${ADMIN_PASSWORD}
HEARTH_INTERNAL_TOKEN=${INTERNAL_TOKEN}
HEARTH_COOKIE_SECURE=${COOKIE_SECURE}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
DEEPSEEK_API_KEY=${DEEPSEEK_KEY}
DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_THINKING=disabled
HEARTH_PLAN=personal
PSTN_ENABLED=0
SMS_ENABLED=0
HEARTH_SANDBOX=docker
HEARTH_SANDBOX_IMAGE=hearth-sandbox:local
HEARTH_DOMAIN=${DOMAIN}
SIP_ENABLED=0
EOF
chmod 600 "$ENV_FILE"

if [[ -n "$DOMAIN" ]]; then
  cat > "$PREFIX/deploy/Caddyfile" <<EOF
${DOMAIN} {
	encode gzip
	reverse_proxy gateway:8787
}
EOF
fi

UNIT_DIR="$PREFIX/deploy/systemd"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/hearth.service" <<EOF
[Unit]
Description=Hearth personal agent
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${PREFIX}
ExecStart=/usr/bin/docker compose --project-directory ${PREFIX} up -d --remove-orphans --build
ExecStop=/usr/bin/docker compose --project-directory ${PREFIX} down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF

if [[ "$DRY_RUN" != 1 ]]; then
  cp "$UNIT_DIR/hearth.service" /etc/systemd/system/hearth.service
  docker build -f "$PREFIX/Dockerfile.sandbox" -t hearth-sandbox:local "$PREFIX"
  if [[ -n "$DOMAIN" ]]; then
    docker compose --project-directory "$PREFIX" --profile tls up -d --build
  else
    docker compose --project-directory "$PREFIX" up -d --build
  fi
  systemctl daemon-reload
  systemctl enable --now hearth.service
fi

log "env written to $ENV_FILE"
log "admin user: owner"
log "gateway health: ${PUBLIC_URL}/healthz"
if [[ -z "$DOMAIN" ]]; then
  log "no domain set; TLS proxy was not started. Pass --domain to enable Caddy."
fi
log "sentinel, gateway, and sandbox-manager are separate compose services"
log "backup: ${PREFIX}/deploy/backup.sh   upgrade: ${PREFIX}/deploy/upgrade.sh"
