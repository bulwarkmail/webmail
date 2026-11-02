FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
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
    node scripts/build-plugin-sandbox.mjs && \
    npx next build --webpack

# webpack has no debug IDs of its own, so sentry-cli adds them to the
# chunks; then every map moves to /sourcemaps (exported with
# `--target sourcemaps`) and the check fails the build if one would ship.
# https://bulwarkmail.org/docs/deployment/monitoring
ARG SENTRY_CLI_VERSION=3.8.2
RUN if [ "$BULWARK_SOURCE_MAPS" = "1" ]; then \
      npx --yes "@sentry/cli@${SENTRY_CLI_VERSION}" sourcemaps inject .next/static; \
    fi && \
    node scripts/sourcemaps.mjs collect --out /sourcemaps .next/static .next/standalone && \
    node scripts/sourcemaps.mjs check .next/static .next/standalone public

# Only the maps, for CI to upload: never part of the image.
FROM scratch AS sourcemaps
COPY --from=builder /sourcemaps /

FROM node:24-alpine AS runner

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
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/scripts/healthcheck.mjs ./healthcheck.mjs
# Every data dir exists up front and belongs to the runtime user, so a fresh
# volume on /app/data (Docker copies these into it) or on any one of them is
# writable. plugin-secrets holds users' plugin credentials, version-check the
# result of the last update check.
RUN mkdir -p /app/.next/cache /app/data/settings /app/data/admin /app/data/admin-state \
      /app/data/telemetry /app/data/plugin-secrets /app/data/version-check && \
    chmod 700 /app/data/plugin-secrets && \
    chown -R nextjs:nodejs /app/.next/cache /app/data
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
