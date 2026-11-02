import diagnostics from 'node:diagnostics_channel';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { metricsEnabled, observeRequest } from './index';

/**
 * Counts every request this process serves, through Node's own HTTP
 * diagnostics channels: nothing is wrapped or patched, and the proxy's
 * matcher doesn't matter. Installed once at startup when the metrics
 * endpoint is on (instrumentation.node.ts).
 */

interface HttpState {
  installed: boolean;
  started: WeakMap<IncomingMessage, number>;
}

const KEY = Symbol.for('bulwark.metrics.http');
function state(): HttpState {
  const g = globalThis as typeof globalThis & { [KEY]?: HttpState };
  return (g[KEY] ??= { installed: false, started: new WeakMap() });
}

export function installHttpMetrics(basePath = process.env.NEXT_PUBLIC_BASE_PATH || ''): boolean {
  const s = state();
  if (s.installed || !metricsEnabled()) return false;
  s.installed = true;
  diagnostics.subscribe('http.server.request.start', (message) => {
    const { request } = message as { request: IncomingMessage };
    s.started.set(request, performance.now());
  });
  diagnostics.subscribe('http.server.response.finish', (message) => {
    const { request, response } = message as { request: IncomingMessage; response: ServerResponse };
    const start = s.started.get(request);
    if (start === undefined) return;
    s.started.delete(request);
    observeRequest(request.url ?? '/', request.method, response.statusCode, (performance.now() - start) / 1000, basePath);
  });
  return true;
}
