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

  it('keeps the snapshot folder when the account has no inbox of its own', async () => {
    const state = await boot('/', { mailboxes: FOLDERS.slice(1), selectedMailbox: 'm-trash', emails: TRASH_ROWS });
    expect(state.selectedMailbox).toBe('m-trash');
  });
});
