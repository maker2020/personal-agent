# ADR 0007 — 应用内语音走 WebRTC，真实电话走共享企业网关

## 状态

已接受

## 背景

每个用户有自己的助手，跑在隔离的沙箱里。有两种完全不同的通话：

- 用户和自己的助手说话。
- 助手拨打或接听真实电话号码。

如果把 SIP 用户代理放进沙箱，中继账号就会和不可信的工具执行放在一起。消费级产品里，大多数用户也不会各自拥有一个号码。

## 决定

1. **用户和助手的语音是 WebRTC，所有套餐都有。** 浏览器（以及以后的 iOS / Android WebView）是对端。服务端用 PCMU 应答，把 ICE 候选收进 answer，再走 ASR → LLM → TTS，并支持打断。这里没有 SIP。

2. **真实电话是平台级的一条中继，不是每个用户一条。** 共享电话网关持有阿里云 SIP 配置、号码池、呼入路由（专属号码、总机加分机、手机呼叫转移）、并发、静默时段、同意、禁呼和用量。用户助手只调用 `placeCall(to, purpose)`，看不到 SIP 口令。该能力**默认关闭**。企业套餐且 `PSTN_ENABLED=1` 时打开；本地试用阿里云线路时用 `HEARTH_DEV_PSTN=1`。

3. **短信使用同样的开通方式。** 阿里云模板适配器、Twilio 和未来的 Android 网关都留在代码里。未开通时发送会被拒绝。企业套餐且 `SMS_ENABLED=1`，或设置 `HEARTH_DEV_SMS=1`，才会发送。

## 后果

- 沙箱扩容时不必给每个容器开放 UDP 5060。
- 默认 compose 不发布 SIP 和 RTP。企业版真实电话用 `docker compose -f docker-compose.yml -f docker-compose.pstn.yml up -d` 补上 UDP 5060 和 UDP 10000–10199（或 `SIP_SIGNAL_PORT` / `SIP_RTP_PORT_MIN` / `SIP_RTP_PORT_MAX`）。`.env` 里 `SIP_ENABLED=1` 时，`install.sh` 和 `deploy/upgrade.sh` 会带上这个覆盖文件。
- 增加中继容量或号码只改网关配置。
- 核心产品可以在没有阿里云号码的情况下交付和测试。
- 用户以后可以用同一个 WebRTC 对端加入助手正在进行的真实电话；接管发生在网关，不在沙箱里。

```mermaid
flowchart LR
  user[用户浏览器]
  agent[用户助手沙箱]
  gw[共享电话网关]
  trunk[阿里云 SIP 中继]
  user -->|WebRTC PCMU| agent
  agent -->|placeCall 内部接口| gw
  gw -->|SIP 与 RTP| trunk
```
