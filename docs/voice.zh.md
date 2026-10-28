# 语音

架构决定见 [ADR 0007](adr/0007-voice-and-pstn.zh.md)。English notes: [voice.md](voice.md)。

## 应用内通话

登录后打开 **语音**，点通话按钮。页面是移动端 WebRTC 客户端：一条音频，优先 PCMU，开启回声消除，远端音轨用 `playsinline` 播放。服务端在 `POST /api/voice/calls` 应答。ICE 服务器来自 `GET /api/voice/config`。

`HEARTH_STUN_URL` 是一条 STUN。留空则只收集 host 候选（本机测试，以及 `stun.l.google.com` 被墙的网络）。`HEARTH_ICE_SERVERS` 是 JSON 数组，元素形如 `{ "urls", "username", "credential" }`。也可以用 `HEARTH_TURN_URL`、`HEARTH_TURN_USERNAME`、`HEARTH_TURN_PASSWORD` 追加一个 TURN。浏览器拿到同一份列表，包含 TURN 口令，因为它要向中继认证。

## UDP 端口和公网地址

媒体不走 nginx。网关把 ICE 绑在 `HEARTH_ICE_PORT_MIN`–`HEARTH_ICE_PORT_MAX`（默认 UDP 50000–50199），compose 按同样的端口段发布。`HEARTH_ICE_PUBLIC_IP` 会写成一条 host 候选，这样一对一 NAT 或安全组才能把这些端口送到容器。把它设成服务器的公网地址。候选里的端口和宿主机映射端口必须相同，否则连不上。

安全组入方向：

| 用途 | 协议 | 端口 |
|---|---|---|
| 已有的 HTTPS 反代（宝塔 / nginx） | TCP | 443 |
| 应用内语音媒体 | UDP | 50000–50199（`HEARTH_ICE_PORT_MIN`–`MAX`） |
| coturn 的 STUN/TURN，仅 `--profile turn` | TCP 和 UDP | 3478（`TURN_PORT`） |
| coturn 中继，仅 `--profile turn` | UDP | 49160–49200（`TURN_MIN_PORT`–`TURN_MAX_PORT`） |

前面有 nginx 时，不要把网关 HTTP 端口发布到 `0.0.0.0`。保持 `HEARTH_HTTP_BIND=127.0.0.1`。不要把 `/metrics` 暴露到公网。

## coturn

`docker-compose.yml` 里的 coturn 在 `turn` profile 下，默认不启动。`.env` 里 `TURN_ENABLED=1` 时，安装和升级会加上 `--profile turn`。也可以手动：

```bash
docker compose --profile turn up -d
```

需要 `HEARTH_TURN_USERNAME`、`HEARTH_TURN_PASSWORD` 和 `HEARTH_ICE_PUBLIC_IP`。客户端指向它：

```bash
HEARTH_STUN_URL=stun:203.0.113.10:3478
HEARTH_TURN_URL=turn:203.0.113.10:3478?transport=udp
HEARTH_TURN_USERNAME=hearth
HEARTH_TURN_PASSWORD=换成你的口令
HEARTH_ICE_PUBLIC_IP=203.0.113.10
TURN_ENABLED=1
```

把 `203.0.113.10` 换成公网地址。中国大陆访问不到 `stun.l.google.com:19302`。

## 真实电话和短信默认关闭

个人版只有应用内 WebRTC。企业版且 `PSTN_ENABLED=1` 才走共享阿里云中继；`SMS_ENABLED=1` 才发短信。本地试用用 `HEARTH_DEV_PSTN=1` 或 `HEARTH_DEV_SMS=1`。SIP 口令只在电话网关进程里。说明见 [sip-aliyun.zh.md](sip-aliyun.zh.md)。企业版 SIP 端口是另一个覆盖文件 `docker-compose.pstn.yml`（UDP 5060 和 UDP 10000–10199），和应用内语音无关。
