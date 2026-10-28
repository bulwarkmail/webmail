import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox, StateChange } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { createFakeBrowser, deferred, settle, type FakeTab } from '@/lib/__tests__/helpers/fake-tabs';

// Every open tab gets the same push and used to re-count the sidebar tag
// badges on its own, two server queries per tag in each tab. Tabs of one
// login now take turns and share the counts.

const inbox = { id: 'inbox', role: 'inbox', isShared: false } as Mailbox;
type Counts = Awaited<ReturnType<IJMAPClient['getTagCounts']>>;

function makeClient(accountId: string, counts: () => Promise<Counts>) {
  const getTagCounts = vi.fn<IJMAPClient['getTagCounts']>(counts);
  return {
    getEmails: vi.fn(async () => ({ emails: [], total: 0, hasMore: false, state: 'list-state' })),
    getThreads: vi.fn(async () => []),
    getTagCounts,
    getAccountId: () => accountId,
    getServerUrl: () => 'https://mail.example.com',
  } as unknown as IJMAPClient & { getTagCounts: typeof getTagCounts };
}

// A tab is its own copy of the stores, wired to its own end of the fake
// browser's locks and channel.
async function openTab(tab: FakeTab) {
  vi.resetModules();
  vi.stubGlobal('BroadcastChannel', class { constructor() { return tab.channel; } });
  Object.defineProperty(navigator, 'locks', { value: tab.locks, configurable: true });
  const { useEmailStore } = await import('../email-store');
  const { useSettingsStore } = await import('../settings-store');
  useSettingsStore.setState({ emailKeywords: [{ id: 'work', label: 'Work', color: 'blue' }] } as never);
  useEmailStore.setState({ selectedMailbox: 'inbox', mailboxes: [inbox] });
  return useEmailStore;
}

const push = (accountId: string, state: string): StateChange =>
  ({ '@type': 'StateChange', changed: { [accountId]: { Email: state } } });

describe('tag counts after a push, across tabs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'locks');
  });

  it('counts once and hands the result to the other tab', async () => {
    const browser = createFakeBrowser();
    const storeA = await openTab(browser.openTab());
    const storeB = await openTab(browser.openTab());
    const slow = deferred<Counts>();
    const clientA = makeClient('me', () => slow.promise);
    const clientB = makeClient('me', async () => ({ work: { total: 9, unread: 9 } }));

    const pushA = storeA.getState().handleStateChange(push('me', 's2'), clientA);
    const pushB = storeB.getState().handleStateChange(push('me', 's2'), clientB);
    await Promise.all([pushA, pushB]);
    await settle();
    slow.resolve({ work: { total: 4, unread: 1 } });
    await settle();

    expect(clientA.getTagCounts).toHaveBeenCalledTimes(1);
    expect(clientB.getTagCounts).not.toHaveBeenCalled();
    expect(storeA.getState().tagCounts).toEqual({ work: { total: 4, unread: 1 } });
    expect(storeB.getState().tagCounts).toEqual({ work: { total: 4, unread: 1 } });
  });

  it('counts in the other tab when the counting tab closes first', async () => {
    const browser = createFakeBrowser();
    const tabA = browser.openTab();
    const storeA = await openTab(tabA);
    const storeB = await openTab(browser.openTab());
    const clientA = makeClient('me', () => new Promise<Counts>(() => {}));
    const clientB = makeClient('me', async () => ({ work: { total: 2, unread: 0 } }));

    await storeA.getState().handleStateChange(push('me', 's2'), clientA);
    await storeB.getState().handleStateChange(push('me', 's2'), clientB);
    await settle();
    expect(clientB.getTagCounts).not.toHaveBeenCalled();

    tabA.close();
    await vi.waitFor(() => expect(clientB.getTagCounts).toHaveBeenCalledTimes(1));
    expect(storeB.getState().tagCounts).toEqual({ work: { total: 2, unread: 0 } });
  });

  it('keeps the tabs of different logins apart', async () => {
    const browser = createFakeBrowser();
    const storeA = await openTab(browser.openTab());
    const storeB = await openTab(browser.openTab());
    const clientA = makeClient('me', () => new Promise<Counts>(() => {}));
    const clientB = makeClient('other', async () => ({ work: { total: 1, unread: 1 } }));

    await storeA.getState().handleStateChange(push('me', 's2'), clientA);
    await storeB.getState().handleStateChange(push('other', 's2'), clientB);
    await settle();
    expect(clientB.getTagCounts).toHaveBeenCalledTimes(1);
    expect(storeB.getState().tagCounts).toEqual({ work: { total: 1, unread: 1 } });
  });
});
