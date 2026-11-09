import { readFileSync } from 'node:fs';
import type { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import client from '@prometheus-io/client';
import { routeGroup } from '@/lib/route-groups';

/**
 * Prometheus metrics for /api/metrics, off unless METRICS_TOKEN (or
 * METRICS_TOKEN_FILE) is set. Every replica counts for itself; Prometheus
 * scrapes each one. Labels come from fixed lists only (route groups, sign-in
 * outcomes, upstream targets), never from user names or hosts users type.
 *
 * https://bulwarkmail.org/docs/deployment/monitoring#metrics
 */

export const SIGNIN_OUTCOMES = ['success', 'failure', 'refresh_failure', 'rate_limited'] as const;
export type SigninOutcome = typeof SIGNIN_OUTCOMES[number];

export const UPSTREAM_TARGETS = ['stalwart', 'wopi', 'translate', 'plugin_proxy', 'oauth'] as const;
export type UpstreamTarget = typeof UPSTREAM_TARGETS[number];

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

/** The bearer token /api/metrics wants, or null when the endpoint is off. */
export function metricsToken(): string | null {
  const direct = process.env.METRICS_TOKEN?.trim();
  if (direct) return direct;
  const file = process.env.METRICS_TOKEN_FILE?.trim();
  if (!file) return null;
  try {
    return readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function metricsEnabled(): boolean {
  return metricsToken() !== null;
}

interface Metrics {
  registry: Registry;
  httpRequests: Counter<'group' | 'method' | 'status'>;
  httpDuration: Histogram<'group' | 'method'>;
  signins: Counter<'outcome'>;
  upstreamRequests: Counter<'target' | 'outcome'>;
  upstreamDuration: Histogram<'target'>;
  browserErrors: Counter;
  errorsToday: Gauge;
}

const KEY = Symbol.for('bulwark.metrics');

/** The registry and metrics, made once per process whatever bundle asks. */
export function metrics(): Metrics {
  const g = globalThis as typeof globalThis & { [KEY]?: Metrics };
  if (g[KEY]) return g[KEY];
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry, prefix: 'bulwark_' });
  const version = process.env.NEXT_PUBLIC_APP_VERSION || '0.0.0';
  const build = process.env.NEXT_PUBLIC_GIT_COMMIT || process.env.BULWARK_BUILD || 'unknown';
  new client.Gauge({ name: 'bulwark_build_info', help: 'Bulwark version and build; always 1', labelNames: ['version', 'build'], registers: [registry] })
    .set({ version, build }, 1);
  new client.Gauge({
    name: 'bulwark_uptime_seconds',
    help: 'Seconds since this process started',
    registers: [registry],
    collect() { this.set(process.uptime()); },
  });
  const created: Metrics = {
    registry,
    httpRequests: new client.Counter({ name: 'bulwark_http_requests_total', help: 'HTTP requests by route group, method and status class', labelNames: ['group', 'method', 'status'], registers: [registry] }),
    httpDuration: new client.Histogram({ name: 'bulwark_http_request_duration_seconds', help: 'HTTP request duration by route group and method', labelNames: ['group', 'method'], buckets: DURATION_BUCKETS, registers: [registry] }),
    signins: new client.Counter({ name: 'bulwark_signins_total', help: 'Sign-ins handled by this server, by outcome', labelNames: ['outcome'], registers: [registry] }),
    upstreamRequests: new client.Counter({ name: 'bulwark_upstream_requests_total', help: 'Requests this server made to other services, by target and outcome', labelNames: ['target', 'outcome'], registers: [registry] }),
    upstreamDuration: new client.Histogram({ name: 'bulwark_upstream_request_duration_seconds', help: 'Duration of requests to other services, by target', labelNames: ['target'], buckets: DURATION_BUCKETS, registers: [registry] }),
    browserErrors: new client.Counter({ name: 'bulwark_browser_errors_total', help: 'Errors browsers reported to this server', registers: [registry] }),
    errorsToday: new client.Gauge({
      name: 'bulwark_errors_today',
      help: 'Errors counted today (UTC) by the whole deployment, browsers and servers',
      registers: [registry],
      async collect() {
        const { readErrors, summarizeDay } = await import('@/lib/error-reporting/aggregate');
        this.set(summarizeDay(await readErrors()).total);
      },
    }),
  };
  // Pre-create the label sets, so a series exists at 0 before its first event.
  for (const outcome of SIGNIN_OUTCOMES) created.signins.inc({ outcome }, 0);
  for (const target of UPSTREAM_TARGETS) {
    for (const outcome of ['ok', 'error']) created.upstreamRequests.inc({ target, outcome }, 0);
  }
  g[KEY] = created;
  return created;
}

export function methodLabel(method: string | undefined): string {
  const upper = (method ?? '').toUpperCase();
  return METHODS.has(upper) ? upper : 'other';
}

export function statusClass(status: number): string {
  return status >= 100 && status < 600 ? `${Math.floor(status / 100)}xx` : 'other';
}

/** What a finished request means for sign-ins, from its route, method and status. */
export function signinOutcome(group: string, path: string, method: string, status: number): SigninOutcome | null {
  if (group !== 'api:auth') return null;
  const route = path.split(/[?#]/, 1)[0].replace(/\/+$/, '');
  const signIn = method === 'POST' && /\/api\/auth\/(?:session|stalwart-context|totp-token-exchange|token)$/.test(route);
  const refresh = method === 'PUT' && /\/api\/auth\/token$/.test(route);
  if (!signIn && !refresh) return null;
  if (status === 429) return 'rate_limited';
  if (status >= 200 && status < 300) return refresh ? null : 'success';
  return refresh ? 'refresh_failure' : 'failure';
}

/** Count a finished HTTP request (lib/metrics/http.ts). */
export function observeRequest(path: string, method: string | undefined, status: number, seconds: number, basePath = ''): void {
  if (!metricsEnabled()) return;
  const m = metrics();
  const group = routeGroup(path, basePath);
  const verb = methodLabel(method);
  m.httpRequests.inc({ group, method: verb, status: statusClass(status) });
  m.httpDuration.observe({ group, method: verb }, seconds);
  const outcome = signinOutcome(group, basePath && path.startsWith(basePath) ? path.slice(basePath.length) : path, verb, status);
  if (outcome) m.signins.inc({ outcome });
}

export function observeUpstreamResult(target: UpstreamTarget, ok: boolean, seconds: number): void {
  if (!metricsEnabled()) return;
  const m = metrics();
  m.upstreamRequests.inc({ target, outcome: ok ? 'ok' : 'error' });
  m.upstreamDuration.observe({ target }, seconds);
}

export function countBrowserError(): void {
  if (!metricsEnabled()) return;
  metrics().browserErrors.inc();
}

/** For tests. */
export function resetMetricsForTests(): void {
  const g = globalThis as typeof globalThis & { [KEY]?: Metrics };
  g[KEY]?.registry.clear();
  delete g[KEY];
}
