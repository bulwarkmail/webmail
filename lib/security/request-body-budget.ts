import diagnostics from 'node:diagnostics_channel';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from '@/lib/logger';

/**
 * A ceiling on the request bodies this process holds in memory at once.
 *
 * For every request proxy.ts runs for, Next copies the body into memory
 * before the proxy or any route sees it, up to proxyClientMaxBodySize (10 MB,
 * see next.config.ts). That is per request, with no limit on how many
 * requests do it at once and no deadline for a body to arrive: a few hundred
 * connections that each start a 10 MB body and never finish it hold that
 * memory until the process is killed, on any route and before any check of
 * who is asking.
 *
 * So each request that announces a body reserves what Next may copy for it,
 * and gives it back when its response is closed. A request that would take
 * the total over the budget is refused before a byte of its body is read.
 * A body that never arrives in full holds its reservation until Node closes
 * the request (`server.requestTimeout`, five minutes by default).
 * Small bodies (sign-in, JMAP calls, settings of an ordinary size) are let
 * through without counting: one connection can hold no more than
 * UNCOUNTED_MAX_BYTES that way.
 *
 * Like the request metrics (lib/metrics/http.ts) this listens on Node's own
 * HTTP diagnostics channel: nothing is wrapped or patched. A reverse proxy
 * that buffers request bodies (nginx by default) never lets a half-sent body
 * through, so behind one this only sees complete requests.
 */

/** What Next copies per request at most: proxyClientMaxBodySize, left at its default. */
export const PER_REQUEST_MAX_BYTES = 10 * 1024 * 1024;
/** Bodies up to this size are not counted. */
export const UNCOUNTED_MAX_BYTES = 64 * 1024;
const DEFAULT_BUDGET_BYTES = 128 * 1024 * 1024;

/**
 * The routes proxy.ts does not run for (its `config.matcher`): they stream
 * their uploads and cap what they read themselves, so Next copies nothing.
 */
const STREAMED_ROUTE = /\/api\/(?:webdav|plugin-proxy|wopi\/files\/[^/]+\/contents)$/;

const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

/**
 * The budget in bytes from REQUEST_BODY_BUDGET_MB, or null when it is `0`
 * (off). Anything that isn't a whole number of megabytes keeps the default.
 */
export function bodyBudgetBytes(raw: string | undefined = process.env.REQUEST_BODY_BUDGET_MB): number | null {
  if (raw === undefined || raw.trim() === '') return DEFAULT_BUDGET_BYTES;
  const megabytes = Number(raw);
  if (!Number.isInteger(megabytes) || megabytes < 0) return DEFAULT_BUDGET_BYTES;
  return megabytes === 0 ? null : megabytes * 1024 * 1024;
}

/**
 * The bytes Next may copy for a request with these headers, or 0 when it
 * copies nothing worth counting.
 */
export function bodyWeight(method: string | undefined, url: string | undefined, headers: IncomingMessage['headers']): number {
  if (BODYLESS_METHODS.has((method ?? 'GET').toUpperCase())) return 0;
  const path = (url ?? '/').split('?', 1)[0];
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Not a path Next will route to a handler; counted as it stands.
  }
  if (STREAMED_ROUTE.test(path) && STREAMED_ROUTE.test(decoded)) return 0;

  let weight: number;
  if (headers['transfer-encoding'] !== undefined) {
    // No length is announced: the whole allowance may be used.
    weight = PER_REQUEST_MAX_BYTES;
  } else {
    const length = headers['content-length'];
    if (length === undefined) return 0;
    const declared = /^\d{1,15}$/.test(length) ? Number(length) : PER_REQUEST_MAX_BYTES;
    weight = Math.min(declared, PER_REQUEST_MAX_BYTES);
  }
  return weight > UNCOUNTED_MAX_BYTES ? weight : 0;
}

export interface BodyBudget {
  /** Bytes reserved right now. */
  reserved(): number;
  /** Requests refused since the start. */
  refused(): number;
  /** Take a request into account. Called for every request, before its listener. */
  admit(request: IncomingMessage, response: ServerResponse): void;
}

const REFUSAL =
  'HTTP/1.1 503 Service Unavailable\r\n' +
  'Content-Type: text/plain; charset=utf-8\r\n' +
  'Retry-After: 5\r\n' +
  'Connection: close\r\n' +
  'Content-Length: 31\r\n' +
  '\r\n' +
  'Too many uploads at once. Retry';

export function createBodyBudget(options: { budgetBytes: () => number | null }): BodyBudget {
  let reserved = 0;
  let refused = 0;
  let lastWarning = 0;

  function warn(): void {
    refused++;
    const now = Date.now();
    // At most one line a minute: this runs while someone floods the server.
    if (now - lastWarning < 60_000) return;
    lastWarning = now;
    logger.warn('Request body refused', { reservedBytes: reserved, refused });
  }

  /** Answer 503 on the raw socket and close it: nothing of the body is read. */
  function refuse(request: IncomingMessage): void {
    const socket = request.socket;
    if (!socket || socket.destroyed) return;
    // Stop reading first, so no part of the body is copied while the answer drains.
    request.pause();
    socket.pause();
    socket.end(REFUSAL, () => socket.destroy());
    // A peer that never reads the answer must not keep the socket open.
    setTimeout(() => socket.destroy(), 1000).unref();
  }

  return {
    reserved: () => reserved,
    refused: () => refused,
    admit(request, response) {
      const budget = options.budgetBytes();
      if (budget === null) return;
      const weight = bodyWeight(request.method, request.url, request.headers);
      if (weight === 0) return;

      if (reserved + weight > budget) {
        warn();
        refuse(request);
        return;
      }

      reserved += weight;
      // 'close' comes after the response was sent, and when the connection
      // drops before there is one. Once per response, so nothing is left on
      // a socket that serves many requests.
      response.once('close', () => {
        reserved = Math.max(0, reserved - weight);
      });
    },
  };
}

interface GuardState {
  installed: boolean;
  budget: BodyBudget | null;
}

const KEY = Symbol.for('bulwark.security.request-body-budget');
function state(): GuardState {
  const g = globalThis as typeof globalThis & { [KEY]?: GuardState };
  return (g[KEY] ??= { installed: false, budget: null });
}

/** Start counting. Once per process, from instrumentation.node.ts. */
export function installBodyBudget(): BodyBudget {
  const s = state();
  if (s.installed && s.budget) return s.budget;
  const budget = createBodyBudget({ budgetBytes: () => bodyBudgetBytes() });
  s.installed = true;
  s.budget = budget;
  diagnostics.subscribe('http.server.request.start', (message) => {
    const { request, response } = message as { request: IncomingMessage; response: ServerResponse };
    try {
      budget.admit(request, response);
    } catch (error) {
      // Never let the count take a request down.
      logger.warn('Request body budget failed', { error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });
  return budget;
}
