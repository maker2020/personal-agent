# ADR 0005 — Truth and LangGraph

## Status

Accepted

## Context

dsh's session log is the model-visible history. The product also needs users, approvals, routines, and notes that survive a process restart. LangGraph's checkpointer is built for the second job, not for replacing the harness log.

## Decision

Postgres is the product record: users, sessions, messages, approvals, invites, placements. When `DATABASE_URL` is set, Hearth uses LangGraph `PostgresSaver` (`@langchain/langgraph-checkpoint-postgres`) as the checkpointer for task memory. Each finished turn calls `remember(conversationId, assistantText)`. A new process builds a new graph on the same saver and `recall`s that thread. The in-memory `MemorySaver` is only for tests and for a laptop with no database. The dsh JSONL session log stays the harness source of truth when `HEARTH_SPINE=dsh`. LangGraph does not own that log; its checkpoint format is not the harness event format.

## Why not LangGraph as the only store

The web client, approvals, and the sentinel read ordinary rows. A checkpoint blob is a poor place for an invite code or a DID assignment. Using it for resumable notes matches the library and leaves the rest of the schema explicit.

## Consequences

Restarting the gateway does not drop conversation messages or LangGraph notes when Postgres is configured. Tests prove a second `TaskMemory` on the same saver still sees the note.
