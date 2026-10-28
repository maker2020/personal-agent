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

Then open http://127.0.0.1:8787 . Dev login is `owner` / `hearth-dev` unless `HEARTH_ADMIN_PASSWORD` is set.

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

On Ubuntu, Debian, or a CentOS/RHEL-family host:

```bash
curl -fsSL https://raw.githubusercontent.com/maker2020/personal-agent/main/deploy/install.sh | sudo bash -s -- --deepseek-key "$DEEPSEEK_API_KEY" --domain agent.example.com
```

From a checkout:

```bash
sudo ./deploy/install.sh --deepseek-key "$DEEPSEEK_API_KEY" --domain agent.example.com
```

The script installs Docker and the compose plugin, writes `.env` with random `POSTGRES_PASSWORD`, admin password, and internal token, builds `hearth-sandbox:local`, and starts gateway, sentinel, and sandbox-manager as separate compose services under systemd. With `--domain`, Caddy terminates HTTPS. Backup and upgrade: `deploy/backup.sh`, `deploy/restore.sh`, `deploy/upgrade.sh`.

Dev without Docker: `npm install && npm test && npm start`, then http://127.0.0.1:8787 (`owner` / `hearth-dev` if no admin password is set). The host-folder sandbox is dev-only.
