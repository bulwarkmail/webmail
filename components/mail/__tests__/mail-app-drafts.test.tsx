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

// Drafts reopen where people look for them (compose-p2-6, compose-p2-8):
// a click on a draft opens it in the composer, and Reply on a message with a
// reply draft opens that draft instead of starting a second one.

const device = vi.hoisted(() => ({ current: { isMobile: false, isTablet: false, isDesktop: true } }));
const DRAFT_ROW = vi.hoisted(() => ({
  id: 'd1', threadId: 't1', mailboxIds: { drafts: true }, keywords: { $seen: true, $draft: true },
  from: [{ email: 'a@example.org' }], to: [{ email: 'ann@example.org' }],
  subject: 'Re: Plans', receivedAt: '2026-11-02T10:00:00Z', preview: 'my answer', size: 10, hasAttachment: false,
}));

vi.mock('@/components/layout/mv-top-bar', () => ({ MvTopBar: () => null }));
vi.mock('@/components/layout/sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/email/email-composer', () => ({
  EmailComposer: ({ mode, initialData }: { mode: string; initialData?: { draftId?: string } | null }) => (
    <div data-testid="stub-composer" data-mode={mode} data-draft={initialData?.draftId ?? ''}>stub composer</div>
  ),
}));
vi.mock('@/components/search/mv-search-form', () => ({
  MvSearchForm: ({ onSearch }: { onSearch: () => void }) => <button onClick={onSearch}>stub filter search</button>,
}));
vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: ({ onReply, replyDraft }: { onReply: () => void; replyDraft?: { preview?: string; onEdit: () => void } | null }) => (
    <div data-testid="viewer">
      message viewer
      <button onClick={() => onReply()}>stub reply</button>
      {replyDraft && <button onClick={replyDraft.onEdit}>stub reply draft: {replyDraft.preview}</button>}
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
  EmailList: ({ onEmailSelect }: { onEmailSelect: (email: unknown) => void }) => (
    <button onClick={() => onEmailSelect(DRAFT_ROW)}>stub draft row</button>
  ),
}));

const { MailApp } = await import('../mail-app');

const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 0, unreadEmails: 0 } as Mailbox;
const drafts = { id: 'drafts', name: 'Drafts', role: 'drafts', totalEmails: 1, unreadEmails: 0 } as Mailbox;
const MESSAGE = {
  id: 'm1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Ann', email: 'ann@example.org' }], to: [{ email: 'a@example.org' }],
  subject: 'Plans', receivedAt: '2026-11-01T10:00:00Z', preview: 'Hi', size: 10,
  hasAttachment: false, textBody: [], htmlBody: [], bodyValues: {}, messageId: ['plans@example.org'],
} as never;
const FULL_DRAFT = {
  ...DRAFT_ROW, textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [], bodyValues: { 1: { value: 'my answer' } },
  inReplyTo: ['plans@example.org'],
};

type Client = Record<string, unknown> & { getEmail: ReturnType<typeof vi.fn> };
let client: Client;

beforeEach(() => {
  device.current = { isMobile: false, isTablet: false, isDesktop: true };
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  client = {
    getAccountId: () => 'acc', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    getEmail: vi.fn(async (id: string) => (id === 'd1' ? { ...FULL_DRAFT } : null)),
    getThread: vi.fn(async () => ({ id: 't1', emailIds: ['m1', 'd1'] })),
    getSomeEmails: vi.fn(async () => [{ ...(MESSAGE as object) }, { ...DRAFT_ROW }]),
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: () => client as never,
    getAllConnectedClients: () => new Map([['login-a', client]]) as never,
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, interfaceLayout: 'default', mailLayout: 'split' } as never);
  useEmailStore.setState({
    emails: [MESSAGE], selectedEmail: MESSAGE, selectedMailbox: 'inbox', selectedKeyword: null, mailboxes: [inbox, drafts],
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

describe('a draft in the list (compose-p2-8)', () => {
  it('opens in the composer on a click', async () => {
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub draft row'));
    const composer = await screen.findByTestId('stub-composer');
    expect(composer).toHaveAttribute('data-draft', 'd1');
    expect(composer).toHaveAttribute('data-mode', 'compose');
  });
});

describe('a message with a reply draft (compose-p2-6)', () => {
  it('shows the draft under the message', async () => {
    render(<MailApp />);
    expect(await screen.findByText('stub reply draft: my answer')).toBeInTheDocument();
  });

  it('opens that draft on Reply instead of a new reply', async () => {
    render(<MailApp />);
    await screen.findByText('stub reply draft: my answer');
    fireEvent.click(screen.getByText('stub reply'));
    await waitFor(() => expect(screen.getByTestId('stub-composer')).toHaveAttribute('data-draft', 'd1'));
    // Under the message it answers, as a new reply is, not over it.
    expect(screen.getByTestId('stub-composer').closest('[data-reply-dock]')).not.toBeNull();
  });

  it('starts a new reply when the conversation has no reply to this message', async () => {
    client.getEmail = vi.fn(async (id: string) => (id === 'd1' ? { ...FULL_DRAFT, inReplyTo: ['other@example.org'] } : null));
    render(<MailApp />);
    await waitFor(() => expect(client.getEmail).toHaveBeenCalled());
    expect(screen.queryByText(/stub reply draft/)).toBeNull();
    fireEvent.click(screen.getByText('stub reply'));
    await waitFor(() => expect(screen.getByTestId('stub-composer')).toHaveAttribute('data-mode', 'reply'));
    expect(screen.getByTestId('stub-composer')).toHaveAttribute('data-draft', '');
  });
});
