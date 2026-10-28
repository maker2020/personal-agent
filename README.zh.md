# Hearth

基于 DeepSeek Harness（`@deepseek-ai/dsh@0.2.1-rc.2`）的个人助手。English notes: [README.md](README.md)。

每个用户都有一条和应用内助手的 **WebRTC** 语音通话（PCMU、可打断、手机浏览器）。拨打真实电话和短信是企业版能力，**默认关闭**。

## 语音

登录后打开「语音」，点通话按钮。浏览器是 WebRTC 对端，服务端用 PCMU 应答，不经过 SIP，沙箱里也没有中继口令。

```bash
npm install
npm test
npm start
```

浏览器打开 http://127.0.0.1:8787 。未设置 `HEARTH_ADMIN_PASSWORD` 时，开发账号是 `owner` / `hearth-dev`。

`node scripts/verify-voice-browser.mjs` 用无头 Chrome、手机尺寸视口登录，并确认通话状态变为「通话中」。

## 套餐

| 能力 | 个人版（默认） | 企业版 |
|---|---|---|
| 与助手的 WebRTC | 开 | 开 |
| 阿里云共享中继的真实电话 | 关 | `PSTN_ENABLED=1` |
| 短信 | 关 | `SMS_ENABLED=1` |

不改套餐、只在本机试用阿里云线路：`HEARTH_DEV_PSTN=1` 或 `HEARTH_DEV_SMS=1`，并设置 `SIP_ENABLED=1` 与 `.env.example` 里的阿里云配置。架构说明：[英文 ADR](docs/adr/0007-voice-and-pstn.md)、[中文 ADR](docs/adr/0007-voice-and-pstn.zh.md)。

## 真实模型检查

设置 `DEEPSEEK_API_KEY` 后执行 `make smoke-live`。没有密钥时退出码为 2，测试套件会跳过，且不会打印密钥。

## 部署

```bash
cp .env.example .env
docker compose up -d --build
```

健康检查：`GET /healthz`，就绪：`GET /readyz`。
