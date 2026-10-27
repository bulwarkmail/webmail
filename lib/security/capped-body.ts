/**
 * Size-capped reads of upstream response bodies.
 *
 * `response.text()` and `response.json()` read a body whole, however large.
 * For a server the user chose (allowCustomJmapEndpoint) that lets it stream
 * into this process's memory for as long as the request deadline allows, so
 * routes that read such a body read it through these instead.
 */

import type { PublicFetchResponse } from '@/lib/security/url-guard';

/** Generous cap for small JMAP answers: session documents, a few method calls. */
export const UPSTREAM_JSON_MAX_BYTES = 5 * 1024 * 1024;

export class UpstreamBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Upstream response is larger than ${maxBytes} bytes`);
    this.name = 'UpstreamBodyTooLargeError';
  }
}

/**
 * The body as bytes, or null once it exceeds `maxBytes`, in which case the
 * upstream connection is aborted rather than drained. Takes a request too.
 */
export async function readBodyCapped(
  response: PublicFetchResponse | Response | Request,
  maxBytes: number,
  controller?: AbortController,
): Promise<ArrayBuffer | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    controller?.abort();
    (response.body as ReadableStream<Uint8Array> | null)?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    return buffer.byteLength > maxBytes ? null : buffer;
  }
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const chunk = value as Uint8Array;
    received += chunk.byteLength;
    if (received > maxBytes) {
      controller?.abort();
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

/** Like `response.text()`, but throws {@link UpstreamBodyTooLargeError} past `maxBytes`. */
export async function readTextCapped(response: PublicFetchResponse | Response, maxBytes: number): Promise<string> {
  // No stream means no body to grow: the plain read is bounded.
  if (!response.body) return response.text();
  const buffer = await readBodyCapped(response, maxBytes);
  if (!buffer) throw new UpstreamBodyTooLargeError(maxBytes);
  return new TextDecoder().decode(buffer);
}

/** Like `response.json()`, but throws {@link UpstreamBodyTooLargeError} past `maxBytes`. */
export async function readJsonCapped<T = unknown>(response: PublicFetchResponse | Response, maxBytes: number): Promise<T> {
  if (!response.body) return (await response.json()) as T;
  return JSON.parse(await readTextCapped(response, maxBytes)) as T;
}
