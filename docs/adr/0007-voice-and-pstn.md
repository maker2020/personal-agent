# ADR 0007 — In-app voice is WebRTC; PSTN is a shared enterprise gateway

## Status

Accepted

## Context

Each tenant has an agent in an isolated sandbox. Two different calls were being conflated:

- The user talking to their own agent.
- The agent calling or answering a real phone number.

A SIP user agent inside the sandbox would put trunk credentials next to untrusted tool execution, and it would not match a consumer product where most people never receive a phone number.

## Decision

1. **User ↔ agent voice is WebRTC and is on for every plan.** The browser (including a later iOS or Android WebView) is the peer. The server answers with PCMU, gathers ICE into the answer, and runs ASR → LLM → TTS with barge-in. No SIP.

2. **PSTN is one platform trunk, not a per-user trunk.** A shared telephony gateway owns the Aliyun SIP profile, the number pool, DID routing (dedicated number, shared main plus extension, or mobile call-forwarding), concurrency, quiet hours, consent, blocklists, and usage. User agents call `placeCall(to, purpose)`. They never see SIP credentials. This capability is **off by default**. It turns on for an enterprise plan when `PSTN_ENABLED=1`, or for a local trial with `HEARTH_DEV_PSTN=1`.

3. **SMS uses the same entitlement shape.** The Aliyun template adapter, Twilio adapter, and Android-gateway slot stay in the tree. Sending is refused unless the tenant is enterprise and `SMS_ENABLED=1`, or `HEARTH_DEV_SMS=1`.

## Consequences

- Sandboxes can scale without opening UDP 5060 on every container.
- The default compose file does not publish SIP or RTP. Enterprise PSTN adds them with `docker compose -f docker-compose.yml -f docker-compose.pstn.yml up -d` (UDP 5060 and UDP 10000–10199, or `SIP_SIGNAL_PORT` / `SIP_RTP_PORT_MIN` / `SIP_RTP_PORT_MAX`). `install.sh` and `deploy/upgrade.sh` include that override when `.env` has `SIP_ENABLED=1`.
- In-app WebRTC ICE servers, the UDP port range, and the announced public address are configuration (`HEARTH_STUN_URL`, `HEARTH_ICE_SERVERS`, `HEARTH_TURN_*`, `HEARTH_RTC_PORT_MIN`/`MAX`, `HEARTH_ICE_PUBLIC_IP`). Compose publishes that UDP range, 50000–50049 by default. A TURN URL is also served over TCP, and over TLS on 5349 when `HEARTH_TURN_TLS=1`. coturn is an optional `turn` profile and denies relay to private addresses. `stun.l.google.com` is not a usable default on networks that block it. See [docs/voice.md](../voice.md).
- Adding trunk capacity or DIDs is configuration on the gateway.
- The core product can ship and be tested without an Aliyun number.
- A human can later join a PSTN call with the same WebRTC peer; that takeover sits on the gateway, not in the sandbox.

```mermaid
flowchart LR
  user[User browser]
  agent[User agent sandbox]
  gw[Shared telephony gateway]
  trunk[Aliyun SIP trunk]
  user -->|WebRTC PCMU| agent
  agent -->|placeCall internal API| gw
  gw -->|SIP and RTP| trunk
```
