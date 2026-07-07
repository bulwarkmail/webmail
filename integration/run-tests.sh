#!/usr/bin/env bash
# Run the Playwright integration suite.
#
# Playwright's browser download host is often unreachable (and some host OSes
# aren't supported by the browser bundles), so the tests run inside the official
# Playwright container, which ships the browsers. The container uses host
# networking to reach the published stack ports (webmail :3000, Stalwart :8025).
#
# The docker stack itself is brought up here (on the host) and the in-container
# run is told to skip its own docker management via IT_NO_DOCKER=1.
#
# Usage:
#   integration/run-tests.sh                 # whole suite
#   integration/run-tests.sh 01-login        # a single spec (grep on file name)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INTEGRATION_DIR="${REPO_ROOT}/integration"
PW_IMAGE="mcr.microsoft.com/playwright:v1.59.1-noble"

cd "${INTEGRATION_DIR}"
[ -f .env ] || cp .env.example .env

echo "== bringing up stack =="
bash stalwart/prepare-stalwart-cli.sh
docker compose --env-file .env up -d --build --wait --wait-timeout 300

echo "== running Playwright in ${PW_IMAGE} =="
FILTER="${1:-}"
docker run --rm --network host \
  --user "$(id -u):$(id -g)" \
  -v "${REPO_ROOT}":/work -w /work \
  -e IT_NO_DOCKER=1 \
  -e HOME=/tmp \
  "${PW_IMAGE}" \
  npx playwright test -c playwright.integration.config.ts ${FILTER:+"$FILTER"}
