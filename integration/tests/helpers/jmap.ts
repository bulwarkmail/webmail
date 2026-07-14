/**
 * Minimal JMAP client for test setup/inspection against Stalwart.
 *
 * Uses global fetch (Node 18+). Not a full JMAP implementation — just the
 * pieces the integration tests need: authenticate, read/reset mailboxes,
 * create folders, and poll for delivery. Assertions on *server* state (via
 * this client) are kept separate from assertions on *UI* state (via the page),
 * so a failing test can tell whether the bug is in delivery or in the webmail's
 * sync.
 */
import { JMAP_URL } from './config';

const CORE = 'urn:ietf:params:jmap:core';
const MAIL = 'urn:ietf:params:jmap:mail';
// Identity/* lives under the submission capability, not mail.
const SUBMISSION = 'urn:ietf:params:jmap:submission';

interface JmapMailbox {
  id: string;
  name: string;
  role: string | null;
  parentId: string | null;
  totalEmails: number;
  unreadEmails: number;
}

type MethodCall = [string, Record<string, unknown>, string];

export class JmapClient {
  private authHeader: string;
  private apiUrl: string;
  accountId = '';
  /** Every account visible in this user's session (own + shared/group),
   *  keyed by accountId -> account name (its email address). */
  accounts: Record<string, string> = {};

  private constructor(private email: string, password: string) {
    this.authHeader = 'Basic ' + Buffer.from(`${email}:${password}`).toString('base64');
    // Stalwart advertises apiUrl on its configured hostname (mail.example.org);
    // rewrite onto the reachable origin, exactly as the app client does.
    this.apiUrl = `${JMAP_URL}/jmap/`;
  }

  static async connect(email: string, password: string): Promise<JmapClient> {
    const c = new JmapClient(email, password);
    const res = await fetch(`${JMAP_URL}/jmap/session`, {
      headers: { Authorization: c.authHeader },
    });
    if (!res.ok) throw new Error(`JMAP session failed for ${email}: ${res.status}`);
    const session = await res.json();
    const primary = session.primaryAccounts?.[MAIL];
    if (!primary) throw new Error(`No mail account for ${email} in JMAP session`);
    c.accountId = primary;
    c.accounts = Object.fromEntries(
      Object.entries(session.accounts ?? {}).map(([id, a]) => [id, (a as { name: string }).name]),
    );
    return c;
  }

  /** Names (email addresses) of the shared/group accounts this user can access,
   *  i.e. everything in the session except the user's own primary account. */
  sharedAccountNames(): string[] {
    return Object.entries(this.accounts)
      .filter(([id]) => id !== this.accountId)
      .map(([, name]) => name);
  }

  async request(methodCalls: MethodCall[]): Promise<any> {
    const res = await fetch(this.apiUrl, {
      method: 'POST',
      headers: { Authorization: this.authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ using: [CORE, MAIL, SUBMISSION], methodCalls }),
    });
    if (!res.ok) throw new Error(`JMAP request failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async mailboxes(): Promise<JmapMailbox[]> {
    const r = await this.request([['Mailbox/get', { accountId: this.accountId }, '0']]);
    return r.methodResponses[0][1].list as JmapMailbox[];
  }

  async mailboxByRole(role: string): Promise<JmapMailbox | undefined> {
    return (await this.mailboxes()).find((m) => m.role === role);
  }

  async mailboxByName(name: string): Promise<JmapMailbox | undefined> {
    return (await this.mailboxes()).find((m) => m.name === name);
  }

  /** Create a folder (top-level) and return its id. Idempotent by name. */
  async createMailbox(name: string, parentId: string | null = null): Promise<string> {
    const existing = await this.mailboxByName(name);
    if (existing) return existing.id;
    const r = await this.request([
      ['Mailbox/set', { accountId: this.accountId, create: { new: { name, parentId } } }, '0'],
    ]);
    const created = r.methodResponses[0][1].created?.new;
    if (!created) throw new Error(`Mailbox/set create failed: ${JSON.stringify(r.methodResponses[0][1])}`);
    return created.id;
  }

  async deleteMailboxByName(name: string): Promise<void> {
    const mb = await this.mailboxByName(name);
    if (!mb) return;
    await this.request([
      ['Mailbox/set', { accountId: this.accountId, onDestroyRemoveEmails: true, destroy: [mb.id] }, '0'],
    ]);
  }

  private async allEmailIds(): Promise<string[]> {
    const r = await this.request([['Email/query', { accountId: this.accountId, limit: 5000 }, '0']]);
    return r.methodResponses[0][1].ids as string[];
  }

  /**
   * Reset a mailbox to a clean slate: destroy every message and delete any
   * non-system (custom) folder. System folders (Inbox/Sent/Trash/…) are kept.
   */
  async reset(): Promise<void> {
    const ids = await this.allEmailIds();
    if (ids.length) {
      await this.request([['Email/set', { accountId: this.accountId, destroy: ids }, '0']]);
    }
    const custom = (await this.mailboxes()).filter((m) => !m.role);
    if (custom.length) {
      await this.request([
        ['Mailbox/set', { accountId: this.accountId, onDestroyRemoveEmails: true, destroy: custom.map((m) => m.id) }, '0'],
      ]);
    }
  }

  /** Look up an email id by subject within an optional mailbox. */
  async findEmailBySubject(subject: string, mailboxId?: string): Promise<any | undefined> {
    const filter: Record<string, unknown> = { subject };
    if (mailboxId) filter.inMailbox = mailboxId;
    const r = await this.request([
      ['Email/query', { accountId: this.accountId, filter }, '0'],
      ['Email/get', {
        accountId: this.accountId,
        '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' },
        properties: ['id', 'subject', 'keywords', 'mailboxIds', 'from', 'preview'],
      }, '1'],
    ]);
    return r.methodResponses[1][1].list[0];
  }

  /** Poll until a message with `subject` is delivered (or throw on timeout). */
  async waitForEmail(subject: string, opts: { mailboxId?: string; timeoutMs?: number } = {}): Promise<any> {
    const deadline = Date.now() + (opts.timeoutMs ?? 15000);
    for (;;) {
      const found = await this.findEmailBySubject(subject, opts.mailboxId);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for email "${subject}" (${this.email})`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
