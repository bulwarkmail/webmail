import React, { Suspense, lazy } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { useToastStore } from '@/stores/toast-store';
import { useMailTransferStore } from '@/stores/mail-transfer-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { clearAllHooks } from '@/lib/plugin-hooks';
import type { CommandGroup } from '@/lib/command-registry';

// Mail adds its own commands to the palette (Ctrl/⌘+K): the open message's
// actions and a "Go to" per folder.

vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
vi.mock('@/components/email/email-viewer', () => ({ EmailViewer: () => <div>viewer</div> }));
vi.mock('@/components/email/email-composer', () => ({ EmailComposer: () => null }));
vi.mock('@/components/layout/sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/calendar-event-notification-toaster', () => ({ CalendarEventNotificationToaster: () => null }));
vi.mock('@/components/layout/share-notification-toaster', () => ({ ShareNotificationToaster: () => null }));
vi.mock('@/components/layout/mobile-header', () => ({ MobileHeader: () => null }));
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
vi.mock('@/components/email/email-list', () => ({ EmailList: () => <div>message list</div> }));

const { MailApp } = await import('../mail-app');

const folder = (id: string, role: string | undefined, name = role ?? id): Mailbox => ({
  id, name, role, sortOrder: 0, totalEmails: 1, unreadEmails: 0, totalThreads: 1, unreadThreads: 0, isSubscribed: true,
  myRights: { mayAddItems: true, mayRemoveItems: true, mayReadItems: true },
}) as Mailbox;
const folders = [folder('inbox', 'inbox'), folder('trash', 'trash'), folder('work', undefined, 'Work')];
const open = { id: 'm1', threadId: 't1', subject: 'Hello', receivedAt: '2026-10-26T10:00:00Z', keywords: { $seen: true }, mailboxIds: { inbox: true } } as unknown as Email;

let client: Record<string, unknown>;
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  useToastStore.setState({ toasts: [] });
  clearAllHooks();
  client = {
    getAccountId: () => 'acc', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    getMailboxes: vi.fn().mockResolvedValue(folders),
    moveEmail: vi.fn().mockResolvedValue(undefined),
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: () => client as never, getAllConnectedClients: () => new Map([['login-a', client]]) as never,
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, mailLayout: 'split' } as never);
  useEmailStore.setState({
    emails: [open], selectedEmail: open, selectedMailbox: 'inbox', selectedKeyword: null, mailboxes: folders,
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '', selectedEmailKeys: new Set(),
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const { useRegisteredCommandGroups } = await import('@/lib/command-registry');
function Palette({ onGroups }: { onGroups: (groups: CommandGroup[]) => void }) {
  onGroups(useRegisteredCommandGroups());
  return null;
}

describe('Mail in the command palette', () => {
  it('lists the open message\'s actions and a Go to per other folder', async () => {
    let groups: CommandGroup[] = [];
    render(<><MailApp /><Palette onGroups={(g) => { groups = g; }} /></>);
    await screen.findByText('viewer', {}, { timeout: 5000 });
    await waitFor(() => expect(groups.find((g) => g.label === 'sidebar.mail')).toBeDefined());
    const ids = groups.find((g) => g.label === 'sidebar.mail')!.commands.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['reply', 'archive', 'delete', 'move', 'mark-unread', 'spam', 'go-trash', 'go-work']));
    expect(ids).not.toContain('go-inbox');
    expect(ids).not.toContain('mark-read');
  });

  it("offers Import mail into the open folder, which left the reader's ⋮ menu", async () => {
    let groups: CommandGroup[] = [];
    render(<><MailApp /><Palette onGroups={(g) => { groups = g; }} /></>);
    await screen.findByText('viewer', {}, { timeout: 5000 });
    await waitFor(() => expect(groups.find((g) => g.label === 'sidebar.mail')).toBeDefined());
    const importMail = groups.find((g) => g.label === 'sidebar.mail')!.commands.find((c) => c.id === 'import');
    expect(importMail?.label).toBe('mail_import.menu_import');
    act(() => importMail!.run());
    expect(useMailTransferStore.getState().request).toMatchObject({ kind: 'import', mailboxId: 'inbox' });
    act(() => useMailTransferStore.setState({ request: null, visible: false }));
  });

  it("says whose a shared folder is and where a subfolder is, so two Inboxes don't look the same", async () => {
    const shared = { ...folder('support:inbox', 'inbox'), isShared: true, accountName: 'Support', accountId: 'support', originalId: 'inbox' } as Mailbox;
    const archive = folder('archive', 'archive', 'Archive');
    const year = { ...folder('y2025', undefined, '2025'), parentId: 'archive' } as Mailbox;
    const all = [...folders, shared, archive, year];
    useEmailStore.setState({ mailboxes: all, selectedMailbox: 'work' } as never);
    client.getMailboxes = vi.fn().mockResolvedValue(all);
    let groups: CommandGroup[] = [];
    render(<><MailApp /><Palette onGroups={(g) => { groups = g; }} /></>);
    await screen.findByText('viewer', {}, { timeout: 5000 });
    await waitFor(() => expect(groups.find((g) => g.label === 'sidebar.mail')).toBeDefined());
    // The test translator drops parameters; the place also goes in the keywords.
    const where = (id: string) => groups.find((g) => g.label === 'sidebar.mail')!.commands.find((c) => c.id === id)!.keywords?.slice(1);
    expect(where('go-support:inbox')).toEqual(['Support']);
    expect(where('go-inbox')).toEqual([]);
    expect(where('go-y2025')?.[0]).toMatch(/archive/i);
  });

  it('moves the open message from "Move to…"', async () => {
    let groups: CommandGroup[] = [];
    render(<><MailApp /><Palette onGroups={(g) => { groups = g; }} /></>);
    await screen.findByText('viewer', {}, { timeout: 5000 });
    await waitFor(() => expect(groups.find((g) => g.label === 'sidebar.mail')).toBeDefined());
    const move = groups.find((g) => g.label === 'sidebar.mail')!.commands.find((c) => c.id === 'move')!;
    act(() => move.run());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeNull());
    fireEvent.click(await screen.findByText('Work'));
    await waitFor(() => expect(client.moveEmail).toHaveBeenCalledWith('m1', 'work', undefined));
  });
});
