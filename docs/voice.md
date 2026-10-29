# Voice

English notes are in [the ADR](adr/0007-voice-and-pstn.md). 中文说明见 [voice.zh.md](voice.zh.md)。

## In-app call

Sign in, open **语音 / Voice**, and tap the call button. The page is a mobile WebRTC client: one audio transceiver, PCMU preferred, echo cancellation on, and the remote track played with `playsinline`. The server answers at `POST /api/voice/calls`. ICE servers come from `GET /api/voice/config`, which also reports `asr` and `tts`.

Speech recognition defaults to a local Vosk model (`vosk-model-small-cn-0.22`, about 42 MB) in the `vosk` compose service. No API key. The gateway sends each utterance as 16 kHz mono PCM over `HEARTH_VOSK_URL` (default `ws://vosk:2700`). Synthesis defaults to Microsoft Edge voices through the same sidecar (`HEARTH_TTS_PROVIDER=edge`, voice `zh-CN-XiaoxiaoNeural`). Replies are spoken sentence by sentence. Set `HEARTH_TTS_RATE` and `HEARTH_TTS_PITCH` if you want to change them (`+0%`, `+0Hz`).

`install.sh` and `upgrade.sh` download the model into `/var/lib/hearth/vosk` when that directory does not already contain `vosk-model-small-cn-0.22/am`. The default zip is `https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip`. `--mirror cn` uses `https://hf-mirror.com/localstack/vosk-models/resolve/main/vosk-model-small-cn-0.22.zip` and installs Python packages from `https://mirrors.aliyun.com/pypi/simple`. Override either with `HEARTH_VOSK_MODEL_URL` or `PIP_INDEX_URL`. On a host that already has the Aliyun apt mirror or the Tencent image prefix, `upgrade.sh` writes those two lines when they are missing. The sidecar is built from `python:3.12-slim`, capped at 512 MB, and publishes no host ports. The gateway waits until its health check passes.

Pull this revision, then run the new upgrade script. The copy of `upgrade.sh` already on the server does not download the model, and Compose will wait on a sidecar that exits until the model is there:

```bash
cd /opt/hearth
git pull --ff-only
sudo bash deploy/upgrade.sh
```

`HEARTH_ASR_PROVIDER=openai` with `HEARTH_ASR_API_KEY` still uses the hosted transcription API (SiliconFlow by default). `HEARTH_TTS_PROVIDER=openai` does the same for synthesis. `none` turns that side off: `/api/voice/config` returns false, the page shows “语音识别/合成未配置”, and the server plays no tone.

`HEARTH_STUN_URL` is one STUN URL. Leave it empty to gather host candidates only (local tests, and any network where `stun.l.google.com` is blocked). `HEARTH_ICE_SERVERS` is a JSON list of `{ "urls", "username", "credential" }`. `HEARTH_TURN_URL`, `HEARTH_TURN_USERNAME`, and `HEARTH_TURN_PASSWORD` add a TURN server. The gateway also serves `turn:<host>:<port>?transport=tcp` with the same user, so a network that blocks UDP can still place the call. `HEARTH_TURN_TLS=1` adds `turns:<host>:5349?transport=tcp` (`TURN_TLS_PORT`). The browser receives that list, including the TURN credential, because it has to authenticate to the relay.

## UDP ports and the public address

Media does not go through nginx. The gateway process binds ICE in `HEARTH_RTC_PORT_MIN`–`HEARTH_RTC_PORT_MAX` (default UDP 50000–50049) and compose publishes that same range. `HEARTH_ICE_PUBLIC_IP` is added as a host candidate so a 1:1 NAT or cloud security group can deliver those ports to the container. Set it to the server's public address. Opening a different host port than the port inside the candidate will not connect.

Each published UDP port starts a `docker-proxy` process. The default is 50 ports. A wider range costs RAM on a small machine. Two ways to avoid the proxies:

- Set `"userland-proxy": false` in `/etc/docker/daemon.json` and restart Docker. Docker then uses iptables for the same published ports. This applies to every container on the host.
- Run the gateway on the host network so it binds the ports itself. Put this in `docker-compose.local.yml` (Compose 2.24 or newer; `upgrade.sh` already includes that file). `ports` from the base file must be cleared, because host networking cannot publish ports:

```yaml
services:
  gateway:
    network_mode: host
    ports: !reset []
```

`HEARTH_ICE_PUBLIC_IP` is still required when the host address is not the address clients use. An older name, `HEARTH_ICE_PORT_MIN` / `MAX`, is still read by the process when the `HEARTH_RTC_PORT_*` pair is unset. Compose publishes `HEARTH_RTC_PORT_*`.

Security group, inbound, from the internet (or from your users' networks):

| Purpose | Protocol | Ports |
|---|---|---|
| Existing HTTPS proxy (BaoTa / nginx) | TCP | 443 |
| In-app voice media | UDP | 50000–50049 (`HEARTH_RTC_PORT_MIN`–`MAX`) |
| coturn STUN/TURN, only with `--profile turn` | TCP and UDP | 3478 (`TURN_PORT`) |
| coturn TURN over TLS, only when `HEARTH_TURN_TLS=1` | TCP | 5349 (`TURN_TLS_PORT`) |
| coturn relay, only with `--profile turn` | UDP | 49160–49200 (`TURN_MIN_PORT`–`TURN_MAX_PORT`) |

Do not publish the gateway's HTTP port on `0.0.0.0` when nginx is in front. Keep `HEARTH_HTTP_BIND=127.0.0.1`. Do not expose `/metrics`.

Coturn refuses to relay to private, loopback, and link-local addresses (`10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `0/8`, `::1`, `fc00::/7`, `fe80::/10`). That keeps a public TURN port away from MySQL or a panel bound on every interface. Public peers stay allowed. If the agent must be reached on the compose bridge, set `HEARTH_TURN_ALLOW_PEER` to that range only, for example `172.18.0.0-172.18.255.255` (`docker network inspect`). `allowed-peer-ip` is an exception inside the deny list, not a wide open relay.

## coturn

`docker-compose.yml` includes coturn under the `turn` profile. It stays off until `TURN_ENABLED=1` (install and upgrade add `--profile turn`) or you run:

```bash
docker compose --profile turn up -d
```

Set `HEARTH_TURN_USERNAME`, `HEARTH_TURN_PASSWORD`, and `HEARTH_ICE_PUBLIC_IP`. Point the clients at it:

```bash
HEARTH_STUN_URL=stun:203.0.113.10:3478
HEARTH_TURN_URL=turn:203.0.113.10:3478?transport=udp
HEARTH_TURN_USERNAME=hearth
HEARTH_TURN_PASSWORD=replace-me
HEARTH_ICE_PUBLIC_IP=203.0.113.10
TURN_ENABLED=1
```

The served ICE list includes that URL and `turn:203.0.113.10:3478?transport=tcp`. For TLS, mount a certificate and key and set `HEARTH_TURN_TLS=1`, `TURN_CERT`, and `TURN_PKEY`. The list then also includes `turns:203.0.113.10:5349?transport=tcp`. Replace `203.0.113.10` with the public address. `stun.l.google.com:19302` is not reachable from mainland China. Coturn's healthcheck is a STUN binding to `127.0.0.1` on `TURN_PORT`.

## PSTN and SMS stay off

| Flag | Default | Effect |
|---|---|---|
| plan `personal` | yes | WebRTC only |
| `PSTN_ENABLED=1` and plan `enterprise` | off | Shared Aliyun trunk, number pool, `placeCall` |
| `SMS_ENABLED=1` and plan `enterprise` | off | Aliyun / Twilio / Android SMS adapters |
| `HEARTH_DEV_PSTN=1` | off | Trial path for the owner's Aliyun line without an enterprise plan |
| `HEARTH_DEV_SMS=1` | off | Same for SMS |

Trial SIP still uses `SIP_PROFILE=aliyun-trial` or `aliyun-prod` and `SIP_ENABLED=1`. Credentials stay on the telephony process. See [docs/sip-aliyun.zh.md](sip-aliyun.zh.md). Enterprise SIP ports are a separate override, `docker-compose.pstn.yml` (UDP 5060 and UDP 10000–10199), and they are not required for in-app voice.
