import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { useToastStore } from '@/stores/toast-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';

// Reply in the standard layout on a computer: the composer docks under the
// message it answers, which stays on screen above it, as in Gmail and Outlook.

const device = vi.hoisted(() => ({ current: { isMobile: false, isTablet: false, isDesktop: true } }));
const stub = vi.hoisted(() => ({ requestClose: null as null | ((afterClose?: () => void) => void) }));

vi.mock('@/components/layout/mv-top-bar', () => ({ MvTopBar: () => null }));
vi.mock('@/components/layout/sidebar', () => ({
  Sidebar: ({ onCompose }: { onCompose: () => void }) => <button onClick={onCompose}>stub compose</button>,
}));
// The composer hands its draft to the host as it unmounts, and offers the
// host its close when the test says so.
vi.mock('@/components/email/email-composer', async () => {
  const { useEffect } = await import('react');
  return {
    EmailComposer: ({ onSaveState, requestCloseRef, replyTo }: {
      onSaveState: (data: Record<string, unknown>) => void;
      requestCloseRef?: { current: unknown };
      replyTo?: { quoteHeaderHtml?: string };
    }) => {
      useEffect(() => {
        if (requestCloseRef && stub.requestClose) requestCloseRef.current = stub.requestClose;
        return () => {
          if (requestCloseRef) requestCloseRef.current = null;
          onSaveState({ subject: 'Parked', draftId: 'draft-7', draftAccountId: 'acc', mode: 'compose' });
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return <div data-testid="stub-composer" data-quote={replyTo?.quoteHeaderHtml ?? ''}>stub composer</div>;
    },
  };
});
vi.mock('@/components/search/mv-search-form', () => ({
  MvSearchForm: ({ onSearch }: { onSearch: () => void }) => <button onClick={onSearch}>stub filter search</button>,
}));
vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: ({ onReply, onForward, replyComposerOpen }: { onReply: () => void; onForward: () => void; replyComposerOpen?: boolean }) => (
    <div data-testid="viewer" data-reply-open={replyComposerOpen ? 'yes' : 'no'}>
      message viewer
      <button onClick={() => onReply()}>stub reply</button>
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
  EmailList: ({ onEmailSelect }: { onEmailSelect: (email: { id: string }) => void }) => (
    <button onClick={() => void onEmailSelect({ id: 'other-mail' })}>stub other mail</button>
  ),
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
  stub.requestClose = null;
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useToastStore.getState().clearToasts();
});

describe('a reply in the standard layout', () => {
  for (const action of ['stub reply', 'stub forward']) {
    it(`docks under the message, which stays on screen (${action})`, async () => {
      render(<MailApp />);
      fireEvent.click(await screen.findByText(action));
      const composer = await screen.findByText('stub composer');
      expect(screen.getByTestId('viewer')).toBeInTheDocument();
      expect(composer.closest('[data-reply-dock]')).not.toBeNull();
      // No quick reply box under the message as well.
      expect(screen.getByTestId('viewer')).toHaveAttribute('data-reply-open', 'yes');
    });
  }

  // compose-30: a forward says who the message went to.
  it('gives a forward a header with To', async () => {
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub forward'));
    await waitFor(() => expect(screen.getByTestId('stub-composer').getAttribute('data-quote')).toContain('forward_to_label'));
  });

  it('takes the whole pane for a new message', async () => {
    render(<MailApp />);
    fireEvent.click(screen.getByText('stub compose'));
    await screen.findByText('stub composer');
    expect(screen.queryByTestId('viewer')).toBeNull();
  });
});
