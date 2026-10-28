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

不改套餐、只在本机试用阿里云线路：`HEARTH_DEV_PSTN=1` 或 `HEARTH_DEV_SMS=1`，并设置 `SIP_ENABLED=1`。架构记录（中英）：[组合](docs/adr/0001-composition.zh.md)、[主干](docs/adr/0002-spine.zh.md)、[能力](docs/adr/0003-capability.zh.md)、[控制](docs/adr/0004-control.zh.md)、[事实与 LangGraph](docs/adr/0005-truth.zh.md)、[界面](docs/adr/0006-surface.zh.md)、[语音与电话](docs/adr/0007-voice-and-pstn.zh.md)。审计说明：[docs/audit.md](docs/audit.md)。

## 真实模型检查

设置 `DEEPSEEK_API_KEY` 后执行 `make smoke-live`。没有密钥时退出码为 2，测试套件会跳过，且不会打印密钥。

## 部署

Ubuntu、Debian 或 CentOS/RHEL 系：

```bash
curl -fsSL https://raw.githubusercontent.com/maker2020/personal-agent/main/deploy/install.sh | sudo bash -s -- --deepseek-key "$DEEPSEEK_API_KEY" --domain agent.example.com
```

已经克隆仓库时：

```bash
sudo ./deploy/install.sh --deepseek-key "$DEEPSEEK_API_KEY" --domain agent.example.com
```

脚本会安装 Docker 和 compose 插件，用随机的数据库密码、管理员密码和内部令牌写 `.env`，构建 `hearth-sandbox:local`，并用 systemd 拉起相互独立的网关、哨兵和沙箱管理器容器。带 `--domain` 时由 Caddy 做 HTTPS。备份和升级：`deploy/backup.sh`、`deploy/restore.sh`、`deploy/upgrade.sh`。

不用 Docker 的开发机：`npm install && npm test && npm start`，然后打开 http://127.0.0.1:8787（未设置管理员密码时是 `owner` / `hearth-dev`）。宿主机目录沙箱只允许开发模式。
