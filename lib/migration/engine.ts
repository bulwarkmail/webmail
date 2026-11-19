import { createHash } from 'node:crypto';
import { parseVCard } from '@/lib/vcard';
import { contactToWire } from '@/lib/jmap/contact-wire';
import { dropDuplicateUids, prepareImportedEvent } from '@/lib/calendar/import-event';
import type { CalendarEvent } from '@/lib/jmap/types';
import { FolderPlanner } from './folder-roles';
import { keywordsFromFlags } from './keywords';
import {
  MAX_PROBLEMS,
  PHASES,
  SourceError,
  TargetAuthError,
  TargetRateLimitError,
  type AccountReport,
  type AccountStatus,
  type CopyMap,
  type CopyWhat,
  type DavCopyEntry,
  type DavSource,
  type EmailImportItem,
  type MailSource,
  type MessageMeta,
  type MigrationTarget,
  type Phase,
  type Problem,
  type ReportKind,
  type SieveSource,
  type SourceFolder,
  type TargetCollection,
} from './types';

/**
 * Copies one account: Mail, Contacts, Calendars, Filters in that order. A
 * pass is safe to run again at any point: the copy map says what earlier
 * passes (or the part of this pass before a restart) copied, so a resumed or
 * repeated pass copies only what is new.
 *
 * - Mail: per folder the UIDVALIDITY and the highest UID copied. A batch of
 *   up to 20 is marked in flight before Email/import and cleared after, so
 *   a pass cut off in between checks those Message-IDs on the target instead
 *   of importing them twice. A folder whose UIDVALIDITY changed is read
 *   again from the start and skips what an earlier pass copied into it, by
 *   hashes of Message-ID (INTERNALDATE where there is none).
 * - Contacts and calendars: per resource href its ETag and the target id.
 *   Objects are also matched by UID on the target, which covers a pass cut
 *   off between the write and the map.
 * - Filters: per script name a content hash.
 *
 * On HTTP 429 (or any Retry-After) from Stalwart the account pauses until
 * then and continues by itself, as lib/mail-import/engine.ts does. Network
 * errors to the source are retried 3 times with a backoff before the account
 * fails. Cancel stops after the current batch.
 */

export const MAIL_BATCH = 20;
const DAV_BATCH = 50;
const EVENT_BATCH = 20;
/** Backoff before each retry of a source that dropped. */
export const SOURCE_RETRY_DELAYS_MS = [5_000, 30_000, 120_000];
/** Stalwart counts uploads in hourly windows; without a Retry-After, wait for the next one. */
const UPLOAD_WINDOW_MS = 60 * 60 * 1000;
/** While paused, look for a cancel this often. */
const PAUSE_CHECK_MS = 5_000;

export const NOTES = {
  noSieve: 'Filters not copied: the source has no ManageSieve. Kopano keeps its rules in its own store; recreate them by hand.',
  davNeedsPassword: "Calendars and contacts need the user's password",
  noCardDav: 'Contacts not copied: the source has no CardDAV address.',
  noCalDav: 'Calendars not copied: the source has no CalDAV address.',
  taskList: 'Task lists are not copied',
  inactive: 'Imported inactive: the target already has an active filter script',
  tooLarge: 'Larger than the target server accepts',
} as const;

export interface AccountProgress {
  messagesDone: number;
  messagesTotal: number;
}

/** What the engine keeps per account (inside the account document). */
export interface AccountState {
  status: AccountStatus;
  /** The phase a running or paused pass is in. */
  phase?: Phase;
  pausedUntil?: number;
  progress: AccountProgress;
  copyMap: CopyMap;
  /** The batch between Email/import and its checkpoint. */
  inflight?: { folder: string; mailboxId: string; messageIds: string[] };
  report: AccountReport;
  /** Why the account failed. Never holds a password or message content. */
  error?: string;
  /** `target-auth`: Stalwart refused the job's credential (a self-service app password that expired). */
  errorCode?: 'target-auth';
  passStartedAt?: number;
  passFinishedAt?: number;
  passes: number;
}

export function emptyReport(): AccountReport {
  const counts = () => ({ copied: 0, skipped: 0, failed: 0 });
  return {
    counts: { messages: counts(), folders: counts(), contacts: counts(), events: counts(), scripts: counts() },
    problems: [],
    problemCount: 0,
  };
}

export function newAccountState(): AccountState {
  return { status: 'queued', progress: { messagesDone: 0, messagesTotal: 0 }, copyMap: { folders: {}, scripts: {} }, report: emptyReport(), passes: 0 };
}

/** Where the engine keeps what doesn't fit the account document. */
export interface EngineStore {
  /** Write the account state (keeping what others changed, such as a cancel request). */
  save(state: AccountState): Promise<void>;
  isCancelled(): Promise<boolean>;
  loadHashes(folder: string): Promise<Set<string>>;
  appendHashes(folder: string, hashes: string[]): Promise<void>;
  loadDav(kind: 'contacts' | 'calendars'): Promise<Record<string, DavCopyEntry>>;
  saveDav(kind: 'contacts' | 'calendars', map: Record<string, DavCopyEntry>): Promise<void>;
}

/**
 * How to reach the sources. A phase whose opener is absent is skipped with
 * the reason in `skipReasons`. Openers are called again to reconnect after
 * a network error.
 */
export interface AccountSources {
  mail?: () => Promise<MailSource>;
  contacts?: () => Promise<DavSource>;
  calendars?: () => Promise<DavSource>;
  sieve?: () => Promise<SieveSource>;
  skipReasons?: Partial<Record<Phase, string>>;
}

export interface EngineClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const realClock: EngineClock = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  }),
};

export interface PassContext {
  what: CopyWhat;
  sources: AccountSources;
  target: () => Promise<MigrationTarget>;
  state: AccountState;
  store: EngineStore;
  /** Aborted when the job stops (leader change, shutdown): the pass stops after its batch and resumes later. */
  signal: AbortSignal;
  clock?: EngineClock;
}

/** The job stopped this pass; it continues from the stored state later. */
export class PassStoppedError extends Error {
  constructor() {
    super('The migration job stopped');
    this.name = 'PassStoppedError';
  }
}

class CancelledError extends Error {}

class AccountFailedError extends Error {
  constructor(message: string, readonly phase: Phase, readonly code?: 'target-auth') {
    super(message);
  }
}

/** The key that identifies a message across UIDVALIDITY changes, hashed: no raw Message-IDs stored. */
export function messageKeyHash(meta: Pick<MessageMeta, 'messageId' | 'internalDate'>): string {
  const key = meta.messageId ? `m:${meta.messageId}` : `d:${meta.internalDate.toISOString()}`;
  return createHash('sha256').update(key).digest('base64url').slice(0, 16);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A short, safe text for an error: its message, which our clients keep free of secrets and content. */
function reasonOf(error: unknown): string {
  if (error instanceof TargetAuthError) return 'The target server refused the credential';
  if (error instanceof SourceError) {
    switch (error.kind) {
      case 'auth': return 'The old server refused the login';
      case 'blocked': return "This server can't be reached from here. Only servers on the public internet are allowed.";
      default: return error.message;
    }
  }
  return error instanceof Error ? error.message.slice(0, 300) : 'Unknown error';
}

function lastSegment(href: string): string {
  const parts = href.split('/').filter(Boolean);
  try {
    return decodeURIComponent(parts[parts.length - 1] ?? href);
  } catch {
    return parts[parts.length - 1] ?? href;
  }
}

/** A stable UID for a card that has none, so a repeated pass finds it again. */
function uidForHref(href: string): string {
  const h = sha256(href);
  return `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

class AccountPass {
  private readonly clock: EngineClock;
  private target!: MigrationTarget;
  private readonly state: AccountState;

  constructor(private readonly ctx: PassContext) {
    this.clock = ctx.clock ?? realClock;
    this.state = ctx.state;
  }

  private count(kind: ReportKind, field: 'copied' | 'skipped' | 'failed', n = 1): void {
    this.state.report.counts[kind][field] += n;
  }

  private problem(problem: Problem): void {
    const report = this.state.report;
    const same = report.problems.some((p) => p.phase === problem.phase && p.item === problem.item && p.reason === problem.reason);
    if (same) return;
    if (!problem.note) report.problemCount++;
    if (report.problems.length < MAX_PROBLEMS) report.problems.push(problem);
  }

  private async save(): Promise<void> {
    await this.ctx.store.save(this.state);
  }

  /** Between batches: stop for a job stop or a cancel. */
  private async checkpoint(): Promise<void> {
    if (this.ctx.signal.aborted) throw new PassStoppedError();
    if (await this.ctx.store.isCancelled()) throw new CancelledError();
  }

  /** Calls the target, pausing on the server's limit and continuing after it. */
  private async withTarget<T>(phase: Phase, fn: () => Promise<T>): Promise<T> {
    for (;;) {
      try {
        return await fn();
      } catch (error) {
        if (error instanceof TargetAuthError) throw new AccountFailedError(reasonOf(error), phase, 'target-auth');
        if (!(error instanceof TargetRateLimitError)) throw error;
        const now = this.clock.now();
        const until = error.retryAfterMs !== null
          ? now + error.retryAfterMs
          : (Math.floor(now / UPLOAD_WINDOW_MS) + 1) * UPLOAD_WINDOW_MS + 5_000;
        await this.pauseUntil(until, phase);
      }
    }
  }

  private async pauseUntil(until: number, phase: Phase): Promise<void> {
    this.state.status = 'paused';
    this.state.pausedUntil = until;
    await this.save();
    while (this.clock.now() < until) {
      await this.checkpoint();
      await this.clock.sleep(Math.min(PAUSE_CHECK_MS, until - this.clock.now()), this.ctx.signal);
    }
    await this.checkpoint();
    this.state.status = phase;
    delete this.state.pausedUntil;
    await this.save();
  }

  /**
   * Calls a source, reconnecting and retrying 3 times with a backoff when
   * the network fails. Anything else, or the fourth failure, fails the account.
   */
  private async withSource<S, T>(phase: Phase, holder: { source: S | null; open: () => Promise<S>; close?: (s: S) => Promise<void> }, fn: (source: S) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        holder.source ??= await holder.open();
        return await fn(holder.source);
      } catch (error) {
        const retryable = error instanceof SourceError && error.kind === 'network';
        if (!retryable || attempt >= SOURCE_RETRY_DELAYS_MS.length) {
          throw new AccountFailedError(reasonOf(error), phase);
        }
        if (holder.source && holder.close) await holder.close(holder.source).catch(() => {});
        holder.source = null;
        await this.clock.sleep(SOURCE_RETRY_DELAYS_MS[attempt], this.ctx.signal);
        await this.checkpoint();
      }
    }
  }

  async run(): Promise<void> {
    const state = this.state;
    const resuming = state.status !== 'queued' && state.phase !== undefined;
    if (!resuming) {
      state.passes++;
      state.passStartedAt = this.clock.now();
      state.progress = { messagesDone: 0, messagesTotal: 0 };
      delete state.error;
      delete state.errorCode;
      delete state.passFinishedAt;
    }
    const startAt = resuming ? PHASES.indexOf(state.phase!) : 0;
    try {
      this.target = await this.withTarget(PHASES[startAt], () => this.ctx.target());
      for (const phase of PHASES.slice(startAt)) {
        await this.checkpoint();
        state.phase = phase;
        state.status = phase;
        delete state.pausedUntil;
        await this.save();
        await this.runPhase(phase);
      }
      state.status = state.report.problemCount > 0 ? 'done_with_problems' : 'done';
    } catch (error) {
      if (error instanceof PassStoppedError) throw error;
      if (error instanceof CancelledError) {
        state.status = 'cancelled';
      } else {
        const phase = error instanceof AccountFailedError ? error.phase : state.phase ?? 'mail';
        state.status = 'failed';
        state.error = error instanceof AccountFailedError ? error.message : reasonOf(error);
        if (error instanceof AccountFailedError && error.code) state.errorCode = error.code;
        this.problem({ phase, reason: state.error });
      }
    }
    delete state.phase;
    delete state.pausedUntil;
    delete state.inflight;
    state.passFinishedAt = this.clock.now();
    await this.save();
  }

  private async runPhase(phase: Phase): Promise<void> {
    const { what, sources } = this.ctx;
    if (!what[phase]) return;
    const skip = sources.skipReasons?.[phase];
    switch (phase) {
      case 'mail':
        if (sources.mail) await this.copyMail(sources.mail);
        else if (skip) this.problem({ phase, reason: skip, note: skip !== NOTES.davNeedsPassword });
        return;
      case 'contacts':
        if (sources.contacts) await this.copyContacts(sources.contacts);
        else if (skip) this.problem({ phase, reason: skip, note: skip !== NOTES.davNeedsPassword });
        return;
      case 'calendars':
        if (sources.calendars) await this.copyCalendars(sources.calendars);
        else if (skip) this.problem({ phase, reason: skip, note: skip !== NOTES.davNeedsPassword });
        return;
      case 'filters':
        if (sources.sieve) await this.copyFilters(sources.sieve);
        else this.problem({ phase, reason: skip ?? NOTES.noSieve, note: true });
        return;
    }
  }

  // ─── Mail ────────────────────────────────────────────────────────────────

  private async copyMail(open: () => Promise<MailSource>): Promise<void> {
    const holder = { source: null as MailSource | null, open, close: (s: MailSource) => s.close() };
    try {
      await this.copyMailFrom(holder);
    } finally {
      if (holder.source) await holder.source.close().catch(() => {});
    }
  }

  private async copyMailFrom(holder: { source: MailSource | null; open: () => Promise<MailSource>; close: (s: MailSource) => Promise<void> }): Promise<void> {
    const state = this.state;
    const map = state.copyMap.folders;
    const folders = await this.withSource('mail', holder, (s) => s.listFolders());
    const selectable = folders.filter((f) => !f.noselect);

    // Totals before copying: STATUS for folders not copied before, the UIDs
    // above the last one copied for the others.
    const plans: { folder: SourceFolder; uids: number[] | null; uidValidity?: string }[] = [];
    let remaining = 0;
    for (const folder of selectable) {
      const known = map[folder.path];
      if (!known) {
        const status = await this.withSource('mail', holder, (s) => s.status(folder.path));
        remaining += status.messages;
        plans.push({ folder, uids: null });
      } else {
        const listed = await this.withSource('mail', holder, (s) => s.listUids(folder.path, 1));
        const from = listed.uidValidity === known.uidValidity ? known.lastUid + 1 : 1;
        const uids = listed.uids.filter((uid) => uid >= from);
        remaining += uids.length;
        plans.push({ folder, uids, uidValidity: listed.uidValidity });
      }
    }
    state.progress.messagesTotal = state.progress.messagesDone + remaining;
    await this.save();

    const mailboxes = await this.withTarget('mail', () => this.target.listMailboxes());
    const planner = new FolderPlanner(folders, mailboxes, {
      createMailbox: (name, parentId) => this.withTarget('mail', () => this.target.createMailbox(name, parentId)),
    });
    const createdBefore = planner.createdCount;
    const maxSize = this.target.maxSizeUpload();

    for (const plan of plans) {
      await this.checkpoint();
      let mailboxId: string;
      try {
        mailboxId = await planner.resolve(plan.folder);
      } catch (error) {
        if (error instanceof AccountFailedError) throw error;
        this.count('folders', 'failed');
        this.problem({ phase: 'mail', item: plan.folder.path, reason: reasonOf(error) });
        continue;
      }
      await this.copyFolder(holder, plan, mailboxId, maxSize);
    }
    this.count('folders', 'copied', planner.createdCount - createdBefore);
  }

  private async copyFolder(
    holder: { source: MailSource | null; open: () => Promise<MailSource>; close: (s: MailSource) => Promise<void> },
    plan: { folder: SourceFolder; uids: number[] | null; uidValidity?: string },
    mailboxId: string,
    maxSize: number,
  ): Promise<void> {
    const path = plan.folder.path;
    const map = this.state.copyMap.folders;
    let uids = plan.uids;
    let uidValidity = plan.uidValidity;
    if (!uids) {
      const listed = await this.withSource('mail', holder, (s) => s.listUids(path, 1));
      uids = listed.uids;
      uidValidity = listed.uidValidity;
    }
    const known = map[path];
    // A changed UIDVALIDITY: the UIDs mean nothing any more. Read the whole
    // folder again and skip what was copied into it before.
    let copiedBefore: Set<string> | null = null;
    if (known && known.uidValidity !== uidValidity) {
      copiedBefore = await this.ctx.store.loadHashes(path);
      known.lastUid = 0;
    }
    const folderState = map[path] = { ...(known ?? { lastUid: 0 }), uidValidity: uidValidity!, targetMailboxId: mailboxId };

    // A batch cut off between Email/import and its checkpoint: don't import twice what arrived.
    let alreadyThere = new Set<string>();
    const inflight = this.state.inflight;
    if (inflight && inflight.folder === path && inflight.messageIds.length > 0) {
      alreadyThere = await this.withTarget('mail', () => this.target.findMessageIds(inflight.mailboxId, inflight.messageIds));
    }

    for (let i = 0; i < uids.length; i += MAIL_BATCH) {
      await this.checkpoint();
      const batch = uids.slice(i, i + MAIL_BATCH);
      const metas = await this.withSource('mail', holder, (s) => s.fetchMeta(path, batch));
      const items: (EmailImportItem & { meta: MessageMeta })[] = [];
      const hashes: string[] = [];
      for (const meta of metas) {
        const hash = messageKeyHash(meta);
        if (copiedBefore?.has(hash)) continue;
        if (meta.messageId && alreadyThere.has(meta.messageId)) {
          hashes.push(hash);
          this.count('messages', 'copied');
          continue;
        }
        if (meta.size > maxSize) {
          this.count('messages', 'skipped');
          this.problem({ phase: 'mail', item: `${path} UID ${meta.uid}`, reason: `${NOTES.tooLarge} (${Math.ceil(meta.size / 1_000_000)} MB)` });
          continue;
        }
        let blobId: string;
        try {
          const source = await this.withSource('mail', holder, (s) => s.fetchSource(path, meta.uid));
          blobId = await this.withTarget('mail', () => this.target.uploadBlob(source, 'message/rfc822'));
        } catch (error) {
          if (error instanceof AccountFailedError || error instanceof PassStoppedError || error instanceof CancelledError) throw error;
          this.count('messages', 'failed');
          this.problem({ phase: 'mail', item: `${path} UID ${meta.uid}`, reason: reasonOf(error) });
          continue;
        }
        items.push({ blobId, mailboxId, keywords: keywordsFromFlags(meta.flags), receivedAt: meta.internalDate.toISOString(), meta });
      }
      if (items.length > 0) {
        this.state.inflight = { folder: path, mailboxId, messageIds: items.flatMap((item) => (item.meta.messageId ? [item.meta.messageId] : [])) };
        await this.save();
        const results = await this.withTarget('mail', () => this.target.importEmails(items.map(({ meta: _meta, ...item }) => item)));
        results.forEach((result, index) => {
          const { meta } = items[index];
          if ('id' in result) {
            this.count('messages', 'copied');
            hashes.push(messageKeyHash(meta));
          } else {
            this.count('messages', 'failed');
            this.problem({ phase: 'mail', item: `${path} UID ${meta.uid}`, reason: result.error });
          }
        });
      }
      if (hashes.length > 0) await this.ctx.store.appendHashes(path, hashes);
      folderState.lastUid = Math.max(folderState.lastUid, ...batch);
      this.state.progress.messagesDone += batch.length;
      delete this.state.inflight;
      alreadyThere = new Set();
      await this.save();
    }
  }

  // ─── Contacts and calendars ──────────────────────────────────────────────

  private async copyContacts(open: () => Promise<DavSource>): Promise<void> {
    const holder = { source: null as DavSource | null, open };
    const map = await this.ctx.store.loadDav('contacts');
    const books = await this.withSource('contacts', holder, (s) => s.listCollections());
    const targetBooks = await this.withTarget('contacts', () => this.target.listAddressBooks());
    for (const book of books) {
      await this.checkpoint();
      const bookId = await this.targetCollection('contacts', book.name, !!book.isDefault, targetBooks, (name) => this.target.createAddressBook(name));
      if (!bookId) continue;
      const refs = await this.withSource('contacts', holder, (s) => s.listObjects(book.href));
      const todo = refs.filter((ref) => map[ref.href]?.etag !== ref.etag);
      for (let i = 0; i < todo.length; i += DAV_BATCH) {
        await this.checkpoint();
        const chunk = todo.slice(i, i + DAV_BATCH);
        const objects = await this.withSource('contacts', holder, (s) => s.fetchObjects(book.href, chunk.map((ref) => ref.href)));
        const parsed = objects.flatMap((object) => {
          const card = parseVCard(object.data)[0];
          if (!card) {
            this.count('contacts', 'failed');
            this.problem({ phase: 'contacts', item: `${book.name}: ${lastSegment(object.href)}`, reason: 'Not a readable vCard' });
            return [];
          }
          const { id: _id, ...data } = card;
          const uid = data.uid || uidForHref(object.href);
          return [{ object, uid, card: { ...contactToWire(data, 'create'), uid, addressBookIds: { [bookId]: true } } }];
        });
        if (parsed.length === 0) continue;
        const existing = await this.withTarget('contacts', () => this.target.findContactsByUid(parsed.map((p) => p.uid)));
        const results = await this.withTarget('contacts', () => this.target.saveContacts(parsed.map((p) => ({
          id: map[p.object.href]?.targetId || existing.get(p.uid),
          card: p.card,
        }))));
        results.forEach((result, index) => {
          const { object } = parsed[index];
          if ('id' in result) {
            this.count('contacts', 'copied');
            map[object.href] = { etag: object.etag, targetId: result.id };
          } else {
            this.count('contacts', 'failed');
            this.problem({ phase: 'contacts', item: `${book.name}: ${lastSegment(object.href)}`, reason: result.error });
          }
        });
        await this.ctx.store.saveDav('contacts', map);
      }
    }
  }

  /** The target address book or calendar for a source one: the default for the default, else by name, else a new one. */
  private async targetCollection(
    phase: 'contacts' | 'calendars',
    name: string,
    isDefault: boolean,
    existing: TargetCollection[],
    create: (name: string) => Promise<string>,
  ): Promise<string | null> {
    const match = (isDefault ? existing.find((c) => c.isDefault) : undefined) ?? existing.find((c) => c.name === name);
    if (match) return match.id;
    try {
      const id = await this.withTarget(phase, () => create(name));
      existing.push({ id, name });
      this.count('folders', 'copied');
      return id;
    } catch (error) {
      if (error instanceof AccountFailedError || error instanceof PassStoppedError) throw error;
      this.count('folders', 'failed');
      this.problem({ phase, item: name, reason: reasonOf(error) });
      return null;
    }
  }

  private async copyCalendars(open: () => Promise<DavSource>): Promise<void> {
    const holder = { source: null as DavSource | null, open };
    const map = await this.ctx.store.loadDav('calendars');
    const calendars = await this.withSource('calendars', holder, (s) => s.listCollections());
    const targetCalendars = await this.withTarget('calendars', () => this.target.listCalendars());
    for (const calendar of calendars) {
      await this.checkpoint();
      const components = calendar.components ?? [];
      if (components.length > 0 && !components.includes('VEVENT')) {
        this.problem({ phase: 'calendars', item: calendar.name, reason: NOTES.taskList, note: true });
        continue;
      }
      const calendarId = await this.targetCollection('calendars', calendar.name, false, targetCalendars,
        (name) => this.target.createCalendar(name, calendar.color));
      if (!calendarId) continue;
      const refs = await this.withSource('calendars', holder, (s) => s.listObjects(calendar.href));
      const todo = refs.filter((ref) => map[ref.href]?.etag !== ref.etag);
      for (let i = 0; i < todo.length; i += EVENT_BATCH) {
        await this.checkpoint();
        const chunk = todo.slice(i, i + EVENT_BATCH);
        const objects = await this.withSource('calendars', holder, (s) => s.fetchObjects(calendar.href, chunk.map((ref) => ref.href)));
        const prepared: { href: string; etag: string; first: boolean; event: Partial<CalendarEvent> }[] = [];
        for (const object of objects) {
          const item = `${calendar.name}: ${lastSegment(object.href)}`;
          let events: Partial<CalendarEvent>[];
          try {
            const blobId = await this.withTarget('calendars', () => this.target.uploadBlob(object.data, 'text/calendar', 'calendars'));
            events = dropDuplicateUids(await this.withTarget('calendars', () => this.target.parseEvents(blobId)) as Partial<CalendarEvent>[]);
          } catch (error) {
            if (error instanceof AccountFailedError || error instanceof PassStoppedError) throw error;
            this.count('events', 'failed');
            this.problem({ phase: 'calendars', item, reason: reasonOf(error) });
            continue;
          }
          if (events.length === 0) {
            // A task or journal entry in an event calendar.
            this.count('events', 'skipped');
            map[object.href] = { etag: object.etag, targetId: '' };
            continue;
          }
          events.forEach((event, index) => prepared.push({ href: object.href, etag: object.etag, first: index === 0, event: prepareImportedEvent(event, calendarId) }));
        }
        if (prepared.length > 0) {
          const uids = prepared.flatMap((p) => (p.event.uid ? [p.event.uid] : []));
          const existing = await this.withTarget('calendars', () => this.target.findEventsByUid(uids));
          const results = await this.withTarget('calendars', () => this.target.saveEvents(prepared.map((p) => ({
            id: (p.event.uid && existing.get(p.event.uid)) || (p.first ? map[p.href]?.targetId || undefined : undefined),
            event: p.event as Record<string, unknown>,
          }))));
          results.forEach((result, index) => {
            const p = prepared[index];
            if ('id' in result) {
              this.count('events', 'copied');
              if (p.first) map[p.href] = { etag: p.etag, targetId: result.id };
            } else {
              this.count('events', 'failed');
              this.problem({ phase: 'calendars', item: `${calendar.name}: ${lastSegment(p.href)}`, reason: result.error });
            }
          });
        }
        await this.ctx.store.saveDav('calendars', map);
      }
    }
  }

  // ─── Filters ─────────────────────────────────────────────────────────────

  private async copyFilters(open: () => Promise<SieveSource>): Promise<void> {
    const holder = { source: null as SieveSource | null, open, close: (s: SieveSource) => s.close() };
    try {
      const scripts = await this.withSource('filters', holder, (s) => s.listScripts());
      const onTarget = await this.withTarget('filters', () => this.target.listSieveScripts());
      let targetHasActive = onTarget.some((s) => s.isActive);
      const map = this.state.copyMap.scripts;
      for (const script of scripts) {
        await this.checkpoint();
        const content = await this.withSource('filters', holder, (s) => s.getScript(script.name));
        const hash = sha256(content);
        const before = map[script.name];
        if (before?.hash === hash) continue;
        const ours = before && onTarget.find((s) => s.id === before.targetId);
        let name = script.name;
        if (!ours) {
          for (let n = 1; onTarget.some((s) => s.name === name); n++) {
            name = n === 1 ? `${script.name} (migrated)` : `${script.name} (migrated ${n})`;
          }
        }
        const activate = script.active && (!targetHasActive || !!ours?.isActive);
        try {
          const blobId = await this.withTarget('filters', () => this.target.uploadBlob(content, 'application/sieve', 'sieve'));
          const result = await this.withTarget('filters', () => this.target.saveSieveScript({ id: ours?.id, name: ours?.name ?? name, blobId, activate }));
          if ('error' in result) {
            this.count('scripts', 'failed');
            this.problem({ phase: 'filters', item: script.name, reason: result.error });
            continue;
          }
          this.count('scripts', 'copied');
          map[script.name] = { hash, targetId: result.id };
          if (!ours) onTarget.push({ id: result.id, name, isActive: activate });
          if (activate) targetHasActive = true;
          else if (script.active) this.problem({ phase: 'filters', item: script.name, reason: NOTES.inactive, note: true });
          await this.save();
        } catch (error) {
          if (error instanceof AccountFailedError || error instanceof PassStoppedError || error instanceof CancelledError) throw error;
          this.count('scripts', 'failed');
          this.problem({ phase: 'filters', item: script.name, reason: reasonOf(error) });
        }
      }
    } finally {
      if (holder.source) await holder.source.close().catch(() => {});
    }
  }
}

/**
 * Run (or resume) one pass for one account. Ends with the account done,
 * done with problems, failed or cancelled; throws PassStoppedError when the
 * job stopped, leaving the state to resume from.
 */
export async function runAccountPass(ctx: PassContext): Promise<void> {
  await new AccountPass(ctx).run();
}
