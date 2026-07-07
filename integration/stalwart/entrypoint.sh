#!/bin/sh
# Declarative bootstrap for the integration-test Stalwart Mail Server.
#
# Phase 1 (first start only, marker absent):
#   - Stalwart starts in bootstrap mode (no config.json -> HTTP on :8080).
#   - plan-bootstrap.ndjson is applied via stalwart-cli. This writes
#     config.json, initialises RocksDB and creates the default domain +
#     admin account.
#   - Stalwart is restarted in normal mode (config.json now exists).
#   - plan-accounts.ndjson.tpl is materialised with the resolved DOMAIN_ID
#     and the shared TEST_ACCOUNT_PASSWORD, then applied (test accounts +
#     submission/IMAP listeners + cleartext auth for the dev lanes).
#   - Stalwart is stopped and the marker is written.
#
# Phase 2 (regular start, marker present):
#   - exec stalwart as PID 1.
#
# Adapted from examples/docker/stalwart for webmail<->Stalwart integration
# testing: no ticket/service accounts, no Sieve, a single shared password for
# the alice/bob/carol test mailboxes.

set -eu

# stalwart-cli caches its schema under $HOME/.cache/stalwart-cli. The stalwart
# user has no home, so redirect to /tmp.
export HOME=/tmp

DATA_DIR=/var/lib/stalwart
MARKER="${DATA_DIR}/.bootstrap-applied"
PLAN_DIR=/etc/stalwart-bootstrap
STALWART_BIN=/usr/local/bin/stalwart
STALWART_CLI=/usr/local/bin/stalwart-cli
STALWART_CFG=/etc/stalwart/config.json
LOCAL_URL=http://127.0.0.1:8080

log() { printf '[stalwart-bootstrap] %s\n' "$*" >&2; }

wait_for_http() {
  for _ in $(seq 1 60); do
    if curl -fsS -u "admin:${ADMIN_PASS}" "${LOCAL_URL}/jmap/session" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  log "Stalwart HTTP on :8080 did not come up in time"
  return 1
}

run_stalwart_bg() {
  "${STALWART_BIN}" --config "${STALWART_CFG}" &
  STALWART_PID=$!
}

stop_stalwart_bg() {
  if [ -n "${STALWART_PID:-}" ]; then
    kill -TERM "${STALWART_PID}" 2>/dev/null || true
    wait "${STALWART_PID}" 2>/dev/null || true
    STALWART_PID=
  fi
}

if [ ! -f "${MARKER}" ]; then
  : "${STALWART_RECOVERY_ADMIN:?must be set for first-run bootstrap}"
  : "${TEST_ACCOUNT_PASSWORD:?must be set for first-run bootstrap}"

  ADMIN_PASS=${STALWART_RECOVERY_ADMIN#*:}

  log "Phase 1: starting Stalwart in bootstrap mode"
  run_stalwart_bg
  wait_for_http

  log "Applying plan-bootstrap.ndjson"
  STALWART_URL=${LOCAL_URL} \
  STALWART_USER=admin \
  STALWART_PASSWORD=${ADMIN_PASS} \
    "${STALWART_CLI}" apply --file "${PLAN_DIR}/plan-bootstrap.ndjson" --quiet

  log "Restarting Stalwart to leave bootstrap mode"
  stop_stalwart_bg
  run_stalwart_bg
  wait_for_http

  log "Resolving DOMAIN_ID for example.org"
  DOMAIN_ID=$(STALWART_URL=${LOCAL_URL} STALWART_USER=admin STALWART_PASSWORD=${ADMIN_PASS} \
    "${STALWART_CLI}" query Domain --json 2>/dev/null \
    | head -1 \
    | sed -E 's/.*"id":"([^"]+)".*/\1/')
  if [ -z "${DOMAIN_ID}" ]; then
    log "Could not resolve DOMAIN_ID after bootstrap"
    stop_stalwart_bg
    exit 1
  fi
  log "DOMAIN_ID=${DOMAIN_ID}"

  # Materialise the account plan. gettext/envsubst is not in the base image,
  # so substitute the two placeholders with sed. Passwords are escaped for the
  # sed replacement (& and / are the only metacharacters that matter here).
  PLAN_ACCOUNTS=/tmp/plan-accounts.ndjson
  esc_pw=$(printf '%s' "${TEST_ACCOUNT_PASSWORD}" | sed -e 's/[&/\\]/\\&/g')
  sed -e "s/\${DOMAIN_ID}/${DOMAIN_ID}/g" \
      -e "s/\${TEST_ACCOUNT_PASSWORD}/${esc_pw}/g" \
      "${PLAN_DIR}/plan-accounts.ndjson.tpl" > "${PLAN_ACCOUNTS}"

  log "Applying plan-accounts.ndjson"
  STALWART_URL=${LOCAL_URL} \
  STALWART_USER=admin \
  STALWART_PASSWORD=${ADMIN_PASS} \
    "${STALWART_CLI}" apply --file "${PLAN_ACCOUNTS}" --quiet
  rm -f "${PLAN_ACCOUNTS}"

  # Default inbound throttles (sender->recipient + sender-IP) otherwise trip
  # 452 4.4.5 when a test blasts many messages. Stalwart re-seeds the defaults
  # on every start when absent, so deleting is useless; disable them instead,
  # which survives restarts.
  for tid in $(STALWART_URL=${LOCAL_URL} STALWART_USER=admin STALWART_PASSWORD=${ADMIN_PASS} \
      "${STALWART_CLI}" query MtaInboundThrottle --json 2>/dev/null \
      | sed -E 's/.*"id":"([^"]+)".*/\1/'); do
    log "Disabling MtaInboundThrottle ${tid}"
    STALWART_URL=${LOCAL_URL} STALWART_USER=admin STALWART_PASSWORD=${ADMIN_PASS} \
      "${STALWART_CLI}" update MtaInboundThrottle "${tid}" --field enable=false >/dev/null
  done

  log "Stopping bootstrap instance, marking complete"
  stop_stalwart_bg
  touch "${MARKER}"
fi

log "Starting Stalwart (final, foreground)"
exec "${STALWART_BIN}" --config "${STALWART_CFG}"
