import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Mailbox, MailboxRights } from '@/lib/jmap/types';
import { jmapError } from '@/lib/jmap/jmap-error';

/**
 * A group account as the team notes store sees it: folders, notes stored as
 * the Email/set create objects the store sends, an Email/changes journal and
 * keyword patches on the messages. One instance per test.
 */

export const GROUP = 'g';
const ALL_RIGHTS: MailboxRights = {
  mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true,
  mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true,
} as MailboxRights;
const READ_ONLY = { ...ALL_RIGHTS, mayAddItems: false, mayRemoveItems: false, maySetSeen: false, maySetKeywords: false, mayCreateChild: false, mayRename: false, mayDelete: false, maySubmit: false } as MailboxRights;

interface StoredNote {
  id: string;
  receivedAt: string;
  create: Record<string, unknown>;
}

export class FakeTeamServer {
  folders: Array<{ id: string; name: string; role?: string; rights: MailboxRights; shareWith?: Record<string, MailboxRights> | null }> = [
    { id: 'inbox', name: 'Inbox', role: 'inbox', rights: ALL_RIGHTS, shareWith: { reader: { mayReadItems: true } as MailboxRights } },
  ];
  notes = new Map<string, StoredNote>();
  keywordPatches: Array<{ ids: string[]; patch: Record<string, boolean | null> }> = [];
  failNextCreate: string | null = null;
  readOnly = false;
  private journal: Array<{ kind: 'created' | 'updated' | 'destroyed'; id: string }> = [];
  private nextId = 1;
  calls: string[] = [];

  constructor(public login = 'tm-alice@example.org') {}

  get state(): string {
    return `s${this.journal.length}`;
  }

  /** A note another member wrote (through their own client). */
  addNote(create: Record<string, unknown>, receivedAt = new Date().toISOString()): string {
    const id = `n${this.nextId++}`;
    this.notes.set(id, { id, receivedAt, create });
    this.journal.push({ kind: 'created', id });
    return id;
  }

  removeNote(id: string): void {
    this.notes.delete(id);
    this.journal.push({ kind: 'destroyed', id });
  }

  /** Something else changed in the account (a real message). */
  touchMail(id: string): void {
    this.journal.push({ kind: 'created', id });
  }

  addNotesFolder(id = 'notes', rights: MailboxRights = ALL_RIGHTS): void {
    this.folders.push({ id, name: 'Team notes', rights });
  }

  setReadOnly(): void {
    this.readOnly = true;
    for (const f of this.folders) f.rights = READ_ONLY;
  }

  private asEmail(note: StoredNote, properties: readonly string[], text: boolean): Record<string, unknown> {
    const c = note.create;
    const full: Record<string, unknown> = {
      id: note.id,
      receivedAt: (c.receivedAt as string) ?? note.receivedAt,
      from: c.from,
      keywords: c.keywords,
      mailboxIds: c.mailboxIds,
      messageId: c.messageId,
      subject: c.subject,
    };
    for (const p of properties) if (p.startsWith('header:')) full[p] = c[p] ?? null;
    const out: Record<string, unknown> = {};
    for (const p of properties) out[p] = full[p] ?? null;
    if (text) {
      out.textBody = [{ partId: '1' }];
      out.bodyValues = { '1': { value: ((c.bodyValues as Record<string, { value: string }>)['1']).value } };
    }
    return out;
  }

  private matches(note: StoredNote, filter: Record<string, unknown>): boolean {
    if (filter.operator === 'AND') return (filter.conditions as Record<string, unknown>[]).every((f) => this.matches(note, f));
    if (filter.operator === 'OR') return (filter.conditions as Record<string, unknown>[]).some((f) => this.matches(note, f));
    const c = note.create;
    const at = Date.parse((c.receivedAt as string) ?? note.receivedAt);
    if (filter.inMailbox) return Boolean((c.mailboxIds as Record<string, boolean>)[filter.inMailbox as string]);
    if (filter.after) return at >= Date.parse(filter.after as string);
    if (filter.before) return at < Date.parse(filter.before as string);
    if (typeof filter.subject === 'string') {
      const words = filter.subject.toLowerCase().split(/\s+/).filter(Boolean);
      const subject = String(c.subject ?? '').toLowerCase();
      return words.every((w) => subject.includes(w));
    }
    throw new Error(`fake: unknown filter ${JSON.stringify(filter)}`);
  }

  client(): IJMAPClient {
    // The client object's methods are arrow functions over this server.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const server = this;
    const mailbox = (f: FakeTeamServer['folders'][number]): Mailbox => ({
      id: `${GROUP}:${f.id}`, originalId: f.id, name: f.name, role: f.role, myRights: f.rights,
      accountId: GROUP, isShared: true, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true,
    } as unknown as Mailbox);
    return {
      getUsername: () => server.login,
      getAccountId: () => 'me',
      getAccountInfo: (id: string) => (id === GROUP ? { name: 'tm-team@example.org', isPersonal: false, isReadOnly: server.readOnly, accountCapabilities: {} } : null),
      getIdentities: async () => [{ id: 'i1', name: 'Alice Archer', email: server.login }],
      getMailboxes: async (_acc?: string, options?: { includeHidden?: boolean }) => server.folders
        .filter((f) => options?.includeHidden || f.name !== 'Team notes')
        .map(mailbox),
      getMailboxShareWith: async (id: string) => server.folders.find((f) => f.id === id)?.shareWith ?? null,
      createTeamNotesFolder: async (_acc: string, name: string, shareWith: Record<string, MailboxRights> | null) => {
        server.calls.push('createTeamNotesFolder');
        if (server.readOnly) throw jmapError('no', { type: 'forbidden' });
        server.folders.push({ id: 'notes', name, rights: ALL_RIGHTS, shareWith });
        return 'notes';
      },
      queryTeamNotes: async (_acc: string, filter: Record<string, unknown>, options: { limit: number; position?: number; properties: readonly string[] }) => {
        server.calls.push('queryTeamNotes');
        const all = [...server.notes.values()]
          .filter((n) => server.matches(n, filter))
          .sort((a, b) => Date.parse((b.create.receivedAt as string) ?? b.receivedAt) - Date.parse((a.create.receivedAt as string) ?? a.receivedAt));
        const page = all.slice(options.position ?? 0, (options.position ?? 0) + options.limit);
        return { ids: page.map((n) => n.id), list: page.map((n) => server.asEmail(n, options.properties, false)), total: all.length, state: server.state };
      },
      getTeamNotes: async (_acc: string, ids: readonly string[], properties: readonly string[], options?: { text?: boolean }) => {
        server.calls.push(options?.text ? 'getTeamNotes:text' : 'getTeamNotes');
        const list = ids.flatMap((id) => {
          const note = server.notes.get(id);
          if (note) return [server.asEmail(note, properties, !!options?.text)];
          // A real message: no note headers, not in the notes folder.
          return id.startsWith('mail') ? [{ id, keywords: {}, mailboxIds: { inbox: true } }] : [];
        });
        return { list, state: server.state, notFound: [] };
      },
      createTeamNote: async (_acc: string, email: Record<string, unknown>) => {
        server.calls.push('createTeamNote');
        if (server.failNextCreate) {
          const type = server.failNextCreate;
          server.failNextCreate = null;
          throw jmapError('refused', { type });
        }
        const folder = Object.keys(email.mailboxIds as Record<string, boolean>)[0];
        if (!server.folders.find((f) => f.id === folder)?.rights.mayAddItems) throw jmapError('no', { type: 'forbidden' });
        return { id: server.addNote(email) };
      },
      destroyTeamNote: async (_acc: string, id: string) => {
        server.calls.push('destroyTeamNote');
        server.removeNote(id);
      },
      getEmailChanges: async (since: string) => {
        const from = Number(since.slice(1));
        const entries = server.journal.slice(from);
        const pick = (kind: string) => entries.filter((e) => e.kind === kind).map((e) => e.id);
        return { oldState: since, newState: server.state, hasMoreChanges: false, created: pick('created'), updated: pick('updated'), destroyed: pick('destroyed'), updatedProperties: null };
      },
      batchUpdateKeywords: async (ids: string[], patch: Record<string, boolean | null>) => {
        server.keywordPatches.push({ ids, patch });
      },
    } as unknown as IJMAPClient;
  }
}
