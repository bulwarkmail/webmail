import { expect, it } from 'vitest';

// Store fetches had no account guard: a request started for account A that
// resolved after the switch to B wrote A's folders into B's sidebar, and A's
// filter rules and script id into B's filter store - so B's next save
// uploaded A's rules (a redirect to A's bookkeeper included) to B's server.
import { useEmailStore } from '@/stores/email-store';
import { useFilterStore } from '@/stores/filter-store';
import { useAuthStore } from '@/stores/auth-store';
import { clearAllStores } from '@/lib/account-state-manager';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

it('fetchMailboxes for A landing after the switch leaves B folder tree alone', async () => {
  const gate = deferred<void>();
  const aMailboxes = [
    { id: 'a', name: 'Inbox', role: 'inbox', accountId: 'A', totalEmails: 1, unreadEmails: 0, sortOrder: 0 },
    { id: 'g', name: 'A-Invoices', role: null, accountId: 'A', totalEmails: 1, unreadEmails: 0, sortOrder: 1 },
  ];
  const clientA = {
    getAllMailboxesWithState: async () => { await gate.promise; return { mailboxes: aMailboxes, states: { A: 's1' } }; },
  };
  useAuthStore.setState({ activeAccountId: 'acct-A' });
  useEmailStore.setState({ mailboxes: [{ id: 'a', name: 'Inbox', role: 'inbox', accountId: 'A' }] as never, selectedMailbox: 'a' });
  const p = useEmailStore.getState().fetchMailboxes(clientA as never); // e.g. push-driven refresh for A

  // User switches to B: stores reset and B's folders restored.
  clearAllStores();
  useAuthStore.setState({ activeAccountId: 'acct-B' });
  const bMailboxes = [
    { id: 'a', name: 'Inbox', role: 'inbox', accountId: 'B' },
    { id: 'g', name: 'B-Family', role: null, accountId: 'B' },
  ];
  useEmailStore.setState({ mailboxes: bMailboxes as never, selectedMailbox: 'a' });

  gate.resolve();
  await p;
  const names = useEmailStore.getState().mailboxes.map((m) => `${m.id}:${m.name}`);
  expect(names).toEqual(['a:Inbox', 'g:B-Family']);
});

it('filter fetch for A landing after B loaded is dropped', async () => {
  const gateA = deferred<void>();
  const scriptA = 'require ["fileinto"];\r\nif header :contains "subject" "invoice" { redirect "bookkeeper@a.example"; }\r\n';
  const scriptB = 'require ["fileinto"];\r\nif header :contains "from" "mom@b.example" { fileinto "Family"; }\r\n';
  const mk = (sieveAcct: string, script: string, gate?: Promise<void>) => {
    const uploads: Array<{ id: string; content: string; account: string | undefined }> = [];
    return {
      uploads,
      client: {
        getSieveAccounts: () => [{ id: sieveAcct, name: sieveAcct, isPrimary: true }],
        getSieveAccountId: () => sieveAcct,
        getSieveCapabilities: () => ({ sieveExtensions: ['fileinto', 'include'] }),
        getSieveScripts: async () => { if (gate) await gate; return [{ id: sieveAcct === 'sA' ? 'a' : 'c', name: 'filters', blobId: 'blob-' + sieveAcct, isActive: true }]; },
        getSieveScriptContent: async () => script,
        updateSieveScript: async (id: string, content: string, _act: boolean, account?: string) => { uploads.push({ id, content, account }); },
        createSieveScript: async () => ({ id: 'new' }),
      },
    };
  };
  const A = mk('sA', scriptA, gateA.promise);
  const B = mk('sB', scriptB);

  const fA = useFilterStore.getState().fetchFilters(A.client as never); // in flight for A
  useFilterStore.getState().clearState();                               // switch → clearAllStores
  await useFilterStore.getState().selectAccount(B.client as never, 'sB'); // B's filters page loads
  gateA.resolve();
  await fA;
  const s = useFilterStore.getState();
  expect(s.selectedAccountId).toBe('sB');
  expect(s.activeScriptId).toBe('c');
  expect(s.rawScript).not.toContain('bookkeeper@a.example');
  await useFilterStore.getState().saveFilters(B.client as never);      // user toggles a rule in B
  expect(B.uploads[0].account).toBe('sB');
  expect(B.uploads[0].content).not.toContain('bookkeeper@a.example');
});
