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

浏览器打开 http://127.0.0.1:8787 。未设置 `HEARTH_ADMIN_PASSWORD` 时，开发账号是 `owner` / `hearth-dev`。ICE 服务器、UDP 端口和 coturn 见 [docs/voice.zh.md](docs/voice.zh.md)。

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

适用于 Ubuntu、Debian 或 CentOS/RHEL 8+。密钥从环境变量读取，也可以在终端里隐藏输入，不必写在命令行上。

```bash
sudo --preserve-env=DEEPSEEK_API_KEY bash -c 'curl -fsSL https://raw.githubusercontent.com/maker2020/personal-agent/main/deploy/install.sh | bash -s -- --domain agent.example.com'
```

已经克隆仓库时：

```bash
sudo --preserve-env=DEEPSEEK_API_KEY ./deploy/install.sh --domain agent.example.com
```

合并到 `main` 之前，用分支上的脚本并加上 `--ref`：

```bash
sudo --preserve-env=DEEPSEEK_API_KEY bash -c 'curl -fsSL https://raw.githubusercontent.com/maker2020/personal-agent/cursor/hearth-personal-agent-23e9/deploy/install.sh | bash -s -- --ref cursor/hearth-personal-agent-23e9 --domain agent.example.com'
```

`--branch` 与 `--ref` 相同，会传给 `git clone --branch`。再次运行会保留 `.env` 里已有的 `POSTGRES_PASSWORD`、`HEARTH_ADMIN_PASSWORD` 和 `HEARTH_INTERNAL_TOKEN`。`--dry-run` 只打印计划，不写任何文件，也不需要 root。`--deepseek-key` 仍然可选。

中国大陆服务器加 `--mirror cn`（或 `HEARTH_MIRROR=cn`）：Docker CE 从 `https://mirrors.aliyun.com/docker-ce` 安装（Debian 和 RHEL 8+ 走 `get.docker.com --mirror Aliyun`，CentOS 7 走 yum）。镜像构建使用 apt `https://mirrors.aliyun.com`、npm `https://registry.npmmirror.com`、静态 Docker 客户端 `https://mirrors.aliyun.com/docker-ce/linux/static/stable`，基础镜像前缀是 `mirror.ccs.tencentyun.com/`（`HEARTH_IMAGE_PREFIX`）。apt 镜像可用 `HEARTH_APT_MIRROR` 改成腾讯云内网 `http://mirrors.tencentyun.com` 或公网 `https://mirrors.cloud.tencent.com`。Docker Hub 加速地址是账号自己的，到容器镜像服务控制台的「镜像工具 → 镜像加速器」复制，设到 `HEARTH_DOCKER_REGISTRY_MIRROR`。阿里云 VPC 内网可设 `HEARTH_DOCKER_MIRROR_BASE=http://mirrors.cloud.aliyuncs.com/docker-ce`。CentOS 7 不带 `--mirror cn` 时会直接拒绝：`get.docker.com` 已不再支持它，系统上也没有 dnf。

已经有宝塔 nginx 时：

```bash
sudo --preserve-env=DEEPSEEK_API_KEY ./deploy/install.sh --proxy external --domain agent.example.com --http-port 8787
```

`--no-caddy` 等于 `--proxy external`。不启动 Caddy，网关只发布在 `127.0.0.1:8787`（`HEARTH_HTTP_BIND` / `HEARTH_HTTP_PORT`），并写出 `deploy/nginx/hearth.conf`：`proxy_buffering off`、长超时、WebSocket 升级头，以及关闭 `/metrics`。把这些 location 放进已经有证书的 server 块。

脚本会安装 Docker 和 compose 插件，构建 `hearth-sandbox:local`，并用 systemd 拉起相互独立的网关、哨兵和沙箱管理器。管理器镜像里带 Docker 客户端。默认在有域名时由 Caddy 做 HTTPS。备份和升级：`deploy/backup.sh`、`deploy/restore.sh`、`deploy/upgrade.sh`。存在 `docker-compose.local.yml` 时升级会带上它，`HEARTH_COMPOSE_FILES`（冒号分隔）里的文件也会带上。

应用内语音走 UDP，不走 HTTPS 反代。compose 发布 UDP 50000–50199，需要中继时用 `--profile turn` 启动 coturn。把 `HEARTH_ICE_PUBLIC_IP` 设成公网地址。中国大陆访问不到 `stun.l.google.com`。端口和示例见 [docs/voice.zh.md](docs/voice.zh.md)。

沙箱管理器把 `/var/lib/hearth/workspaces`（也可用绝对路径 `HEARTH_WORKSPACE_ROOT`）以相同路径挂载进去。每个用户的容器使用这个宿主机路径，因此 `sandbox_write` 和 `sandbox_exec` 看到的是同一批文件，属主是 uid 65534。

企业版真实电话只通过覆盖文件发布端口：

```bash
docker compose -f docker-compose.yml -f docker-compose.pstn.yml up -d
```

这会映射 UDP 5060 和 UDP 10000–10199。同时设置 `SIP_ENABLED=1`、`PSTN_ENABLED=1`，并把套餐设为企业版（试用线路用 `HEARTH_DEV_PSTN=1`）。`.env` 里已经是 `SIP_ENABLED=1` 时，`install.sh` 和 `deploy/upgrade.sh` 会带上这个覆盖文件。

邀请默认 `HEARTH_INVITE_TTL_HOURS`（168 小时）后过期。注册时在创建用户的同一事务里消费邀请。

不用 Docker 的开发机：`npm install && npm test && npm start`，然后打开 http://127.0.0.1:8787（未设置管理员密码时是 `owner` / `hearth-dev`）。宿主机目录沙箱只允许开发模式。
