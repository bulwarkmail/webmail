// Server side of the plugin secret proxy. A plugin asks the host to send a
// request "with credential X"; the browser posts it to /api/plugin-proxy and
// this module adds the secret and forwards it, but only to the credential's
// own origin. Bodies stream in both directions (uploads, downloads, AI
// responses), with size caps, a per-user rate limit and an audit line per
// request that names no paths, headers or bodies.

import { getPlugin } from '@/lib/admin/plugin-registry';
import { getPluginConfig } from '@/lib/admin/plugin-config';
import { logger } from '@/lib/logger';
import { DisallowedUrlError, fetchPublicUrl } from '@/lib/security/url-guard';
import { authHeaderFor, credentialOrigin, privateProxyOrigins, type CredentialInject, type CredentialSpec } from './credentials';
import { getUserCredential, setUserCredentialSecret, userKey, type VaultUser } from './vault';
import { declaredUserCredential } from './known-plugins';

/** Largest request body the proxy forwards (one upload chunk). */
export const MAX_PROXY_REQUEST_BYTES = 100 * 1024 * 1024;
/** Largest response body it passes back (a download). */
export const MAX_PROXY_RESPONSE_BYTES = 2 * 1024 * 1024 * 1024;
/** Largest response it reads to capture a secret from. */
export const MAX_CAPTURE_BYTES = 1024 * 1024;
/** Requests per user and plugin per minute. */
export const PROXY_RATE_LIMIT = 300;
/** Requests one user may have running at once. */
export const PROXY_MAX_CONCURRENT = 8;
const PROXY_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_REDIRECTS = 3;

export const PROXY_METHODS = new Set([
  'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE',
  // WebDAV, for Nextcloud and other file servers.
  'PROPFIND', 'PROPPATCH', 'MKCOL', 'COPY', 'MOVE', 'REPORT', 'SEARCH', 'LOCK', 'UNLOCK',
]);

/** Request headers never forwarded: the proxy owns auth, cookies and transport. */
const DROP_REQUEST_HEADERS = new Set([
  'host', 'cookie', 'authorization', 'proxy-authorization', 'origin', 'referer', 'connection',
  'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'forwarded', 'via',
  'content-length', 'accept-encoding', 'expect', 'priority',
]);
const DROP_REQUEST_PREFIXES = ['x-forwarded-', 'x-real-', 'sec-', 'proxy-', 'x-bulwark-', 'cf-'];

/** Response headers passed back to the plugin. */
const PASS_RESPONSE_HEADERS = new Set([
  'content-type', 'content-range', 'content-disposition', 'content-language', 'accept-ranges',
  'etag', 'last-modified', 'dav', 'retry-after', 'oc-etag', 'oc-fileid', 'x-request-id',
]);
const PASS_RESPONSE_PREFIXES = ['x-ratelimit-', 'ratelimit-', 'anthropic-ratelimit-', 'x-oc-', 'oc-'];

export class ProxyError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

export interface ResolvedCredential {
  origin: string;
  inject: CredentialInject;
  secret?: string;
  username?: string;
  /** May reach private addresses: the admin set it up. */
  trusted: boolean;
  scope: 'admin' | 'user';
}

/**
 * The credential a plugin asks for: one the user connected, else one the
 * admin configured for an installed plugin that declares it.
 */
export async function resolveCredential(user: VaultUser, pluginId: string, credentialId: string): Promise<ResolvedCredential | null> {
  const stored = await getUserCredential(user, pluginId, credentialId);
  if (stored) {
    // Only for a plugin this server knows declares it, on the server the
    // manifest fixes (see declaredUserCredential).
    const spec = await declaredUserCredential(pluginId, credentialId);
    if (!spec) return null;
    if (spec.origin && credentialOrigin(spec.origin) !== stored.origin) return null;
    return {
      origin: stored.origin, inject: stored.inject, secret: stored.secret, username: stored.username,
      trusted: privateProxyOrigins().includes(stored.origin), scope: 'user',
    };
  }
  const plugin = await getPlugin(pluginId);
  const spec = (plugin as { credentials?: Record<string, CredentialSpec> } | null)?.credentials?.[credentialId];
  if (!plugin || !plugin.enabled || !spec || spec.scope !== 'admin') return null;
  const config = await getPluginConfig(pluginId);
  const secret = config[spec.secretKey];
  const origin = spec.origin ?? credentialOrigin(spec.originKey ? config[spec.originKey] : undefined);
  // A credential that adds nothing (a keyless service such as a local Ollama)
  // needs only its server.
  const needsSecret = spec.inject.type !== 'none';
  if (!origin || (needsSecret && (typeof secret !== 'string' || !secret))) return null;
  const username = spec.usernameKey ? config[spec.usernameKey] : undefined;
  return {
    origin, inject: spec.inject, secret: typeof secret === 'string' && secret ? secret : undefined,
    username: typeof username === 'string' ? username : undefined,
    trusted: true, scope: 'admin',
  };
}

/**
 * Which of a plugin's admin credentials are ready to use (secret and server
 * set). No secret or address leaves the server; plugins learn only yes/no.
 */
export async function adminCredentialStatus(pluginId: string): Promise<{ credentialId: string; configured: boolean }[]> {
  return (await adminCredentials(pluginId)).map(({ credentialId, origin }) => ({ credentialId, configured: !!origin }));
}

/**
 * The servers of a plugin's admin credentials that are set up. Only for the
 * host page, which checks links a plugin shows against them: plugins
 * themselves still learn only yes/no (adminCredentialStatus).
 */
export async function adminCredentialOrigins(pluginId: string): Promise<string[]> {
  return (await adminCredentials(pluginId)).flatMap(({ origin }) => (origin ? [origin] : []));
}

async function adminCredentials(pluginId: string): Promise<{ credentialId: string; origin: string | null }[]> {
  const plugin = await getPlugin(pluginId);
  const specs = (plugin as { credentials?: Record<string, CredentialSpec> } | null)?.credentials;
  if (!plugin || !plugin.enabled || !specs) return [];
  const adminIds = Object.entries(specs).filter(([, spec]) => spec.scope === 'admin').map(([id]) => id);
  if (adminIds.length === 0) return [];
  const user = { username: '', serverUrl: '' };
  return Promise.all(adminIds.map(async (credentialId) => ({
    credentialId,
    origin: (await resolveAdminOnly(user, pluginId, credentialId))?.origin ?? null,
  })));
}

async function resolveAdminOnly(user: VaultUser, pluginId: string, credentialId: string): Promise<ResolvedCredential | null> {
  const resolved = await resolveCredential(user, pluginId, credentialId);
  return resolved?.scope === 'admin' ? resolved : null;
}

// ─── Rate limiting ────────────────────────────────────────────

const windows = new Map<string, number[]>();
const running = new Map<string, number>();

function takeSlot(user: string, pluginId: string, now = Date.now()): { ok: true } | { ok: false; retryAfter: number } {
  if ((running.get(user) ?? 0) >= PROXY_MAX_CONCURRENT) return { ok: false, retryAfter: 1 };
  const key = `${user}:${pluginId}`;
  const recent = (windows.get(key) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= PROXY_RATE_LIMIT) {
    windows.set(key, recent);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((60_000 - (now - recent[0])) / 1000)) };
  }
  recent.push(now);
  windows.set(key, recent);
  running.set(user, (running.get(user) ?? 0) + 1);
  return { ok: true };
}

function releaseSlot(user: string): void {
  const n = (running.get(user) ?? 1) - 1;
  if (n <= 0) running.delete(user);
  else running.set(user, n);
}

/** Test helper. */
export function resetProxyLimits(): void {
  windows.clear();
  running.clear();
}

// ─── Forwarding ───────────────────────────────────────────────

/** Ask the proxy to store a field of a JSON response as the secret. */
export interface CaptureSpec {
  /** Top-level JSON field holding the secret, e.g. Nextcloud's `appPassword`. */
  secret: string;
  /** Top-level JSON field holding the user name, e.g. `loginName`. */
  username?: string;
}

export interface ProxyInput {
  user: VaultUser;
  pluginId: string;
  credentialId: string;
  url: string;
  method: string;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  capture?: CaptureSpec;
  signal?: AbortSignal;
}

function forwardHeaders(input: Headers, credential: ResolvedCredential): Record<string, string> {
  const out: Record<string, string> = {};
  input.forEach((value, rawName) => {
    const name = rawName.toLowerCase();
    if (DROP_REQUEST_HEADERS.has(name)) return;
    if (DROP_REQUEST_PREFIXES.some((p) => name.startsWith(p))) return;
    out[name] = value;
  });
  // WebDAV COPY/MOVE name their target as a full URL: it must stay on the
  // credential's server.
  if (out.destination) {
    let dest: URL;
    try { dest = new URL(out.destination); } catch { throw new ProxyError('Invalid Destination header', 400, 'bad_destination'); }
    if (dest.origin !== credential.origin) throw new ProxyError('Destination must be on the same server', 400, 'bad_destination');
  }
  const auth = authHeaderFor(credential.inject, credential.secret, credential.username);
  if (auth) out[auth[0]] = auth[1];
  return out;
}

function countingStream(limit: number, onDone: (bytes: number, overLimit: boolean) => void): TransformStream<Uint8Array, Uint8Array> {
  let bytes = 0;
  let finished = false;
  const finish = (over: boolean) => { if (!finished) { finished = true; onDone(bytes, over); } };
  return new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > limit) {
        finish(true);
        controller.error(new ProxyError('Body too large', 413, 'too_large'));
        return;
      }
      controller.enqueue(chunk);
    },
    flush() { finish(false); },
  });
}

async function send(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Uint8Array | null; signal: AbortSignal },
  trusted: boolean,
): Promise<Response> {
  const request = {
    method: init.method,
    headers: init.headers,
    signal: init.signal,
    ...(init.body ? { body: init.body } : {}),
  };
  if (trusted) return fetch(url, { ...request, redirect: 'manual' } as RequestInit);
  return (await fetchPublicUrl(url, request as never)) as unknown as Response;
}

function responseHeaders(upstream: Response): Headers {
  const out = new Headers();
  upstream.headers.forEach((value, rawName) => {
    const name = rawName.toLowerCase();
    if (PASS_RESPONSE_HEADERS.has(name) || PASS_RESPONSE_PREFIXES.some((p) => name.startsWith(p))) out.set(name, value);
  });
  // fetch has already decoded a compressed body, so its length is unknown.
  if (!upstream.headers.get('content-encoding')) {
    const length = upstream.headers.get('content-length');
    if (length) out.set('content-length', length);
  }
  out.set('cache-control', 'no-store');
  return out;
}

function redact(body: Record<string, unknown>, capture: CaptureSpec): Record<string, unknown> {
  const out = { ...body };
  delete out[capture.secret];
  if (capture.username) delete out[capture.username];
  return out;
}

/**
 * Forward one plugin request. Returns the upstream response with a filtered
 * set of headers and a size-capped body, or throws ProxyError.
 */
export async function proxyRequest(input: ProxyInput): Promise<Response> {
  const method = input.method.toUpperCase();
  if (!PROXY_METHODS.has(method)) throw new ProxyError(`Method ${method} is not allowed`, 405, 'bad_method');

  const credential = await resolveCredential(input.user, input.pluginId, input.credentialId);
  if (!credential) throw new ProxyError('No such credential', 404, 'no_credential');

  let target: URL;
  try { target = new URL(input.url); } catch { throw new ProxyError('Invalid URL', 400, 'bad_url'); }
  if (target.origin !== credential.origin || target.username || target.password) {
    throw new ProxyError('This credential is only for its own server', 403, 'wrong_origin');
  }
  if (input.capture && credential.scope !== 'user') {
    throw new ProxyError('Only a credential the user connected can be filled in', 400, 'bad_capture');
  }

  const who = userKey(input.user);
  const slot = takeSlot(who, input.pluginId);
  if (!slot.ok) {
    throw Object.assign(new ProxyError('Too many requests', 429, 'rate_limited'), { retryAfter: slot.retryAfter });
  }

  const started = Date.now();
  let sent = 0;
  let released = false;
  const release = () => { if (!released) { released = true; releaseSlot(who); } };
  const audit = (status: number, received: number, note?: string) => {
    logger.info('Plugin proxy request', {
      plugin: input.pluginId, credential: input.credentialId, user: who.slice(0, 12),
      method, host: target.host, status, sentBytes: sent, receivedBytes: received,
      ms: Date.now() - started, ...(note ? { note } : {}),
    });
  };

  const timeout = AbortSignal.timeout(PROXY_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;

  try {
    const headers = forwardHeaders(input.headers, credential);
    // Read the whole body first and send it with a Content-Length. Streamed
    // (chunked) uploads reach some servers empty: Paperless (Django) answers
    // "No file was submitted". proxy.ts doesn't run for /api/plugin-proxy,
    // so this is the only copy, and the only limit.
    let body = input.body && method !== 'GET' && method !== 'HEAD'
      ? await readBody(input.body, MAX_PROXY_REQUEST_BYTES)
      : null;
    sent = body?.byteLength ?? 0;
    let currentUrl = target.toString();
    let currentMethod = method;
    let upstream: Response | null = null;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      upstream = await send(currentUrl, { method: currentMethod, headers, body, signal }, credential.trusted);
      if (upstream.status < 300 || upstream.status >= 400 || upstream.status === 304) break;
      const location = upstream.headers.get('location');
      if (!location) break;
      await upstream.body?.cancel().catch(() => {});
      const next = new URL(location, currentUrl);
      // A redirect off the credential's server would take the secret along.
      if (next.origin !== credential.origin) {
        throw new ProxyError('The server redirected to another address', 502, 'redirect_off_origin');
      }
      if (body && upstream.status !== 307 && upstream.status !== 308) {
        currentMethod = 'GET';
        body = null;
        delete headers['content-type'];
      }
      currentUrl = next.toString();
      upstream = null;
    }
    if (!upstream) throw new ProxyError('Too many redirects', 502, 'too_many_redirects');

    if (input.capture) {
      const text = await readCapped(upstream, MAX_CAPTURE_BYTES);
      let json: unknown;
      try { json = JSON.parse(text); } catch { json = null; }
      const out = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
      if (upstream.ok && json && typeof json === 'object' && !Array.isArray(json)) {
        const record = json as Record<string, unknown>;
        const secret = record[input.capture.secret];
        const username = input.capture.username ? record[input.capture.username] : undefined;
        if (typeof secret === 'string' && secret) {
          await setUserCredentialSecret(input.user, input.pluginId, input.credentialId, secret, typeof username === 'string' ? username : undefined);
          audit(upstream.status, text.length, 'captured');
          return new Response(JSON.stringify({ ...redact(record, input.capture), captured: true }), { status: upstream.status, headers: out });
        }
        audit(upstream.status, text.length);
        return new Response(JSON.stringify({ ...redact(record, input.capture), captured: false }), { status: upstream.status, headers: out });
      }
      audit(upstream.status, text.length);
      // Never hand back a body that might hold the secret in another shape.
      return new Response(JSON.stringify({ captured: false }), { status: upstream.status, headers: out });
    }

    const status = upstream.status;
    const outHeaders = responseHeaders(upstream);
    // Where a redirect on the same server ended up (CalDAV discovery needs it).
    if (currentUrl !== target.toString()) outHeaders.set('x-bulwark-url', currentUrl);
    if (!upstream.body) {
      audit(status, 0);
      release();
      return new Response(null, { status, headers: outHeaders });
    }
    const stream = upstream.body.pipeThrough(countingStream(MAX_PROXY_RESPONSE_BYTES, (received, over) => {
      audit(status, received, over ? 'response too large' : undefined);
      release();
    }));
    // The browser may stop reading (cancelled download); free the slot then too.
    signal.addEventListener('abort', release, { once: true });
    return new Response(stream, { status, headers: outHeaders });
  } catch (error) {
    release();
    if (error instanceof ProxyError) {
      audit(error.status, 0, error.code);
      throw error;
    }
    if (error instanceof DisallowedUrlError) {
      audit(403, 0, 'blocked address');
      throw new ProxyError('This server address is not allowed', 403, 'blocked_address');
    }
    if (signal.aborted) {
      audit(504, 0, 'timeout');
      throw new ProxyError('The server did not answer in time', 504, 'timeout');
    }
    audit(502, 0, 'unreachable');
    throw new ProxyError('Could not reach the server', 502, 'unreachable');
  } finally {
    if (input.capture) release();
  }
}

async function readBody(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new ProxyError('Body too large', 413, 'too_large');
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function readCapped(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new ProxyError('Response too large', 502, 'too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
