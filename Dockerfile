# Base images by digest, so a build gets the image that was reviewed; the
# Dependabot docker entry moves the digest when the tag gets a new image.
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS builder
WORKDIR /app
COPY package.json package-lock.json ./
# @sentry/cli's install script looks for a binary for this platform and fails
# where there is none (linux s390x, ppc64le, riscv64). It has nothing to do
# anyway: the binary, where one exists, comes in its platform package.
RUN SENTRYCLI_SKIP_DOWNLOAD=1 npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Optional: serve under a subpath like /webmail. Baked into emitted asset URLs
# at build time, so it cannot be changed without rebuilding.
ARG NEXT_PUBLIC_BASE_PATH=
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH
# Optional: avoid next-intl rewrite loops when served under a subpath.
# Baked in at build time.
ARG NEXT_PUBLIC_LOCALE_PREFIX=
ENV NEXT_PUBLIC_LOCALE_PREFIX=$NEXT_PUBLIC_LOCALE_PREFIX
# Optional: fallback UI locale (e.g. tr, de, fr) used when the visitor's
# Accept-Language header does not match any supported locale. Baked in at
# build time because next-intl wires it into client-side routing too.
ARG NEXT_PUBLIC_DEFAULT_LOCALE=
ENV NEXT_PUBLIC_DEFAULT_LOCALE=$NEXT_PUBLIC_DEFAULT_LOCALE
# Commit SHA shown in the About screen. .dockerignore excludes .git, so
# `git rev-parse` inside the build can't find it - CI must pass it in.
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT
# Browser source maps for the error tracker: CI passes 1, a plain build makes
# none (next.config.ts reads it). They never reach the image, see below.
ARG BULWARK_SOURCE_MAPS=0
ENV BULWARK_SOURCE_MAPS=$BULWARK_SOURCE_MAPS
# One build id for every platform of a release (#1531). CI passes the same
# seed to the amd64 and arm64 builds; without one each build makes its own id
# (next.config.ts), and a load balancer mixing the two would tell open tabs a
# new version is out on every check.
ARG BULWARK_BUILD_SEED=
ENV BULWARK_BUILD_SEED=$BULWARK_BUILD_SEED
# The mock JMAP server (DEV_MOCK_JMAP) accepts any password and is for
# `npm run dev` only; images ship without it.
# `next build` type-checks every .ts file, and some unit tests import the
# deleted route, so the tests go too. .dockerignore already drops them from a
# local context, but a remote Git context never applies .dockerignore (#1118).
RUN rm -rf "app/api/dev-jmap" && \
    find . -path ./node_modules -prune -o \
      \( -name __tests__ -o -name "*.test.ts" -o -name "*.test.tsx" \) \
      -prune -exec rm -rf {} \; && \
    node scripts/build-pst-worker.mjs && \
    node scripts/build-store-worker.mjs && \
    node scripts/build-plugin-sandbox.mjs && \
    npx next build --webpack && \
    node scripts/standalone-guard.mjs

# webpack has no debug IDs of its own, so sentry-cli adds them to the
# chunks: the @sentry/cli devDependency, as package-lock.json locks it. It
# runs in a stage of its own, and the next stage takes back only
# .next/static, the folder it is meant to change. Anything it writes
# elsewhere stays in this stage and never reaches the image.
FROM builder AS debug-ids
RUN if [ "$BULWARK_SOURCE_MAPS" = "1" ]; then \
      npx --no-install sentry-cli sourcemaps inject .next/static; \
    fi

# Every map moves to /sourcemaps (exported with `--target sourcemaps`) and
# the check fails the build if one would ship.
# https://bulwarkmail.org/docs/deployment/monitoring
FROM builder AS bundle
COPY --from=debug-ids /app/.next/static ./.next/static
RUN node scripts/sourcemaps.mjs collect --out /sourcemaps .next/static .next/standalone && \
    node scripts/sourcemaps.mjs check .next/static .next/standalone public

# Only the maps, for CI to upload: never part of the image.
FROM scratch AS sourcemaps
COPY --from=bundle /sourcemaps /

FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS runner

LABEL org.opencontainers.image.title="Bulwark Webmail"
LABEL org.opencontainers.image.description="Modern webmail client built with Next.js and the JMAP protocol"
LABEL org.opencontainers.image.source="https://github.com/bulwarkmail/webmail"
LABEL org.opencontainers.image.url="https://github.com/bulwarkmail/webmail"
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"
LABEL org.opencontainers.image.vendor="rbm.systems"

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN apk upgrade --no-cache && \
    npm uninstall -g npm && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npx && \
    addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs
# The app stays root's and read-only for the runtime user, so a bug that
# lets it write a file can't replace server.js or a bundle and run code on
# the next start. It writes only to Next's cache and the data dirs.
COPY --from=bundle /app/public ./public
COPY --from=bundle /app/.next/standalone ./
COPY --from=bundle /app/.next/static ./.next/static
COPY --from=bundle /app/scripts/healthcheck.mjs ./healthcheck.mjs
# Every data dir exists up front and belongs to the runtime user, so a fresh
# volume on /app/data (Docker copies these into it) or on any one of them is
# writable. plugin-secrets holds users' plugin credentials, version-check the
# result of the last update check. They are also group 0's with the owner's
# rights, so the image runs as any uid in group 0 (`user: "<uid>:0"` in
# compose, OpenShift's random uids) without giving anyone else write access.
RUN mkdir -p /app/.next/cache /app/data/settings /app/data/admin /app/data/admin-state \
      /app/data/telemetry /app/data/plugin-secrets /app/data/version-check && \
    chmod 700 /app/data/plugin-secrets && \
    chown -R nextjs:0 /app/.next/cache /app/data && \
    chmod -R g=u /app/.next/cache /app/data
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
# The health check needs the base path the bundle was built with.
ARG NEXT_PUBLIC_BASE_PATH=
ENV BULWARK_BASE_PATH=$NEXT_PUBLIC_BASE_PATH
# Liveness only (/api/health/live); readiness is /api/health/ready.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "healthcheck.mjs"]
CMD ["node", "server.js"]
