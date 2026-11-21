// Host side of `api.http.eventSource`: a plugin's subscription to
// Server-Sent Events from one of its httpOrigins. A sandboxed frame can't
// open the connection itself (its CSP has no connect-src for other sites),
// so the host holds it in the user's browser, reads the events and posts
// each to the frame that asked. The host reconnects by itself; the
// connection ends when the plugin closes it, when its frame goes or when
// the plugin is turned off.

import type { EventStreamMsg } from './protocol';

/** Where the events go: the iframe that subscribed. */
export interface EventStreamSink {
  sendEventStream(msg: EventStreamMsg): void;
  /** True once the frame is gone. */
  readonly closed: boolean;
}

export const MAX_EVENT_STREAMS_PER_PLUGIN = 4;
/** Largest single event (its data, or a line still being read), in characters. */
export const MAX_EVENT_CHARS = 1024 * 1024;
/** Wait before reconnecting, until the server names one with `retry:`. */
export const DEFAULT_RETRY_MS = 3000;
const MIN_RETRY_MS = 1000;
/** The wait doubles with each failed attempt in a row, up to this. */
export const MAX_RETRY_MS = 60_000;

const STREAM_ID_RE = /^[a-z0-9]{6,40}$/;

export interface ServerEvent {
  /** The event's name; "message" when the server names none. */
  type: string;
  data: string;
  lastEventId: string;
}

/**
 * Reads a `text/event-stream` body as the HTML standard says: lines end in
 * LF, CR or CRLF, a blank line ends an event, a line starting with a colon
 * is a comment.
 */
export class EventStreamParser {
  private pending = '';
  private data = '';
  private hasData = false;
  private type = '';
  private first = true;
  /** The last id the server sent; kept across events and reconnects. */
  lastEventId: string;
  /** The server's `retry:` in milliseconds, once it sent one. */
  retry: number | null = null;

  constructor(lastEventId = '') {
    this.lastEventId = lastEventId;
  }

  /** The events `text` completes. Throws when one grows past the cap. */
  feed(text: string): ServerEvent[] {
    if (this.first) {
      this.first = false;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    this.pending += text;
    const events: ServerEvent[] = [];
    let start = 0;
    for (;;) {
      let end = -1;
      let next = -1;
      for (let i = start; i < this.pending.length; i++) {
        const c = this.pending.charCodeAt(i);
        if (c === 10) { end = i; next = i + 1; break; }
        if (c === 13) {
          // A CR at the very end may be half of a CRLF; wait for what follows.
          if (i + 1 === this.pending.length) break;
          end = i;
          next = this.pending.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
          break;
        }
      }
      if (end < 0) break;
      const event = this.line(this.pending.slice(start, end));
      if (event) events.push(event);
      start = next;
    }
    this.pending = this.pending.slice(start);
    if (this.pending.length + this.data.length > MAX_EVENT_CHARS) {
      throw new Error(`An event is larger than ${MAX_EVENT_CHARS} characters`);
    }
    return events;
  }

  private line(line: string): ServerEvent | null {
    if (line === '') {
      const event = this.hasData
        ? { type: this.type || 'message', data: this.data.slice(0, -1), lastEventId: this.lastEventId }
        : null;
      this.data = '';
      this.hasData = false;
      this.type = '';
      return event;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      this.data += value + '\n';
      this.hasData = true;
    } else if (field === 'event') {
      this.type = value;
    } else if (field === 'id') {
      if (!value.includes('\0')) this.lastEventId = value;
    } else if (field === 'retry') {
      if (/^\d+$/.test(value)) this.retry = Number(value);
    }
    return null;
  }
}

interface Running {
  controller: AbortController;
  sink: EventStreamSink;
}

const running = new Map<string, Map<string, Running>>();

export interface EventStreamInit {
  headers?: Record<string, string>;
  /** Set by the runtime: ties the events to this subscription. */
  streamId?: string;
}

function checkInit(raw: unknown): { headers: Record<string, string>; streamId: string } {
  if (raw === null || typeof raw !== 'object') throw new Error('init must be an object');
  const init = raw as Record<string, unknown>;
  if (typeof init.streamId !== 'string' || !STREAM_ID_RE.test(init.streamId)) throw new Error('Invalid streamId');
  const headers: Record<string, string> = {};
  if (init.headers !== undefined) {
    if (!init.headers || typeof init.headers !== 'object') throw new Error('headers must be an object');
    for (const [name, value] of Object.entries(init.headers as Record<string, unknown>)) {
      if (typeof value !== 'string') throw new Error(`Invalid header "${name}"`);
      const lower = name.toLowerCase();
      // As http.fetch: never the user's session, and the host sets the two
      // headers the event stream itself needs.
      if (lower === 'cookie' || lower === 'x-jmap-username' || lower === 'accept' || lower === 'last-event-id') continue;
      headers[name] = value;
    }
    // A name or value fetch() would refuse must fail here, once, instead of
    // looking like a network error the host retries for ever.
    try { new Headers(headers); } catch { throw new Error('Invalid headers'); }
  }
  return { headers, streamId: init.streamId };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** A failed attempt: `final` ones are not tried again. */
class Failed extends Error {
  constructor(message: string, readonly final: boolean, readonly status?: number) {
    super(message);
  }
}

/** One connection: resolves when the server ends it, throws when it fails. */
async function connect(
  url: URL,
  allowed: (url: URL) => boolean,
  headers: Record<string, string>,
  parser: EventStreamParser,
  signal: AbortSignal,
  onOpen: () => void,
  onEvent: (event: ServerEvent) => void,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        ...headers,
        Accept: 'text/event-stream',
        ...(parser.lastEventId ? { 'Last-Event-ID': parser.lastEventId } : {}),
      },
      credentials: 'omit',
      mode: 'cors',
      redirect: 'follow',
      cache: 'no-store',
      signal,
    });
  } catch (err) {
    throw new Failed((err as Error).message || 'Network error', false);
  }
  const drop = () => { void res.body?.cancel().catch(() => {}); };
  // The same second look http.fetch takes: fetch() follows redirects, and
  // the plugin only hears from a last hop that is still allowlisted.
  if (res.url) {
    let finalUrl: URL | null = null;
    try { finalUrl = new URL(res.url); } catch { /* opaque */ }
    if (!finalUrl || !allowed(finalUrl)) {
      drop();
      throw new Failed(`Request was redirected to ${finalUrl?.origin ?? 'an unknown origin'}, which is not in plugin httpOrigins allowlist`, true);
    }
  }
  if (!res.ok || res.status === 204) {
    drop();
    // A busy or restarting server is asked again; any other answer (a
    // refused token, a wrong address) is the plugin's to deal with.
    const again = res.status === 429 || res.status >= 500;
    throw new Failed(`The server answered ${res.status}`, !again, res.status);
  }
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'text/event-stream' || !res.body) {
    drop();
    throw new Failed('The answer is not a text/event-stream', true, res.status);
  }
  onOpen();
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      let events: ServerEvent[];
      try {
        events = parser.feed(decoder.decode(value, { stream: true }));
      } catch (err) {
        void reader.cancel().catch(() => {});
        throw new Failed((err as Error).message, true);
      }
      for (const event of events) onEvent(event);
    }
  } catch (err) {
    if (err instanceof Failed) throw err;
    throw new Failed((err as Error).message || 'The connection broke off', false);
  }
}

async function run(
  streamId: string,
  url: URL,
  allowed: (url: URL) => boolean,
  headers: Record<string, string>,
  entry: Running,
  untrack: () => void,
): Promise<void> {
  const { controller, sink } = entry;
  const gone = () => controller.signal.aborted || sink.closed;
  const send = (event: EventStreamMsg['event']) => {
    if (!gone()) sink.sendEventStream({ type: 'event-stream', streamId, event });
  };
  let lastEventId = '';
  let retry = DEFAULT_RETRY_MS;
  let failures = 0;
  try {
    while (!gone()) {
      // A parser per connection (half an event dies with its connection),
      // the last id carried over for Last-Event-ID.
      const parser = new EventStreamParser(lastEventId);
      let failed: Failed | null = null;
      try {
        await connect(url, allowed, headers, parser, controller.signal,
          () => { failures = 0; send({ kind: 'open' }); },
          (event) => send({ kind: 'event', ...event }));
      } catch (err) {
        failed = err as Failed;
      }
      if (gone()) return;
      lastEventId = parser.lastEventId;
      if (parser.retry !== null) retry = Math.min(Math.max(parser.retry, MIN_RETRY_MS), MAX_RETRY_MS);
      if (failed?.final) {
        send({ kind: 'error', message: failed.message, ...(failed.status ? { status: failed.status } : {}), closed: true });
        return;
      }
      // The server ending the stream is no failure, but the plugin hears of
      // it the same way: nothing arrives until the next "open".
      send({
        kind: 'error',
        message: failed?.message ?? 'The server closed the connection',
        ...(failed?.status ? { status: failed.status } : {}),
        closed: false,
      });
      const delay = Math.min(retry * 2 ** Math.min(failures, 10), MAX_RETRY_MS);
      if (failed) failures++;
      await wait(delay, controller.signal);
    }
  } finally {
    untrack();
  }
}

/**
 * `api.http.eventSource(url, init)`. The caller (host-api.ts) has checked
 * `url` against the plugin's httpOrigins as http.fetch does; `allowed` is
 * that same check, for the address a redirect leads to. Resolves once the
 * subscription is taken; what happens on the connection then reaches the
 * frame as 'event-stream' messages.
 */
export function openEventStream(
  pluginId: string,
  url: URL,
  allowed: (url: URL) => boolean,
  rawInit: unknown,
  sink: EventStreamSink | null,
): void {
  if (!sink) throw new Error('http.eventSource needs a plugin frame');
  const { headers, streamId } = checkInit(rawInit);
  let streams = running.get(pluginId);
  if (!streams) {
    streams = new Map();
    running.set(pluginId, streams);
  }
  if (streams.has(streamId)) throw new Error('Invalid streamId');
  if (streams.size >= MAX_EVENT_STREAMS_PER_PLUGIN) throw new Error(`At most ${MAX_EVENT_STREAMS_PER_PLUGIN} event streams at once`);
  const entry: Running = { controller: new AbortController(), sink };
  streams.set(streamId, entry);
  const untrack = () => end(pluginId, streamId, entry);
  void run(streamId, url, allowed, headers, entry, untrack);
}

/** Abort a subscription and free its place at once, not when its fetch settles. */
function end(pluginId: string, streamId: string, entry: Running): void {
  entry.controller.abort();
  const streams = running.get(pluginId);
  if (streams?.get(streamId) === entry) streams.delete(streamId);
  if (streams?.size === 0) running.delete(pluginId);
}

/** `api.http.eventSource(...).close()`: one already closed is ignored. */
export function closeEventStream(pluginId: string, streamId: unknown): void {
  if (typeof streamId !== 'string') return;
  const entry = running.get(pluginId)?.get(streamId);
  if (entry) end(pluginId, streamId, entry);
}

/** Close what a frame subscribed to (the frame is gone). */
export function closeEventStreamsOf(sink: EventStreamSink): void {
  for (const [pluginId, streams] of [...running]) {
    for (const [streamId, entry] of [...streams]) {
      if (entry.sink === sink) end(pluginId, streamId, entry);
    }
  }
}

/** Close everything a plugin subscribed to (it was turned off). */
export function closePluginEventStreams(pluginId: string): void {
  for (const [streamId, entry] of [...(running.get(pluginId) ?? [])]) end(pluginId, streamId, entry);
}

/** How many subscriptions a plugin holds; for tests. */
export function eventStreamCount(pluginId: string): number {
  return running.get(pluginId)?.size ?? 0;
}
