// Host side of `api.proxy`: a plugin's requests that need one of its
// credentials go to /api/plugin-proxy, which adds the secret on the server.
// Responses come back whole (text, JSON, bytes) or as a stream of chunks for
// large downloads and AI answers; uploads report progress.

import type { InstalledPlugin } from '../plugin-types';
import { apiFetch, withBasePath } from '../browser-navigation';
import { requestConnect, forgetCredentials, credentialOverview } from './connect-dialog';

/** Where streamed chunks and upload progress go: the iframe that asked. */
export interface StreamSink {
  sendStream(msg:
    | { type: 'stream-chunk'; streamId: string; chunk: ArrayBuffer }
    | { type: 'stream-end'; streamId: string; error?: string }
    | { type: 'stream-progress'; streamId: string; loaded: number; total: number }): void;
}

/** Largest response returned in one piece; bigger ones need responseType "stream". */
export const MAX_PROXY_BUFFERED_BYTES = 25 * 1024 * 1024;
/** Largest request body; matches MAX_PROXY_REQUEST_BYTES on the server. */
export const MAX_PROXY_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_STREAMS_PER_PLUGIN = 8;

type ResponseType = 'text' | 'json' | 'arraybuffer' | 'stream';

export interface ProxyInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer | Uint8Array | Blob | null;
  responseType?: ResponseType;
  /** Set by the runtime: ties chunks and progress to this request. */
  streamId?: string;
  /** Store these JSON fields of the response as the credential (see the proxy route). */
  capture?: { secret: string; username?: string };
}

export interface ProxyResult {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body?: unknown;
  /** Set when the proxy itself refused, e.g. "rate_limited", "wrong_origin". */
  proxyError?: string;
}

const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const STREAM_ID_RE = /^[a-z0-9]{6,40}$/;
const running = new Map<string, Map<string, AbortController>>();

function credentialSpec(plugin: InstalledPlugin, credentialId: unknown) {
  if (typeof credentialId !== 'string') throw new Error('credentialId must be a string');
  const spec = plugin.credentials?.[credentialId];
  if (!spec) throw new Error(`The manifest declares no credential "${credentialId}"`);
  return { id: credentialId, spec };
}

function checkInit(raw: unknown): ProxyInit {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object') throw new Error('init must be an object');
  const init = raw as Record<string, unknown>;
  const out: ProxyInit = {};
  if (init.method !== undefined) {
    if (typeof init.method !== 'string' || !/^[A-Z]{3,10}$/i.test(init.method)) throw new Error('Invalid method');
    out.method = init.method.toUpperCase();
  }
  if (init.headers !== undefined) {
    if (!init.headers || typeof init.headers !== 'object') throw new Error('headers must be an object');
    const entries = Object.entries(init.headers as Record<string, unknown>);
    if (entries.length > 50) throw new Error('Too many headers');
    out.headers = {};
    for (const [name, value] of entries) {
      if (!HEADER_NAME_RE.test(name) || typeof value !== 'string' || value.length > 8192 || /[\r\n]/.test(value)) {
        throw new Error(`Invalid header "${name}"`);
      }
      out.headers[name] = value;
    }
  }
  if (init.body !== undefined && init.body !== null) {
    const b = init.body;
    const size = typeof b === 'string' ? b.length : b instanceof Blob ? b.size : (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) ? (b as ArrayBuffer).byteLength : -1;
    if (size < 0) throw new Error('body must be a string, ArrayBuffer, Uint8Array or Blob');
    if (size > MAX_PROXY_UPLOAD_BYTES) throw new Error(`body is larger than ${MAX_PROXY_UPLOAD_BYTES} bytes; upload it in chunks`);
    out.body = b as ProxyInit['body'];
  }
  if (init.responseType !== undefined) {
    if (!['text', 'json', 'arraybuffer', 'stream'].includes(init.responseType as string)) throw new Error('Invalid responseType');
    out.responseType = init.responseType as ResponseType;
  }
  if (init.streamId !== undefined) {
    if (typeof init.streamId !== 'string' || !STREAM_ID_RE.test(init.streamId)) throw new Error('Invalid streamId');
    out.streamId = init.streamId;
  }
  if (init.capture !== undefined) {
    const c = init.capture as Record<string, unknown>;
    if (!c || typeof c.secret !== 'string' || (c.username !== undefined && typeof c.username !== 'string')) throw new Error('Invalid capture');
    out.capture = { secret: c.secret, ...(typeof c.username === 'string' ? { username: c.username } : {}) };
  }
  return out;
}

function headersOf(res: { headers: Headers }): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((value, name) => { out[name] = value; });
  return out;
}

async function readCapped(res: Response, limit: number): Promise<ArrayBuffer> {
  const length = Number(res.headers.get('content-length') ?? '0');
  if (length > limit) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Response is larger than ${limit} bytes; use responseType "stream"`);
  }
  if (!res.body) return new ArrayBuffer(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new Error(`Response is larger than ${limit} bytes; use responseType "stream"`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out.buffer;
}

function track(pluginId: string, streamId: string, controller: AbortController): () => void {
  let streams = running.get(pluginId);
  if (!streams) {
    streams = new Map();
    running.set(pluginId, streams);
  }
  if (streams.size >= MAX_STREAMS_PER_PLUGIN) throw new Error(`At most ${MAX_STREAMS_PER_PLUGIN} proxy requests at once`);
  streams.set(streamId, controller);
  return () => {
    streams!.delete(streamId);
    if (streams!.size === 0) running.delete(pluginId);
  };
}

/** Upload with progress reports; resolves with a fetch-like Response. */
function sendWithProgress(url: string, method: string, headers: Record<string, string>, body: XMLHttpRequestBodyInit, signal: AbortSignal, onProgress: (loaded: number, total: number) => void): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.responseType = 'arraybuffer';
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.setRequestHeader('x-bulwark-method', method);
    xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : 0);
    xhr.onload = () => {
      const h = new Headers();
      for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
        const i = line.indexOf(':');
        if (i > 0) h.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
      }
      resolve(new Response(xhr.status === 204 || xhr.status === 304 ? null : xhr.response as ArrayBuffer, { status: xhr.status, headers: h }));
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

/** `api.proxy.fetch(credentialId, url, init)`. */
export async function proxyFetch(plugin: InstalledPlugin, args: unknown[], sink: StreamSink | null): Promise<ProxyResult> {
  const { id: credentialId } = credentialSpec(plugin, args[0]);
  if (typeof args[1] !== 'string' || args[1].length > 8192) throw new Error('url must be a string');
  const target = args[1];
  const init = checkInit(args[2]);
  const method = init.method ?? (init.body ? 'POST' : 'GET');
  const responseType = init.responseType ?? 'text';
  const streamId = init.streamId ?? Math.random().toString(36).slice(2, 12);
  if (init.capture && plugin.credentials?.[credentialId]?.scope !== 'user') throw new Error('capture needs a user credential');

  const query = new URLSearchParams({ plugin: plugin.id, credential: credentialId, url: target });
  const url = withBasePath(`/api/plugin-proxy?${query}`);
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.capture) headers['x-bulwark-capture'] = JSON.stringify(init.capture);

  const controller = new AbortController();
  const untrack = track(plugin.id, streamId, controller);
  let streaming = false;
  try {
    let res: Response;
    // XHR reports upload progress but can't stream the answer, so a request
    // that wants a streamed answer (an AI reply) goes through fetch.
    if (init.body && sink && responseType !== 'stream' && typeof XMLHttpRequest !== 'undefined') {
      res = await sendWithProgress(url, method, headers, init.body as XMLHttpRequestBodyInit, controller.signal,
        (loaded, total) => sink.sendStream({ type: 'stream-progress', streamId, loaded, total }));
    } else {
      res = await apiFetch(`/api/plugin-proxy?${query}`, {
        method: 'POST',
        headers: { ...headers, 'x-bulwark-method': method },
        body: (init.body ?? undefined) as BodyInit | undefined,
        signal: controller.signal,
      });
    }

    const result: ProxyResult = { status: res.status, ok: res.ok, headers: headersOf(res) };
    const proxyRefused = !!res.headers.get('x-bulwark-proxy-error');

    if (responseType === 'stream' && sink && res.body && res.ok) {
      streaming = true;
      const reader = res.body.getReader();
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const copy = value.slice().buffer;
            sink.sendStream({ type: 'stream-chunk', streamId, chunk: copy });
          }
          sink.sendStream({ type: 'stream-end', streamId });
        } catch (err) {
          sink.sendStream({ type: 'stream-end', streamId, error: controller.signal.aborted ? 'cancelled' : (err as Error).message });
        } finally {
          untrack();
        }
      })();
      return result;
    }

    const bytes = await readCapped(res, MAX_PROXY_BUFFERED_BYTES);
    if (proxyRefused) {
      result.proxyError = res.headers.get('x-bulwark-proxy-error') ?? 'refused';
      try {
        result.body = (JSON.parse(new TextDecoder().decode(bytes)) as { error?: string }).error ?? '';
      } catch {
        result.body = '';
      }
      return result;
    }
    if (responseType === 'arraybuffer') result.body = bytes;
    else {
      const text = new TextDecoder().decode(bytes);
      if (responseType === 'json') {
        try { result.body = text ? JSON.parse(text) : null; } catch { throw new Error(`Response is not JSON (HTTP ${res.status})`); }
      } else {
        result.body = text;
      }
    }
    return result;
  } finally {
    if (!streaming) untrack();
  }
}

/** `api.proxy.cancel(streamId)`: stop a running request or stream. */
export function proxyCancel(plugin: InstalledPlugin, streamId: unknown): void {
  if (typeof streamId !== 'string') return;
  running.get(plugin.id)?.get(streamId)?.abort();
}

/** Stop everything a plugin has running (it was turned off). */
export function cancelPluginProxyRequests(pluginId: string): void {
  for (const controller of running.get(pluginId)?.values() ?? []) controller.abort();
  running.delete(pluginId);
}

/** `api.proxy.connect(credentialId, { mode, server, username })`. */
export async function proxyConnect(plugin: InstalledPlugin, args: unknown[]): Promise<{ connected: boolean; origin?: string }> {
  const { id, spec } = credentialSpec(plugin, args[0]);
  if (spec.scope !== 'user') throw new Error(`"${id}" is set up by the administrator`);
  const opts = (args[1] && typeof args[1] === 'object' ? args[1] : {}) as Record<string, unknown>;
  const mode = spec.appPassword ? 'appPassword' : opts.mode === 'signin' ? 'signin' : 'password';
  return requestConnect({
    pluginId: plugin.id,
    pluginName: plugin.name,
    credentialId: id,
    spec,
    mode,
    ...(typeof opts.server === 'string' && opts.server.length < 2048 ? { suggestedOrigin: opts.server } : {}),
    ...(typeof opts.username === 'string' && opts.username.length < 256 ? { suggestedUsername: opts.username } : {}),
  });
}

/**
 * `api.proxy.accounts()`: the user's connected accounts (with server and
 * user name) and, with `scope: 'admin'`, whether each admin credential is
 * set up. No secrets, and no server address for admin credentials.
 */
export async function proxyAccounts(plugin: InstalledPlugin): Promise<{ credentialId: string; scope: 'user' | 'admin'; origin?: string; username?: string; connected: boolean }[]> {
  const { credentials, admin } = await credentialOverview(plugin.id);
  return [
    ...credentials.map(({ credentialId, origin, username, connected }) => ({ credentialId, scope: 'user' as const, origin, ...(username ? { username } : {}), connected })),
    ...admin.map(({ credentialId, configured }) => ({ credentialId, scope: 'admin' as const, connected: configured })),
  ];
}

/** `api.proxy.disconnect(credentialId)`. */
export async function proxyDisconnect(plugin: InstalledPlugin, args: unknown[]): Promise<boolean> {
  const { id } = credentialSpec(plugin, args[0]);
  return forgetCredentials(plugin.id, id);
}
