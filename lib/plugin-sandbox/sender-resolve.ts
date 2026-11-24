// The sender a plugin shows for a message in place of its From
// (onSenderResolve, #633): a forwarding service that rewrites From keeps the
// original sender in a header, and a plugin can show that one instead. It is
// for display only. Replies, contacts, blocking, the sender check and
// everything else keep reading the message's own From.
//
// The hook is async and the list asks for every row, so answers are kept per
// message, as row badges are. Deliberately free of store imports.

import type { Email } from '../jmap/types';

/** A sender as a plugin may return it. */
export interface ResolvedSender {
  name: string;
  email: string;
}

const MAX_NAME = 200;
/** RFC 5321: a path of at most 256 octets, so an address of at most 254. */
const MAX_ADDRESS = 254;
const CACHE_LIMIT = 2000;

// eslint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const ADDRESS = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+$/;

/**
 * A plugin's answer as the app may show it: a plain name and an address
 * that looks like one, without control or direction characters (they could
 * make one address read as another). Anything else is no answer, and the
 * message's From shows.
 */
export function normalizeSender(value: unknown): ResolvedSender | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.email !== 'string') return null;
  const email = raw.email.replace(CONTROL_CHARS, '').trim();
  if (email.length > MAX_ADDRESS || !ADDRESS.test(email)) return null;
  const name = typeof raw.name === 'string' ? raw.name.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) : '';
  return { name, email };
}

let generation = 0;
const listeners = new Set<() => void>();
const cache = new Map<string, ResolvedSender | null>();
const inflight = new Map<string, Promise<ResolvedSender | null>>();

export function senderGeneration(): number {
  return generation;
}

export function subscribeSenderResolve(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** A plugin's onSenderResolve handler came or went: ask every message again. */
export function senderHandlersChanged(): void {
  generation += 1;
  cache.clear();
  for (const listener of listeners) {
    try { listener(); } catch { /* ignore */ }
  }
}

/** The cache key of a message: its login, account and id (ids repeat across accounts), and its From. */
export function senderCacheKey(email: Email, source: string): string {
  const from = email.from?.[0];
  return `${generation}|${source}|${email.id}|${from?.email ?? ''}|${from?.name ?? ''}`;
}

export function cachedSender(key: string): ResolvedSender | null | undefined {
  return cache.get(key);
}

/** Ask the plugins once per key; `ask` runs the hook. */
export function resolveSender(key: string, ask: () => Promise<unknown>): Promise<ResolvedSender | null> {
  const known = cache.get(key);
  if (known !== undefined) return Promise.resolve(known);
  const pending = inflight.get(key);
  if (pending) return pending;
  const promise = ask()
    .then(normalizeSender, () => null)
    .then((sender) => {
      if (cache.size >= CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, sender);
      return sender;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/** Test helper. */
export function resetSenderResolve(): void {
  generation = 0;
  cache.clear();
  inflight.clear();
}
