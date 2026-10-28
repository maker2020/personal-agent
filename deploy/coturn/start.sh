#!/bin/sh
# coturn 4.18. The CLI and DTLS stay off unless a certificate is configured.
# Private, loopback, and link-local peers are denied so a public TURN port cannot reach
# MySQL or a panel listening on every interface. Set HEARTH_TURN_ALLOW_PEER to the
# compose network range (for example 172.18.0.0-172.18.255.255) when the agent must
# be reached on that network. Public peers stay allowed.
set -eu
if [ -z "${HEARTH_TURN_USERNAME:-}" ] || [ -z "${HEARTH_TURN_PASSWORD:-}" ] || [ -z "${HEARTH_ICE_PUBLIC_IP:-}" ]; then
  echo "coturn requires HEARTH_TURN_USERNAME, HEARTH_TURN_PASSWORD, and HEARTH_ICE_PUBLIC_IP" >&2
  exit 1
fi

set -- turnserver \
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
  --denied-peer-ip=0.0.0.0-0.255.255.255 \
  --denied-peer-ip=10.0.0.0-10.255.255.255 \
  --denied-peer-ip=127.0.0.0-127.255.255.255 \
  --denied-peer-ip=169.254.0.0-169.254.255.255 \
  --denied-peer-ip=172.16.0.0-172.31.255.255 \
  --denied-peer-ip=192.168.0.0-192.168.255.255 \
  --denied-peer-ip=::1 \
  --denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff \
  --denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff

if [ -n "${HEARTH_TURN_ALLOW_PEER:-}" ]; then
  old_ifs=$IFS
  IFS=','
  for item in $HEARTH_TURN_ALLOW_PEER; do
    item=$(printf '%s' "$item" | tr -d ' \t')
    if [ -n "$item" ]; then
      set -- "$@" --allowed-peer-ip="$item"
    fi
  done
  IFS=$old_ifs
fi

if [ "${HEARTH_TURN_TLS:-0}" = "1" ]; then
  if [ -z "${TURN_CERT:-}" ] || [ -z "${TURN_PKEY:-}" ]; then
    echo "HEARTH_TURN_TLS=1 requires TURN_CERT and TURN_PKEY mounted into the container" >&2
    exit 1
  fi
  set -- "$@" \
    --tls-listening-port="${TURN_TLS_PORT:-5349}" \
    --cert="$TURN_CERT" \
    --pkey="$TURN_PKEY"
fi

exec "$@"
