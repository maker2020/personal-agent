# ADR 0005 — 事实与 LangGraph

## 状态

已接受

## 背景

dsh 的会话日志是模型能看见的历史。产品还要有用户、审批、日程和笔记，并且进程重启后还在。LangGraph 的 checkpointer 适合后一件事，不适合替换 harness 日志。

## 决定

Postgres 是产品记录：用户、会话、消息、审批、邀请、沙箱放置。设置了 `DATABASE_URL` 时，Hearth 用 LangGraph 的 `PostgresSaver`（`@langchain/langgraph-checkpoint-postgres`）做任务记忆的检查点。每个回合结束调用 `remember(conversationId, assistantText)`。新进程在同一个 saver 上建新图，再 `recall` 这条线程。没有数据库时才用内存 `MemorySaver`，只给测试和单机开发。`HEARTH_SPINE=dsh` 时，dsh 的 JSONL 会话日志仍是 harness 的事实来源。LangGraph 不拥有那份日志，它的检查点格式也不是 harness 的事件格式。

## 为什么不把 LangGraph 当成唯一存储

网页、审批和哨兵读的是普通行。邀请码或号码分配不该塞进检查点。用它保存可恢复的笔记，其余表保持直白。

## 后果

配置了 Postgres 时，重启网关不会丢掉会话消息和 LangGraph 笔记。测试证明同一个 saver 上的第二个 `TaskMemory` 仍能读到那条笔记。
