# ADR 0003 — Capability

## Status

Accepted

## Context

A seam is a definition, a provider, and a consumer. dsh already has seams for the model, filesystem, shell, and web. Email, SMS, phone audio, and a per-user workspace are not in the base profile.

## Decision

The default interactive runner calls DeepSeek through `packages/llm` (`DeepSeekMessages`). That client posts to the Messages API (`/v1/messages` on `https://api.deepseek.com/anthropic`) with `x-api-key`, `anthropic-version: 2023-06-01`, and the same `DEEPSEEK_API_KEY` the harness uses. dsh's built-in adapter (`dsh-llm-deepseek-api-key`) is used only when `HEARTH_SPINE=dsh` runs a headless turn.

Email, SMS, web fetch, schedule, memory, and sandbox tools are implemented in `packages/tools`. The harness plugin registers those names on `ctx.tools` and forwards `execute` to `POST /internal/tools/invoke`, so both runners share one body. Workspace files and shell commands go through the sandbox manager, not the host shell.

## Why the default path is not the built-in adapter

Headless dsh does not stream tokens into the web client. A private Messages client keeps the key, base URL, and request shape aligned with `dsh-llm-deepseek` and can still stream. The adapter remains the spine used for `HEARTH_SPINE=dsh`.

## Consequences

Swapping the sandbox backend does not change tool schemas. SMS and PSTN tools still exist, and entitlements decide whether they run.
