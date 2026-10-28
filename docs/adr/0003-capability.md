# ADR 0003 — Capability

## Status

Accepted

## Context

A seam is a definition, a provider, and a consumer. dsh already has seams for the model, filesystem, shell, and web. Email, SMS, phone audio, and a per-user workspace are not in the base profile.

## Decision

Use the built-in DeepSeek adapter (`dsh-llm-deepseek-api-key`, `DEEPSEEK_API_KEY`) for the model. Register email, SMS, web fetch, schedule, memory, and sandbox tools on `ctx.tools`. Point workspace execution at one container per user through the sandbox manager, not at the host shell.

## Why not a second model stack

The key, base URL, and Messages shape already match the harness. A private client would drift from `dsh-llm-deepseek`.

## Consequences

Swapping the sandbox backend does not change tool schemas. SMS and PSTN tools still exist, and entitlements decide whether they run.
