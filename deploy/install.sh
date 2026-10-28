#!/usr/bin/env bash
# One-click Hearth install for Ubuntu/Debian and CentOS/RHEL-family.
#
# Prefer the environment over argv so the DeepSeek key does not land in shell history:
#   export DEEPSEEK_API_KEY=...
#   sudo --preserve-env=DEEPSEEK_API_KEY ./deploy/install.sh --domain agent.example.com
# A terminal with no key gets a hidden prompt. --deepseek-key remains optional.
#
# Before the branch is merged, point curl at that branch and pass --ref:
#   sudo --preserve-env=DEEPSEEK_API_KEY bash -c 'curl -fsSL https://raw.githubusercontent.com/maker2020/personal-agent/cursor/hearth-personal-agent-23e9/deploy/install.sh | bash -s -- --ref cursor/hearth-personal-agent-23e9 --domain agent.example.com'
#
# Mainland China: add --mirror cn (or HEARTH_MIRROR=cn). Docker CE comes from
# https://mirrors.aliyun.com/docker-ce and npm uses https://registry.npmmirror.com.
# A Docker Hub accelerator is per-account. Set HEARTH_DOCKER_REGISTRY_MIRROR to the
# URL from the Aliyun container registry console (镜像工具 → 镜像加速器). This script
# does not invent one. On an Aliyun VPC, set
# HEARTH_DOCKER_MIRROR_BASE=http://mirrors.cloud.aliyuncs.com/docker-ce
set -euo pipefail

ENV_KEYS=(
  HEARTH_ENV
  HEARTH_LOG_LEVEL
  HEARTH_PUBLIC_URL
  HEARTH_ADMIN_USER
  HEARTH_ADMIN_PASSWORD
  HEARTH_INTERNAL_TOKEN
  HEARTH_COOKIE_SECURE
  POSTGRES_PASSWORD
  DEEPSEEK_API_KEY
  DEEPSEEK_BASE_URL
  DEEPSEEK_MODEL
  DEEPSEEK_THINKING
  HEARTH_PLAN
  PSTN_ENABLED
  SMS_ENABLED
  HEARTH_SANDBOX
  HEARTH_SANDBOX_IMAGE
  HEARTH_WORKSPACE_ROOT
  HEARTH_DOMAIN
  SIP_ENABLED
  NPM_REGISTRY
)

log() { printf 'hearth-install: %s\n' "$*"; }

hearth_rand() {
  openssl rand -hex 20
}

hearth_detect_os() {
  if [[ -n "${OS_OVERRIDE:-}" ]]; then
    printf '%s\n' "$OS_OVERRIDE"
    return
  fi
  if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    if [[ "${ID:-}" == "centos" && "${VERSION_ID:-}" == 7* ]]; then
      echo centos7
      return
    fi
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

hearth_docker_base() {
  local base="${HEARTH_DOCKER_MIRROR_BASE:-https://mirrors.aliyun.com/docker-ce}"
  printf '%s\n' "${base%/}"
}

# Prints the installer action. Returns 1 when this OS cannot be installed.
hearth_docker_plan() {
  local family="$1"
  local mirror="$2"
  case "$family" in
    debian)
      if [[ "$mirror" == "cn" ]]; then
        echo "apt packages, then Docker CE from $(hearth_docker_base) (get.docker.com --mirror Aliyun unless HEARTH_DOCKER_MIRROR_BASE is a VPC mirror); npm registry https://registry.npmmirror.com"
      else
        echo "apt packages, then https://get.docker.com"
      fi
      ;;
    rhel)
      if [[ "$mirror" == "cn" ]]; then
        echo "dnf packages, then Docker CE from $(hearth_docker_base) (get.docker.com --mirror Aliyun unless HEARTH_DOCKER_MIRROR_BASE is a VPC mirror); npm registry https://registry.npmmirror.com"
      else
        echo "dnf packages, then https://get.docker.com"
      fi
      ;;
    centos7)
      if [[ "$mirror" == "cn" ]]; then
        echo "yum packages, then Docker CE from $(hearth_docker_base)/linux/centos/docker-ce.repo (CentOS 7); npm registry https://registry.npmmirror.com"
      else
        echo "CentOS 7 has yum, not dnf, and get.docker.com no longer supports it (the script only prints an end-of-life warning). Re-run with --mirror cn to install Docker CE from https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo, or use Rocky, Alma, or RHEL 8+." >&2
        return 1
      fi
      ;;
    *)
      echo "unsupported OS family: $family" >&2
      return 1
      ;;
  esac
}

hearth_merge_env() {
  local -A current=()
  local -A next=()
  local line key val item known
  if [[ -f "$ENV_FILE" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
      key="${line%%=*}"
      val="${line#*=}"
      current["$key"]="$val"
      next["$key"]="$val"
    done < "$ENV_FILE"
  fi

  local kept_db=0
  if [[ -n "${next[POSTGRES_PASSWORD]:-}" ]]; then
    kept_db=1
  else
    next[POSTGRES_PASSWORD]="$(hearth_rand)"
  fi
  if [[ -z "${next[HEARTH_ADMIN_PASSWORD]:-}" ]]; then
    next[HEARTH_ADMIN_PASSWORD]="$(hearth_rand)"
  fi
  if [[ -z "${next[HEARTH_INTERNAL_TOKEN]:-}" ]]; then
    next[HEARTH_INTERNAL_TOKEN]="$(hearth_rand)"
  fi
  if [[ "$DEEPSEEK_KEY_SET" == 1 ]]; then
    next[DEEPSEEK_API_KEY]="$DEEPSEEK_KEY"
  fi
  if [[ "$DOMAIN_SET" == 1 ]]; then
    next[HEARTH_DOMAIN]="$DOMAIN"
  fi
  if [[ -n "${next[HEARTH_DOMAIN]:-}" ]]; then
    next[HEARTH_PUBLIC_URL]="https://${next[HEARTH_DOMAIN]}"
    next[HEARTH_COOKIE_SECURE]=1
  elif [[ "$DOMAIN_SET" == 1 ]]; then
    next[HEARTH_PUBLIC_URL]="http://127.0.0.1:8787"
    next[HEARTH_COOKIE_SECURE]=0
  fi
  if [[ "$MIRROR" == "cn" && -z "${next[NPM_REGISTRY]:-}" ]]; then
    next[NPM_REGISTRY]="https://registry.npmmirror.com"
  fi

  local -a defaults=(
    HEARTH_ENV=production
    HEARTH_LOG_LEVEL=info
    HEARTH_PUBLIC_URL=http://127.0.0.1:8787
    HEARTH_ADMIN_USER=owner
    HEARTH_COOKIE_SECURE=0
    DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic
    DEEPSEEK_MODEL=deepseek-flash
    DEEPSEEK_THINKING=disabled
    HEARTH_PLAN=personal
    PSTN_ENABLED=0
    SMS_ENABLED=0
    HEARTH_SANDBOX=docker
    HEARTH_SANDBOX_IMAGE=hearth-sandbox:local
    HEARTH_WORKSPACE_ROOT=/var/lib/hearth/workspaces
    SIP_ENABLED=0
  )
  for item in "${defaults[@]}"; do
    key="${item%%=*}"
    val="${item#*=}"
    if [[ -z "${next[$key]:-}" ]]; then
      next["$key"]="$val"
    fi
  done
  if [[ -z "${next[DEEPSEEK_API_KEY]+x}" ]]; then
    next[DEEPSEEK_API_KEY]=""
  fi
  if [[ -z "${next[HEARTH_DOMAIN]+x}" ]]; then
    next[HEARTH_DOMAIN]=""
  fi
  if [[ -z "${next[NPM_REGISTRY]+x}" ]]; then
    next[NPM_REGISTRY]=""
  fi

  EFFECTIVE_DOMAIN="${next[HEARTH_DOMAIN]:-}"
  EFFECTIVE_SIP="${next[SIP_ENABLED]:-0}"

  if [[ "$DRY_RUN" == 1 ]]; then
    log "would merge ${ENV_FILE} without writing it"
    return 0
  fi

  mkdir -p "$(dirname "$ENV_FILE")"
  local tmp
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  {
    for key in "${ENV_KEYS[@]}"; do
      printf '%s=%s\n' "$key" "${next[$key]:-}"
    done
    local -a extra=()
    for key in "${!current[@]}"; do
      known=0
      for item in "${ENV_KEYS[@]}"; do
        if [[ "$item" == "$key" ]]; then
          known=1
          break
        fi
      done
      if [[ "$known" == 0 ]]; then
        extra+=("$key")
      fi
    done
    if ((${#extra[@]} > 0)); then
      local sorted
      while IFS= read -r sorted; do
        printf '%s=%s\n' "$sorted" "${current[$sorted]}"
      done < <(printf '%s\n' "${extra[@]}" | sort)
    fi
  } > "$tmp"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  if [[ "$kept_db" == 1 ]]; then
    log "kept existing POSTGRES_PASSWORD"
  else
    log "generated POSTGRES_PASSWORD"
  fi
  log "env written to ${ENV_FILE}"
}

hearth_install_docker() {
  local family="$1"
  local base
  base="$(hearth_docker_base)"
  case "$family" in
    debian)
      apt-get update
      apt-get install -y ca-certificates curl gnupg git openssl
      if [[ "$MIRROR" == "cn" && -n "${HEARTH_DOCKER_MIRROR_BASE:-}" && "$base" != "https://mirrors.aliyun.com/docker-ce" ]]; then
        hearth_apt_docker_repo "$base"
      elif [[ "$MIRROR" == "cn" ]]; then
        curl -fsSL https://get.docker.com | sh -s -- --mirror Aliyun
      else
        curl -fsSL https://get.docker.com | sh
      fi
      ;;
    rhel)
      dnf install -y ca-certificates curl git openssl
      if [[ "$MIRROR" == "cn" && -n "${HEARTH_DOCKER_MIRROR_BASE:-}" && "$base" != "https://mirrors.aliyun.com/docker-ce" ]]; then
        hearth_yum_docker_repo "$base" dnf
      elif [[ "$MIRROR" == "cn" ]]; then
        curl -fsSL https://get.docker.com | sh -s -- --mirror Aliyun
      else
        curl -fsSL https://get.docker.com | sh
      fi
      ;;
    centos7)
      yum install -y yum-utils git openssl ca-certificates
      hearth_yum_docker_repo "$base" yum
      ;;
    *)
      echo "unsupported OS family: $family" >&2
      return 1
      ;;
  esac
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now docker
  fi
  hearth_write_registry_mirror
}

hearth_apt_docker_repo() {
  local base="$1"
  local distro codename
  # shellcheck disable=SC1091
  . /etc/os-release
  distro="${ID:-ubuntu}"
  if [[ "$distro" != "debian" && "$distro" != "ubuntu" ]]; then
    distro="ubuntu"
  fi
  codename="${VERSION_CODENAME:-stable}"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "${base}/linux/${distro}/gpg" | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] ${base}/linux/${distro} ${codename} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

hearth_yum_docker_repo() {
  local base="$1"
  local tool="$2"
  cat > /etc/yum.repos.d/docker-ce.repo <<EOF
[docker-ce-stable]
name=Docker CE Stable - \$basearch
baseurl=${base}/linux/centos/\$releasever/\$basearch/stable
enabled=1
gpgcheck=1
gpgkey=${base}/linux/centos/gpg
EOF
  if [[ "$tool" == "dnf" ]]; then
    dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  else
    yum install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
}

hearth_write_registry_mirror() {
  local mirror="${HEARTH_DOCKER_REGISTRY_MIRROR:-}"
  if [[ -z "$mirror" ]]; then
    if [[ "$MIRROR" == "cn" ]]; then
      log "docker registry-mirrors left unset; set HEARTH_DOCKER_REGISTRY_MIRROR to the accelerator URL from the Aliyun container registry console"
    fi
    return 0
  fi
  if [[ -f /etc/docker/daemon.json ]]; then
    log "HEARTH_DOCKER_REGISTRY_MIRROR is set and /etc/docker/daemon.json already exists; leaving it unchanged"
    return 0
  fi
  mkdir -p /etc/docker
  cat > /etc/docker/daemon.json <<EOF
{
  "registry-mirrors": ["${mirror}"]
}
EOF
  if command -v systemctl >/dev/null 2>&1; then
    systemctl restart docker || true
  fi
  log "wrote /etc/docker/daemon.json registry-mirrors from HEARTH_DOCKER_REGISTRY_MIRROR"
}

hearth_clone() {
  if [[ ! -f "$PREFIX/package.json" ]]; then
    mkdir -p "$(dirname "$PREFIX")"
    if [[ -n "$REF" ]]; then
      git clone --depth 1 --branch "$REF" "$REPO_URL" "$PREFIX"
    else
      git clone --depth 1 "$REPO_URL" "$PREFIX"
    fi
  elif [[ -n "$REF" ]]; then
    git -C "$PREFIX" fetch --depth 1 origin "$REF"
    git -C "$PREFIX" checkout --force FETCH_HEAD
  fi
}

main() {
  local PREFIX=/opt/hearth
  local REPO_URL="${HEARTH_REPO:-https://github.com/maker2020/personal-agent.git}"
  local REF="${HEARTH_REF:-}"
  local DOMAIN=""
  local DEEPSEEK_KEY="${DEEPSEEK_API_KEY:-}"
  local DRY_RUN=0
  local NONINTERACTIVE=0
  local OS_OVERRIDE=""
  local MIRROR="${HEARTH_MIRROR:-}"
  local DOMAIN_SET=0
  local DEEPSEEK_KEY_SET=0
  if [[ -n "$DEEPSEEK_KEY" ]]; then
    DEEPSEEK_KEY_SET=1
  fi

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --prefix) PREFIX="$2"; shift 2 ;;
      --repo) REPO_URL="$2"; shift 2 ;;
      --ref|--branch) REF="$2"; shift 2 ;;
      --domain) DOMAIN="$2"; DOMAIN_SET=1; shift 2 ;;
      --deepseek-key) DEEPSEEK_KEY="$2"; DEEPSEEK_KEY_SET=1; shift 2 ;;
      --mirror) MIRROR="$2"; shift 2 ;;
      --dry-run) DRY_RUN=1; shift ;;
      --noninteractive) NONINTERACTIVE=1; shift ;;
      --os) OS_OVERRIDE="$2"; shift 2 ;;
      -h|--help)
        cat <<'EOF'
usage: install.sh [--prefix DIR] [--domain HOST] [--repo URL] [--ref REF] [--branch REF]
                  [--deepseek-key KEY] [--mirror cn] [--dry-run] [--noninteractive]
                  [--os debian|rhel|centos7]

DEEPSEEK_API_KEY is read from the environment. A terminal with no key gets a hidden prompt.
--deepseek-key is optional. Re-running keeps POSTGRES_PASSWORD, HEARTH_ADMIN_PASSWORD,
and HEARTH_INTERNAL_TOKEN already stored in .env. --dry-run writes nothing and does not need root.
EOF
        exit 0
        ;;
      *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
  done

  if [[ -n "$MIRROR" && "$MIRROR" != "cn" ]]; then
    echo "unknown mirror: $MIRROR (supported: cn)" >&2
    exit 2
  fi

  export DRY_RUN DEEPSEEK_KEY DEEPSEEK_KEY_SET DOMAIN DOMAIN_SET MIRROR
  local ENV_FILE="$PREFIX/.env"
  export ENV_FILE
  EFFECTIVE_DOMAIN=""
  EFFECTIVE_SIP="0"

  local family plan
  family="$(hearth_detect_os)"
  log "os family: $family"
  if ! plan="$(hearth_docker_plan "$family" "$MIRROR")"; then
    exit 1
  fi
  log "$plan"

  if [[ "$DRY_RUN" == 1 ]]; then
    if [[ -n "$REF" ]]; then
      log "would git clone --branch ${REF} ${REPO_URL} into ${PREFIX}"
    else
      log "would git clone ${REPO_URL} into ${PREFIX}"
    fi
    log "would merge ${ENV_FILE} and keep an existing POSTGRES_PASSWORD"
    if [[ "$MIRROR" == "cn" ]]; then
      if [[ -n "${HEARTH_DOCKER_REGISTRY_MIRROR:-}" ]]; then
        log "would write /etc/docker/daemon.json registry-mirrors from HEARTH_DOCKER_REGISTRY_MIRROR"
      else
        log "docker registry-mirrors left unset; set HEARTH_DOCKER_REGISTRY_MIRROR to the accelerator URL from the Aliyun container registry console"
      fi
    fi
    log "dry-run writes nothing"
    exit 0
  fi

  if [[ "$(id -u)" -ne 0 ]]; then
    echo "run as root, or pass --dry-run" >&2
    exit 1
  fi

  if [[ -t 0 && "$DEEPSEEK_KEY_SET" != 1 && "$NONINTERACTIVE" != 1 ]]; then
    read -r -s -p "DeepSeek API key (input hidden; or export DEEPSEEK_API_KEY): " DEEPSEEK_KEY
    echo
    if [[ -n "$DEEPSEEK_KEY" ]]; then
      DEEPSEEK_KEY_SET=1
    fi
  fi
  if [[ -t 0 && "$DOMAIN_SET" != 1 && -z "$DOMAIN" && "$NONINTERACTIVE" != 1 ]]; then
    read -r -p "Public domain for HTTPS (empty to skip TLS): " DOMAIN
    if [[ -n "$DOMAIN" ]]; then
      DOMAIN_SET=1
    fi
  fi

  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "docker compose already present"
    hearth_write_registry_mirror
  else
    hearth_install_docker "$family"
  fi

  hearth_clone
  hearth_merge_env

  local workspace="${HEARTH_WORKSPACE_ROOT:-/var/lib/hearth/workspaces}"
  if [[ -f "$ENV_FILE" ]]; then
    local from_env
    from_env="$(grep -E '^HEARTH_WORKSPACE_ROOT=' "$ENV_FILE" | head -n 1 | cut -d= -f2- || true)"
    if [[ -n "$from_env" ]]; then
      workspace="$from_env"
    fi
  fi
  mkdir -p "$workspace"
  chmod 755 "$workspace"

  if [[ -n "$EFFECTIVE_DOMAIN" ]]; then
    mkdir -p "$PREFIX/deploy"
    cat > "$PREFIX/deploy/Caddyfile" <<EOF
${EFFECTIVE_DOMAIN} {
	encode gzip
	reverse_proxy gateway:8787
}
EOF
  fi

  local compose_args="-f ${PREFIX}/docker-compose.yml"
  if [[ "$EFFECTIVE_SIP" == "1" ]]; then
    compose_args="${compose_args} -f ${PREFIX}/docker-compose.pstn.yml"
    log "SIP_ENABLED=1; systemd will publish UDP 5060 and the RTP range"
  fi
  local profile=""
  if [[ -n "$EFFECTIVE_DOMAIN" ]]; then
    profile="--profile tls"
  fi

  mkdir -p "$PREFIX/deploy/systemd"
  cat > "$PREFIX/deploy/systemd/hearth.service" <<EOF
[Unit]
Description=Hearth personal agent
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${PREFIX}
ExecStart=/usr/bin/docker compose --project-directory ${PREFIX} ${compose_args} ${profile} up -d --remove-orphans --build
ExecStop=/usr/bin/docker compose --project-directory ${PREFIX} ${compose_args} ${profile} down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF
  cp "$PREFIX/deploy/systemd/hearth.service" /etc/systemd/system/hearth.service
  docker build -f "$PREFIX/Dockerfile.sandbox" -t hearth-sandbox:local "$PREFIX"
  # shellcheck disable=SC2086
  docker compose --project-directory "$PREFIX" ${compose_args} ${profile} up -d --build
  systemctl daemon-reload
  systemctl enable --now hearth.service

  log "admin user: owner"
  if [[ -n "$EFFECTIVE_DOMAIN" ]]; then
    log "gateway health: https://${EFFECTIVE_DOMAIN}/healthz"
  else
    log "gateway health: http://127.0.0.1:8787/healthz"
    log "no domain set; TLS proxy was not started. Pass --domain to enable Caddy."
  fi
  log "sentinel, gateway, and sandbox-manager are separate compose services"
  log "workspace bind: ${workspace}"
  log "backup: ${PREFIX}/deploy/backup.sh   upgrade: ${PREFIX}/deploy/upgrade.sh"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
