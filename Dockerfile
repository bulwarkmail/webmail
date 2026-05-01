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
# Commit SHA shown in the About screen. .dockerignore excludes .git, so
# `git rev-parse` inside the build can't find it — CI must pass it in.
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT
RUN npx next build --webpack

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
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
RUN mkdir -p /app/data/settings /app/data/admin /app/data/telemetry && chown -R nextjs:nodejs /app/data
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
