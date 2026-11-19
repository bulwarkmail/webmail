import type { AccountState, EngineStore } from '../engine';
import {
  SourceError,
  TargetRateLimitError,
  type DavCollection,
  type DavCopyEntry,
  type DavObject,
  type DavSource,
  type EmailImportItem,
  type FolderStatus,
  type MailSource,
  type MessageMeta,
  type MigrationTarget,
  type SetOutcome,
  type SieveScriptRef,
  type SieveSource,
  type SourceFolder,
  type TargetCollection,
  type TargetMailbox,
  type TargetScript,
} from '../types';

/** In-memory stand-ins for the IMAP, DAV and ManageSieve sources and the Stalwart account. */

export interface FakeMessage {
  uid: number;
  flags?: string[];
  internalDate?: Date;
  size?: number;
  messageId?: string;
  body?: string;
}

export interface FakeFolder extends Omit<SourceFolder, 'path'> {
  uidValidity: string;
  messages: FakeMessage[];
}

export class FakeMailSource implements MailSource {
  /** Throw a network error on the next this-many calls. */
  failNext = 0;
  closed = 0;
  calls: string[] = [];

  constructor(public folders: Record<string, FakeFolder>) {}

  private maybeFail(what: string): void {
    this.calls.push(what);
    if (this.failNext > 0) {
      this.failNext--;
      throw new SourceError('Connection reset', 'network');
    }
  }

  async listFolders(): Promise<SourceFolder[]> {
    this.maybeFail('list');
    return Object.entries(this.folders).map(([path, f]) => ({ path, delimiter: f.delimiter, specialUse: f.specialUse, noselect: f.noselect }));
  }

  async status(path: string): Promise<FolderStatus> {
    this.maybeFail('status');
    const f = this.folders[path];
    return { messages: f.messages.length, uidValidity: f.uidValidity };
  }

  async listUids(path: string, fromUid: number) {
    this.maybeFail('uids');
    const f = this.folders[path];
    return { uidValidity: f.uidValidity, uids: f.messages.map((m) => m.uid).filter((u) => u >= fromUid).sort((a, b) => a - b) };
  }

  async fetchMeta(path: string, uids: number[]): Promise<MessageMeta[]> {
    this.maybeFail('meta');
    return this.folders[path].messages.filter((m) => uids.includes(m.uid)).map((m) => ({
      uid: m.uid,
      flags: m.flags ?? [],
      internalDate: m.internalDate ?? new Date(Date.UTC(2020, 0, 1, 0, 0, m.uid)),
      size: m.size ?? 100,
      ...(m.messageId ? { messageId: m.messageId } : {}),
    }));
  }

  async fetchSource(path: string, uid: number): Promise<Uint8Array> {
    this.maybeFail('source');
    const m = this.folders[path].messages.find((x) => x.uid === uid)!;
    return new TextEncoder().encode(m.body ?? `Message-ID: <${m.messageId ?? `uid${uid}`}>\r\n\r\nbody ${uid}`);
  }

  async close(): Promise<void> {
    this.closed++;
  }
}

export class FakeDavSource implements DavSource {
  failNext = 0;
  constructor(public collections: (DavCollection & { objects: DavObject[] })[]) {}

  async listCollections(): Promise<DavCollection[]> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new SourceError('down', 'network');
    }
    return this.collections.map(({ objects: _objects, ...c }) => c);
  }

  async listObjects(href: string) {
    return this.collections.find((c) => c.href === href)!.objects.map(({ href: h, etag }) => ({ href: h, etag }));
  }

  async fetchObjects(href: string, hrefs: string[]) {
    return this.collections.find((c) => c.href === href)!.objects.filter((o) => hrefs.includes(o.href));
  }
}

export class FakeSieveSource implements SieveSource {
  constructor(public scripts: (SieveScriptRef & { content: string })[]) {}
  async listScripts() {
    return this.scripts.map(({ name, active }) => ({ name, active }));
  }
  async getScript(name: string) {
    return this.scripts.find((s) => s.name === name)!.content;
  }
  async close() {}
}

export interface StoredEmail extends EmailImportItem {
  content: string;
}

export class FakeTarget implements MigrationTarget {
  mailboxes: TargetMailbox[] = [
    { id: 'mb-inbox', name: 'Inbox', parentId: null, role: 'inbox' },
    { id: 'mb-sent', name: 'Sent', parentId: null, role: 'sent' },
    { id: 'mb-drafts', name: 'Drafts', parentId: null, role: 'drafts' },
    { id: 'mb-trash', name: 'Trash', parentId: null, role: 'trash' },
    { id: 'mb-junk', name: 'Junk', parentId: null, role: 'junk' },
  ];
  blobs = new Map<string, string>();
  emails: StoredEmail[] = [];
  addressBooks: TargetCollection[] = [{ id: 'ab-default', name: 'Personal', isDefault: true }];
  contacts = new Map<string, Record<string, unknown>>();
  calendars: TargetCollection[] = [{ id: 'cal-default', name: 'Calendar', isDefault: true }];
  events = new Map<string, Record<string, unknown>>();
  eventSets: { create: number; update: number; extra: Record<string, unknown> }[] = [];
  scripts: (TargetScript & { content: string })[] = [];
  refusedScripts = new Map<string, string>();
  /** Answer 429 to this many uploads, with this Retry-After. */
  rateLimitUploads = 0;
  rateLimitRetryMs: number | null = 60_000;
  maxUpload = 10_000;
  /** Called after each Email/import (tests stop the job there). */
  onImport?: () => void | Promise<void>;
  /** Parse calendar data into events (the fake CalendarEvent/parse). */
  parse: (ics: string) => Record<string, unknown>[] = (ics) => {
    const uid = /UID:(.*)/.exec(ics)?.[1]?.trim();
    const title = /SUMMARY:(.*)/.exec(ics)?.[1]?.trim();
    return /BEGIN:VEVENT/.test(ics) ? [{ uid, title, start: '2026-01-01T10:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin' }] : [];
  };
  private next = 1;

  maxSizeUpload() { return this.maxUpload; }

  async listMailboxes() { return this.mailboxes.map((m) => ({ ...m })); }

  async createMailbox(name: string, parentId: string | null) {
    const id = `mb-${this.next++}`;
    this.mailboxes.push({ id, name, parentId, role: null });
    return id;
  }

  async uploadBlob(data: Uint8Array | string) {
    if (this.rateLimitUploads > 0) {
      this.rateLimitUploads--;
      throw new TargetRateLimitError(this.rateLimitRetryMs);
    }
    const id = `blob-${this.next++}`;
    this.blobs.set(id, typeof data === 'string' ? data : new TextDecoder().decode(data));
    return id;
  }

  async importEmails(items: EmailImportItem[]): Promise<SetOutcome[]> {
    const out = items.map((item) => {
      this.emails.push({ ...item, content: this.blobs.get(item.blobId)! });
      return { id: `email-${this.next++}` };
    });
    await this.onImport?.();
    return out;
  }

  async findMessageIds(mailboxId: string, messageIds: string[]) {
    const found = new Set<string>();
    for (const e of this.emails) {
      const id = /Message-ID: <([^>]+)>/.exec(e.content)?.[1];
      if (id && e.mailboxId === mailboxId && messageIds.includes(id)) found.add(id);
    }
    return found;
  }

  async listAddressBooks() { return this.addressBooks.map((b) => ({ ...b })); }
  async createAddressBook(name: string) {
    const id = `ab-${this.next++}`;
    this.addressBooks.push({ id, name });
    return id;
  }

  async findContactsByUid(uids: string[]) {
    const out = new Map<string, string>();
    for (const [id, card] of this.contacts) if (uids.includes(card.uid as string)) out.set(card.uid as string, id);
    return out;
  }

  async saveContacts(cards: { id?: string; card: Record<string, unknown> }[]): Promise<SetOutcome[]> {
    return cards.map(({ id, card }) => {
      const key = id ?? `card-${this.next++}`;
      this.contacts.set(key, { ...(id ? this.contacts.get(id) : {}), ...card });
      return { id: key };
    });
  }

  async listCalendars() { return this.calendars.map((c) => ({ ...c })); }
  async createCalendar(name: string, color?: string) {
    const id = `cal-${this.next++}`;
    this.calendars.push({ id, name, ...(color ? { color } : {}) } as TargetCollection);
    return id;
  }

  async parseEvents(blobId: string) { return this.parse(this.blobs.get(blobId)!); }

  async findEventsByUid(uids: string[]) {
    const out = new Map<string, string>();
    for (const [id, e] of this.events) if (uids.includes(e.uid as string)) out.set(e.uid as string, id);
    return out;
  }

  async saveEvents(events: { id?: string; event: Record<string, unknown> }[]): Promise<SetOutcome[]> {
    this.eventSets.push({ create: events.filter((e) => !e.id).length, update: events.filter((e) => e.id).length, extra: { sendSchedulingMessages: false } });
    return events.map(({ id, event }) => {
      const key = id ?? `ev-${this.next++}`;
      this.events.set(key, { ...event });
      return { id: key };
    });
  }

  async listSieveScripts() { return this.scripts.map(({ id, name, isActive }) => ({ id, name, isActive })); }

  async saveSieveScript(script: { id?: string; name: string; blobId: string; activate: boolean }): Promise<SetOutcome> {
    const refused = this.refusedScripts.get(script.name);
    if (refused) return { error: refused };
    const content = this.blobs.get(script.blobId)!;
    if (script.activate) for (const s of this.scripts) s.isActive = false;
    if (script.id) {
      const s = this.scripts.find((x) => x.id === script.id)!;
      s.content = content;
      if (script.activate) s.isActive = true;
      return { id: s.id };
    }
    const id = `script-${this.next++}`;
    this.scripts.push({ id, name: script.name, isActive: script.activate, content });
    return { id };
  }
}

/** The engine's store in memory, with a cancel switch. */
export class MemoryEngineStore implements EngineStore {
  saved: AccountState[] = [];
  cancelled = false;
  /** A dead process writes nothing more. */
  frozen = false;
  hashes = new Map<string, string[]>();
  dav: Record<string, Record<string, DavCopyEntry>> = {};
  async save(state: AccountState) { if (!this.frozen) this.saved.push(structuredClone(state)); }
  async isCancelled() { return this.cancelled; }
  async loadHashes(folder: string) { return new Set(this.hashes.get(folder) ?? []); }
  async appendHashes(folder: string, hashes: string[]) { if (this.frozen) return; this.hashes.set(folder, [...(this.hashes.get(folder) ?? []), ...hashes]); }
  async loadDav(kind: 'contacts' | 'calendars') { return structuredClone(this.dav[kind] ?? {}); }
  async saveDav(kind: 'contacts' | 'calendars', map: Record<string, DavCopyEntry>) { this.dav[kind] = structuredClone(map); }
}

/** A clock whose sleep moves time on at once. */
export function fakeClock(start = Date.UTC(2026, 10, 19, 12)) {
  const clock = {
    time: start,
    sleeps: [] as number[],
    now: () => clock.time,
    sleep: async (ms: number) => {
      clock.sleeps.push(ms);
      clock.time += ms;
    },
  };
  return clock;
}
