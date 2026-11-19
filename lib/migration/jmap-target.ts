import { readParsedCalendarEvents } from '@/lib/calendar/import-event';
import { SIEVE_USING, sieveScriptSetArgs, uploadedBlobId } from '@/lib/sieve/script-set';
import { fetchJmapServer } from '@/lib/stalwart/server-fetch';
import { rebaseApiUrl } from '@/lib/stalwart/jmap-api';
import {
  TargetAuthError,
  TargetRateLimitError,
  type EmailImportItem,
  type MigrationTarget,
  type SetOutcome,
  type TargetCollection,
  type TargetMailbox,
  type TargetScript,
} from './types';

/**
 * The Stalwart account a migration copies into, over JMAP with the job's
 * own credential: the master user for bulk migrations, the user's app
 * password for self-service ones. HTTP 401 becomes TargetAuthError and 429
 * TargetRateLimitError with the server's Retry-After, so the engine can
 * pause or renew instead of failing.
 */

export type HttpRequest = (url: string, init: RequestInit) => Promise<Response>;

const CORE = 'urn:ietf:params:jmap:core';
const MAIL_USING = [CORE, 'urn:ietf:params:jmap:mail'];
const CONTACTS_USING = [CORE, 'urn:ietf:params:jmap:contacts'];
const CALENDARS_USING = [CORE, 'urn:ietf:params:jmap:calendars'];

/** Requests in a migration may move a few MB; give them more than the usual 30 s. */
const REQUEST_TIMEOUT_MS = 120_000;

const defaultRequest: HttpRequest = (url, init) =>
  fetchJmapServer(url, { ...init, signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) }, true, { storedCredential: false });

interface SessionDoc {
  apiUrl?: string;
  uploadUrl?: string;
  username?: string;
  capabilities?: Record<string, unknown>;
  primaryAccounts?: Record<string, string>;
}

/** Retry-After as seconds or an HTTP date, in ms from now; null when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function checkStatus(response: Response): void {
  if (response.status === 401) throw new TargetAuthError();
  if (response.status === 429) throw new TargetRateLimitError(retryAfterMs(response.headers.get('retry-after')));
  if (response.status === 503 && response.headers.get('retry-after')) {
    throw new TargetRateLimitError(retryAfterMs(response.headers.get('retry-after')));
  }
  if (!response.ok) throw new Error(`Stalwart answered HTTP ${response.status}`);
}

/** The session of the account `authHeader` opens; TargetAuthError when Stalwart refuses it. */
export async function fetchTargetSession(serverUrl: string, authHeader: string, request: HttpRequest = defaultRequest): Promise<SessionDoc> {
  let lastError: unknown = null;
  for (const path of ['/jmap/session', '/.well-known/jmap']) {
    const response = await request(`${serverUrl}${path}`, { method: 'GET', headers: { Authorization: authHeader }, redirect: 'follow' });
    if (response.status === 401) throw new TargetAuthError();
    try {
      checkStatus(response);
      const session = (await response.json()) as SessionDoc;
      if (session?.primaryAccounts) return session;
    } catch (error) {
      if (error instanceof TargetRateLimitError) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Stalwart sent no usable JMAP session');
}

function rebase(url: string | undefined, serverUrl: string): string | null {
  return url ? rebaseApiUrl({ apiUrl: url }, serverUrl) : null;
}

type MethodResponse = [string, Record<string, unknown>, string];

function refusal(error: unknown): string {
  const e = error as { description?: string; type?: string } | undefined;
  return e?.description || e?.type || 'refused';
}

function outcomes(result: Record<string, unknown>, keys: string[], ids: (string | undefined)[] = []): SetOutcome[] {
  const created = (result.created ?? {}) as Record<string, { id?: string }>;
  const notCreated = (result.notCreated ?? {}) as Record<string, unknown>;
  const updated = (result.updated ?? {}) as Record<string, unknown>;
  const notUpdated = (result.notUpdated ?? {}) as Record<string, unknown>;
  return keys.map((key, i) => {
    const id = ids[i];
    if (id) {
      if (id in updated) return { id };
      return { error: refusal(notUpdated[id]) };
    }
    const made = created[key]?.id;
    return made ? { id: made } : { error: refusal(notCreated[key]) };
  });
}

export class JmapMigrationTarget implements MigrationTarget {
  private constructor(
    private readonly serverUrl: string,
    private readonly authHeader: string,
    private readonly session: SessionDoc,
    private readonly request: HttpRequest,
  ) {}

  static async open(opts: { serverUrl: string; authHeader: string; request?: HttpRequest }): Promise<JmapMigrationTarget> {
    const request = opts.request ?? defaultRequest;
    const session = await fetchTargetSession(opts.serverUrl, opts.authHeader, request);
    return new JmapMigrationTarget(opts.serverUrl, opts.authHeader, session, request);
  }

  /** The login the session belongs to. */
  get username(): string | undefined {
    return this.session.username;
  }

  private account(capability: string): string {
    const primary = this.session.primaryAccounts ?? {};
    const id = primary[capability] ?? primary['urn:ietf:params:jmap:mail'] ?? Object.values(primary)[0];
    if (!id) throw new Error('The target session names no account');
    return id;
  }

  private get mailAccount() { return this.account('urn:ietf:params:jmap:mail'); }
  private get contactsAccount() { return this.account('urn:ietf:params:jmap:contacts'); }
  private get calendarsAccount() { return this.account('urn:ietf:params:jmap:calendars'); }
  private get sieveAccount() { return this.account('urn:ietf:params:jmap:sieve'); }

  maxSizeUpload(): number {
    const core = this.session.capabilities?.[CORE] as { maxSizeUpload?: unknown } | undefined;
    return typeof core?.maxSizeUpload === 'number' && core.maxSizeUpload > 0 ? core.maxSizeUpload : 50_000_000;
  }

  private async call(using: string[], calls: [string, Record<string, unknown>, string][]): Promise<MethodResponse[]> {
    const apiUrl = rebase(this.session.apiUrl, this.serverUrl) ?? `${this.serverUrl}/jmap/`;
    const response = await this.request(apiUrl, {
      method: 'POST',
      headers: { Authorization: this.authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ using, methodCalls: calls }),
    });
    checkStatus(response);
    const data = (await response.json()) as { methodResponses?: MethodResponse[] };
    const responses = data.methodResponses ?? [];
    const failed = responses.find((r) => r[0] === 'error');
    if (failed) throw new Error(`${calls.find((c) => c[2] === failed[2])?.[0] ?? 'JMAP'}: ${refusal(failed[1])}`);
    return responses;
  }

  private async one(using: string[], method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const [first] = await this.call(using, [[method, args, '0']]);
    if (!first || first[0] !== method) throw new Error(`${method}: unexpected answer`);
    return first[1];
  }

  async uploadBlob(data: Uint8Array | string, type: string, kind: 'mail' | 'calendars' | 'sieve' = 'mail'): Promise<string> {
    const accountId = kind === 'calendars' ? this.calendarsAccount : kind === 'sieve' ? this.sieveAccount : this.mailAccount;
    const template = rebase(this.session.uploadUrl, this.serverUrl) ?? `${this.serverUrl}/jmap/upload/{accountId}/`;
    const url = template.replace(encodeURIComponent('{accountId}'), '{accountId}').replace('{accountId}', encodeURIComponent(accountId));
    const response = await this.request(url, {
      method: 'POST',
      headers: { Authorization: this.authHeader, 'Content-Type': type },
      body: typeof data === 'string' ? data : Uint8Array.from(data),
    });
    checkStatus(response);
    return uploadedBlobId((await response.json()) as Record<string, unknown>, accountId);
  }

  async listMailboxes(): Promise<TargetMailbox[]> {
    const result = await this.one(MAIL_USING, 'Mailbox/get', { accountId: this.mailAccount, properties: ['id', 'name', 'parentId', 'role'] });
    return ((result.list ?? []) as TargetMailbox[]).map((m) => ({ id: m.id, name: m.name, parentId: m.parentId ?? null, role: m.role ?? null }));
  }

  async createMailbox(name: string, parentId: string | null): Promise<string> {
    const result = await this.one(MAIL_USING, 'Mailbox/set', { accountId: this.mailAccount, create: { m: { name, parentId } } });
    const [outcome] = outcomes(result, ['m']);
    if ('error' in outcome) throw new Error(`Folder ${name} not created: ${outcome.error}`);
    return outcome.id;
  }

  async importEmails(items: EmailImportItem[]): Promise<SetOutcome[]> {
    const keys = items.map((_, i) => `e${i}`);
    const emails = Object.fromEntries(items.map((item, i) => [keys[i], {
      blobId: item.blobId,
      mailboxIds: { [item.mailboxId]: true },
      keywords: item.keywords,
      receivedAt: item.receivedAt,
    }]));
    const result = await this.one(MAIL_USING, 'Email/import', { accountId: this.mailAccount, emails });
    return outcomes(result, keys);
  }

  async findMessageIds(mailboxId: string, messageIds: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    if (messageIds.length === 0) return found;
    const responses = await this.call(MAIL_USING, [
      ['Email/query', {
        accountId: this.mailAccount,
        filter: {
          operator: 'AND',
          conditions: [
            { inMailbox: mailboxId },
            { operator: 'OR', conditions: messageIds.map((id) => ({ header: ['Message-ID', `<${id}>`] })) },
          ],
        },
        limit: messageIds.length * 2,
      }, 'q'],
      ['Email/get', { accountId: this.mailAccount, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['messageId'] }, 'g'],
    ]);
    const list = (responses.find((r) => r[0] === 'Email/get')?.[1].list ?? []) as { messageId?: string[] | null }[];
    const wanted = new Set(messageIds);
    for (const email of list) for (const id of email.messageId ?? []) if (wanted.has(id)) found.add(id);
    return found;
  }

  private async byUid(using: string[], type: string, accountId: string, uids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (uids.length === 0) return out;
    const responses = await this.call(using, [
      [`${type}/query`, { accountId, filter: { operator: 'OR', conditions: uids.map((uid) => ({ uid })) }, limit: uids.length * 2 }, 'q'],
      [`${type}/get`, { accountId, '#ids': { resultOf: 'q', name: `${type}/query`, path: '/ids' }, properties: ['id', 'uid'] }, 'g'],
    ]);
    const list = (responses.find((r) => r[0] === `${type}/get`)?.[1].list ?? []) as { id: string; uid?: string }[];
    for (const item of list) if (item.uid) out.set(item.uid, item.id);
    return out;
  }

  private async collections(using: string[], type: string, accountId: string): Promise<TargetCollection[]> {
    const result = await this.one(using, `${type}/get`, { accountId, properties: ['id', 'name', 'isDefault'] });
    return ((result.list ?? []) as TargetCollection[]).map((c) => ({ id: c.id, name: c.name, isDefault: !!c.isDefault }));
  }

  private async createCollection(using: string[], type: string, accountId: string, props: Record<string, unknown>): Promise<string> {
    const result = await this.one(using, `${type}/set`, { accountId, create: { c: props } });
    const [outcome] = outcomes(result, ['c']);
    if ('error' in outcome) throw new Error(`${props.name} not created: ${outcome.error}`);
    return outcome.id;
  }

  private async save(using: string[], type: string, accountId: string, items: { id?: string; value: Record<string, unknown> }[], extra: Record<string, unknown> = {}): Promise<SetOutcome[]> {
    const keys = items.map((_, i) => `o${i}`);
    const create = Object.fromEntries(items.flatMap((item, i) => (item.id ? [] : [[keys[i], item.value]])));
    const update = Object.fromEntries(items.flatMap((item) => (item.id ? [[item.id, item.value]] : [])));
    const result = await this.one(using, `${type}/set`, {
      accountId,
      ...(Object.keys(create).length ? { create } : {}),
      ...(Object.keys(update).length ? { update } : {}),
      ...extra,
    });
    return outcomes(result, keys, items.map((item) => item.id));
  }

  listAddressBooks() { return this.collections(CONTACTS_USING, 'AddressBook', this.contactsAccount); }
  createAddressBook(name: string) { return this.createCollection(CONTACTS_USING, 'AddressBook', this.contactsAccount, { name }); }
  findContactsByUid(uids: string[]) { return this.byUid(CONTACTS_USING, 'ContactCard', this.contactsAccount, uids); }
  saveContacts(cards: { id?: string; card: Record<string, unknown> }[]) {
    return this.save(CONTACTS_USING, 'ContactCard', this.contactsAccount, cards.map((c) => ({ id: c.id, value: c.card })));
  }

  listCalendars() { return this.collections(CALENDARS_USING, 'Calendar', this.calendarsAccount); }
  createCalendar(name: string, color?: string) {
    return this.createCollection(CALENDARS_USING, 'Calendar', this.calendarsAccount, { name, ...(color ? { color } : {}) });
  }

  async parseEvents(blobId: string): Promise<Record<string, unknown>[]> {
    const result = await this.one(CALENDARS_USING, 'CalendarEvent/parse', { accountId: this.calendarsAccount, blobIds: [blobId] });
    return readParsedCalendarEvents(result, blobId) as Record<string, unknown>[];
  }

  findEventsByUid(uids: string[]) { return this.byUid(CALENDARS_USING, 'CalendarEvent', this.calendarsAccount, uids); }

  saveEvents(events: { id?: string; event: Record<string, unknown> }[]) {
    // Imported events are copies of what the source already sent: no invitations again.
    return this.save(CALENDARS_USING, 'CalendarEvent', this.calendarsAccount, events.map((e) => ({ id: e.id, value: e.event })), { sendSchedulingMessages: false });
  }

  async listSieveScripts(): Promise<TargetScript[]> {
    const result = await this.one(SIEVE_USING, 'SieveScript/get', { accountId: this.sieveAccount, properties: ['id', 'name', 'isActive'] });
    return ((result.list ?? []) as TargetScript[]).map((s) => ({ id: s.id, name: s.name, isActive: !!s.isActive }));
  }

  async saveSieveScript(script: { id?: string; name: string; blobId: string; activate: boolean }): Promise<SetOutcome> {
    const args = sieveScriptSetArgs({ accountId: this.sieveAccount, creationId: 's', ...script });
    const result = await this.one(SIEVE_USING, 'SieveScript/set', args);
    const [outcome] = outcomes(result, ['s'], [script.id]);
    return outcome;
  }
}
