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

// With the local store on, the mail is encrypted on the device, and subjects in
// localStorage would give it away.
describe('email boot snapshot with the local store on', { timeout: 30_000 }, () => {
  const ROW = { id: 'e1', subject: 'Secret subject', mailboxIds: { inbox: true } };
  const SNAPSHOT = { v: 3, account: 'alice@mail.example', mailboxes: MAILBOXES, selectedMailbox: 'inbox', emails: [ROW] };

  async function boot(enabled: string[]) {
    persistSession('alice@mail.example');
    localStorage.setItem('email-snapshot', JSON.stringify(SNAPSHOT));
    localStorage.setItem('bulwark-offline-accounts', JSON.stringify(enabled));
    vi.resetModules();
    return (await import('@/stores/email-store')).useEmailStore;
  }

  it('is removed at the start and not restored', async () => {
    const store = await boot(['alice@mail.example']);
    expect(localStorage.getItem('email-snapshot')).toBeNull();
    expect(store.getState().emails).toEqual([]);
  });

  it('still works for an account without it', async () => {
    const store = await boot(['bob@mail.example']);
    expect(localStorage.getItem('email-snapshot')).not.toBeNull();
    expect(store.getState().emails).toHaveLength(1);
  });

  it('is never written while it is on', async () => {
    const store = await boot(['alice@mail.example']);
    store.setState({ mailboxes: MAILBOXES as never, emails: [ROW] as never, selectedMailbox: 'inbox' });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(localStorage.getItem('email-snapshot')).toBeNull();
  });

  it('is written without it, as the control', async () => {
    const store = await boot([]);
    store.setState({ emails: [{ ...ROW, id: 'e2' }] as never });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(localStorage.getItem('email-snapshot')).toContain('e2');
  });

  it('goes the moment the user turns it on', async () => {
    const store = await boot([]);
    expect(store.getState().emails).toHaveLength(1);
    const { useOfflineStore } = await import('@/lib/offline/state');
    useOfflineStore.setState({ enabled: ['alice@mail.example'] });
    expect(localStorage.getItem('email-snapshot')).toBeNull();
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
