import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { useToastStore } from '@/stores/toast-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { resetDesktopCommands, runDesktopCommand } from '@/lib/desktop/commands';
import { useMoveDialogStore } from '@/components/email/move-to-dialog';

// The desktop app's Message menu with several messages selected: each line acts on all
// of them, or isn't offered. Reply to one of seven, or Move for the open one only, acts on
// mail nobody picked (usability pass 2, desktop-p2-3).

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

const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 3, unreadEmails: 0, myRights: { mayRemoveItems: true, mayAddItems: true } } as unknown as Mailbox;
const later = { id: 'later', name: 'Read later', role: null, totalEmails: 0, unreadEmails: 0, myRights: { mayRemoveItems: true, mayAddItems: true } } as unknown as Mailbox;
const message = (id: string) => ({ id, threadId: `t-${id}`, subject: `Subject ${id}`, receivedAt: '2026-10-31T10:00:00Z', keywords: { $seen: true }, mailboxIds: { inbox: true } }) as unknown as Email;
const [a, b, c] = ['a', 'b', 'c'].map(message);

let reported: Record<string, unknown> = {};
let named: string[] = [];
let batchMoveToMailbox: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));
  reported = {};
  named = [];
  (window as unknown as { bulwarkDesktop: unknown }).bulwarkDesktop = {
    version: 1,
    platform: 'win32',
    menu: { setState: (state: Record<string, unknown>) => { reported = state; }, onCommand: () => () => {} },
    windows: { setMenuName: (name: string) => { named.push(name); } },
  };
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
  useSettingsStore.setState({ enableUnifiedMailbox: false, interfaceLayout: 'default', mailLayout: 'split', proInterface: false, disableThreading: false } as never);
  batchMoveToMailbox = vi.fn().mockResolvedValue(true);
  useEmailStore.setState({
    emails: [a, b, c], selectedEmail: a, selectedMailbox: 'inbox', selectedKeyword: null, mailboxes: [inbox, later],
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '', isAdvancedSearchOpen: false,
    selectedEmailKeys: new Set(['a', 'b', 'c']), unreadSection: null, threadEmailsCache: new Map(), error: null,
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
    fetchEmailContent: vi.fn().mockResolvedValue(undefined),
    refreshCurrentMailbox: vi.fn().mockResolvedValue(undefined),
    batchMoveToMailbox,
  } as never);
});
afterEach(() => {
  cleanup();
  resetDesktopCommands();
  useMoveDialogStore.setState({ request: null });
  delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the Message menu with three messages selected', () => {
  it('offers no Reply, Reply all or Forward, which would act on one of them', async () => {
    render(<MailApp />);
    await waitFor(() => expect(reported['message.archive']).toBe(true));
    expect(reported['message.reply']).toBe(false);
    expect(reported['message.replyAll']).toBe(false);
    expect(reported['message.forward']).toBe(false);
    expect(reported['message.openWindow']).toBe(false);
    expect(reported['message.move']).toBe(true);
  });

  // desktop-p3-14: Star was greyed for a selection while the selection view beside it offered Star.
  it('Star stars all three, as the selection view does, and says Remove star once all have one', async () => {
    const batchSetStarred = vi.fn().mockResolvedValue(true);
    useEmailStore.setState({ batchSetStarred } as never);
    render(<MailApp />);
    await waitFor(() => expect(reported['message.star']).toEqual({ enabled: true, checked: false }));
    act(() => { runDesktopCommand('message.star'); });
    await waitFor(() => expect(batchSetStarred).toHaveBeenCalledWith(expect.anything(), true));
    cleanup();
    const starred = (email: Email) => ({ ...email, keywords: { ...email.keywords, $flagged: true } }) as Email;
    useEmailStore.setState({ emails: [starred(a), starred(b), starred(c)] } as never);
    render(<MailApp />);
    await waitFor(() => expect(reported['message.star']).toEqual({ enabled: true, checked: true }));
    act(() => { runDesktopCommand('message.star'); });
    await waitFor(() => expect(batchSetStarred).toHaveBeenCalledWith(expect.anything(), false));
  });

  it('Move to… moves all three, and the toast says how many', async () => {
    render(<MailApp />);
    await waitFor(() => expect(reported['message.move']).toBe(true));
    act(() => { runDesktopCommand('message.move'); });
    const request = useMoveDialogStore.getState().request;
    expect(request?.emails.map((email) => email.id)).toEqual(['a', 'b', 'c']);
    await act(async () => { request!.onMove('later'); });
    await waitFor(() => expect(batchMoveToMailbox).toHaveBeenCalledWith(expect.anything(), 'later', undefined, expect.any(Array)));
    // Three conversations are selected, so the toast counts conversations (mail-p3-7).
    await waitFor(() => expect(useToastStore.getState().toasts.map((toast) => toast.title)).toContain('mail_p2_list.conversations_moved_to'));
  });

  it('with conversations off, Move to… counts emails', async () => {
    useSettingsStore.setState({ disableThreading: true } as never);
    render(<MailApp />);
    await waitFor(() => expect(reported['message.move']).toBe(true));
    act(() => { runDesktopCommand('message.move'); });
    await act(async () => { useMoveDialogStore.getState().request!.onMove('later'); });
    await waitFor(() => expect(useToastStore.getState().toasts.map((toast) => toast.title)).toContain('mail_list_extra.moved_count_to'));
  });

  it('with one message open and none selected, Reply and Move are for that one', async () => {
    useEmailStore.setState({ selectedEmailKeys: new Set() } as never);
    render(<MailApp />);
    await waitFor(() => expect(reported['message.reply']).toBe(true));
    // Star says whether that one has a star (desktop-p3-14).
    expect(reported['message.star']).toEqual({ enabled: true, checked: false });
    expect(reported['message.move']).toBe(true);
    act(() => { runDesktopCommand('message.move'); });
    expect(useMoveDialogStore.getState().request).toBeNull();
    expect(batchMoveToMailbox).not.toHaveBeenCalled();
  });
});

describe('the Window menu name of the main window', () => {
  it('is the folder, not the message open in it, so it never reads like the window of that message', async () => {
    useEmailStore.setState({ selectedEmailKeys: new Set() } as never);
    render(<MailApp />);
    await waitFor(() => expect(named.at(-1)).toBe('sidebar.mailboxes.inbox'));
    expect(named).not.toContain('Subject a');
  });
});
