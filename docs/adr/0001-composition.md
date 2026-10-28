# ADR 0001 — Composition

## Status

Accepted

## Context

DeepSeek Harness composes a process from profiles, bundles, and `cordis.patch.yml` layers. The personal agent needs its own tools without forking that loader.

## Decision

Use dsh's built-in composition. Hearth ships `@hearth/dsh-plugin` as an out-of-tree bundle (`apply(ctx)` plus `cordis.patch.yml`) stacked on `dsh-base` and `dsh-headless`. The pinned CLI is `@deepseek-ai/dsh@0.2.1-rc.2`. Product processes (gateway, sentinel, sandbox manager) are ordinary Node services; they do not reinvent the plugin tree.

## Why not a custom loader

The preview breaks often. A private loader would have to track those breaks. Patches stay replaceable by the user's own layer.

## Consequences

`dsh --profile hearth --dump-config` shows the hearth tools. Duplicate tool names already owned by `dsh-base` are skipped rather than failing the boot.
