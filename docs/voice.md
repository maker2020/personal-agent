# Voice

English notes are in [the ADR](adr/0007-voice-and-pstn.md). 中文说明见 [voice.zh.md](voice.zh.md)。

## In-app call

Sign in, open **语音 / Voice**, and tap the call button. The page is a mobile WebRTC client: one audio transceiver, PCMU preferred, echo cancellation on, and the remote track played with `playsinline`. The server answers at `POST /api/voice/calls`. ICE servers come from `GET /api/voice/config`.

`HEARTH_STUN_URL` is one STUN URL. Leave it empty to gather host candidates only (local tests, and any network where `stun.l.google.com` is blocked). `HEARTH_ICE_SERVERS` is a JSON list of `{ "urls", "username", "credential" }`. `HEARTH_TURN_URL`, `HEARTH_TURN_USERNAME`, and `HEARTH_TURN_PASSWORD` add a TURN server. The browser receives the same list, including the TURN credential, because it has to authenticate to the relay.

## UDP ports and the public address

Media does not go through nginx. The gateway process binds ICE in `HEARTH_ICE_PORT_MIN`–`HEARTH_ICE_PORT_MAX` (default UDP 50000–50199) and compose publishes that same range. `HEARTH_ICE_PUBLIC_IP` is added as a host candidate so a 1:1 NAT or cloud security group can deliver those ports to the container. Set it to the server's public address. Opening a different host port than the port inside the candidate will not connect.

Security group, inbound, from the internet (or from your users' networks):

| Purpose | Protocol | Ports |
|---|---|---|
| Existing HTTPS proxy (BaoTa / nginx) | TCP | 443 |
| In-app voice media | UDP | 50000–50199 (`HEARTH_ICE_PORT_MIN`–`MAX`) |
| coturn STUN/TURN, only with `--profile turn` | TCP and UDP | 3478 (`TURN_PORT`) |
| coturn relay, only with `--profile turn` | UDP | 49160–49200 (`TURN_MIN_PORT`–`TURN_MAX_PORT`) |

Do not publish the gateway's HTTP port on `0.0.0.0` when nginx is in front. Keep `HEARTH_HTTP_BIND=127.0.0.1`. Do not expose `/metrics`.

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

Replace `203.0.113.10` with the public address. `stun.l.google.com:19302` is not reachable from mainland China.

## PSTN and SMS stay off

| Flag | Default | Effect |
|---|---|---|
| plan `personal` | yes | WebRTC only |
| `PSTN_ENABLED=1` and plan `enterprise` | off | Shared Aliyun trunk, number pool, `placeCall` |
| `SMS_ENABLED=1` and plan `enterprise` | off | Aliyun / Twilio / Android SMS adapters |
| `HEARTH_DEV_PSTN=1` | off | Trial path for the owner's Aliyun line without an enterprise plan |
| `HEARTH_DEV_SMS=1` | off | Same for SMS |

Trial SIP still uses `SIP_PROFILE=aliyun-trial` or `aliyun-prod` and `SIP_ENABLED=1`. Credentials stay on the telephony process. See [docs/sip-aliyun.zh.md](sip-aliyun.zh.md). Enterprise SIP ports are a separate override, `docker-compose.pstn.yml` (UDP 5060 and UDP 10000–10199), and they are not required for in-app voice.
