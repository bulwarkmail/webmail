#!/usr/bin/env bash
# Upload a folder of source maps (with their chunks, as scripts/sourcemaps.mjs
# collect leaves them) to Bugsink. Bugsink finds a map by the debug ID alone,
# so the release name doesn't matter, but it keeps maps per project: every
# project that gets events for these chunks needs them.
#
#   BUGSINK_AUTH_TOKEN  upload token; without it the upload is skipped with a notice
#   BUGSINK_URL         default https://bugsink.internal.bulwarkmail.org/
#   BUGSINK_PROJECTS    default "bulwark-instances bulwark-telemetry"
#   SENTRY_CLI_VERSION  default 3.8.2
#
# https://bulwarkmail.org/docs/deployment/monitoring
set -euo pipefail

dir="${1:?usage: upload-sourcemaps.sh <dir>}"
if [ -z "${BUGSINK_AUTH_TOKEN:-}" ]; then
  echo "::notice::BUGSINK_AUTH_TOKEN is not set: source maps in ${dir} were built but not uploaded"
  exit 0
fi
if [ -z "$(find "$dir" -name '*.map' -print -quit 2>/dev/null)" ]; then
  echo "::warning::no source maps in ${dir}"
  exit 0
fi

url="${BUGSINK_URL:-https://bugsink.internal.bulwarkmail.org/}"
cli="@sentry/cli@${SENTRY_CLI_VERSION:-3.8.2}"
for project in ${BUGSINK_PROJECTS:-bulwark-instances bulwark-telemetry}; do
  SENTRY_AUTH_TOKEN="$BUGSINK_AUTH_TOKEN" npx --yes "$cli" --url "$url" \
    sourcemaps --org bugsinkhasnoorgs --project "$project" upload "$dir"
done
