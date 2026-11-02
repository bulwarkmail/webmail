// Docker HEALTHCHECK: exit 0 when /api/health/live answers 200 within 4 s.
// Liveness only, so a Stalwart outage never marks the container unhealthy.
// The base path is baked in at build time (BULWARK_BASE_PATH in the image).
// https://bulwarkmail.org/docs/deployment/monitoring#health
const port = process.env.PORT || '3000';
const listen = process.env.HOSTNAME;
const host = !listen || listen === '0.0.0.0' || listen === '::' ? '127.0.0.1' : listen.includes(':') ? `[${listen}]` : listen;
const base = (process.env.BULWARK_BASE_PATH || '').replace(/\/+$/, '');

try {
  const res = await fetch(`http://${host}:${port}${base}/api/health/live`, { signal: AbortSignal.timeout(4000) });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
