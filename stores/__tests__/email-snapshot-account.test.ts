import { beforeEach, describe, expect, it, vi } from 'vitest';

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
