# ADR 0006 — 界面

## 状态

已接受

## 背景

dsh 的 web profile 是 3080 端口上的编程工作台。这个产品是个人助手，要有账号、手机尺寸的通话按钮，以及以后的 iOS / Android WebView。界面不能变成第二份会话日志。

## 决定

对外界面是 Hearth 网关和静态网页。认证是 HttpOnly cookie 加 bearer token。对话用 SSE。语音是打到 `POST /api/voice/calls` 的 WebRTC。注册靠邀请码（或 `HEARTH_OPEN_SIGNUP=1`）。所有者账号管理用户和套餐。不暴露 dsh 自带的界面。

## 为什么不用自带的网页

那个界面假设一个开发者和一个本地工作区。它没有租户套餐、审批收件箱，也没有 WebRTC 通话。拿来用，要么放宽它的信任边界，要么把产品藏在编程 IDE 后面。

## 后果

iOS 或 Android 客户端可以是同一来源的 WebView。接口就是契约：`/api/auth/*`、`/api/sessions/*`、`/api/voice/*`、`/api/admin/*`。
