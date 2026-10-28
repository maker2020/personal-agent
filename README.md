# Hearth

Personal agent platform on DeepSeek Harness (`@deepseek-ai/dsh@0.2.1-rc.2`). 中文说明见 [README.zh.md](README.zh.md)。

Every user gets an in-app **WebRTC** voice call with their own agent (PCMU, barge-in, mobile browser). Real phone calls and SMS are enterprise features and stay **off** until a tenant is entitled.

## Voice

Open the app, sign in, choose **语音**, and tap the call button. The browser is the WebRTC peer. The server answers with PCMU and runs the voice pipeline. No SIP credentials are involved.

```bash
npm install
npm test
npm start
```

Then open http://127.0.0.1:8787 . Dev login is `owner` / `hearth-dev` unless `HEARTH_ADMIN_PASSWORD` is set. ICE servers, the UDP port range, and coturn are in [docs/voice.md](docs/voice.md).

`node scripts/verify-voice-browser.mjs` signs in with headless Chrome at a phone-sized viewport and checks that the call reaches “通话中”.

## Plans

| Capability | Personal (default) | Enterprise |
|---|---|---|
| WebRTC with the agent | on | on |
| PSTN via the shared Aliyun trunk | off | `PSTN_ENABLED=1` |
| SMS | off | `SMS_ENABLED=1` |

Architecture decisions, English and 中文: [composition](docs/adr/0001-composition.md), [spine](docs/adr/0002-spine.md), [capability](docs/adr/0003-capability.md), [control](docs/adr/0004-control.md), [truth and LangGraph](docs/adr/0005-truth.md), [surface](docs/adr/0006-surface.md), [voice and PSTN](docs/adr/0007-voice-and-pstn.md). Audit notes: [docs/audit.md](docs/audit.md).

## Live model check

`make smoke-live` calls the real DeepSeek Messages API when `DEEPSEEK_API_KEY` is set. It exits 2 when the key is absent and never prints the key. The unit suite skips that test the same way.

## Deploy

On Ubuntu, Debian, or a CentOS/RHEL 8+ host. The key is read from the environment (or a hidden prompt); it is not required on the command line.

```bash
sudo --preserve-env=DEEPSEEK_API_KEY bash -c 'curl -fsSL https://raw.githubusercontent.com/maker2020/personal-agent/main/deploy/install.sh | bash -s -- --domain agent.example.com'
```

From a checkout:

```bash
sudo --preserve-env=DEEPSEEK_API_KEY ./deploy/install.sh --domain agent.example.com
```

Before this branch is merged, install that ref instead of `main`:

```bash
sudo --preserve-env=DEEPSEEK_API_KEY bash -c 'curl -fsSL https://raw.githubusercontent.com/maker2020/personal-agent/cursor/hearth-personal-agent-23e9/deploy/install.sh | bash -s -- --ref cursor/hearth-personal-agent-23e9 --domain agent.example.com'
```

`--branch` is the same as `--ref` and is passed to `git clone --branch`. Re-running the script keeps `POSTGRES_PASSWORD`, `HEARTH_ADMIN_PASSWORD`, and `HEARTH_INTERNAL_TOKEN` already in `.env`. `--dry-run` prints the plan and writes nothing, including when it is not root. `--deepseek-key` remains optional.

Mainland China (`--mirror cn` or `HEARTH_MIRROR=cn`): Docker CE is installed from `https://mirrors.aliyun.com/docker-ce` (`get.docker.com --mirror Aliyun` on Debian and RHEL 8+; yum on CentOS 7). The image build uses apt `https://mirrors.aliyun.com`, npm `https://registry.npmmirror.com`, the static Docker client from `https://mirrors.aliyun.com/docker-ce/linux/static/stable`, and base images from `mirror.ccs.tencentyun.com/` (`HEARTH_IMAGE_PREFIX`). Override the apt mirror with `HEARTH_APT_MIRROR` (`http://mirrors.tencentyun.com` on a Tencent VPC, or `https://mirrors.cloud.tencent.com`). A Docker Hub accelerator is per-account: set `HEARTH_DOCKER_REGISTRY_MIRROR` to the URL from the Aliyun container registry console (镜像工具 → 镜像加速器). On an Aliyun VPC, set `HEARTH_DOCKER_MIRROR_BASE=http://mirrors.cloud.aliyuncs.com/docker-ce`. CentOS 7 without `--mirror cn` stops with a refusal, because `get.docker.com` no longer supports it and the host has yum rather than dnf.

Behind an existing reverse proxy (BaoTa nginx):

```bash
sudo --preserve-env=DEEPSEEK_API_KEY ./deploy/install.sh --proxy external --domain agent.example.com --http-port 8787
```

`--no-caddy` is the same as `--proxy external`. Caddy stays off, the gateway is published on `127.0.0.1:8787` (`HEARTH_HTTP_BIND` / `HEARTH_HTTP_PORT`), and `deploy/nginx/hearth.conf` is a sample vhost: `proxy_buffering off`, long read timeouts, WebSocket upgrade headers, and `/metrics` closed. Put those locations into the server block that already has TLS.

The script installs Docker and the compose plugin, builds `hearth-sandbox:local`, and starts gateway, sentinel, and sandbox-manager as separate compose services under systemd. The manager image includes the Docker client. With `--domain` and the default proxy, Caddy terminates HTTPS. Backup and upgrade: `deploy/backup.sh`, `deploy/restore.sh`, `deploy/upgrade.sh`. `upgrade.sh` keeps `docker-compose.local.yml` when that file exists, plus any paths in `HEARTH_COMPOSE_FILES` (colon-separated).

In-app voice needs UDP, not just the HTTPS proxy. Compose publishes UDP 50000–50199 and can add coturn with `--profile turn`. Set `HEARTH_ICE_PUBLIC_IP` to the public address. `stun.l.google.com` does not work from mainland China. Ports and the sample config are in [docs/voice.md](docs/voice.md) and [docs/voice.zh.md](docs/voice.zh.md).

The sandbox manager bind-mounts `/var/lib/hearth/workspaces` (override with an absolute `HEARTH_WORKSPACE_ROOT`) at that same path. Per-user containers use that host path, so `sandbox_write` and `sandbox_exec` see the same files, owned by uid 65534.

Enterprise PSTN publishes signaling and media only through the override:

```bash
docker compose -f docker-compose.yml -f docker-compose.pstn.yml up -d
```

That maps UDP 5060 and UDP 10000–10199. Set `SIP_ENABLED=1`, `PSTN_ENABLED=1`, and an enterprise plan (or `HEARTH_DEV_PSTN=1` for a trial). When `SIP_ENABLED=1` is already in `.env`, `install.sh` and `deploy/upgrade.sh` include the override.

Invites expire after `HEARTH_INVITE_TTL_HOURS` (default 168). Signup consumes the invite in the same transaction as user creation.

Dev without Docker: `npm install && npm test && npm start`, then http://127.0.0.1:8787 (`owner` / `hearth-dev` if no admin password is set). The host-folder sandbox is dev-only.
