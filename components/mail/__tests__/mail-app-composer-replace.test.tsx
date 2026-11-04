import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { useToastStore } from '@/stores/toast-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';

// One composer at a time (compose-p2-1, compose-p2-2). Another one opening
// while a composer is on screen closes that one the way its X does (save,
// "Draft saved"), then opens. It never crashes and never drops the text.

const device = vi.hoisted(() => ({ current: { isMobile: false, isTablet: false, isDesktop: true } }));
// What the stub composer's close does: 'saves' closes and lets the next one
// open, 'fails' keeps the composer (a save the server refused).
const stub = vi.hoisted(() => ({
  close: 'none' as 'none' | 'saves' | 'fails',
  closes: [] as string[],
  mounts: [] as string[],
}));

vi.mock('@/components/layout/mv-top-bar', () => ({ MvTopBar: () => null }));
vi.mock('@/components/layout/sidebar', () => ({
  Sidebar: ({ onCompose }: { onCompose: () => void }) => <button onClick={onCompose}>stub compose</button>,
}));
// As the real composer: it hands its state (its own mode, untouched) to the
// host as it unmounts without an explicit close, and offers its close.
vi.mock('@/components/email/email-composer', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    EmailComposer: ({ mode, onSaveState, onClose, requestCloseRef }: {
      mode: string;
      onSaveState: (data: Record<string, unknown>) => void;
      onClose: () => void;
      requestCloseRef?: { current: unknown };
    }) => {
      const closed = useRef(false);
      useEffect(() => {
        stub.mounts.push(mode);
        // The old host moved the composer between dock and pane for ever
        // (React error 185 in the browser); stop it here instead of hanging.
        if (stub.mounts.length > 40) throw new Error('composer remount loop');
        if (requestCloseRef && stub.close !== 'none') {
          requestCloseRef.current = (afterClose?: () => void) => {
            stub.closes.push(mode);
            if (stub.close === 'fails') return;
            closed.current = true;
            onClose();
            afterClose?.();
          };
        }
        return () => {
          if (requestCloseRef) requestCloseRef.current = null;
          if (closed.current) return;
          onSaveState({ to: '', cc: '', bcc: '', subject: '', body: '', mode, draftId: null, unedited: true });
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return <div data-testid="stub-composer" data-mode={mode}>stub composer</div>;
    },
  };
});
vi.mock('@/components/search/mv-search-form', () => ({
  MvSearchForm: ({ onSearch }: { onSearch: () => void }) => <button onClick={onSearch}>stub filter search</button>,
}));
vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: ({ onReply, onReplyAll, onForward }: { onReply: () => void; onReplyAll: () => void; onForward: () => void }) => (
    <div data-testid="viewer">
      message viewer
      <button onClick={() => onReply()}>stub reply</button>
      <button onClick={() => onReplyAll()}>stub reply all</button>
      <button onClick={() => onForward()}>stub forward</button>
    </div>
  ),
}));
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
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => device.current,
  useMediaQuery: () => false,
  useIsDesktop: () => true,
}));
vi.mock('@/lib/push-bindings', () => ({ reconcilePushBindings: () => {}, releasePushBindings: () => {} }));
vi.mock('@/components/email/email-list', () => ({
  EmailList: () => null,
}));

const { MailApp } = await import('../mail-app');

const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 0, unreadEmails: 0 } as Mailbox;
const MESSAGE = {
  id: 'm1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Ann', email: 'ann@example.org' }], to: [{ email: 'a@example.org' }],
  subject: 'Plans', receivedAt: '2026-11-01T10:00:00Z', preview: 'Hi', size: 10,
  hasAttachment: false, textBody: [], htmlBody: [], bodyValues: {},
} as never;

beforeEach(() => {
  device.current = { isMobile: false, isTablet: false, isDesktop: true };
  stub.close = 'none';
  stub.closes = [];
  stub.mounts = [];
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  const client = {
    getAccountId: () => 'acc', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    getEmail: vi.fn().mockResolvedValue(null),
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: () => client as never,
    getAllConnectedClients: () => new Map([['login-a', client]]) as never,
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, interfaceLayout: 'default', mailLayout: 'split' } as never);
  useEmailStore.setState({
    emails: [MESSAGE], selectedEmail: MESSAGE, selectedMailbox: 'inbox', selectedKeyword: null, mailboxes: [inbox],
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '', isAdvancedSearchOpen: false,
    selectedEmailKeys: new Set(), unreadSection: null,
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
  } as never);
  useToastStore.getState().clearToasts();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useToastStore.getState().clearToasts();
});

const composerMode = () => screen.getByTestId('stub-composer').getAttribute('data-mode');

describe('Compose while a reply is docked (compose-p2-1)', () => {
  for (const action of ['stub reply', 'stub forward']) {
    it(`opens a new message in the pane after ${action}`, async () => {
      render(<MailApp />);
      fireEvent.click(await screen.findByText(action));
      const reply = await screen.findByTestId('stub-composer');
      expect(reply.closest('[data-reply-dock]')).not.toBeNull();

      fireEvent.click(screen.getByText('stub compose'));
      await waitFor(() => expect(composerMode()).toBe('compose'));
      // The new message takes the pane, not the dock, and stays put.
      expect(screen.getByTestId('stub-composer').closest('[data-reply-dock]')).toBeNull();
      const mounted = stub.mounts.length;
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(stub.mounts.length).toBe(mounted);
      expect(composerMode()).toBe('compose');
    });
  }
});

describe('another composer while one is open (compose-p2-2)', () => {
  it('closes the reply through its own close (save, "Draft saved") before Compose opens', async () => {
    stub.close = 'saves';
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub reply'));
    await screen.findByTestId('stub-composer');

    fireEvent.click(screen.getByText('stub compose'));
    await waitFor(() => expect(composerMode()).toBe('compose'));
    expect(stub.closes).toEqual(['reply']);
  });

  for (const [action, mode] of [['stub reply all', 'replyAll'], ['stub forward', 'forward']] as const) {
    it(`closes the reply through its own close before ${action} opens`, async () => {
      stub.close = 'saves';
      render(<MailApp />);
      fireEvent.click(await screen.findByText('stub reply'));
      await screen.findByTestId('stub-composer');

      fireEvent.click(screen.getByText(action));
      await waitFor(() => expect(composerMode()).toBe(mode));
      expect(stub.closes).toEqual(['reply']);
    });
  }

  it('closes a new message before another new message opens', async () => {
    stub.close = 'saves';
    render(<MailApp />);
    fireEvent.click(screen.getByText('stub compose'));
    await screen.findByTestId('stub-composer');
    const mounted = stub.mounts.length;

    fireEvent.click(screen.getByText('stub compose'));
    await waitFor(() => expect(stub.mounts.length).toBe(mounted + 1));
    expect(stub.closes).toEqual(['compose']);
  });

  it('keeps the open composer when its save fails', async () => {
    stub.close = 'fails';
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub reply'));
    await screen.findByTestId('stub-composer');
    const mounted = stub.mounts.length;

    fireEvent.click(screen.getByText('stub compose'));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(stub.closes).toEqual(['reply']);
    expect(stub.mounts.length).toBe(mounted);
    expect(composerMode()).toBe('reply');
  });
});
