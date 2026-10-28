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

Local trial without changing the plan: `HEARTH_DEV_PSTN=1` or `HEARTH_DEV_SMS=1`, plus `SIP_ENABLED=1` and the Aliyun profile in `.env.example`. Architecture: [docs/adr/0007-voice-and-pstn.md](docs/adr/0007-voice-and-pstn.md) and [中文](docs/adr/0007-voice-and-pstn.zh.md).

## Live model check

`make smoke-live` calls the real DeepSeek Messages API when `DEEPSEEK_API_KEY` is set. It exits 2 when the key is absent and never prints the key. The unit suite skips that test the same way.

## Deploy

```bash
cp .env.example .env
docker compose up -d --build
```

Health: `GET /healthz`, readiness: `GET /readyz`.
