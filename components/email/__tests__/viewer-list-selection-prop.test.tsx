import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// The reader panel hears which messages are ticked in the list
// (`listSelection`), so the AI assistant can work on several at once.

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
const seen: Record<string, unknown>[] = [];
vi.mock('@/components/plugins/plugin-slot', () => ({
  PluginSlot: ({ name, extraProps }: { name: string; extraProps?: Record<string, unknown> }) => {
    if (name === 'email-detail-sidebar' && extraProps) seen.push(extraProps);
    return React.createElement('div', { 'data-slot': name });
  },
}));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({
  usePluginSlotOffers: (slot: string) => (slot === 'email-detail-sidebar' ? [{ pluginId: 'p', order: 100 }] : []),
}));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const { EmailViewer } = await import('../email-viewer');
const { useEmailStore } = await import('@/stores/email-store');
const { useAuthStore } = await import('@/stores/auth-store');

const mailboxes = [{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } }] as unknown as Mailbox[];
const row = (id: string) => ({
  id, threadId: `t-${id}`, mailboxIds: { inbox: true }, keywords: {}, subject: id, receivedAt: '2026-01-01T00:00:00Z',
  from: [{ name: 'Bob', email: 'bob@example.org' }], preview: '', hasAttachment: false, size: 1,
} as unknown as Email);

const client = { getAccountId: () => 'acc1' } as unknown as IJMAPClient;

afterEach(() => {
  cleanup();
  seen.length = 0;
  useEmailStore.setState({ emails: [], selectedEmailKeys: new Set() });
  useAuthStore.setState({ client: null });
});

describe('the reader panel prop listSelection', () => {
  it('names the ticked messages when two or more are, and is null otherwise', () => {
    useAuthStore.setState({ client });
    useEmailStore.setState({ emails: [row('a'), row('b'), row('c')], selectedEmailKeys: new Set(['a']), selectedMailbox: 'inbox', mailboxes });
    render(<EmailViewer email={null} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onDelete={() => {}} />);
    expect(seen.at(-1)).toMatchObject({ listSelection: null });

    act(() => { useEmailStore.setState({ selectedEmailKeys: new Set(['a', 'c', 'b']) }); });
    expect(seen.at(-1)?.listSelection).toEqual({
      emails: [{ id: 'a', accountId: 'acc1' }, { id: 'b', accountId: 'acc1' }, { id: 'c', accountId: 'acc1' }],
      total: 3,
    });

    // New mail arriving doesn't hand the panel a new object for the same selection.
    const before = seen.at(-1)?.listSelection;
    act(() => { useEmailStore.setState({ emails: [row('new'), row('a'), row('b'), row('c')] }); });
    expect(seen.at(-1)?.listSelection).toBe(before);
  });

  it('does not render the reader again when the list changes but the ticks do not', () => {
    useAuthStore.setState({ client });
    useEmailStore.setState({ emails: [row('a'), row('b')], selectedEmailKeys: new Set(['a', 'b']), selectedMailbox: 'inbox', mailboxes });
    render(<EmailViewer email={null} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onDelete={() => {}} />);
    const renders = seen.length;
    act(() => { useEmailStore.setState({ emails: [row('new'), row('a'), row('b')] }); });
    act(() => { useEmailStore.setState({ emails: [row('newer'), row('new'), row('a'), row('b')], threadEmailsCache: new Map() }); });
    expect(seen.length).toBe(renders);
    // A new tick does.
    act(() => { useEmailStore.setState({ selectedEmailKeys: new Set(['a', 'b', 'new']) }); });
    expect(seen.length).toBeGreaterThan(renders);
  });

  it('gives a panel outside the main list (a Pro tab) no ticks', () => {
    useAuthStore.setState({ client });
    useEmailStore.setState({ emails: [row('a'), row('b')], selectedEmailKeys: new Set(['a', 'b']), selectedMailbox: 'inbox', mailboxes });
    render(<EmailViewer email={null} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onDelete={() => {}} withListSelection={false} />);
    expect(seen.at(-1)).toMatchObject({ listSelection: null });
  });
});
