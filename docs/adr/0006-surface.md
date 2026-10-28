# ADR 0006 — Surface

## Status

Accepted

## Context

dsh's web profile is a coding workspace on port 3080. This product is a personal assistant with accounts, a phone-sized call button, and a later WebView on iOS or Android. The surface must not become a second copy of the session log.

## Decision

The public surface is the Hearth gateway and the static web client. Authentication is an HttpOnly cookie plus a bearer token. Chat is server-sent events. Voice is WebRTC to `POST /api/voice/calls`. Signup is by invite (or `HEARTH_OPEN_SIGNUP=1`). The owner account manages users and plans. dsh's own UI is not exposed.

## Why not the bundled web app

That UI assumes one developer and a local workspace. It does not have tenant entitlements, approval inbox, or the WebRTC call. Reusing it would either widen its trust boundary or hide the product behind a coding IDE.

## Consequences

An iOS or Android client can be a WebView of the same origin. The API stays the contract: `/api/auth/*`, `/api/sessions/*`, `/api/voice/*`, `/api/admin/*`.
