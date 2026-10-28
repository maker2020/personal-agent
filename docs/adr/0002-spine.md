# ADR 0002 — Spine

## Status

Accepted

## Context

The harness spine is `dsh-agent-loop`: one model call, tool execution, and an append to the session log. The personal client also needs token streaming and several users on one machine.

## Decision

Keep `dsh-agent-loop` as the spine whenever a turn is delegated with `HEARTH_SPINE=dsh` (`dsh --profile headless --json`). The default interactive runner is a thin loop that calls the same DeepSeek Messages API and the same tool handlers the plugin registers. It does not replace the loop inside dsh.

## Why not only the headless CLI

Headless boots a process per message and emits text when the assistant message settles. The web client wants tokens as they arrive. Both paths share tools, so a harness session and a chat session enforce the same approvals.

## Consequences

`make smoke-live` exercises the interactive runner. `verify-dsh` boots the real loop and checks that the plugin applies.
