#!/bin/sh
# coturn for in-app WebRTC when the client cannot reach the gateway's host candidates.
# Requires HEARTH_TURN_USERNAME, HEARTH_TURN_PASSWORD, and HEARTH_ICE_PUBLIC_IP.
set -eu
if [ -z "${HEARTH_TURN_USERNAME:-}" ] || [ -z "${HEARTH_TURN_PASSWORD:-}" ] || [ -z "${HEARTH_ICE_PUBLIC_IP:-}" ]; then
  echo "coturn requires HEARTH_TURN_USERNAME, HEARTH_TURN_PASSWORD, and HEARTH_ICE_PUBLIC_IP" >&2
  exit 1
fi
exec turnserver \
  --log-file=stdout \
  -n \
  --lt-cred-mech \
  --fingerprint \
  --listening-port="${TURN_PORT:-3478}" \
  --min-port="${TURN_MIN_PORT:-49160}" \
  --max-port="${TURN_MAX_PORT:-49200}" \
  --realm="${TURN_REALM:-hearth}" \
  --user="${HEARTH_TURN_USERNAME}:${HEARTH_TURN_PASSWORD}" \
  --external-ip="${HEARTH_ICE_PUBLIC_IP}" \
  --listening-ip=0.0.0.0 \
  --no-cli \
  --no-tls \
  --no-dtls
