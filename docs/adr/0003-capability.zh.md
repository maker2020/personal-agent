# ADR 0003 — 能力面

## 状态

已接受

## 背景

能力缝由定义、提供者和消费者组成。dsh 已经有模型、文件系统、shell 和网页。邮件、短信、电话音频和每用户工作区不在基础 profile 里。

## 决定

模型用内置 DeepSeek 适配器（`dsh-llm-deepseek-api-key`，环境变量 `DEEPSEEK_API_KEY`）。邮件、短信、网页抓取、日程、记忆和沙箱工具注册在 `ctx.tools`。工作区命令通过沙箱管理器进每个用户自己的容器，不在宿主机 shell 里跑。

## 为什么不另写模型客户端

密钥、基址和 Messages 形状已经和 harness 一致。私有客户端会和 `dsh-llm-deepseek` 分叉。

## 后果

更换沙箱后端不必改工具 schema。短信和真实电话的工具还在，是否执行由套餐决定。
