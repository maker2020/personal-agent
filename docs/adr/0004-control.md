# ADR 0004 — Control

## Status

Accepted

## Context

dsh constrains a turn with `tools/pre-execute`, approvals, and a sandbox backend. This product also has to watch mail and routines while the user is away, and it must keep trunk credentials out of user sandboxes.

Headless dsh disables the approval service. An unanswered `ask` from `tools/pre-execute` becomes a deny, so that hook cannot show a pending approval in the product UI.

## Decision

Approval is the Hearth durable queue, enforced inside the tool body. `email_send`, `sms_send`, and `phone_call` insert a pending row and refuse to send until that row is approved. The same body runs for the native loop and for the harness callback (`POST /internal/tools/invoke`). The plugin does not register a `tools/pre-execute` handler.

The sentinel is not dsh's in-process `ctx.schedule`. It is its own container and entrypoint (`node dist/packages/sentinel/src/main.js`). Mail uses IMAP IDLE when the mailbox implements `watch`; routines stay on a timer because they are clock events.

Confinement for shell and files is one container per user: `--network none`, dropped capabilities, `no-new-privileges`, a pid and memory cap, and a read-only root. Commands run as uid 65534. The manager bind-mounts one absolute host path (`/var/lib/hearth/workspaces` by default) at that same path, and `docker run --mount type=bind` uses the per-user directory. The host Docker daemon resolves bind sources on the host, so a named volume visible only inside the manager would hide `sandbox_write` from `sandbox_exec`. The manager chowns the directory and written files to 65534:65534. Only the sandbox-manager process mounts the Docker socket. gVisor (`HEARTH_SANDBOX_RUNTIME=runsc`) is optional; stock Ubuntu and RHEL images do not ship `runsc`, and requiring it would break one-click install.

## Why the socket is not on the gateway

A Docker socket is root-equivalent. Keeping it on a single manager means the gateway and the sentinel cannot start containers, and a user command runs only inside that user's container.

## Consequences

`LocalSandbox` throws when `HEARTH_ENV=production`. Dev laptops keep the host-folder backend.
