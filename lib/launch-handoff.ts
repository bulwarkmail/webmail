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
 * still be there afterwards. sessionStorage only holds which stored handoffs
 * belong to this tab, so a second window doesn't take them. What is stored
 * goes when it is taken, when it is too old, or at sign-out.
 */

import { matchSurface } from '@/lib/deep-links';

export type HandoffKind = 'compose' | 'eml' | 'calendar' | 'contacts';

export interface Handoff {
  id: string;
  kind: HandoffKind;
  files: File[];
  /** New draft only. */
  subject?: string;
  body?: string;
  createdAt: number;
}

/** The service worker writes this cache too, in the same layout. */
export const HANDOFF_CACHE = 'bulwark-launch-handoff-v1';
const STORE_PREFIX = '/__bulwark/handoff/';
const TAB_IDS_KEY = 'bulwark:launch-handoffs';
export const HANDOFF_TTL_MS = 15 * 60 * 1000;
/** A launch can arrive twice: as launchQueue's target and as the page's own address. */
const NEW_MESSAGE_REPEAT_MS = 2000;

type Listener = (kind: HandoffKind) => void;

const queue: Handoff[] = [];
const stored = new Map<string, Promise<void>>();
const kindListeners = new Map<HandoffKind, Set<Listener>>();
const anyListeners = new Set<Listener>();
let lastNewMessageAt = 0;

function newId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function cacheApi(): CacheStorage | null {
  return typeof caches !== 'undefined' && caches && typeof caches.open === 'function' ? caches : null;
}

function readTabIds(): string[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(TAB_IDS_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeTabIds(ids: string[]): void {
  try {
    if (ids.length > 0) sessionStorage.setItem(TAB_IDS_KEY, JSON.stringify(ids));
    else sessionStorage.removeItem(TAB_IDS_KEY);
  } catch {
    // Hardened or private modes: the handoff stays in memory only.
  }
}

async function writeStored(handoff: Handoff): Promise<void> {
  const api = cacheApi();
  if (!api) return;
  const prefix = STORE_PREFIX + handoff.id + '/';
  try {
    const cache = await api.open(HANDOFF_CACHE);
    // The list first: the sweep goes by it, so no file can stay behind unlisted.
    await cache.put(prefix + 'meta', new Response(JSON.stringify({
      kind: handoff.kind,
      createdAt: handoff.createdAt,
      title: handoff.subject ?? '',
      text: handoff.body ?? '',
      url: '',
      files: handoff.files.map((file) => ({ name: file.name, type: file.type })),
    })));
    await Promise.all(handoff.files.map((file, index) => cache.put(prefix + index, new Response(file))));
    writeTabIds([...readTabIds().filter((id) => id !== handoff.id), handoff.id]);
  } catch {
    // Quota, or no Cache API here: the handoff stays in memory only.
    await deleteStored(handoff.id);
  }
}

async function deleteStored(id: string): Promise<void> {
  writeTabIds(readTabIds().filter((other) => other !== id));
  const api = cacheApi();
  if (!api) return;
  try {
    if (!(await api.has(HANDOFF_CACHE))) return;
    const cache = await api.open(HANDOFF_CACHE);
    const prefix = STORE_PREFIX + id + '/';
    const keys = await cache.keys();
    const own = keys.filter((key) => new URL(key.url, 'https://x.invalid').pathname.startsWith(prefix));
    // The list last, for the sweep.
    await Promise.all(own.filter((key) => !key.url.endsWith('/meta')).map((key) => cache.delete(key)));
    await cache.delete(prefix + 'meta');
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

function enqueue(handoff: Handoff, persist: boolean): void {
  queue.push(handoff);
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

/** Opens a new draft with this text and these files. */
export function handOffDraft(draft: { subject?: string; body?: string; files?: File[] }): void {
  enqueue({
    id: newId(),
    kind: 'compose',
    files: draft.files ?? [],
    ...(draft.subject ? { subject: draft.subject } : {}),
    ...(draft.body ? { body: draft.body } : {}),
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
  for (let index = 0; index < queue.length; index += 1) {
    if (queue[index].kind !== kind) continue;
    const [handoff] = queue.splice(index, 1);
    index -= 1;
    void (stored.get(handoff.id) ?? Promise.resolve()).then(() => deleteStored(handoff.id));
    stored.delete(handoff.id);
    if (now - handoff.createdAt <= HANDOFF_TTL_MS) return handoff;
  }
  return null;
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

/** Subject and body of a draft from what the OS shared. */
export function shareDraft(shared: { title?: string; text?: string; url?: string }): { subject: string; body: string } {
  const text = (shared.text ?? '').trim();
  const url = (shared.url ?? '').trim();
  // Android often puts the link in the text as well.
  const body = url && !text.includes(url) ? [text, url].filter(Boolean).join('\n\n') : text;
  return { subject: (shared.title ?? '').trim(), body };
}

/** Brings a stored handoff into this tab. False when it is gone. */
export async function adoptStoredHandoff(id: string): Promise<boolean> {
  if (queue.some((handoff) => handoff.id === id)) return true;
  const api = cacheApi();
  if (!api) return false;
  const prefix = STORE_PREFIX + id + '/';
  try {
    if (!(await api.has(HANDOFF_CACHE))) return false;
    const cache = await api.open(HANDOFF_CACHE);
    const metaResponse = await cache.match(prefix + 'meta');
    if (!metaResponse) return false;
    const meta = (await metaResponse.json()) as {
      kind: HandoffKind; createdAt: number; title?: string; text?: string; url?: string;
      files?: Array<{ name: string; type?: string }>;
    };
    if (Date.now() - meta.createdAt > HANDOFF_TTL_MS) {
      await deleteStored(id);
      return false;
    }
    const files: File[] = [];
    for (const [index, entry] of (meta.files ?? []).entries()) {
      const response = await cache.match(prefix + index);
      if (!response) continue;
      files.push(new File([await response.blob()], entry.name, { type: entry.type ?? '' }));
    }
    const { subject, body } = shareDraft(meta);
    // A second await above: another caller may have got here first.
    if (queue.some((handoff) => handoff.id === id)) return true;
    if (!readTabIds().includes(id)) writeTabIds([...readTabIds(), id]);
    enqueue({
      id,
      kind: meta.kind,
      files,
      ...(subject ? { subject } : {}),
      ...(body ? { body } : {}),
      createdAt: meta.createdAt,
    }, false);
    return true;
  } catch {
    return false;
  }
}

/** After a page load: this tab's stored handoffs come back, what is too old goes. */
export async function restoreStoredHandoffs(): Promise<void> {
  await Promise.all(readTabIds().map(async (id) => {
    if (!(await adoptStoredHandoff(id))) writeTabIds(readTabIds().filter((other) => other !== id));
  }));
  const api = cacheApi();
  if (!api) return;
  try {
    if (!(await api.has(HANDOFF_CACHE))) return;
    const cache = await api.open(HANDOFF_CACHE);
    for (const key of await cache.keys()) {
      const match = /\/__bulwark\/handoff\/([^/]+)\/meta$/.exec(key.url);
      if (!match) continue;
      const response = await cache.match(key);
      const meta = response ? ((await response.json()) as { createdAt?: number }) : null;
      if (!meta || typeof meta.createdAt !== 'number' || Date.now() - meta.createdAt > HANDOFF_TTL_MS) {
        await deleteStored(match[1]);
      }
    }
  } catch {
    // Tried again at the next page load.
  }
}

/** Sign-out: nothing that was on its way into an account stays. */
export function clearHandoffs(): void {
  queue.length = 0;
  stored.clear();
  writeTabIds([]);
  lastNewMessageAt = 0;
  const api = cacheApi();
  if (api) void api.delete(HANDOFF_CACHE).catch(() => {});
}

export type LaunchLanding =
  | { type: 'new-message' }
  /** The service worker stored what was shared. */
  | { type: 'stored'; id: string }
  /** It couldn't be stored, or no worker ran: the text came along in the address. */
  | { type: 'inline'; subject: string; body: string; filesLost: boolean };

const LANDING_PARAMS = ['compose', 'share', 'share_title', 'share_text', 'share_url', 'share_files'];

/** What the page's own address asks for, once. See stripLandingParams. */
export function parseLaunchLanding(search: string): LaunchLanding | null {
  const params = new URLSearchParams(search);
  if (params.get('compose') === '1') return { type: 'new-message' };
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
    };
  }
  return /^[\w-]{1,64}$/.test(share) ? { type: 'stored', id: share } : null;
}

/** The query without what parseLaunchLanding read, so a reload doesn't do it again. */
export function stripLandingParams(search: string): string {
  const params = new URLSearchParams(search);
  for (const name of LANDING_PARAMS) params.delete(name);
  const rest = params.toString();
  return rest ? `?${rest}` : '';
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
