import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { handOffComposeTab, useProTabStore } from '@/stores/pro-tab-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { emailHooks } from '@/lib/plugin-hooks';
import { handOffNewMessage } from '@/lib/launch-handoff';
import { commitReturnedComposer, dropReturnedComposer, offerReturnedComposer, takeReturnedComposer } from '@/lib/popout/return-to-main';
import { EmbeddedContext } from '@/hooks/use-is-embedded';

// A reply crossing between a Pro compose tab and the standard composer answers
// the message it was started from. The message selected in the mail list can be
// another one, and it must not get the $answered flag.

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

function handOffReply(composeData: { sourceEmailId?: string | null; sourceEmailSource?: typeof SOURCE_OF_A | null }) {
  useProTabStore.setState({
    tabs: [
      { id: 'home-mail', kind: 'mail', labelKey: 'mail', closeable: false, paneId: 'main' },
      {
        id: 'c1', kind: 'compose', labelKey: '', closeable: true, paneId: 'main',
        composeData: { sessionId: 1, mode: 'reply', title: 'Re: A', initialData: { subject: 'Re: A', mode: 'reply' } as never, ...composeData },
      },
    ],
    activeTabId: 'c1',
  } as never);
  handOffComposeTab('c1');
}

beforeEach(() => {
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

describe('a reply handed from a Pro compose tab to the standard composer', () => {
  it('flags the message it answers, not the one selected in the list', async () => {
    handOffReply({ sourceEmailId: 'a', sourceEmailSource: SOURCE_OF_A });
    render(<MailApp />);
    await screen.findByLabelText('stub subject');
    expect(seen.sourceEmailId).toBe('a');

    fireEvent.click(screen.getByText('stub send'));
    await waitFor(() => expect(markEmailKeyword).toHaveBeenCalled());
    expect(markEmailKeyword).toHaveBeenCalledTimes(1);
    expect(markEmailKeyword).toHaveBeenCalledWith(expect.anything(), 'a', '$answered', SOURCE_OF_A);
  });

  it('flags nothing when the tab did not know its message', async () => {
    handOffReply({});
    render(<MailApp />);
    await screen.findByLabelText('stub subject');
    expect(seen.sourceEmailId).toBeUndefined();

    fireEvent.click(screen.getByText('stub send'));
    await waitFor(() => expect(useEmailStore.getState().sendEmail).toHaveBeenCalled());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(markEmailKeyword).not.toHaveBeenCalled();
  });

  it('takes its message along when the window widens back into Pro', async () => {
    handOffReply({ sourceEmailId: 'a', sourceEmailSource: SOURCE_OF_A });
    const view = render(<MailApp />);
    fireEvent.change(await screen.findByLabelText('stub subject'), { target: { value: 'Re: A, typed' } });

    useSettingsStore.setState({ proInterface: true } as never);
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));
    view.unmount();

    const tab = useProTabStore.getState().tabs.find((t) => t.kind === 'compose');
    expect(tab?.composeData?.initialData?.subject).toBe('Re: A, typed');
    expect(tab?.composeData?.sourceEmailId).toBe('a');
    expect(tab?.composeData?.sourceEmailSource).toEqual(SOURCE_OF_A);
  });
});

describe('a composer coming back from its own window', () => {
  const REPLY = { mode: 'reply' as const, sourceEmailId: 'a', sourceEmailSource: SOURCE_OF_A, initialData: { subject: 'Re: A', mode: 'reply' } as never };

  afterEach(() => {
    takeReturnedComposer();
    cleanup();
    useProTabStore.setState({ tabs: [], activeTabId: null } as never);
  });

  function comeBack(id: string, payload: Parameters<typeof offerReturnedComposer>[0]['payload'] = REPLY, ready: 'commit' | 'silent' = 'commit') {
    const answer = vi.fn();
    act(() => offerReturnedComposer({ returnId: id, payload, answer, sendReady: () => { if (ready === 'commit') commitReturnedComposer(id); } }));
    return answer;
  }

  const showsMail = async () => {
    await screen.findByText('message list');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  };

  it('opens with its text, says so, and answers its own message', async () => {
    render(<MailApp />);
    await showsMail();
    const answer = comeBack('r1');
    expect(await screen.findByLabelText('stub subject')).toHaveProperty('value', 'Re: A');
    await waitFor(() => expect(answer).toHaveBeenCalledWith('shown'));
    expect(seen.sourceEmailId).toBe('a');
  });

  // Mountain View docks the composer of a desktop in its own window; on a
  // phone it fills the reading pane as in the default layout.
  it('under Mountain View too', async () => {
    useSettingsStore.setState({ interfaceLayout: 'mountain-view' } as never);
    device.current = { isMobile: true, isCompact: false, isDesktop: false };
    render(<MailApp />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    const answer = comeBack('r1');
    expect(await screen.findByLabelText('stub subject')).toHaveProperty('value', 'Re: A');
    await waitFor(() => expect(answer).toHaveBeenCalledWith('shown'));
    expect(seen.sourceEmailId).toBe('a');
    useSettingsStore.setState({ interfaceLayout: 'default' } as never);
    device.current = { isMobile: false, isCompact: true, isDesktop: true };
  });

  it('under Pro it becomes a tab that answers its own message, not the one selected in the list', async () => {
    render(<EmbeddedContext.Provider value><MailApp /></EmbeddedContext.Provider>);
    await showsMail();
    comeBack('r1');
    await waitFor(() => expect(useProTabStore.getState().tabs.some((tab) => tab.kind === 'compose')).toBe(true));
    const tab = useProTabStore.getState().tabs.find((candidate) => candidate.kind === 'compose');
    expect(tab?.composeData?.initialData?.subject).toBe('Re: A');
    expect(tab?.composeData?.sourceEmailId).toBe('a');
    expect(tab?.composeData?.sourceEmailSource).toEqual(SOURCE_OF_A);
  });

  it('a new message moved back under Pro answers nothing, whatever is selected', async () => {
    render(<EmbeddedContext.Provider value><MailApp /></EmbeddedContext.Provider>);
    await showsMail();
    comeBack('r1', { mode: 'compose', initialData: { subject: 'New', mode: 'compose' } as never });
    await waitFor(() => expect(useProTabStore.getState().tabs.some((tab) => tab.kind === 'compose')).toBe(true));
    const tab = useProTabStore.getState().tabs.find((candidate) => candidate.kind === 'compose');
    expect(tab?.composeData?.sourceEmailId).toBeNull();
    expect(tab?.composeData?.sourceEmailSource).toBeNull();
  });

  it('with one open already it says busy and leaves that one be', async () => {
    render(<MailApp />);
    await showsMail();
    comeBack('r1');
    const first = await screen.findByLabelText('stub subject');
    fireEvent.change(first, { target: { value: 'Being written' } });
    const answer = comeBack('r2', { mode: 'compose', initialData: { subject: 'Second', mode: 'compose' } as never });
    await waitFor(() => expect(answer).toHaveBeenCalledWith('busy'));
    expect(screen.getByLabelText('stub subject')).toHaveProperty('value', 'Being written');
  });

  it('a pop-out that gave up as this took it: nothing opens, so the draft has one owner', async () => {
    render(<MailApp />);
    await showsMail();
    const answer = comeBack('r1', REPLY, 'silent');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    act(() => dropReturnedComposer('r1'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.queryByLabelText('stub subject')).toBeNull();
    expect(answer).not.toHaveBeenCalledWith('shown');
  });

  it('a new message held up by a slow plugin gate says busy, and nothing replaces what comes after', async () => {
    let letThrough: (value: unknown) => void = () => {};
    const held = emailHooks.onBeforeCompose.register('test', ((options: unknown) => new Promise((resolve) => { letThrough = () => resolve(options); })) as never);
    try {
      render(<MailApp />);
      await showsMail();
      act(() => handOffNewMessage());
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      const answer = comeBack('r1');
      await waitFor(() => expect(answer).toHaveBeenCalledWith('busy'));
      expect(screen.queryByLabelText('stub subject')).toBeNull();
      await act(async () => { letThrough(undefined); await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(await screen.findByLabelText('stub subject')).toHaveProperty('value', '');
    } finally {
      held.dispose();
    }
  });

  it('a handoff arriving while it is being claimed waits for it, and takes nothing over', async () => {
    render(<MailApp />);
    await showsMail();
    const answer = comeBack('r1', REPLY, 'silent');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    act(() => handOffNewMessage());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.queryByLabelText('stub subject')).toBeNull();
    act(() => commitReturnedComposer('r1'));
    expect(await screen.findByLabelText('stub subject')).toHaveProperty('value', 'Re: A');
    await waitFor(() => expect(answer).toHaveBeenCalledWith('shown'));
  });
});
