# Webmail image for integration testing — runs Next.js in DEVELOPMENT mode.
#
# Why dev mode rather than the production Dockerfile at the repo root?
# The browser talks JMAP directly to Stalwart at http://localhost:8025 (plain
# HTTP, cross-origin). The app's production Content-Security-Policy pins
# connect-src to `'self' https:`, which would block that plaintext cross-origin
# fetch. In development mode proxy.ts widens connect-src to `'self' http:
# https: ws: wss:` — exactly what a local, TLS-less Stalwart needs. Running
# from source also ships the integration-test data-testid hooks without a
# production rebuild.
#
# Build context is the repo root (see docker-compose.yml `context: ..`), so the
# root .dockerignore keeps examples/, integration/ and node_modules out.

FROM node:24-alpine
WORKDIR /app

# Install dependencies first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# App source (data-testid hooks included).
COPY . .

# The plugin sandbox document's script and stylesheet (see the script).
RUN node scripts/build-plugin-sandbox.mjs

ENV NODE_ENV=development
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

EXPOSE 3000

# Both the browser and session verification use localhost:8025. Inside this
# test container only, forward that loopback endpoint to the real mail server.
RUN printf '%s\n' \
  'const net = require("node:net");' \
  'net.createServer(socket => {' \
  '  const upstream = net.connect(8080, "stalwart");' \
  '  socket.on("error", () => upstream.destroy());' \
  '  upstream.on("error", () => socket.destroy());' \
  '  socket.pipe(upstream).pipe(socket);' \
  '}).listen(8025, "::");' > /app/integration-jmap-loopback.cjs

# Bind to 0.0.0.0 so the published port is reachable from the host/browser.
CMD ["sh", "-c", "node /app/integration-jmap-loopback.cjs & exec npx next dev -H 0.0.0.0 -p 3000"]
