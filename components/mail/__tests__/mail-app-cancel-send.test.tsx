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

// compose-p3-10: "Cancel send" on a scheduled message moved it to Drafts
// and said nothing about where it went.

type ComposerProps = {
  mode: string;
  initialData?: Record<string, unknown> | null;
  onClose: () => void;
  onDiscardDraft?: (draftId: string, where?: Record<string, unknown>) => void;
  onDiscardStarted?: (draftId: string) => void;
  onRestoreDiscarded?: (data: Record<string, unknown>) => void;
};

const server = vi.hoisted(() => ({
  drafts: [] as Array<Record<string, unknown>>,
  composer: null as null | ComposerProps,
}));

vi.mock('@/components/layout/mv-top-bar', () => ({ MvTopBar: () => null }));
vi.mock('@/components/layout/sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/email/email-composer', () => ({
  EmailComposer: (props: ComposerProps) => {
    server.composer = props;
    return (
      <div
        data-testid="stub-composer" data-mode={props.mode} data-draft={String(props.initialData?.draftId ?? '')}
        data-to={String(props.initialData?.to ?? '')} data-cc={String(props.initialData?.cc ?? '')} data-kind={String(props.initialData?.kind ?? '')}
      >stub composer</div>
    );
  },
}));
vi.mock('@/components/search/mv-search-form', () => ({ MvSearchForm: () => null }));
vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: ({ onCancelScheduledSend }: { onCancelScheduledSend?: () => void }) => (
    <div data-testid="viewer">
      {onCancelScheduledSend && <button onClick={onCancelScheduledSend}>stub cancel send</button>}
    </div>
  ),
}));
vi.mock('@/lib/reply-drafts', () => ({
  threadDrafts: async () => server.drafts,
  findReplyDraft: async (drafts: unknown[]) => drafts[0] ?? null,
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
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
  useIsDesktop: () => true,
}));
vi.mock('@/lib/push-bindings', () => ({ reconcilePushBindings: () => {}, releasePushBindings: () => {} }));
vi.mock('@/components/email/email-list', () => ({ EmailList: () => null }));

const { MailApp } = await import('../mail-app');

const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 0, unreadEmails: 0 } as Mailbox;
const MESSAGE = {
  id: 'm1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true }, messageId: ['m1@example.org'],
  isScheduled: true, emailSubmissionId: 'sub-1', scheduledUndoStatus: 'pending', scheduledSendAt: '2026-11-05T08:00:00Z', scheduledIdentityId: 'id-1',
  from: [{ name: 'Ann', email: 'ann@example.org' }], to: [{ email: 'a@example.org' }, { name: 'Carol', email: 'carol@example.org' }],
  cc: [{ name: 'Dave', email: 'dave@example.org' }],
  subject: 'Plans', receivedAt: '2026-11-01T10:00:00Z', preview: 'Hi', size: 10,
  hasAttachment: false, textBody: [], htmlBody: [], bodyValues: {},
} as never;
const DRAFT = {
  id: 'd1', threadId: 't1', mailboxIds: { drafts: true }, keywords: { $draft: true }, inReplyTo: ['m1@example.org'],
  from: [{ email: 'a@example.org' }], to: [{ name: 'Ann', email: 'ann@example.org' }],
  subject: 'Re: Plans', receivedAt: '2026-11-01T11:00:00Z', preview: 'My answer', size: 10,
  hasAttachment: false, textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [], bodyValues: { '1': { value: 'My answer' } },
};

const deleteEmail = vi.fn(async (id: string) => { server.drafts = server.drafts.filter((d) => d.id !== id); });

beforeEach(() => {
  server.drafts = [];
  server.composer = null;
  deleteEmail.mockClear();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  const client = {
    getAccountId: () => 'acc', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    getEmail: vi.fn(async (id: string) => server.drafts.find((d) => d.id === id) ?? null),
    deleteEmail,
    getThread: async () => ({ emailIds: ['m1', ...server.drafts.map((d) => d.id)] }),
    getSomeEmails: async () => server.drafts,
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

const cancelForEdit = vi.fn(async () => DRAFT);

describe('Cancel send on a scheduled message (compose-p3-10)', () => {
  it('says it is in Drafts, and Open opens it there', async () => {
    useEmailStore.setState({ cancelScheduledEmailForEdit: cancelForEdit as never, isScheduledView: true } as never);
    server.drafts = [DRAFT];
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub cancel send'));

    await waitFor(() => expect(useToastStore.getState().toasts.length).toBeGreaterThan(0));
    const shown = useToastStore.getState().toasts.at(-1)!;
    expect(shown.title).toBe('notifications.moved_to_mailbox');
    expect(shown.action?.label).toBe('offlineDrafts.open');
    act(() => shown.action!.onClick());
    await waitFor(() => expect(screen.getByTestId('stub-composer').getAttribute('data-draft')).toBe('d1'));
  });
});
