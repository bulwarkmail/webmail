/**
 * Answers JMAP requests from the mail kept on this device while the server
 * can't be reached (#523), so the app works as usual: the folder list, the
 * message list of a cached folder, opening a cached message, threads.
 *
 * Changes are queued (queue.ts) and applied to the cache at once: keywords
 * (read, flagged, any tag) and folders (move, delete to Trash). Deleting for
 * good, emptying a folder and everything else that would change the server
 * is refused, as are calls the cache can't answer (search, changes since a
 * state): the whole request then fails as it would without offline mode.
 *
 * Answers carry no collection state strings: a made-up one would end up in an
 * Email/changes once the server is back, which refuses it.
 */

import { BLOBS, emailIndex, getBody, getMisc, patchEmails, putMisc, type CachedEmail } from './cache';
import type { OfflineMethodCall, OfflineResponse } from '@/lib/jmap/offline-hooks';

export type MethodResult = Record<string, unknown>;

export interface ResponderContext {
  account: string;
  /** The client's own JMAP account (calls without accountId use it). */
  defaultJmap: string;
  /** Queue changes to messages; resolves once they are kept. */
  queuePatch: (jmap: string, update: Record<string, Record<string, unknown>>) => Promise<void>;
  /** A change offline mode refuses (delete for good); the caller tells the user. */
  onRefused: (what: 'destroy' | 'other') => void;
  /**
   * The folders whose mail is kept here, per JMAP account. A list of any
   * other folder isn't answered (it would look empty while its count says
   * otherwise). Without it, every folder is answered.
   */
  keptFolders?: Record<string, readonly string[]>;
}

/** The folders a filter lists, as far as it names them. */
function filterFolders(filter: Filter | undefined | null, out: string[] = []): string[] {
  if (!filter) return out;
  if (typeof filter.inMailbox === 'string') out.push(filter.inMailbox);
  if (Array.isArray(filter.conditions)) for (const c of filter.conditions as Filter[]) filterFolders(c, out);
  return out;
}

class Unanswerable extends Error {}

/** RFC 8620 §3.7 result references, with the `*` array step. */
function resolvePointer(value: unknown, path: string): unknown {
  const steps = path.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  const walk = (node: unknown, i: number): unknown => {
    if (i === steps.length) return node;
    const step = steps[i];
    if (step === '*') {
      if (!Array.isArray(node)) throw new Unanswerable();
      return node.flatMap((item) => {
        const out = walk(item, i + 1);
        return Array.isArray(out) ? out : [out];
      });
    }
    if (node === null || typeof node !== 'object') throw new Unanswerable();
    return walk((node as Record<string, unknown>)[step], i + 1);
  };
  return walk(value, 0);
}

function resolveArgs(args: Record<string, unknown>, done: Array<[string, MethodResult, string]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!key.startsWith('#')) {
      out[key] = value;
      continue;
    }
    const ref = value as { resultOf?: string; name?: string; path?: string };
    const source = done.find(([name, , id]) => id === ref.resultOf && name === ref.name);
    if (!source || typeof ref.path !== 'string') throw new Unanswerable();
    out[key.slice(1)] = resolvePointer(source[1], ref.path);
  }
  return out;
}

// ---- Email/query filters and sort ----

type Filter = Record<string, unknown>;

function matches(email: CachedEmail, filter: Filter | undefined | null): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  if (typeof filter.operator === 'string') {
    const conditions = Array.isArray(filter.conditions) ? (filter.conditions as Filter[]) : [];
    if (filter.operator === 'AND') return conditions.every((c) => matches(email, c));
    if (filter.operator === 'OR') return conditions.some((c) => matches(email, c));
    if (filter.operator === 'NOT') return !conditions.some((c) => matches(email, c));
    throw new Unanswerable();
  }
  for (const [key, value] of Object.entries(filter)) {
    switch (key) {
      case 'inMailbox':
        if (!email.mailboxIds?.[value as string]) return false;
        break;
      case 'inMailboxOtherThan':
        if (!Object.keys(email.mailboxIds ?? {}).some((id) => !(value as string[]).includes(id))) return false;
        break;
      case 'hasKeyword':
        if (!email.keywords?.[value as string]) return false;
        break;
      case 'notKeyword':
        if (email.keywords?.[value as string]) return false;
        break;
      case 'after':
        if (Date.parse(String(email.receivedAt)) < Date.parse(String(value))) return false;
        break;
      case 'before':
        if (Date.parse(String(email.receivedAt)) >= Date.parse(String(value))) return false;
        break;
      case 'hasAttachment':
        if (Boolean(email.hasAttachment) !== Boolean(value)) return false;
        break;
      default:
        // Text search and the rest need the server.
        throw new Unanswerable();
    }
  }
  return true;
}

interface Comparator { property?: string; isAscending?: boolean; keyword?: string }

function firstAddress(value: unknown): string {
  const first = Array.isArray(value) ? (value[0] as { name?: string; email?: string } | undefined) : undefined;
  return (first?.name || first?.email || '').toLowerCase();
}

function compareBy(sort: Comparator[]): (a: CachedEmail, b: CachedEmail) => number {
  const levels = sort.length > 0 ? sort : [{ property: 'receivedAt', isAscending: false }];
  return (a, b) => {
    for (const level of levels) {
      let diff = 0;
      switch (level.property) {
        case 'receivedAt':
        case 'sentAt':
          diff = (Date.parse(String(a[level.property] ?? a.receivedAt)) || 0) - (Date.parse(String(b[level.property] ?? b.receivedAt)) || 0);
          break;
        case 'size':
          diff = Number(a.size ?? 0) - Number(b.size ?? 0);
          break;
        case 'subject':
          diff = String(a.subject ?? '').localeCompare(String(b.subject ?? ''));
          break;
        case 'from':
          diff = firstAddress(a.from).localeCompare(firstAddress(b.from));
          break;
        case 'to':
          diff = firstAddress(a.to).localeCompare(firstAddress(b.to));
          break;
        case 'hasKeyword':
          diff = Number(Boolean(a.keywords?.[level.keyword ?? ''])) - Number(Boolean(b.keywords?.[level.keyword ?? '']));
          break;
        default:
          diff = 0;
      }
      if (diff !== 0) return level.isAscending === false ? -diff : diff;
    }
    return 0;
  };
}

async function emailsOf(ctx: ResponderContext, jmap: string): Promise<CachedEmail[]> {
  const index = await emailIndex(ctx.account);
  const prefix = `${ctx.account}\u0001${jmap}\u0001`;
  const out: CachedEmail[] = [];
  for (const [key, email] of index) if (key.startsWith(prefix)) out.push(email);
  return out;
}

async function emailQuery(ctx: ResponderContext, args: Record<string, unknown>): Promise<MethodResult> {
  const jmap = (args.accountId as string) || ctx.defaultJmap;
  if (args.anchor !== undefined) throw new Unanswerable();
  if (ctx.keptFolders) {
    const kept = ctx.keptFolders[jmap] ?? [];
    if (filterFolders(args.filter as Filter).some((id) => !kept.includes(id))) throw new Unanswerable();
  }
  let list = (await emailsOf(ctx, jmap)).filter((email) => matches(email, args.filter as Filter));
  list.sort(compareBy((args.sort as Comparator[]) ?? []));
  if (args.collapseThreads) {
    const seen = new Set<string>();
    list = list.filter((email) => {
      const thread = email.threadId ?? email.id;
      if (seen.has(thread)) return false;
      seen.add(thread);
      return true;
    });
  }
  const position = Math.max(0, Number(args.position ?? 0));
  const limit = typeof args.limit === 'number' ? args.limit : list.length;
  return {
    accountId: jmap,
    canCalculateChanges: false,
    position,
    ids: list.slice(position, position + limit).map((email) => email.id),
    total: list.length,
  };
}

function pick(email: Record<string, unknown>, properties: unknown): Record<string, unknown> {
  if (!Array.isArray(properties)) {
    const all = { ...email };
    delete all[BLOBS];
    return all;
  }
  const out: Record<string, unknown> = { id: email.id };
  for (const prop of properties as string[]) if (prop in email) out[prop] = email[prop];
  return out;
}

const NEEDS_BODY = new Set(['bodyValues', 'textBody', 'htmlBody', 'bodyStructure', 'headers', 'attachments']);

async function emailGet(ctx: ResponderContext, args: Record<string, unknown>): Promise<MethodResult> {
  const jmap = (args.accountId as string) || ctx.defaultJmap;
  const index = await emailIndex(ctx.account);
  const ids = Array.isArray(args.ids) ? (args.ids as string[]) : null;
  if (!ids) throw new Unanswerable();
  const properties = args.properties as string[] | undefined;
  const wantsBody = args.fetchTextBodyValues || args.fetchHTMLBodyValues || args.fetchAllBodyValues
    || !properties || properties.some((p) => NEEDS_BODY.has(p));
  const list: Record<string, unknown>[] = [];
  const notFound: string[] = [];
  for (const id of ids) {
    const meta = index.get(`${ctx.account}\u0001${jmap}\u0001${id}`);
    if (!meta) { notFound.push(id); continue; }
    if (!wantsBody) { list.push(pick(meta, properties)); continue; }
    const body = await getBody(ctx.account, jmap, id);
    // Asked for the text and it isn't here: as if the message weren't
    // there, rather than an empty message.
    if (!body && (args.fetchTextBodyValues || args.fetchHTMLBodyValues || args.fetchAllBodyValues || properties?.includes('bodyValues'))) {
      notFound.push(id);
      continue;
    }
    list.push(pick({ ...(body ?? {}), ...meta }, properties));
  }
  return { accountId: jmap, list, notFound };
}

async function threadGet(ctx: ResponderContext, args: Record<string, unknown>): Promise<MethodResult> {
  const jmap = (args.accountId as string) || ctx.defaultJmap;
  const ids = Array.isArray(args.ids) ? (args.ids as string[]) : [];
  const emails = await emailsOf(ctx, jmap);
  const list = [...new Set(ids)].map((id) => ({
    id,
    emailIds: emails
      .filter((email) => email.threadId === id)
      .sort((a, b) => (Date.parse(String(a.receivedAt)) || 0) - (Date.parse(String(b.receivedAt)) || 0))
      .map((email) => email.id),
  }));
  return { accountId: jmap, list: list.filter((t) => t.emailIds.length > 0), notFound: list.filter((t) => t.emailIds.length === 0).map((t) => t.id) };
}

async function listGet(ctx: ResponderContext, args: Record<string, unknown>, name: 'mailboxes' | 'identities'): Promise<MethodResult> {
  const jmap = (args.accountId as string) || ctx.defaultJmap;
  const all = await getMisc<Record<string, Record<string, unknown>[]>>(ctx.account, name);
  const list = all?.[jmap];
  if (!list) throw new Unanswerable();
  const ids = Array.isArray(args.ids) ? new Set(args.ids as string[]) : null;
  const chosen = ids ? list.filter((item) => ids.has(item.id as string)) : list;
  return {
    accountId: jmap,
    list: chosen.map((item) => pick(item, args.properties)),
    notFound: ids ? [...ids].filter((id) => !list.some((item) => item.id === id)) : [],
  };
}

/** Unfiltered mailbox pages used to load a complete folder list offline. */
async function mailboxQuery(ctx: ResponderContext, args: Record<string, unknown>): Promise<MethodResult> {
  if (args.filter || args.sort || args.anchor || args.sortAsTree) throw new Unanswerable();
  const { list } = await listGet(ctx, { accountId: args.accountId }, 'mailboxes');
  const mailboxes = list as Record<string, unknown>[];
  const position = typeof args.position === 'number' ? args.position : 0;
  const limit = typeof args.limit === 'number' ? args.limit : mailboxes.length;
  return {
    accountId: (args.accountId as string) || ctx.defaultJmap,
    // A query token only, never a Mailbox collection state for /changes.
    queryState: JSON.stringify(mailboxes),
    position,
    ids: mailboxes.slice(position, position + limit).map((mailbox) => mailbox.id),
    ...(args.calculateTotal ? { total: mailboxes.length } : {}),
  };
}

/** Whether a PatchObject only changes what offline mode may queue. */
function queueablePatch(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).length > 0 && Object.keys(patch).every((path) =>
    path === 'keywords' || path === 'mailboxIds' || path.startsWith('keywords/') || path.startsWith('mailboxIds/'));
}

async function emailSet(ctx: ResponderContext, args: Record<string, unknown>): Promise<MethodResult> {
  const jmap = (args.accountId as string) || ctx.defaultJmap;
  // A new message (a draft saved while offline) needs the server; the
  // composer says the draft wasn't saved, so no notice here.
  if (args.create && Object.keys(args.create as object).length > 0) throw new Unanswerable();
  if (Array.isArray(args.destroy) && args.destroy.length > 0) { ctx.onRefused('destroy'); throw new Unanswerable(); }
  const update = (args.update ?? {}) as Record<string, Record<string, unknown>>;
  if (!Object.values(update).every(queueablePatch)) { ctx.onRefused('other'); throw new Unanswerable(); }
  // A message moved out of every folder would be gone: that is a delete.
  const index = await emailIndex(ctx.account);
  for (const [id, patch] of Object.entries(update)) {
    if ('mailboxIds' in patch && Object.keys((patch.mailboxIds as object) ?? {}).length === 0) { ctx.onRefused('destroy'); throw new Unanswerable(); }
    const current = index.get(`${ctx.account}\u0001${jmap}\u0001${id}`);
    if (current && Object.keys(patch).some((p) => p.startsWith('mailboxIds/'))) {
      const after = new Set(Object.keys(current.mailboxIds ?? {}));
      for (const [path, value] of Object.entries(patch)) {
        if (!path.startsWith('mailboxIds/')) continue;
        const box = path.slice('mailboxIds/'.length);
        if (value) after.add(box); else after.delete(box);
      }
      if (after.size === 0) { ctx.onRefused('destroy'); throw new Unanswerable(); }
    }
  }
  await ctx.queuePatch(jmap, update);
  const before = new Map(Object.keys(update).map((id) => [id, index.get(`${ctx.account}\u0001${jmap}\u0001${id}`)]));
  await patchEmails(ctx.account, jmap, update);
  await adjustFolderCounts(ctx, jmap, before, index);
  return {
    accountId: jmap,
    updated: Object.fromEntries(Object.keys(update).map((id) => [id, null])),
  };
}

/** The folder counts kept with the folder list follow a change made offline (read state, moves). */
async function adjustFolderCounts(
  ctx: ResponderContext,
  jmap: string,
  before: Map<string, CachedEmail | undefined>,
  index: Map<string, CachedEmail>,
): Promise<void> {
  const delta = new Map<string, { total: number; unread: number }>();
  const bump = (box: string, total: number, unread: number) => {
    const d = delta.get(box) ?? { total: 0, unread: 0 };
    d.total += total;
    d.unread += unread;
    delta.set(box, d);
  };
  for (const [id, old] of before) {
    const now = index.get(`${ctx.account}\u0001${jmap}\u0001${id}`);
    if (!old || !now) continue;
    const wasUnread = !old.keywords?.$seen ? 1 : 0;
    const isUnread = !now.keywords?.$seen ? 1 : 0;
    const oldBoxes = new Set(Object.keys(old.mailboxIds ?? {}));
    const newBoxes = new Set(Object.keys(now.mailboxIds ?? {}));
    for (const box of oldBoxes) if (!newBoxes.has(box)) bump(box, -1, -wasUnread);
    for (const box of newBoxes) {
      if (!oldBoxes.has(box)) bump(box, 1, isUnread);
      else if (wasUnread !== isUnread) bump(box, 0, isUnread - wasUnread);
    }
  }
  if (delta.size === 0) return;
  const all = await getMisc<Record<string, Array<Record<string, unknown>>>>(ctx.account, 'mailboxes');
  const list = all?.[jmap];
  if (!all || !list) return;
  all[jmap] = list.map((box) => {
    const d = delta.get(box.id as string);
    if (!d) return box;
    const count = (key: string, by: number) => (typeof box[key] === 'number' ? Math.max(0, (box[key] as number) + by) : box[key]);
    // Messages only: how the conversations change can't be told from here.
    return { ...box, totalEmails: count('totalEmails', d.total), unreadEmails: count('unreadEmails', d.unread) };
  });
  await putMisc(ctx.account, 'mailboxes', all);
}

/**
 * The answer to a whole request from this device, or null when any call in
 * it needs the server.
 */
export async function answerOffline(ctx: ResponderContext, methodCalls: OfflineMethodCall[]): Promise<OfflineResponse | null> {
  const done: Array<[string, MethodResult, string]> = [];
  try {
    for (const [name, rawArgs, callId] of methodCalls) {
      const args = resolveArgs(rawArgs, done);
      let result: MethodResult;
      switch (name) {
        case 'Email/query': result = await emailQuery(ctx, args); break;
        case 'Email/get': result = await emailGet(ctx, args); break;
        case 'Thread/get': result = await threadGet(ctx, args); break;
        case 'Mailbox/query': result = await mailboxQuery(ctx, args); break;
        case 'Mailbox/get': result = await listGet(ctx, args, 'mailboxes'); break;
        case 'Identity/get': result = await listGet(ctx, args, 'identities'); break;
        case 'Email/set': result = await emailSet(ctx, args); break;
        default: throw new Unanswerable();
      }
      done.push([name, result, callId]);
    }
  } catch (error) {
    if (error instanceof Unanswerable) return null;
    throw error;
  }
  return { methodResponses: done };
}
