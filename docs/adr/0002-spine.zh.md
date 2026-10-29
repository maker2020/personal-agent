# ADR 0002 — 主干

## 状态

已接受

## 背景

Harness 的主干是 `dsh-agent-loop`：一次模型调用、工具执行、写入会话日志。个人客户端还要流式 token，并且一台机器上有多名用户。

## 决定

`HEARTH_SPINE=dsh` 时仍把回合交给 `dsh-agent-loop`（`dsh --profile headless --json`）。默认的对话跑在一条薄循环上，调用同一个 DeepSeek Messages 接口，以及插件注册的同一批工具。它不替换 dsh 里面的循环。

## 为什么不只用 headless

Headless 每条消息拉起一个进程，助手消息落定后才吐出全文。网页要边生成边看到 token。两条路径共用工具，所以审批规则一致。

## 后果

`make smoke-live` 走交互循环。`verify-dsh` 启动真正的循环并确认插件挂上了。
