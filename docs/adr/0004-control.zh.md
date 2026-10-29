# ADR 0004 — 控制面

## 状态

已接受

## 背景

dsh 用 `tools/pre-execute`、审批和沙箱约束一个回合。这个产品还要在用户离开时看邮件和日程，并且不能把中继口令放进用户沙箱。

无头 dsh 会关掉审批服务。`tools/pre-execute` 返回的 `ask` 如果没有人应答，就会变成拒绝，所以这个钩子没法在产品界面里留下一条待审批。

## 决定

审批是 Hearth 自己的持久队列，在工具体内强制执行。`email_send`、`sms_send` 和 `phone_call` 先写入一条待审批记录，队列同意之前拒绝发送。原生回合和 harness 回调（`POST /internal/tools/invoke`）走同一个工具体。插件不注册 `tools/pre-execute`。

哨兵不是 dsh 进程内的 `ctx.schedule`。它是自己的容器和入口（`node dist/packages/sentinel/src/main.js`）。邮箱实现了 `watch` 时走 IMAP IDLE；日程仍用定时器，因为它们是时钟事件。

命令和文件的隔离是每用户一个容器：`--network none`、丢掉全部 capabilities、`no-new-privileges`、限制进程数和内存、根文件系统只读。命令以 uid 65534 运行。管理器把一个绝对宿主机路径（默认 `/var/lib/hearth/workspaces`）以相同路径挂进自己，`docker run --mount type=bind` 使用其中的用户目录。宿主机 Docker 守护进程按宿主机路径解析绑定源，所以只在管理器里可见的命名卷会让 `sandbox_write` 和 `sandbox_exec` 看不到同一批文件。管理器把目录和写入的文件 chown 为 65534:65534。只有沙箱管理器挂载 Docker socket。gVisor（`HEARTH_SANDBOX_RUNTIME=runsc`）可选；Ubuntu 和 RHEL 的官方镜像不带 `runsc`，强制它会让一键安装失败。

## 为什么 socket 不在网关上

Docker socket 等同 root。只放在一个管理器上，网关和哨兵就不能起容器，用户命令只在他自己的容器里执行。

## 后果

`HEARTH_ENV=production` 时 `LocalSandbox` 会直接拒绝。开发机仍可用宿主机目录。
