/**
 * The mail kept on this device for offline mode (#523), per Bulwark account
 * (`account`, the local account id) and JMAP account (`jmap`).
 *
 * Messages are kept in two parts: what the list shows (emails) and the text
 * and structure of the message (bodies), so a folder list never decrypts
 * the bodies. Attachments and inline images are blobs. Every value is
 * encrypted (crypto.ts); only the ledger (size, date) and the keys (ids) are
 * not.
 *
 * The cache holds at most CACHE_CAP_BYTES on the device, across accounts;
 * the oldest messages go first, with their bodies and attachments. The
 * outbox (queue.ts) doesn't count and never goes.
 */

import { idbDeleteAccount, idbGet, idbGetAll, idbGetAllByAccount, idbWrite, type StoreName } from './db';
import { openBytes, openJson, sealBytes, sealJson, type Sealed } from './crypto';

/** Most bytes the cache keeps on the device (messages, bodies, attachments). */
export const CACHE_CAP_BYTES = 250 * 1024 * 1024;
/** How far back the Inbox (and the folders the user opened) are kept. */
export const CACHE_DAYS = 30;
export const CACHE_WINDOW_MS = CACHE_DAYS * 24 * 60 * 60 * 1000;

/** Where the metadata keeps the blob ids of a message's parts (never handed out). */
export const BLOBS = '_bulwarkBlobs';

/** The parts of a message that only the reader needs. */
const BODY_KEYS = ['bodyValues', 'textBody', 'htmlBody', 'bodyStructure', 'headers', 'attachments'] as const;

export type CachedEmail = Record<string, unknown> & {
  id: string;
  threadId?: string;
  mailboxIds?: Record<string, boolean>;
  keywords?: Record<string, boolean>;
  receivedAt?: string;
};

interface SealedRecord extends Sealed {
  key: string;
  account: string;
}

interface LedgerEntry {
  key: string;
  account: string;
  store: StoreName;
  ref: string;
  /** The message's date (ms), for oldest-first eviction. */
  at: number;
  bytes: number;
  /** The message a body or blob belongs to. */
  emailKey?: string;
}

const join = (...parts: string[]) => parts.join('\u0001');
export const emailKey = (account: string, jmap: string, id: string) => join(account, jmap, id);
const blobKey = (account: string, jmap: string, blobId: string) => join(account, jmap, 'blob', blobId);
const miscKey = (account: string, name: string) => join(account, 'misc', name);
const ledgerKey = (store: StoreName, key: string) => `${store}:${key}`;

const dateOf = (email: { receivedAt?: unknown }) => {
  const at = typeof email.receivedAt === 'string' ? Date.parse(email.receivedAt) : NaN;
  return Number.isFinite(at) ? at : 0;
};

const byteSize = (sealed: Sealed) => sealed.data.byteLength + 64;

// Decrypted message metadata per account, loaded on first use.
const indexes = new Map<string, Promise<Map<string, CachedEmail>>>();

/** The decrypted metadata of every cached message of an account, by emailKey. */
export function emailIndex(account: string): Promise<Map<string, CachedEmail>> {
  let index = indexes.get(account);
  if (!index) {
    index = (async () => {
      const map = new Map<string, CachedEmail>();
      const records = await idbGetAllByAccount<SealedRecord>('emails', account);
      for (const record of records) {
        try {
          map.set(record.key, await openJson<CachedEmail>(record));
        } catch {
          // Sealed with a key that is gone: dropped at the next write.
        }
      }
      return map;
    })();
    index.catch(() => indexes.delete(account));
    indexes.set(account, index);
  }
  return index;
}

/** Forget what is held in memory (after a wipe). */
export function forgetIndexes(account?: string): void {
  if (account) indexes.delete(account);
  else indexes.clear();
}

function splitBody(email: CachedEmail): { meta: CachedEmail; body: Record<string, unknown> | null } {
  const meta: CachedEmail = { ...email };
  let body: Record<string, unknown> | null = null;
  for (const key of BODY_KEYS) {
    if (key in meta) {
      body ??= {};
      body[key] = meta[key];
      delete meta[key];
    }
  }
  // Only a fetch with the text counts as the message's body.
  return { meta, body: body && 'bodyValues' in body ? body : null };
}

/** Keep messages (as the server sent them, any properties) and their bodies when they came with one. */
export async function putEmails(account: string, jmap: string, emails: CachedEmail[]): Promise<void> {
  if (emails.length === 0) return;
  const index = await emailIndex(account);
  const ops: Array<{ store: StoreName; put?: unknown; del?: IDBValidKey }> = [];
  for (const email of emails) {
    if (!email || typeof email.id !== 'string') continue;
    const key = emailKey(account, jmap, email.id);
    const { meta, body } = splitBody(email);
    const merged = { ...(index.get(key) ?? {}), ...meta } as CachedEmail;
    // The attachments and inline images of the message: only these blobs are kept (blobsOf).
    if (body && Array.isArray(body.attachments)) {
      merged[BLOBS] = (body.attachments as Array<{ blobId?: unknown }>).map((a) => a.blobId).filter((id): id is string => typeof id === 'string');
    }
    index.set(key, merged);
    const at = dateOf(merged);
    const sealed = await sealJson(merged);
    ops.push({ store: 'emails', put: { key, account, ...sealed } });
    ops.push({ store: 'ledger', put: { key: ledgerKey('emails', key), account, store: 'emails', ref: key, at, bytes: byteSize(sealed), emailKey: key } satisfies LedgerEntry });
    if (body) {
      const sealedBody = await sealJson(body);
      ops.push({ store: 'bodies', put: { key, account, ...sealedBody } });
      ops.push({ store: 'ledger', put: { key: ledgerKey('bodies', key), account, store: 'bodies', ref: key, at, bytes: byteSize(sealedBody), emailKey: key } satisfies LedgerEntry });
    }
  }
  await idbWrite(ops);
}

/** Apply a change made to messages (keywords, folders), here or on the server. */
export async function patchEmails(account: string, jmap: string, patches: Record<string, Record<string, unknown>>): Promise<void> {
  const index = await emailIndex(account);
  const changed: CachedEmail[] = [];
  for (const [id, patch] of Object.entries(patches)) {
    const current = index.get(emailKey(account, jmap, id));
    if (!current) continue;
    changed.push(applyPatch(current, patch));
  }
  if (changed.length) await putEmails(account, jmap, changed);
}

/** A JMAP PatchObject (RFC 8620 §5.3) applied to a message, for the properties offline mode changes. */
export function applyPatch(email: CachedEmail, patch: Record<string, unknown>): CachedEmail {
  const next: CachedEmail = { ...email, keywords: { ...(email.keywords ?? {}) }, mailboxIds: { ...(email.mailboxIds ?? {}) } };
  for (const [path, value] of Object.entries(patch)) {
    const [prop, ...rest] = path.split('/');
    if (rest.length === 0) {
      (next as Record<string, unknown>)[prop] = value;
      continue;
    }
    if (prop !== 'keywords' && prop !== 'mailboxIds') continue;
    const name = rest.join('/').replace(/~1/g, '/').replace(/~0/g, '~');
    const map = next[prop] as Record<string, boolean>;
    if (value === null || value === false) delete map[name];
    else map[name] = true;
  }
  return next;
}

export async function removeEmails(account: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const index = await emailIndex(account);
  const ops: Array<{ store: StoreName; del: IDBValidKey }> = [];
  const gone = new Set(keys);
  for (const key of keys) {
    index.delete(key);
    ops.push({ store: 'emails', del: key }, { store: 'bodies', del: key });
    ops.push({ store: 'ledger', del: ledgerKey('emails', key) }, { store: 'ledger', del: ledgerKey('bodies', key) });
  }
  // Their attachments go with them.
  for (const entry of await idbGetAllByAccount<LedgerEntry>('ledger', account)) {
    if (entry.store === 'blobs' && entry.emailKey && gone.has(entry.emailKey)) {
      ops.push({ store: 'blobs', del: entry.ref }, { store: 'ledger', del: entry.key });
    }
  }
  await idbWrite(ops);
}

/** The kept message a blob (attachment, inline image) belongs to, with its date. */
export async function messageOfBlob(account: string, jmap: string, blobId: string): Promise<{ key: string; at: number } | null> {
  const index = await emailIndex(account);
  const prefix = `${account}\u0001${jmap}\u0001`;
  for (const [key, email] of index) {
    if (!key.startsWith(prefix)) continue;
    const blobs = email[BLOBS];
    if (Array.isArray(blobs) && blobs.includes(blobId)) return { key, at: dateOf(email) };
  }
  return null;
}

/** A message's body parts, or null when only its list entry is kept. */
export async function getBody(account: string, jmap: string, id: string): Promise<Record<string, unknown> | null> {
  const record = await idbGet<SealedRecord>('bodies', emailKey(account, jmap, id));
  if (!record) return null;
  try {
    return await openJson<Record<string, unknown>>(record);
  } catch {
    return null;
  }
}

export async function hasBody(account: string, jmap: string, id: string): Promise<boolean> {
  return (await idbGet<SealedRecord>('bodies', emailKey(account, jmap, id))) !== undefined;
}

export async function putBlob(account: string, jmap: string, blobId: string, blob: Blob, at: number, ofEmail?: string): Promise<void> {
  const key = blobKey(account, jmap, blobId);
  const sealed = await sealBytes(await blob.arrayBuffer());
  // The media type too says something about the message: sealed as well.
  const meta = await sealJson({ type: blob.type });
  await idbWrite([
    { store: 'blobs', put: { key, account, meta, ...sealed } },
    { store: 'ledger', put: { key: ledgerKey('blobs', key), account, store: 'blobs', ref: key, at, bytes: byteSize(sealed), emailKey: ofEmail } satisfies LedgerEntry },
  ]);
}

export async function getBlob(account: string, jmap: string, blobId: string): Promise<Blob | null> {
  const record = await idbGet<SealedRecord & { meta?: Sealed }>('blobs', blobKey(account, jmap, blobId));
  if (!record) return null;
  try {
    const meta = record.meta ? await openJson<{ type?: string }>(record.meta) : {};
    return new Blob([await openBytes(record)], { type: meta.type || 'application/octet-stream' });
  } catch {
    return null;
  }
}

export async function hasBlob(account: string, jmap: string, blobId: string): Promise<boolean> {
  return (await idbGet<SealedRecord>('blobs', blobKey(account, jmap, blobId))) !== undefined;
}

/** Small named values of an account (session, folders, identities, opened folders). */
export async function putMisc(account: string, name: string, value: unknown): Promise<void> {
  const key = miscKey(account, name);
  await idbWrite([{ store: 'misc', put: { key, account, ...(await sealJson(value)) } }]);
}

export async function getMisc<T>(account: string, name: string): Promise<T | null> {
  const record = await idbGet<SealedRecord>('misc', miscKey(account, name));
  if (!record) return null;
  try {
    return await openJson<T>(record);
  } catch {
    return null;
  }
}

/** Bytes the cache uses on this device, and per account. */
export async function cacheUsage(): Promise<{ total: number; byAccount: Record<string, number> }> {
  const entries = await idbGetAll<LedgerEntry>('ledger');
  const byAccount: Record<string, number> = {};
  let total = 0;
  for (const entry of entries) {
    total += entry.bytes;
    byAccount[entry.account] = (byAccount[entry.account] ?? 0) + entry.bytes;
  }
  return { total, byAccount };
}

/**
 * Keeps the cache under `cap`: the oldest messages go first, each with its
 * body and attachments. Returns the bytes freed.
 */
export async function enforceCap(cap: number = CACHE_CAP_BYTES): Promise<number> {
  const entries = await idbGetAll<LedgerEntry>('ledger');
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (total <= cap) return 0;
  // Group by message: a message and everything that belongs to it go together.
  const groups = new Map<string, { at: number; bytes: number; account: string; entries: LedgerEntry[] }>();
  for (const entry of entries) {
    const id = entry.emailKey ?? entry.key;
    const group = groups.get(id) ?? { at: entry.at, bytes: 0, account: entry.account, entries: [] };
    group.at = Math.max(group.at, entry.at);
    group.bytes += entry.bytes;
    group.entries.push(entry);
    groups.set(id, group);
  }
  const oldestFirst = [...groups.values()].sort((a, b) => a.at - b.at);
  let freed = 0;
  const ops: Array<{ store: StoreName; del: IDBValidKey }> = [];
  for (const group of oldestFirst) {
    if (total <= cap) break;
    for (const entry of group.entries) {
      ops.push({ store: entry.store, del: entry.ref }, { store: 'ledger', del: entry.key });
      if (entry.store === 'emails') (await indexes.get(entry.account))?.delete(entry.ref);
    }
    total -= group.bytes;
    freed += group.bytes;
  }
  await idbWrite(ops);
  return freed;
}

/** Everything cached for one account (not its outbox). */
export async function wipeAccountCache(account: string): Promise<void> {
  forgetIndexes(account);
  await idbDeleteAccount(account, ['emails', 'bodies', 'blobs', 'misc', 'ledger']);
}
