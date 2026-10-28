# 语音

架构决定见 [ADR 0007](adr/0007-voice-and-pstn.zh.md)。English notes: [voice.md](voice.md)。

## 应用内通话

登录后打开 **语音**，点通话按钮。页面是移动端 WebRTC 客户端：一条音频，优先 PCMU，开启回声消除，远端音轨用 `playsinline` 播放。服务端在 `POST /api/voice/calls` 应答。ICE 服务器来自 `GET /api/voice/config`。

`HEARTH_STUN_URL` 是一条 STUN。留空则只收集 host 候选（本机测试，以及 `stun.l.google.com` 被墙的网络）。`HEARTH_ICE_SERVERS` 是 JSON 数组，元素形如 `{ "urls", "username", "credential" }`。也可以用 `HEARTH_TURN_URL`、`HEARTH_TURN_USERNAME`、`HEARTH_TURN_PASSWORD` 追加 TURN。网关会同时下发 `turn:<主机>:<端口>?transport=tcp`，UDP 被封时仍能通话。`HEARTH_TURN_TLS=1` 再增加 `turns:<主机>:5349?transport=tcp`（端口是 `TURN_TLS_PORT`）。浏览器拿到同一份列表，包含 TURN 口令，因为它要向中继认证。

## UDP 端口和公网地址

媒体不走 nginx。网关把 ICE 绑在 `HEARTH_RTC_PORT_MIN`–`HEARTH_RTC_PORT_MAX`（默认 UDP 50000–50049），compose 按同样的端口段发布。`HEARTH_ICE_PUBLIC_IP` 会写成一条 host 候选，这样一对一 NAT 或安全组才能把这些端口送到容器。把它设成服务器的公网地址。候选里的端口和宿主机映射端口必须相同，否则连不上。

每发布一个 UDP 端口就会多一个 `docker-proxy` 进程。默认 50 个端口。范围拉大后，小内存机器会明显变重。不想为每个端口起代理时：

- 在 `/etc/docker/daemon.json` 里写 `"userland-proxy": false` 然后重启 Docker。同样的端口改由 iptables 转发，对这台机器上所有容器生效。
- 让网关使用宿主机网络，自己绑定端口。把下面的内容放进 `docker-compose.local.yml`（需要 Compose 2.24 或更新；`upgrade.sh` 会自动带上这个文件）。宿主机网络不能再发布端口，所以要用 `!reset` 清掉基础文件里的 `ports`：

```yaml
services:
  gateway:
    network_mode: host
    ports: !reset []
```

客户端看到的地址仍要写在 `HEARTH_ICE_PUBLIC_IP`。旧变量 `HEARTH_ICE_PORT_MIN` / `MAX` 在没有设置 `HEARTH_RTC_PORT_*` 时仍会被进程读取。compose 发布的是 `HEARTH_RTC_PORT_*`。

安全组入方向：

| 用途 | 协议 | 端口 |
|---|---|---|
| 已有的 HTTPS 反代（宝塔 / nginx） | TCP | 443 |
| 应用内语音媒体 | UDP | 50000–50049（`HEARTH_RTC_PORT_MIN`–`MAX`） |
| coturn 的 STUN/TURN，仅 `--profile turn` | TCP 和 UDP | 3478（`TURN_PORT`） |
| coturn 的 TLS，仅 `HEARTH_TURN_TLS=1` | TCP | 5349（`TURN_TLS_PORT`） |
| coturn 中继，仅 `--profile turn` | UDP | 49160–49200（`TURN_MIN_PORT`–`TURN_MAX_PORT`） |

前面有 nginx 时，不要把网关 HTTP 端口发布到 `0.0.0.0`。保持 `HEARTH_HTTP_BIND=127.0.0.1`。不要把 `/metrics` 暴露到公网。

coturn 默认拒绝把中继转到私网、回环和链路本地地址（`10/8`、`172.16/12`、`192.168/16`、`127/8`、`169.254/16`、`0/8`、`::1`、`fc00::/7`、`fe80::/10`）。这样公网上的 TURN 端口碰不到监听在所有网卡上的 MySQL 或面板。公网对端仍然允许。如果必须通过 compose 网桥访问助手，只把那一段写进 `HEARTH_TURN_ALLOW_PEER`，例如 `172.18.0.0-172.18.255.255`（用 `docker network inspect` 看实际网段）。`allowed-peer-ip` 只是拒绝列表里的例外，不是放开所有内网。

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

下发的 ICE 列表里有这条 URL，以及 `turn:203.0.113.10:3478?transport=tcp`。要开 TLS，把证书和私钥挂进容器，并设置 `HEARTH_TURN_TLS=1`、`TURN_CERT`、`TURN_PKEY`。列表会再加 `turns:203.0.113.10:5349?transport=tcp`。把 `203.0.113.10` 换成公网地址。中国大陆访问不到 `stun.l.google.com:19302`。coturn 的健康检查是向本机 `TURN_PORT` 发一次 STUN。

## 真实电话和短信默认关闭

个人版只有应用内 WebRTC。企业版且 `PSTN_ENABLED=1` 才走共享阿里云中继；`SMS_ENABLED=1` 才发短信。本地试用用 `HEARTH_DEV_PSTN=1` 或 `HEARTH_DEV_SMS=1`。SIP 口令只在电话网关进程里。说明见 [sip-aliyun.zh.md](sip-aliyun.zh.md)。企业版 SIP 端口是另一个覆盖文件 `docker-compose.pstn.yml`（UDP 5060 和 UDP 10000–10199），和应用内语音无关。
