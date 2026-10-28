# ADR 0003 — 能力面

## 状态

已接受

## 背景

能力缝由定义、提供者和消费者组成。dsh 已经有模型、文件系统、shell 和网页。邮件、短信、电话音频和每用户工作区不在基础 profile 里。

## 决定

默认的交互回合通过 `packages/llm` 的 `DeepSeekMessages` 调用 DeepSeek。它请求 Messages API（`https://api.deepseek.com/anthropic` 上的 `/v1/messages`），带 `x-api-key` 和 `anthropic-version: 2023-06-01`，密钥仍是 `DEEPSEEK_API_KEY`。dsh 内置适配器 `dsh-llm-deepseek-api-key` 只在 `HEARTH_SPINE=dsh` 的无头回合里使用。

邮件、短信、网页抓取、日程、记忆和沙箱工具实现在 `packages/tools`。harness 插件把这些名字注册到 `ctx.tools`，`execute` 转发到 `POST /internal/tools/invoke`，两条运行路径共用一个工具体。工作区文件和命令经过沙箱管理器，不在宿主机 shell 里跑。

## 为什么默认路径不是内置适配器

无头 dsh 不能把 token 流进网页客户端。私有 Messages 客户端保持和 `dsh-llm-deepseek` 相同的密钥、基址和请求形状，同时可以流式输出。`HEARTH_SPINE=dsh` 时仍走内置适配器。

## 后果

更换沙箱后端不必改工具 schema。短信和真实电话的工具还在，是否执行由套餐决定。
