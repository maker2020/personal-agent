# ADR 0001 — 组合面

## 状态

已接受

## 背景

DeepSeek Harness 用 profile、bundle 和 `cordis.patch.yml` 组合成一个进程。个人助手要自己的工具，但不应该另写一套加载器。

## 决定

使用 dsh 自带的组合。Hearth 以树外 bundle `@hearth/dsh-plugin` 挂上（`apply(ctx)` 和 `cordis.patch.yml`），叠在 `dsh-base` 和 `dsh-headless` 之上。CLI 固定为 `@deepseek-ai/dsh@0.2.1-rc.2`。网关、哨兵、沙箱管理器是普通 Node 服务，不重做插件树。

## 为什么不自建加载器

预览版会破坏兼容。私有加载器得跟着改。补丁层仍然可以被用户自己的层替换。

## 后果

`dsh --profile hearth --dump-config` 能看到 hearth 工具。`dsh-base` 已经占用的同名工具会被跳过，而不是让启动失败。
