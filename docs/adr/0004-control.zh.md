# ADR 0004 — 控制面

## 状态

已接受

## 背景

dsh 用 `tools/pre-execute`、审批和沙箱约束一个回合。这个产品还要在用户离开时看邮件和日程，并且不能把中继口令放进用户沙箱。

## 决定

回合在 harness 里跑时，用 dsh 的审批钩子。产品网关另外保存邮件、短信和真实电话的审批队列，工具在队列同意之前拒绝发送。哨兵不是 dsh 进程内的 `ctx.schedule`。它是自己的容器和入口（`node dist/packages/sentinel/src/main.js`）。邮箱实现了 `watch` 时走 IMAP IDLE；日程仍用定时器，因为它们是时钟事件。命令和文件的隔离是每用户一个容器：`--network none`、丢掉全部 capabilities、`no-new-privileges`、限制进程数和内存、根文件系统只读。只有沙箱管理器挂载 Docker socket。gVisor（`HEARTH_SANDBOX_RUNTIME=runsc`）可选；Ubuntu 和 RHEL 的官方镜像不带 `runsc`，强制它会让一键安装失败。

## 为什么 socket 不在网关上

Docker socket 等同 root。只放在一个管理器上，网关和哨兵就不能起容器，用户命令只在他自己的容器里执行。

## 后果

`HEARTH_ENV=production` 时 `LocalSandbox` 会直接拒绝。开发机仍可用宿主机目录。
