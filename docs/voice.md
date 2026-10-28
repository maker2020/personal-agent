# Voice

English notes are in [the ADR](adr/0007-voice-and-pstn.md). 中文说明在 [ADR](adr/0007-voice-and-pstn.zh.md)。

## In-app call

Sign in, open **语音 / Voice**, and tap the call button. The page is a mobile WebRTC client: one audio transceiver, PCMU preferred, echo cancellation on, and the remote track played with `playsinline`. The server answers at `POST /api/voice/calls`. ICE servers come from `GET /api/voice/config` (`HEARTH_STUN_URL`, default `stun:stun.l.google.com:19302`). An empty `HEARTH_STUN_URL` keeps gathering on host candidates for local tests.

## PSTN and SMS stay off

| Flag | Default | Effect |
|---|---|---|
| plan `personal` | yes | WebRTC only |
| `PSTN_ENABLED=1` and plan `enterprise` | off | Shared Aliyun trunk, number pool, `placeCall` |
| `SMS_ENABLED=1` and plan `enterprise` | off | Aliyun / Twilio / Android SMS adapters |
| `HEARTH_DEV_PSTN=1` | off | Trial path for the owner's Aliyun line without an enterprise plan |
| `HEARTH_DEV_SMS=1` | off | Same for SMS |

Trial SIP still uses `SIP_PROFILE=aliyun-trial` or `aliyun-prod` and `SIP_ENABLED=1`. Credentials stay on the telephony process. See the Aliyun SIP notes in the ADR and `docs/sip-aliyun.zh.md` once that guide is present; the preset resolver is `resolveSipConfig`.
