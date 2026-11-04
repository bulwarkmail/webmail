/**
 * Files and links that arrive from outside the app, on their way to the part
 * of the app that handles them: a .eml to the viewer, a .ics to the calendar
 * import, a .vcf to the contacts import, shared files and links to a new
 * draft.
 *
 * Three things feed it: the launchQueue consumer
 * (components/protocol/protocol-launch-handler-provider.tsx), the service
 * worker's share target (public/sw.js) and, later, the desktop app's bridge,
 * because launchQueue never fires in Electron. A bridge only has to call
 * handOffFiles, handOffDraft or handOffNewMessage.
 *
 * The pending mailto next to it (lib/protocol-handlers/session.ts) is JSON in
 * sessionStorage, which can't hold a File. So a handoff lives in this module's
 * memory, and everything except a .eml also goes into the Cache API: signing
 * in with SSO, or after a session ended, leaves the page, and the file has to
 * still be there afterwards.
 *
 * What is stored is sealed with a key of its own, and the key stays in this
 * tab's sessionStorage, so a second window can't take it. The worker passes
 * its key in the landing address's fragment. What is stored goes when it is
 * taken, after HANDOFF_TTL_MS, when newer handoffs need the room, at sign-out
 * and when offline mode wipes.
 *
 * Anyone can POST to the share target, or link to a landing address, so what
 * arrives that way is untrusted: the provider asks the user before it gets
 * here (peekStoredHandoff, then adoptStoredHandoff or discardStoredHandoff).
 * Chromium's link capturing can bring a cross-site form POST into an installed
 * app's window, so that goes for app windows too. Only a bridge skips it.
 */

import { stripBidiControls } from '@/lib/bidi';
import { matchSurface } from '@/lib/deep-links';
import { cleanMailtoBody, cleanMailtoSubject } from '@/lib/protocol-handlers/mailto';

export type HandoffKind = 'compose' | 'eml' | 'calendar' | 'contacts';

export interface Handoff {
  id: string;
  kind: HandoffKind;
  files: File[];
  /** New draft only. */
  subject?: string;
  body?: string;
  /** From another program through the desktop app (Send to, Open with): a compose window of its own. */
  fromOs?: boolean;
  createdAt: number;
}

/** The service worker writes this cache too, in the same layout and with the same limits. */
export const HANDOFF_CACHE = 'bulwark-launch-handoff-v1';
export const HANDOFF_TTL_MS = 15 * 60 * 1000;
export const HANDOFF_MAX_ENTRIES = 5;
export const HANDOFF_MAX_BYTES = 100 * 1024 * 1024;
const STORE_PREFIX = '/__bulwark/handoff/';
const TAB_KEYS_KEY = 'bulwark:launch-handoffs';
/** A launch can arrive twice: as launchQueue's target and as the page's own address. */
const NEW_MESSAGE_REPEAT_MS = 2000;

type Listener = (kind: HandoffKind) => void;
export type HandoffLoss = 'expired' | 'missing';

const queue: Handoff[] = [];
const stored = new Map<string, Promise<void>>();
const kindListeners = new Map<HandoffKind, Set<Listener>>();
const anyListeners = new Set<Listener>();
const lossListeners = new Set<(loss: HandoffLoss) => void>();
let lastNewMessageAt = 0;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
/** Bumped by clearHandoffs: a store still under way when it ran takes itself back. */
let clearCount = 0;

function newId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function cacheApi(): CacheStorage | null {
  return typeof caches !== 'undefined' && caches && typeof caches.open === 'function' ? caches : null;
}

function readTabKeys(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(TAB_KEYS_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

function writeTabKeys(keys: Record<string, string>): void {
  try {
    if (Object.keys(keys).length > 0) sessionStorage.setItem(TAB_KEYS_KEY, JSON.stringify(keys));
    else sessionStorage.removeItem(TAB_KEYS_KEY);
  } catch {
    // Hardened or private modes: the handoff stays in memory only.
  }
}

function setTabKey(id: string, key: string | null): void {
  const keys = readTabKeys();
  if (key) keys[id] = key;
  else delete keys[id];
  writeTabKeys(keys);
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** A 12-byte IV, then the AES-GCM ciphertext. */
async function seal(key: CryptoKey, data: BufferSource): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  const sealed = new Uint8Array(new ArrayBuffer(iv.length + body.length));
  sealed.set(iv);
  sealed.set(body, iv.length);
  return sealed;
}

async function unseal(key: CryptoKey, sealed: ArrayBuffer): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(0, 12) }, key, sealed.slice(12));
}

function canSeal(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle;
}

function entryPrefix(id: string): string {
  return `${STORE_PREFIX}${id}/`;
}

function pathOf(key: { url: string }): string {
  return new URL(key.url, 'https://x.invalid').pathname;
}

async function deleteEntry(cache: Cache, prefix: string): Promise<void> {
  const keys = await cache.keys();
  const own = keys.filter((key) => pathOf(key).startsWith(prefix));
  // The list last: the sweep goes by it.
  await Promise.all(own.filter((key) => !pathOf(key).endsWith('/meta')).map((key) => cache.delete(key)));
  await cache.delete(`${prefix}meta`);
}

/**
 * Drops what is too old and, when `incoming` wants in, the oldest entries that
 * are in the way. Returns when the oldest remaining entry was stored.
 */
async function sweep(cache: Cache, incoming: { bytes: number } | null): Promise<number | null> {
  const entries: Array<{ prefix: string; createdAt: number; bytes: number }> = [];
  for (const key of await cache.keys()) {
    const path = pathOf(key);
    if (!path.endsWith('/meta')) continue;
    const response = await cache.match(key);
    const meta = response ? ((await response.json().catch(() => null)) as { createdAt?: unknown; bytes?: unknown } | null) : null;
    entries.push({
      prefix: path.slice(0, -'meta'.length),
      createdAt: typeof meta?.createdAt === 'number' ? meta.createdAt : 0,
      bytes: typeof meta?.bytes === 'number' ? meta.bytes : 0,
    });
  }
  entries.sort((a, b) => a.createdAt - b.createdAt);
  const now = Date.now();
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  while (entries.length > 0) {
    const tooOld = now - entries[0].createdAt > HANDOFF_TTL_MS;
    const inTheWay = incoming !== null
      && (entries.length >= HANDOFF_MAX_ENTRIES || total + incoming.bytes > HANDOFF_MAX_BYTES);
    if (!tooOld && !inTheWay) break;
    const [oldest] = entries.splice(0, 1);
    total -= oldest.bytes;
    await deleteEntry(cache, oldest.prefix);
  }
  return entries[0]?.createdAt ?? null;
}

async function writeStored(handoff: Handoff): Promise<void> {
  const api = cacheApi();
  if (!api || !canSeal()) return;
  const bytes = handoff.files.reduce((sum, file) => sum + file.size, 0);
  if (bytes > HANDOFF_MAX_BYTES) return;
  const prefix = entryPrefix(handoff.id);
  const startedAt = clearCount;
  try {
    const cache = await api.open(HANDOFF_CACHE);
    await sweep(cache, { bytes });
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key));
    // The list first: the sweep goes by it, so no file can stay behind unlisted.
    await cache.put(`${prefix}meta`, new Response(JSON.stringify({ kind: handoff.kind, createdAt: handoff.createdAt, bytes })));
    const contents = JSON.stringify({
      title: handoff.subject ?? '',
      text: handoff.body ?? '',
      url: '',
      files: handoff.files.map((file) => ({ name: file.name, type: file.type })),
    });
    await cache.put(`${prefix}sealed`, new Response(await seal(key, new TextEncoder().encode(contents))));
    for (const [index, file] of handoff.files.entries()) {
      await cache.put(`${prefix}${index}`, new Response(await seal(key, await file.arrayBuffer())));
    }
    if (startedAt !== clearCount) {
      await deleteEntry(cache, prefix);
      return;
    }
    setTabKey(handoff.id, toBase64Url(rawKey));
  } catch {
    // Quota, or no Cache API here: the handoff stays in memory only.
    await deleteStored(handoff.id);
  }
}

async function deleteStored(id: string): Promise<void> {
  setTabKey(id, null);
  const api = cacheApi();
  if (!api) return;
  try {
    if (!(await api.has(HANDOFF_CACHE))) return;
    await deleteEntry(await api.open(HANDOFF_CACHE), entryPrefix(id));
  } catch {
    // The sweep gets it.
  }
}

function notify(kind: HandoffKind): void {
  // The app first, so it can go to the right page while the handoff is still
  // pending, then whoever takes it.
  for (const listener of [...anyListeners]) listener(kind);
  for (const listener of [...(kindListeners.get(kind) ?? [])]) listener(kind);
}

function reportLoss(loss: HandoffLoss): void {
  for (const listener of [...lossListeners]) listener(loss);
}

function dropFromQueue(index: number): Handoff {
  const [handoff] = queue.splice(index, 1);
  void (stored.get(handoff.id) ?? Promise.resolve()).then(() => deleteStored(handoff.id));
  stored.delete(handoff.id);
  return handoff;
}

function armExpiry(oldestStored: number | null): void {
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  expiryTimer = null;
  const times = [...queue.map((handoff) => handoff.createdAt), ...(oldestStored === null ? [] : [oldestStored])];
  if (times.length === 0) return;
  const delay = Math.max(0, Math.min(...times) + HANDOFF_TTL_MS - Date.now()) + 1000;
  expiryTimer = setTimeout(() => { void expireHandoffs(); }, delay);
}

/** What waited too long goes, in memory and stored. Also runs on a timer while this page is open. */
export async function expireHandoffs(): Promise<void> {
  const now = Date.now();
  let lost = false;
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    if (now - queue[index].createdAt <= HANDOFF_TTL_MS) continue;
    dropFromQueue(index);
    lost = true;
  }
  if (lost) reportLoss('expired');
  await sweepStoredHandoffs();
}

async function sweepStoredHandoffs(): Promise<void> {
  let oldest: number | null = null;
  const api = cacheApi();
  try {
    if (api && (await api.has(HANDOFF_CACHE))) oldest = await sweep(await api.open(HANDOFF_CACHE), null);
  } catch {
    // Tried again at the next page load.
  }
  armExpiry(oldest);
}

function enqueue(handoff: Handoff, persist: boolean): void {
  queue.push(handoff);
  armExpiry(null);
  if (persist) stored.set(handoff.id, writeStored(handoff));
  notify(handoff.kind);
}

/** The kind a file from the OS goes to; null when nothing here handles it. */
export function kindForFile(file: { name: string; type?: string }): HandoffKind | null {
  const dot = file.name.lastIndexOf('.');
  const extension = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
  if (extension === '.eml') return 'eml';
  if (extension === '.ics' || extension === '.ical') return 'calendar';
  if (extension === '.vcf' || extension === '.vcard') return 'contacts';
  const type = (file.type ?? '').toLowerCase();
  if (type === 'message/rfc822') return 'eml';
  if (type === 'text/calendar') return 'calendar';
  if (type === 'text/vcard' || type === 'text/x-vcard') return 'contacts';
  return null;
}

/** Hands files to a part of the app, which opens when they arrive. */
export function handOffFiles(files: File[], kind: HandoffKind): void {
  if (files.length === 0) return;
  // A .eml opens at once and needs no sign-in, so it never waits for one.
  enqueue({ id: newId(), kind, files, createdAt: Date.now() }, kind !== 'eml');
}

/** Opens a new draft with this text and these files. Trusted: what came from outside was asked about first. */
export function handOffDraft(draft: { subject?: string; body?: string; files?: File[]; fromOs?: boolean }): void {
  const subject = cleanMailtoSubject(draft.subject ?? '');
  const body = cleanMailtoBody(draft.body ?? '');
  enqueue({
    id: newId(),
    kind: 'compose',
    files: draft.files ?? [],
    ...(draft.fromOs ? { fromOs: true } : {}),
    ...(subject ? { subject } : {}),
    ...(body ? { body } : {}),
    createdAt: Date.now(),
  }, true);
}

/** Opens an empty new message. */
export function handOffNewMessage(): void {
  const now = Date.now();
  if (now - lastNewMessageAt < NEW_MESSAGE_REPEAT_MS) return;
  lastNewMessageAt = now;
  enqueue({ id: newId(), kind: 'compose', files: [], createdAt: now }, false);
}

/**
 * Routes files from a launch by their type. Returns the names nothing handles
 * and how many couldn't be read.
 */
export async function handOffLaunchFiles(
  handles: ReadonlyArray<{ kind?: string; getFile?: () => Promise<File> }>,
): Promise<{ unsupported: string[]; failed: number }> {
  const byKind = new Map<HandoffKind, File[]>();
  const unsupported: string[] = [];
  let failed = 0;
  for (const handle of handles) {
    if (typeof handle.getFile !== 'function') continue;
    try {
      const file = await handle.getFile();
      const kind = kindForFile(file);
      if (!kind) {
        unsupported.push(file.name);
        continue;
      }
      byKind.set(kind, [...(byKind.get(kind) ?? []), file]);
    } catch {
      failed += 1;
    }
  }
  for (const [kind, files] of byKind) handOffFiles(files, kind);
  return { unsupported, failed };
}

/** The oldest handoff of this kind; it is gone from here after this. */
export function takeHandoff(kind: HandoffKind): Handoff | null {
  const now = Date.now();
  let lost = false;
  let found: Handoff | null = null;
  for (let index = 0; index < queue.length && !found; index += 1) {
    if (queue[index].kind !== kind) continue;
    const handoff = dropFromQueue(index);
    index -= 1;
    if (now - handoff.createdAt <= HANDOFF_TTL_MS) found = handoff;
    else lost = true;
  }
  if (lost) reportLoss('expired');
  return found;
}

/** What is waiting, oldest first. Nothing is taken. */
export function pendingHandoffs(): readonly Handoff[] {
  return queue;
}

/** `kind` "any" hears every handoff, before those listening for that kind. */
export function subscribeHandoff(kind: HandoffKind | 'any', listener: Listener): () => void {
  if (kind === 'any') {
    anyListeners.add(listener);
    return () => { anyListeners.delete(listener); };
  }
  const set = kindListeners.get(kind) ?? new Set<Listener>();
  kindListeners.set(kind, set);
  set.add(listener);
  return () => { set.delete(listener); };
}

/** Hears about a handoff that went without arriving, so the user can be told. */
export function subscribeHandoffLost(listener: (loss: HandoffLoss) => void): () => void {
  lossListeners.add(listener);
  return () => { lossListeners.delete(listener); };
}

/** Subject and body of a draft from what the OS shared, under the same rules as a mailto: link. */
export function shareDraft(shared: { title?: string; text?: string; url?: string }): { subject: string; body: string } {
  const text = cleanMailtoBody(shared.text ?? '').trim();
  const url = cleanMailtoSubject(shared.url ?? '').trim();
  // Android often puts the link in the text as well.
  const body = url && !text.includes(url) ? [text, url].filter(Boolean).join('\n\n') : text;
  return { subject: cleanMailtoSubject(shared.title ?? '').trim(), body: cleanMailtoBody(body) };
}

/** A name from outside, as it may be shown and attached. */
function cleanFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return stripBidiControls(name.replace(/[\u0000-\u001F\u007F]/g, '')).slice(0, 255) || 'file';
}

interface StoredContents {
  meta: { kind: HandoffKind; createdAt: number };
  subject: string;
  body: string;
  files: Array<{ name: string; type: string }>;
  key: CryptoKey;
  cache: Cache;
}

async function openStored(id: string, encodedKey: string): Promise<StoredContents | null> {
  const api = cacheApi();
  if (!api || !canSeal() || !encodedKey) return null;
  const prefix = entryPrefix(id);
  try {
    if (!(await api.has(HANDOFF_CACHE))) return null;
    const cache = await api.open(HANDOFF_CACHE);
    const metaResponse = await cache.match(`${prefix}meta`);
    if (!metaResponse) return null;
    const meta = (await metaResponse.json()) as StoredContents['meta'];
    if (Date.now() - meta.createdAt > HANDOFF_TTL_MS) {
      await deleteStored(id);
      return null;
    }
    const sealedResponse = await cache.match(`${prefix}sealed`);
    if (!sealedResponse) return null;
    const key = await crypto.subtle.importKey('raw', fromBase64Url(encodedKey), 'AES-GCM', false, ['decrypt']);
    const contents = JSON.parse(new TextDecoder().decode(await unseal(key, await sealedResponse.arrayBuffer()))) as {
      title?: string; text?: string; url?: string; files?: Array<{ name: string; type?: string }>;
    };
    return {
      meta,
      ...shareDraft(contents),
      files: (contents.files ?? []).map((file) => ({ name: cleanFileName(file.name), type: file.type ?? '' })),
      key,
      cache,
    };
  } catch {
    return null;
  }
}

/** What a stored handoff holds, to ask the user about. Null when it is gone or can't be read. */
export async function peekStoredHandoff(id: string, encodedKey: string): Promise<{ subject: string; body: string; files: string[] } | null> {
  const contents = await openStored(id, encodedKey);
  return contents && { subject: contents.subject, body: contents.body, files: contents.files.map((file) => file.name) };
}

/** The user refused it. */
export function discardStoredHandoff(id: string): Promise<void> {
  return deleteStored(id);
}

/** Brings a stored handoff into this tab. False when it is gone. Without `encodedKey`: this tab's own key. */
export async function adoptStoredHandoff(id: string, encodedKey?: string): Promise<boolean> {
  if (queue.some((handoff) => handoff.id === id)) return true;
  const key = encodedKey ?? readTabKeys()[id] ?? '';
  const contents = await openStored(id, key);
  if (!contents) return false;
  const prefix = entryPrefix(id);
  const files: File[] = [];
  let missing = false;
  for (const [index, entry] of contents.files.entries()) {
    try {
      const response = await contents.cache.match(`${prefix}${index}`);
      if (!response) throw new Error('gone');
      const bytes = await unseal(contents.key, await response.arrayBuffer());
      files.push(new File([bytes], entry.name, { type: entry.type }));
    } catch {
      missing = true;
    }
  }
  // The awaits above: another caller may have got here first.
  if (queue.some((handoff) => handoff.id === id)) return true;
  setTabKey(id, key);
  enqueue({
    id,
    kind: contents.meta.kind,
    files,
    ...(contents.subject ? { subject: contents.subject } : {}),
    ...(contents.body ? { body: contents.body } : {}),
    createdAt: contents.meta.createdAt,
  }, false);
  if (missing) reportLoss('missing');
  return true;
}

/** After a page load: this tab's stored handoffs come back, what is too old goes. */
export async function restoreStoredHandoffs(): Promise<void> {
  let lost = false;
  await Promise.all(Object.keys(readTabKeys()).map(async (id) => {
    if (await adoptStoredHandoff(id)) return;
    setTabKey(id, null);
    lost = true;
  }));
  if (lost) reportLoss('expired');
  await sweepStoredHandoffs();
}

/** Sign-out and offline wipes: nothing that was on its way into an account stays. */
export function clearHandoffs(): void {
  clearCount += 1;
  queue.length = 0;
  stored.clear();
  writeTabKeys({});
  lastNewMessageAt = 0;
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  expiryTimer = null;
  const api = cacheApi();
  if (api) void api.delete(HANDOFF_CACHE).catch(() => {});
}

export type LaunchLanding =
  | { type: 'new-message' }
  /** The service worker stored what was shared. */
  | { type: 'stored'; id: string; key: string }
  /** It couldn't be stored, or no worker ran: the text came along in the address. */
  | { type: 'inline'; subject: string; body: string; filesLost: boolean; cut: boolean };

const LANDING_HASH_PARAMS = ['share', 'key', 'share_title', 'share_text', 'share_url', 'share_files', 'share_cut'];

/** What the page's own address asks for, once. See stripLandingParams. */
export function parseLaunchLanding(search: string, hash: string): LaunchLanding | null {
  if (new URLSearchParams(search).get('compose') === '1') return { type: 'new-message' };
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const share = params.get('share');
  if (!share) return null;
  if (share === 'unavailable') {
    return {
      type: 'inline',
      ...shareDraft({
        title: params.get('share_title') ?? '',
        text: params.get('share_text') ?? '',
        url: params.get('share_url') ?? '',
      }),
      filesLost: params.get('share_files') === '1',
      cut: params.get('share_cut') === '1',
    };
  }
  return /^[\w-]{1,64}$/.test(share) ? { type: 'stored', id: share, key: params.get('key') ?? '' } : null;
}

/** The address without what parseLaunchLanding read, so a reload doesn't do it again. */
export function stripLandingParams(search: string, hash: string): { search: string; hash: string } {
  const query = new URLSearchParams(search);
  query.delete('compose');
  const rest = query.toString();
  let leftHash = hash;
  const fragment = new URLSearchParams(hash.replace(/^#/, ''));
  if (fragment.has('share')) {
    for (const name of LANDING_HASH_PARAMS) fragment.delete(name);
    const left = fragment.toString();
    leftHash = left ? `#${left}` : '';
  }
  return { search: rest ? `?${rest}` : '', hash: leftHash };
}

/**
 * What a launch's address asks of a window that is already open. A shortcut
 * with launch_handler focus-existing only focuses that window and passes the
 * address here. Anything else, the start page included, stays as it is.
 */
export function shortcutFromTargetUrl(targetURL: string, origin: string): 'new-message' | 'calendar' | 'contacts' | null {
  let url: URL;
  try {
    url = new URL(targetURL, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const match = matchSurface(url.pathname);
  if (!match || match.segments.length > 0) return null;
  if (match.surface === 'mail') return url.searchParams.get('compose') === '1' ? 'new-message' : null;
  if (match.surface === 'calendar' || match.surface === 'contacts') return match.surface;
  return null;
}
