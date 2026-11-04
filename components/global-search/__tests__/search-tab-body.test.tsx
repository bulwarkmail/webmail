import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarHit, MailHit, SearchProvider } from '@/lib/global-search/types';
import { useProTabStore, normalizeProTabState, type ProTabCoreState } from '@/stores/pro-tab-store';

// Deterministic providers: one mail hit, one calendar hit, per remote call.
function mailHit(): MailHit {
  return {
    kind: 'mail', localAccountId: 'login-a', jmapAccountId: 'j', id: 'm1', accountLabel: 'Work',
    title: 'Q1 numbers', subtitle: 'Inbox', date: '2026-08-31T10:00:00Z', source: 'remote',
    email: { id: 'm1', from: [{ name: 'Dev User', email: 'dev@localhost' }] } as unknown as MailHit['email'],
    snippet: null,
  };
}
function calendarHit(): CalendarHit {
  return {
    kind: 'calendar', localAccountId: 'login-a', jmapAccountId: 'j', id: 'evt-002', accountLabel: 'Work',
    title: 'Sprint Planning', subtitle: 'Work · Room A', date: '2026-09-07T10:30:00', source: 'remote',
    // No uid - mirrors the dev mock's fixtures, where series dedupe can't use it.
    event: { id: 'evt-002', title: 'Sprint Planning' } as unknown as CalendarHit['event'],
    isRecurring: true,
  };
}
const providers: SearchProvider[] = [
  {
    kind: 'mail', supports: () => true, local: () => [],
    remote: async () => ({ hits: [mailHit()], hasMore: false }),
  },
  {
    kind: 'calendar', supports: () => true, local: () => [],
    remote: async () => ({ hits: [calendarHit()], hasMore: false }),
  },
];

vi.mock('@/lib/global-search/providers', () => ({
  get GLOBAL_SEARCH_PROVIDERS() { return providers; },
}));
vi.mock('@/lib/global-search/accounts', () => ({
  getSearchAccounts: () => [{ localAccountId: 'login-a', label: 'Work', email: 'a@x', client: {} }],
  getActiveLocalAccountId: () => 'login-a',
  indexAccounts: (accounts: Array<{ localAccountId: string }>) => new Map(accounts.map((a) => [a.localAccountId, a])),
}));
vi.mock('@/lib/global-search/open-hit', () => ({ openHit: vi.fn() }));
vi.mock('@/stores/account-store', () => {
  const state = { accounts: [{ id: 'login-a', label: 'Work', email: 'a@x', isConnected: true }] };
  const hook = (sel?: (s: typeof state) => unknown) => (typeof sel === 'function' ? sel(state) : state);
  hook.getState = () => state;
  return { useAccountStore: hook };
});
vi.mock('@/stores/auth-store', () => {
  const state = { activeAccountId: 'login-a', client: {}, getClientForAccount: () => undefined };
  const hook = (sel?: (s: typeof state) => unknown) => (typeof sel === 'function' ? sel(state) : state);
  hook.getState = () => state;
  return { useAuthStore: hook };
});
// The mail preview embeds the full email view; not under test here.
vi.mock('@/components/pro/pro-email-tab-body', () => ({
  ProEmailView: () => React.createElement('div', { 'data-testid': 'mail-preview' }),
}));

import { SearchTabBody } from '../search-tab-body';
import { openHit } from '@/lib/global-search/open-hit';
import { PaneSizeContext } from '@/hooks/use-pane-size';

/** Renders the tab the way the Pro page does: data flows from the tab store. */
function Harness({ tabId }: { tabId: string }) {
  const tab = useProTabStore((s) => s.tabs.find((t) => t.id === tabId));
  if (!tab?.searchData) return null;
  return <SearchTabBody tabId={tabId} data={tab.searchData} />;
}

function resetTabs() {
  useProTabStore.setState(normalizeProTabState({
    tabs: [], activeTabId: '', activeSplitTabId: null, focusedPaneId: 'main',
    splitOrientation: null, splitSide: 'right', readerTabId: null, loadedTabIds: [],
  } as ProTabCoreState));
}

const rowCount = (kind: string) => document.querySelectorAll(`[data-hit-kind="${kind}"]`).length;

describe('SearchTabBody scope switching', () => {
  beforeEach(() => {
    resetTabs();
  });

  it('does not accumulate duplicate rows across repeated scope switches', async () => {
    const tabId = useProTabStore.getState().openSearchTab({ query: 'Ann', scope: 'all', accountId: null, title: 'Ann' });
    render(<Harness tabId={tabId} />);

    await waitFor(() => expect(rowCount('calendar')).toBe(1), { timeout: 5000 });
    expect(rowCount('mail')).toBe(1);

    // Flip Search-in several times: all -> mail -> all -> mail -> all.
    for (const scope of ['scope_mail', 'scope_all', 'scope_mail', 'scope_all'] as const) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${scope}`) }));
      // Let the debounce + fetch settle before the next flip.
      await waitFor(() => {
        if (scope === 'scope_mail') {
          expect(rowCount('mail')).toBe(1);
          expect(rowCount('calendar')).toBe(0);
        } else {
          expect(rowCount('mail')).toBe(1);
          expect(rowCount('calendar')).toBe(1);
        }
      }, { timeout: 5000 });
    }
  });

  it('does not accumulate rows in the flat view either', async () => {
    const tabId = useProTabStore.getState().openSearchTab({ query: 'Ann', scope: 'all', accountId: null, title: 'Ann' });
    render(<Harness tabId={tabId} />);
    await waitFor(() => expect(rowCount('calendar')).toBe(1), { timeout: 5000 });

    fireEvent.click(screen.getByRole('button', { name: /flat_by_date/ }));
    await waitFor(() => expect(rowCount('calendar')).toBe(1));
    expect(rowCount('mail')).toBe(1);

    for (const scope of ['scope_mail', 'scope_all', 'scope_mail', 'scope_all'] as const) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${scope}`) }));
      await waitFor(() => {
        expect(rowCount('mail')).toBe(1);
        expect(rowCount('calendar')).toBe(scope === 'scope_mail' ? 0 : 1);
      }, { timeout: 5000 });
    }
  });
});

describe('SearchTabBody in a narrow pane', () => {
  beforeEach(() => {
    resetTabs();
    vi.mocked(openHit).mockClear();
  });

  const renderInPane = async (width: number) => {
    const tabId = useProTabStore.getState().openSearchTab({ query: 'Ann', scope: 'all', accountId: null, title: 'Ann' });
    render(<PaneSizeContext.Provider value={width}><Harness tabId={tabId} /></PaneSizeContext.Provider>);
    await waitFor(() => expect(rowCount('mail')).toBe(1), { timeout: 5000 });
    return document.querySelector<HTMLElement>('[data-hit-kind="mail"]')!;
  };

  it('opens a hit on click where no preview fits', async () => {
    const row = await renderInPane(500);
    fireEvent.click(row);
    expect(openHit).toHaveBeenCalledTimes(1);
  });

  it('only selects it where the preview shows', async () => {
    const row = await renderInPane(1100);
    fireEvent.click(row);
    expect(openHit).not.toHaveBeenCalled();
  });
});
