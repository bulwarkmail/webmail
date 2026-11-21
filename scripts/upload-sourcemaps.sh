#!/usr/bin/env bash
# Upload a folder of source maps (with their chunks, as scripts/sourcemaps.mjs
# collect leaves them) to Bugsink. Bugsink finds a map by the debug ID alone,
# so the release name doesn't matter, but it keeps maps per project: every
# project that gets events for these chunks needs them.
#
#   BUGSINK_AUTH_TOKEN  upload token; without it the upload is skipped with a notice
#   BUGSINK_URL         default https://bugsink.internal.bulwarkmail.org/
#   BUGSINK_PROJECTS    default "bulwark-instances bulwark-telemetry"
#
# sentry-cli is the @sentry/cli devDependency, at the version and integrity
# package-lock.json holds: run `npm ci` (`--ignore-scripts` is enough) first.
# Nothing is fetched here.
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

if ! npx --no-install sentry-cli --version >/dev/null 2>&1; then
  echo "::error::sentry-cli is not installed: run npm ci --ignore-scripts first (it comes from package-lock.json)"
  exit 1
fi

url="${BUGSINK_URL:-https://bugsink.internal.bulwarkmail.org/}"
# Release builds upload in parallel and Bugsink sometimes answers one with a
# 500, so each project gets three tries before the build fails.
for project in ${BUGSINK_PROJECTS:-bulwark-instances bulwark-telemetry}; do
  for attempt in 1 2 3; do
    if SENTRY_AUTH_TOKEN="$BUGSINK_AUTH_TOKEN" npx --no-install sentry-cli --url "$url" \
      sourcemaps --org bugsinkhasnoorgs --project "$project" upload "$dir"; then
      break
    fi
    if [ "$attempt" = 3 ]; then
      echo "::error::uploading source maps to ${project} failed 3 times"
      exit 1
    fi
    echo "::warning::uploading source maps to ${project} failed, trying again in $((attempt * 15)) s"
    sleep $((attempt * 15))
  done
done
