import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The boot snapshot of the mailbox list was not tied to an account: it was
// restored for whichever account the last session had active.

const MAILBOXES = [{ id: 'inbox', name: 'Inbox', role: 'inbox' }];

function persistSession(activeAccountId: string) {
  localStorage.setItem('auth-storage', JSON.stringify({ state: { isAuthenticated: true, activeAccountId } }));
}

async function bootMailboxes() {
  vi.resetModules();
  const { useEmailStore } = await import('@/stores/email-store');
  return useEmailStore.getState().mailboxes;
}

beforeEach(() => localStorage.clear());

// Each case imports the whole email store afresh, slow under a full parallel run.
describe('email boot snapshot', { timeout: 30_000 }, () => {
  it('is restored for the account it was taken from', async () => {
    persistSession('alice@mail.example');
    localStorage.setItem('email-snapshot', JSON.stringify({ v: 3, account: 'alice@mail.example', mailboxes: MAILBOXES }));
    expect(await bootMailboxes()).toHaveLength(1);
  });

  it('is ignored for another account', async () => {
    persistSession('bob@mail.example');
    localStorage.setItem('email-snapshot', JSON.stringify({ v: 3, account: 'alice@mail.example', mailboxes: MAILBOXES }));
    expect(await bootMailboxes()).toHaveLength(0);
  });

  it('discards snapshots that name no account', async () => {
    persistSession('alice@mail.example');
    localStorage.setItem('email-snapshot', JSON.stringify({ v: 2, mailboxes: MAILBOXES }));
    expect(await bootMailboxes()).toHaveLength(0);
  });
});

// With the local store on, mail doesn't go to localStorage in plain text too.
describe('email boot snapshot for an account in the local store', { timeout: 30_000 }, () => {
  const STATE = { mailboxes: MAILBOXES, selectedMailbox: 'inbox', emails: [{ id: 'e1', mailboxIds: { inbox: true } }] };

  async function fresh(account: string) {
    vi.useFakeTimers();
    persistSession(account);
    vi.resetModules();
    const { useEmailStore } = await import('@/stores/email-store');
    const offline = await import('@/lib/offline/state');
    return { useEmailStore, offline };
  }

  afterEach(() => vi.useRealTimers());

  it('isn\'t written', async () => {
    const { useEmailStore, offline } = await fresh('alice@mail.example');
    offline.useOfflineStore.setState({ enabled: ['alice@mail.example'] });
    useEmailStore.setState(STATE as never);
    await vi.advanceTimersByTimeAsync(1500);
    expect(localStorage.getItem('email-snapshot')).toBeNull();
  });

  it('is written for an account outside it', async () => {
    const { useEmailStore, offline } = await fresh('alice@mail.example');
    offline.useOfflineStore.setState({ enabled: ['bob@mail.example'] });
    useEmailStore.setState(STATE as never);
    await vi.advanceTimersByTimeAsync(1500);
    expect(JSON.parse(localStorage.getItem('email-snapshot') ?? '{}').account).toBe('alice@mail.example');
  });

  it('goes only when that account\'s store can take over', async () => {
    const { offline } = await fresh('alice@mail.example');
    localStorage.setItem('email-snapshot', JSON.stringify({ v: 3, account: 'alice@mail.example', mailboxes: MAILBOXES }));
    offline.forgetMailSnapshot('bob@mail.example');
    expect(localStorage.getItem('email-snapshot')).not.toBeNull();
    offline.forgetMailSnapshot('alice@mail.example');
    expect(localStorage.getItem('email-snapshot')).toBeNull();
  });
});

// A client's late answer doesn't land on the client that replaced it.
describe('a list answer from a client that was replaced', { timeout: 30_000 }, () => {
  it('is dropped', async () => {
    persistSession('alice@mail.example');
    vi.resetModules();
    const { useEmailStore } = await import('@/stores/email-store');
    const { useAuthStore } = await import('@/stores/auth-store');
    const rows = [{ id: 'stale', mailboxIds: { inbox: true } }];
    let answer: (value: unknown) => void = () => {};
    const local = {
      getAccountId: () => 'acc',
      getEmails: vi.fn(() => new Promise((resolve) => { answer = resolve; })),
      getThreadEmailCounts: vi.fn(async () => ({})),
    };
    useAuthStore.setState({ client: local as never, activeAccountId: 'alice@mail.example' });
    useEmailStore.setState({ mailboxes: MAILBOXES as never, selectedMailbox: 'inbox', emails: [] });
    const fetching = useEmailStore.getState().fetchEmails(local as never, 'inbox');
    await vi.waitFor(() => expect(local.getEmails).toHaveBeenCalled());
    useAuthStore.setState({ client: { getAccountId: () => 'acc' } as never });
    answer({ emails: rows, hasMore: false, total: 1, state: 's1' });
    await fetching;
    expect(useEmailStore.getState().emails).toEqual([]);
  });
});

// The snapshot keeps the last plain folder that was open; a session that
// ended in a unified view left Trash there, and every visit to "/" opened it.
describe('email boot snapshot folder', { timeout: 30_000 }, () => {
  const FOLDERS = [
    { id: 'm-inbox', name: 'Inbox', role: 'inbox' },
    { id: 'm-trash', name: 'Trash', role: 'trash' },
    { id: 'shared-inbox', name: 'Inbox', role: 'inbox', isShared: true },
  ];
  const TRASH_ROWS = [{ id: 'e1', mailboxIds: { 'm-trash': true } }];

  async function boot(path: string, snapshot: Record<string, unknown>) {
    window.history.replaceState(null, '', path);
    persistSession('alice@mail.example');
    localStorage.setItem('email-snapshot', JSON.stringify({ v: 3, account: 'alice@mail.example', ...snapshot }));
    vi.resetModules();
    const { useEmailStore } = await import('@/stores/email-store');
    return useEmailStore.getState();
  }

  afterEach(() => window.history.replaceState(null, '', '/'));

  it('opens the own inbox on a plain visit and drops rows cached for another folder', async () => {
    const state = await boot('/en', { mailboxes: FOLDERS, selectedMailbox: 'm-trash', emails: TRASH_ROWS, totalEmails: 1 });
    expect(state.mailboxes).toHaveLength(3);
    expect(state.selectedMailbox).toBe('m-inbox');
    expect(state.emails).toHaveLength(0);
  });

  it('keeps the cached rows when the snapshot is the inbox', async () => {
    const state = await boot('/', { mailboxes: FOLDERS, selectedMailbox: 'm-inbox', emails: [{ id: 'e2' }], totalEmails: 1 });
    expect(state.selectedMailbox).toBe('m-inbox');
    expect(state.emails.map(e => e.id)).toEqual(['e2']);
  });

  it('continues in the snapshot folder when a folder link is reloaded', async () => {
    const state = await boot('/webmail/en/mail/folder/trash', { mailboxes: FOLDERS, selectedMailbox: 'm-trash', emails: TRASH_ROWS, totalEmails: 1 });
    expect(state.selectedMailbox).toBe('m-trash');
    expect(state.emails).toHaveLength(1);
  });

  // Without the order the cached "unread first" page was drawn by date and
  // jumped when the live fetch re-sorted it.
  it('restores the order and sync state the cached rows were fetched with', async () => {
    const listOrder = [{ criterion: 'unread', direction: 'desc' }];
    const emailListSync = { state: 's1', accountId: 'acc', mailboxId: 'm-inbox' };
    const state = await boot('/', { mailboxes: FOLDERS, selectedMailbox: 'm-inbox', emails: [{ id: 'e2' }], listOrder, emailListSync });
    expect(state.listOrder).toEqual(listOrder);
    expect(state.emailListSync).toEqual(emailListSync);
  });

  // A snapshot that says "no more mail" beside rows its total does not cover
  // kept the inbox at one page across reloads: the delta catch-up after boot
  // never re-reads the total (#1364).
  it('re-reads a page whose saved total does not cover its rows', async () => {
    const rows = [{ id: 'e1' }, { id: 'e2' }];
    const emailListSync = { state: 's1', accountId: 'acc', mailboxId: 'm-inbox' };
    const state = await boot('/', {
      mailboxes: FOLDERS, selectedMailbox: 'm-inbox', emails: rows, totalEmails: 0, hasMoreEmails: false, emailListSync,
    });
    expect(state.emails).toHaveLength(2);
    const { useEmailStore } = await import('@/stores/email-store');
    const { useSettingsStore } = await import('@/stores/settings-store');
    useSettingsStore.setState({ emailsPerPage: 2 });
    const client = {
      getAccountId: () => 'acc',
      getEmailChanges: vi.fn(async () => ({ oldState: 's1', newState: 's1', hasMoreChanges: false, created: [], updated: [], destroyed: [], updatedProperties: null })),
      getEmails: vi.fn(async () => ({ emails: rows, hasMore: true, total: 10853, state: 's1' })),
      getThreadEmailCounts: vi.fn(async () => ({})),
    };
    await useEmailStore.getState().fetchEmails(client as never, 'm-inbox', { background: true });
    expect(client.getEmails).toHaveBeenCalled();
    expect(useEmailStore.getState().totalEmails).toBe(10853);
    expect(useEmailStore.getState().hasMoreEmails).toBe(true);
  });

  it('keeps the snapshot folder when the account has no inbox of its own', async () => {
    const state = await boot('/', { mailboxes: FOLDERS.slice(1), selectedMailbox: 'm-trash', emails: TRASH_ROWS });
    expect(state.selectedMailbox).toBe('m-trash');
  });
});
