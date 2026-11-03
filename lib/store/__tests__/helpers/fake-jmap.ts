/**
 * A small JMAP server for engine tests, modelled on how Stalwart really
 * behaves (local-data/desktop-offline-facts-parts/stalwart-changes-prf.md):
 * a 5000 cap on /changes pages, fixed log ranges, the three kinds of state
 * refusal, 500 ids per Email/get, 16 calls per request, `ids: null` giving the
 * first 500.
 */

import { TransportError, type JmapResponse, type JmapTransport, type MethodCall, type MethodResponse, type StoreSession } from '../../engine/transport';

export type FakeEmail = Record<string, unknown> & { id: string };

export const JMAP_ACCOUNT = 'acc1';

export const FAKE_SESSION: StoreSession = {
  apiUrl: 'https://fake.test/jmap/',
  downloadUrl: 'https://fake.test/d/{accountId}/{blobId}/{name}?type={type}',
  uploadUrl: 'https://fake.test/u/{accountId}',
  primaryAccounts: { 'urn:ietf:params:jmap:mail': JMAP_ACCOUNT },
  accounts: { [JMAP_ACCOUNT]: { name: 'a@example.org', isPersonal: true, accountCapabilities: { 'urn:ietf:params:jmap:mail': {} } } },
  capabilities: { 'urn:ietf:params:jmap:mail': {} },
};

type ChangeKind = 'created' | 'updated' | 'destroyed';

interface Log { kind: ChangeKind; id: string }

class Collection {
  log: Log[] = [];
  /** Below this log position, states are refused as truncated. */
  truncatedBelow = 0;

  state(): string {
    return `s${this.log.length}`;
  }

  push(kind: ChangeKind, id: string): void {
    this.log.push({ kind, id });
  }

  changes(since: string, maxChanges: number): { created: string[]; updated: string[]; destroyed: string[]; newState: string; hasMoreChanges: boolean } {
    const from = Number(since.slice(1));
    const slice = this.log.slice(from, from + maxChanges);
    const created = new Set<string>();
    const updated = new Set<string>();
    const destroyed = new Set<string>();
    for (const { kind, id } of slice) {
      if (kind === 'created') created.add(id);
      else if (kind === 'updated') {
        if (!created.has(id)) updated.add(id);
      } else if (created.delete(id)) {
        // Created and destroyed in the window: nowhere.
      } else {
        updated.delete(id);
        destroyed.add(id);
      }
    }
    const end = from + slice.length;
    return {
      created: [...created],
      updated: [...updated],
      destroyed: [...destroyed],
      newState: `s${end}`,
      hasMoreChanges: end < this.log.length,
    };
  }
}

export interface FakeOptions {
  /** Ten mailboxes by default, a single Inbox here unless given. */
  mailboxes?: Array<Record<string, unknown> & { id: string }>;
}

export class FakeJmap implements JmapTransport {
  readonly emails = new Map<string, FakeEmail>();
  readonly mailboxes = new Map<string, Record<string, unknown> & { id: string }>();
  readonly threads = new Map<string, string[]>();
  readonly coll = { Email: new Collection(), Mailbox: new Collection(), Thread: new Collection() };
  readonly calls: MethodCall[] = [];
  requests = 0;
  /** Set to make every request fail like a network drop. */
  offline = false;
  /** Fails the next N requests as busy. */
  busyNext = 0;
  /** Called before each request; can change data while a sync is running. */
  beforeRequest: ((n: number) => void) | null = null;
  nextId = 1;

  constructor(options: FakeOptions = {}) {
    for (const box of options.mailboxes ?? [{ id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 0, unreadEmails: 0 }]) {
      this.mailboxes.set(box.id, box);
      this.coll.Mailbox.push('created', box.id);
    }
  }

  addEmail(partial: Partial<FakeEmail> = {}): FakeEmail {
    const n = this.nextId++;
    const id = partial.id ?? `e${n}`;
    const threadId = (partial.threadId as string) ?? `t${n}`;
    const email: FakeEmail = {
      id,
      threadId,
      mailboxIds: { inbox: true },
      keywords: {},
      size: 100,
      receivedAt: new Date(Date.UTC(2026, 9, 1) + n * 1000).toISOString(),
      sentAt: new Date(Date.UTC(2026, 9, 1) + n * 1000).toISOString(),
      from: [{ name: `Sender ${n}`, email: `s${n}@example.org` }],
      to: [{ name: 'A', email: 'a@example.org' }],
      cc: [],
      subject: `Subject ${n}`,
      preview: `Preview ${n}`,
      hasAttachment: false,
      blobId: `b${n}`,
      textBody: [{ partId: '1', type: 'text/plain' }],
      htmlBody: [{ partId: '1', type: 'text/plain' }],
      bodyValues: { 1: { value: `Body of message ${n}`, isTruncated: false, isEncodingProblem: false } },
      attachments: [],
      messageId: [`m${n}@example.org`],
      headers: [],
      bodyStructure: { partId: '1', type: 'text/plain' },
      ...partial,
    };
    this.emails.set(id, email);
    this.coll.Email.push('created', id);
    const members = this.threads.get(threadId);
    if (members) {
      members.push(id);
      this.coll.Thread.push('updated', threadId);
    } else {
      this.threads.set(threadId, [id]);
      this.coll.Thread.push('created', threadId);
    }
    return email;
  }

  updateEmail(id: string, patch: Partial<FakeEmail>): void {
    Object.assign(this.emails.get(id) as FakeEmail, patch);
    this.coll.Email.push('updated', id);
  }

  destroyEmail(id: string): void {
    const email = this.emails.get(id);
    if (!email) return;
    this.emails.delete(id);
    this.coll.Email.push('destroyed', id);
    const threadId = email.threadId as string;
    const members = (this.threads.get(threadId) ?? []).filter((m) => m !== id);
    if (members.length > 0) {
      this.threads.set(threadId, members);
      this.coll.Thread.push('updated', threadId);
    } else {
      this.threads.delete(threadId);
      this.coll.Thread.push('destroyed', threadId);
    }
  }

  /** The next /changes from before this point gets cannotCalculateChanges. */
  truncateLog(type: 'Email' | 'Mailbox' | 'Thread'): void {
    this.coll[type].truncatedBelow = this.coll[type].log.length;
  }

  private queryIds(args: Record<string, unknown>): string[] {
    const filter = args.filter as { after?: string; inMailbox?: string } | undefined;
    let list = [...this.emails.values()];
    if (filter?.after) list = list.filter((e) => Date.parse(String(e.receivedAt)) >= Date.parse(filter.after as string));
    if (filter?.inMailbox) list = list.filter((e) => (e.mailboxIds as Record<string, boolean>)[filter.inMailbox as string]);
    list.sort((a, b) => Date.parse(String(b.receivedAt)) - Date.parse(String(a.receivedAt)));
    return list.map((e) => e.id);
  }

  protected handle(name: string, args: Record<string, unknown>): Record<string, unknown> {
    switch (name) {
      case 'Mailbox/get': {
        const ids = args.ids as string[] | null;
        const all = [...this.mailboxes.values()];
        const list = ids ? all.filter((b) => ids.includes(b.id)) : all;
        return { accountId: args.accountId, state: this.coll.Mailbox.state(), list, notFound: [] };
      }
      case 'Email/query': {
        const ids = this.queryIds(args);
        const position = Number(args.position ?? 0);
        const limit = Number(args.limit ?? 5000) || 5000;
        return {
          accountId: args.accountId,
          queryState: this.coll.Email.state(),
          canCalculateChanges: true,
          position,
          ids: ids.slice(position, position + Math.min(limit, 5000)),
          ...(args.calculateTotal ? { total: ids.length } : {}),
        };
      }
      case 'Email/get': {
        const ids = args.ids as string[] | null;
        if (ids && ids.length > 500) throw Object.assign(new Error('requestTooLarge'), { jmapError: 'requestTooLarge' });
        const chosen = ids ?? [...this.emails.keys()].slice(0, 500);
        const properties = args.properties as string[] | undefined;
        const list: Record<string, unknown>[] = [];
        const notFound: string[] = [];
        for (const id of chosen) {
          const email = this.emails.get(id);
          if (!email) {
            notFound.push(id);
            continue;
          }
          if (!properties) {
            list.push({ ...email });
            continue;
          }
          const out: Record<string, unknown> = { id };
          for (const p of properties) if (p in email) out[p] = email[p];
          list.push(out);
        }
        return { accountId: args.accountId, state: this.coll.Email.state(), list, notFound };
      }
      case 'Thread/get': {
        const ids = (args.ids ?? []) as string[];
        return {
          accountId: args.accountId,
          state: this.coll.Thread.state(),
          list: ids.filter((id) => this.threads.has(id)).map((id) => ({ id, emailIds: this.threads.get(id) })),
          notFound: ids.filter((id) => !this.threads.has(id)),
        };
      }
      case 'Email/changes':
      case 'Mailbox/changes':
      case 'Thread/changes': {
        const type = name.split('/')[0] as 'Email' | 'Mailbox' | 'Thread';
        const coll = this.coll[type];
        const since = String(args.sinceState);
        if (!/^s\d+$/.test(since)) throw Object.assign(new Error('bad state'), { jmapError: 'invalidArguments' });
        const from = Number(since.slice(1));
        if (from < coll.truncatedBelow || from > coll.log.length) {
          throw Object.assign(new Error('log truncated'), { jmapError: 'cannotCalculateChanges' });
        }
        const maxChanges = Math.min(Number(args.maxChanges ?? 5000) || 5000, 5000);
        return { accountId: args.accountId, oldState: since, ...coll.changes(since, maxChanges) };
      }
      default:
        throw Object.assign(new Error(name), { jmapError: 'unknownMethod' });
    }
  }

  async request(calls: MethodCall[]): Promise<JmapResponse> {
    this.requests += 1;
    this.beforeRequest?.(this.requests);
    if (this.offline) throw new TransportError('network', 'Failed to fetch');
    if (this.busyNext > 0) {
      this.busyNext -= 1;
      throw new TransportError('rate', 'Server busy', 429, undefined, 1);
    }
    if (calls.length > 16) throw new TransportError('http', 'too many calls', 400, 'urn:ietf:params:jmap:error:limit');
    const done: MethodResponse[] = [];
    for (const call of calls) {
      this.calls.push(call);
      const [name, raw, id] = call;
      const args: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (key.startsWith('#')) {
          const ref = value as { resultOf: string; path: string };
          const source = done.find(([, , callId]) => callId === ref.resultOf);
          args[key.slice(1)] = source?.[1][ref.path.slice(1)];
        } else {
          args[key] = value;
        }
      }
      try {
        done.push([name, this.handle(name, args), id]);
      } catch (error) {
        const type = (error as { jmapError?: string }).jmapError;
        if (!type) throw error;
        done.push(['error', { type }, id]);
      }
    }
    return { methodResponses: done };
  }

  async download(): Promise<Uint8Array> {
    return new Uint8Array();
  }

  async upload(): Promise<{ blobId: string; type: string; size: number }> {
    return { blobId: 'uploaded', type: 'application/octet-stream', size: 0 };
  }
}
