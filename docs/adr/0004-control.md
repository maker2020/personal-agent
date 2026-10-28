# ADR 0004 — Control

## Status

Accepted

## Context

dsh constrains a turn with `tools/pre-execute`, approvals, and a sandbox backend. This product also has to watch mail and routines while the user is away, and it must keep trunk credentials out of user sandboxes.

## Decision

Use dsh's approval hook when a turn runs inside the harness. The product gateway keeps the durable approval queue for email, SMS, and PSTN, and the tool body refuses to send until that queue says approved. The sentinel is not dsh's in-process `ctx.schedule`. It is its own container and entrypoint (`node dist/packages/sentinel/src/main.js`). Mail uses IMAP IDLE when the mailbox implements `watch`; routines stay on a timer because they are clock events. Confinement for shell and files is the per-user container: `--network none`, dropped capabilities, `no-new-privileges`, a pid and memory cap, and a read-only root. Only the sandbox-manager process mounts the Docker socket. gVisor (`HEARTH_SANDBOX_RUNTIME=runsc`) is optional; stock Ubuntu and RHEL images do not ship `runsc`, and requiring it would break one-click install.

## Why the socket is not on the gateway

A Docker socket is root-equivalent. Keeping it on a single manager means the gateway and the sentinel cannot start containers, and a user command runs only inside that user's container.

## Consequences

`LocalSandbox` throws when `HEARTH_ENV=production`. Dev laptops keep the host-folder backend.
