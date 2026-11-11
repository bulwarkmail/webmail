import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { useProTabStore } from '@/stores/pro-tab-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { handOffDraft, handOffNewMessage } from '@/lib/launch-handoff';
import { commitReturnedComposer, offerReturnedComposer, takeReturnedComposer } from '@/lib/popout/return-to-main';
import { EmbeddedContext } from '@/hooks/use-is-embedded';
import type { ComposePopoutPayload } from '@/lib/popout/compose-payload';

// "Always write messages in a new window" in the desktop app: a composer that would open
// in the main window opens in a window of its own, and the main window shows none.

const routing = vi.hoisted(() => ({
  on: true,
  calls: [] as { payload: ComposePopoutPayload; notShown: () => void }[],
}));
vi.mock('@/lib/popout/compose-in-window', () => ({
  composeInWindowHere: () => routing.on,
  openComposerInWindow: (payload: ComposePopoutPayload, { notShown }: { notShown: () => void }) => {
    if (!routing.on) return false;
    routing.calls.push({ payload, notShown });
    return true;
  },
}));

const seen = vi.hoisted(() => ({ sourceEmailId: undefined as string | undefined }));

vi.mock('@/components/email/email-composer', async () => {
  const { useEffect, useRef, useState } = await import('react');
  const { registerComposeFlush } = await import('@/lib/compose-flush-registry');
  return {
    EmailComposer: ({ initialData, onSaveState, onSend, sourceEmailId }: {
      initialData?: { subject?: string; mode?: string } | null;
      onSaveState: (data: { subject: string; mode?: string }) => void;
      onSend: (data: { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string }) => Promise<unknown>;
      sourceEmailId?: string;
    }) => {
      seen.sourceEmailId = sourceEmailId;
      useEffect(() => registerComposeFlush(async () => {}), []);
      const [subject, setSubject] = useState(initialData?.subject ?? '');
      const initial = useRef(subject);
      const latest = useRef(subject);
      latest.current = subject;
      useEffect(() => () => {
        if (latest.current !== initial.current) onSaveState({ subject: latest.current, mode: initialData?.mode });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return (
        <>
          <input aria-label="stub subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          <button onClick={() => void onSend({ to: ['a@example.org'], cc: [], bcc: [], subject, body: 'x' })}>stub send</button>
        </>
      );
    },
  };
});
vi.mock('@/components/layout/mv-top-bar', () => ({ MvTopBar: () => null }));
vi.mock('@/components/layout/sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/search/mv-search-form', () => ({ MvSearchForm: () => null }));
vi.mock('@/components/email/email-viewer', () => ({ EmailViewer: () => <div>message viewer</div> }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/calendar-event-notification-toaster', () => ({ CalendarEventNotificationToaster: () => null }));
vi.mock('@/components/layout/share-notification-toaster', () => ({ ShareNotificationToaster: () => null }));
vi.mock('@/components/layout/mobile-header', () => ({ MobileHeader: () => null }));
vi.mock('@/components/layout/mv-side-panel', () => ({ MvSidePanel: () => null }));
vi.mock('@/components/email/message-list-tabs', () => ({ useMessageListPanelProps: (id: string) => ({ id }), MessageListTabs: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => null }));
vi.mock('@/components/tour/tour-provider', () => ({ useTour: () => ({ activeTour: null, registerStep: vi.fn() }) }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail' }) }));
vi.mock('@/hooks/use-identity-sync', () => ({ useIdentitySync: () => {} }));
vi.mock('@/hooks/use-pro-multi-account-identities', () => ({ useProMultiAccountIdentities: () => [] }));
vi.mock('@/hooks/use-pro-multi-account-mailboxes', () => ({ useProMultiAccountMailboxes: () => {} }));
vi.mock('@/hooks/use-wopi-status', () => ({ useWopiStatus: () => null, canWopiOpen: () => false }));
vi.mock('@/hooks/use-browser-navigation', () => ({ useBrowserNavigation: () => {} }));
// A compact desktop: rail and folders beside the list, the composer in the pane.
const device = vi.hoisted(() => ({ current: { isMobile: false, isCompact: true, isDesktop: true } }));
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => device.current,
  useMediaQuery: () => false,
  useIsDesktop: () => true,
  atLeast: (px: number) => `(width >= ${px}px)`,
  PHONE_BELOW: 600,
}));
vi.mock('@/lib/push-bindings', () => ({ reconcilePushBindings: () => {}, releasePushBindings: () => {} }));
vi.mock('@/components/email/email-list', () => ({ EmailList: () => <div>message list</div> }));

const { MailApp } = await import('../mail-app');

const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 1, unreadEmails: 0 } as Mailbox;
const messageB = { id: 'b', threadId: 't-b', subject: 'B', receivedAt: '2026-10-31T10:00:00Z', keywords: { $seen: true }, mailboxIds: { inbox: true } } as unknown as Email;
const SOURCE_OF_A = { clientAccountId: 'login-a', accountId: 'shared' };

let markEmailKeyword: ReturnType<typeof vi.fn>;

beforeEach(() => {
  routing.on = true;
  routing.calls = [];
  seen.sourceEmailId = undefined;
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  const client = {
    getAccountId: () => 'acc', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: () => client as never,
    getAllConnectedClients: () => new Map([['login-a', client]]) as never,
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, interfaceLayout: 'default', mailLayout: 'split', proInterface: false } as never);
  markEmailKeyword = vi.fn().mockResolvedValue(undefined);
  useEmailStore.setState({
    emails: [messageB], selectedEmail: messageB, selectedMailbox: 'inbox', selectedKeyword: null, mailboxes: [inbox],
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '', isAdvancedSearchOpen: false,
    selectedEmailKeys: new Set(), unreadSection: null,
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
    fetchEmailContent: vi.fn().mockResolvedValue(undefined),
    sendEmail: vi.fn().mockResolvedValue({ scheduled: false }),
    refreshCurrentMailbox: vi.fn().mockResolvedValue(undefined),
    markEmailKeyword,
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterEach(() => {
  takeReturnedComposer();
  cleanup();
  useProTabStore.setState({ tabs: [], activeTabId: null } as never);
});

const settle = async (ms = 20) => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
};

const showsMail = async () => {
  await screen.findByText('message list');
  await settle();
};

describe('always write messages in a new window', () => {
  it('a new message opens in its window, and nothing opens here', async () => {
    render(<MailApp />);
    await showsMail();
    act(() => handOffNewMessage());
    await waitFor(() => expect(routing.calls).toHaveLength(1));
    expect(routing.calls[0].payload.mode).toBe('compose');
    await settle();
    expect(screen.queryByLabelText('stub subject')).toBeNull();
    expect(screen.getByText('message viewer')).toBeTruthy();
  });

  it('a reply takes the message it answers along', async () => {
    render(<MailApp />);
    await showsMail();
    fireEvent.keyDown(document, { key: 'r' });
    await waitFor(() => expect(routing.calls).toHaveLength(1));
    const { payload } = routing.calls[0];
    expect(payload.mode).toBe('reply');
    expect(payload.sourceEmailId).toBe('b');
    expect(payload.replyTo?.subject).toBe('B');
    await settle();
    expect(screen.queryByLabelText('stub subject')).toBeNull();
  });

  it('opens here after all when the window never shows it, with what it opened with', async () => {
    render(<MailApp />);
    await showsMail();
    act(() => handOffDraft({ subject: 'Shared page' }));
    await waitFor(() => expect(routing.calls).toHaveLength(1));
    expect(routing.calls[0].payload.initialData?.subject).toBe('Shared page');
    expect(screen.queryByLabelText('stub subject')).toBeNull();
    act(() => routing.calls[0].notShown());
    expect(await screen.findByLabelText('stub subject')).toHaveProperty('value', 'Shared page');
    await settle();
    // Once: it doesn't go back out to another window.
    expect(routing.calls).toHaveLength(1);
  });

  it('with the setting off, the composer opens here', async () => {
    routing.on = false;
    render(<MailApp />);
    await showsMail();
    act(() => handOffDraft({ subject: 'Written here' }));
    expect(await screen.findByLabelText('stub subject')).toHaveProperty('value', 'Written here');
  });

  it('a composer coming back from its window stays here', async () => {
    render(<MailApp />);
    await showsMail();
    const answer = vi.fn();
    act(() => offerReturnedComposer({
      returnId: 'r1',
      payload: { mode: 'reply', sourceEmailId: 'a', sourceEmailSource: SOURCE_OF_A, initialData: { subject: 'Re: A', mode: 'reply' } as never },
      answer,
      sendReady: () => commitReturnedComposer('r1'),
    }));
    expect(await screen.findByLabelText('stub subject')).toHaveProperty('value', 'Re: A');
    await waitFor(() => expect(answer).toHaveBeenCalledWith('shown'));
    expect(routing.calls).toHaveLength(0);
  });

  it('under Pro it opens in its window instead of a tab', async () => {
    render(<EmbeddedContext.Provider value><MailApp /></EmbeddedContext.Provider>);
    await showsMail();
    act(() => handOffDraft({ subject: 'Under Pro' }));
    await waitFor(() => expect(routing.calls).toHaveLength(1));
    await settle();
    expect(useProTabStore.getState().tabs.some((tab) => tab.kind === 'compose')).toBe(false);

    act(() => routing.calls[0].notShown());
    const tab = useProTabStore.getState().tabs.find((candidate) => candidate.kind === 'compose');
    expect(tab?.composeData?.initialData?.subject).toBe('Under Pro');
  });
});
