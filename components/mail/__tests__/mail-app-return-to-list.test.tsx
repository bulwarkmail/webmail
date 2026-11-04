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
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { clearAllHooks } from '@/lib/plugin-hooks';
import { forgetEmailPrefetches } from '@/lib/email-prefetch';

// Settings > "Return to list after delete, archive or mark unread": taking
// the open message out of the folder goes back to the list, in Mountain View
// as in the default layout, instead of opening the next message. (#1458)

vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
type ViewerProps = {
  onArchive?: () => void; onDelete?: () => void; onMoveToMailbox?: (mailboxId: string) => void;
  onMarkAsSpam?: () => void; onUndoSpam?: () => void; onRemoveFromFolder?: () => void;
};
vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: ({ onArchive, onDelete, onMoveToMailbox, onMarkAsSpam, onUndoSpam, onRemoveFromFolder }: ViewerProps) => (
    <>
      <button onClick={() => onArchive?.()}>stub archive</button>
      <button onClick={() => onDelete?.()}>stub delete</button>
      <button onClick={() => onMoveToMailbox?.('work')}>stub move</button>
      <button onClick={() => onMarkAsSpam?.()}>stub spam</button>
      <button onClick={() => onUndoSpam?.()}>stub not spam</button>
      {onRemoveFromFolder && <button onClick={onRemoveFromFolder}>stub remove from folder</button>}
    </>
  ),
}));
vi.mock('@/components/email/email-composer', () => ({ EmailComposer: () => null }));
vi.mock('@/components/layout/sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/calendar-event-notification-toaster', () => ({ CalendarEventNotificationToaster: () => null }));
vi.mock('@/components/layout/share-notification-toaster', () => ({ ShareNotificationToaster: () => null }));
vi.mock('@/components/layout/mobile-header', () => ({ MobileHeader: () => null }));
vi.mock('@/components/layout/mv-top-bar', () => ({ MvTopBar: () => null }));
vi.mock('@/components/layout/mv-side-panel', () => ({ MvSidePanel: () => null }));
vi.mock('@/components/email/message-list-tabs', () => ({ useMessageListPanelProps: (id: string) => ({ id }), MessageListTabs: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => <input aria-label="stub search field" data-search-input /> }));
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

function mailbox(id: string, role: string): Mailbox {
  return {
    id, name: role, role, sortOrder: 0, totalEmails: 3, unreadEmails: 0, totalThreads: 3, unreadThreads: 0, isSubscribed: true,
  } as Mailbox;
}
const folders = [
  mailbox('inbox', 'inbox'), mailbox('archive', 'archive'), mailbox('trash', 'trash'),
  mailbox('junk', 'junk'), mailbox('work', ''),
];
const row = (id: string, minute: number, mailboxIds: Record<string, boolean> = { inbox: true }) => ({
  id, threadId: `t-${id}`, subject: id, receivedAt: new Date(Date.UTC(2026, 9, 31, 10, minute)).toISOString(),
  keywords: { $seen: true }, mailboxIds,
}) as unknown as Email;
const inbox = () => [row('m1', 30), row('m2', 20), row('m3', 10)];

/** Opens `rows[0]` of `folder`. */
function showFolder(folder: string, rows: Email[]) {
  useEmailStore.setState({ emails: rows, selectedEmail: rows[0], selectedMailbox: folder } as never);
}

let client: Record<string, ReturnType<typeof vi.fn> | (() => unknown)>;
let fetchEmailContent: ReturnType<typeof vi.fn>;
// Every message the store had open, in order.
let opened: (string | null)[];
let unsubscribe: () => void;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  useToastStore.setState({ toasts: [] });
  clearAllHooks();
  forgetEmailPrefetches();
  client = {
    getAccountId: () => 'acc', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    getMailboxes: vi.fn().mockResolvedValue(folders),
    getThread: vi.fn(async (threadId: string) => ({ id: threadId, emailIds: [threadId.slice(2)] })),
    getEmail: vi.fn(async (id: string) => ({ ...inbox().find((e) => e.id === id)!, bodyValues: {} })),
    moveEmail: vi.fn().mockResolvedValue(undefined),
    moveToTrash: vi.fn().mockResolvedValue(undefined),
    markAsRead: vi.fn().mockResolvedValue(undefined),
    markAsSpam: vi.fn().mockResolvedValue(undefined),
    undoSpam: vi.fn().mockResolvedValue(undefined),
    removeEmailsFromMailbox: vi.fn().mockResolvedValue(undefined),
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: (id: string) => (id === 'login-a' ? client : undefined) as never,
    getAllConnectedClients: () => new Map([['login-a', client]]) as never,
  });
  useSettingsStore.setState({
    enableUnifiedMailbox: false, interfaceLayout: 'default', mailLayout: 'focus', archiveMode: 'single',
    deleteAction: 'trash', returnToListAfterAction: true, confirmArchive: false, confirmDelete: false,
    singleKeyShortcuts: true,
  } as never);
  fetchEmailContent = vi.fn().mockResolvedValue(undefined);
  const emails = inbox();
  useEmailStore.setState({
    emails, selectedEmail: emails[0], selectedMailbox: 'inbox', selectedKeyword: null, mailboxes: folders,
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '',
    selectedEmailKeys: new Set(), unreadSection: null,
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
    fetchEmailContent,
  } as never);
  opened = [];
  unsubscribe = useEmailStore.subscribe((state, prev) => {
    if (state.selectedEmail !== prev.selectedEmail) opened.push(state.selectedEmail?.id ?? null);
  });
});
afterEach(() => {
  unsubscribe();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const selectedId = () => useEmailStore.getState().selectedEmail?.id ?? null;

describe.each([
  ['Mountain View', { interfaceLayout: 'mountain-view' }],
  ['the default layout', { interfaceLayout: 'default' }],
])('Archive on the open message in %s', (_name, layout) => {
  beforeEach(() => useSettingsStore.setState(layout as never));

  it('goes back to the list without opening the next message', async () => {
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub archive', {}, { timeout: 5000 }));
    await waitFor(() => expect(client.moveEmail).toHaveBeenCalledWith('m1', 'archive', undefined));
    await waitFor(() => expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['m2', 'm3']));
    expect(selectedId()).toBeNull();
    expect(opened).not.toContain('m2');
    expect(fetchEmailContent).not.toHaveBeenCalledWith(expect.anything(), 'm2');
  });

  it('opens the next message with the setting off', async () => {
    useSettingsStore.setState({ returnToListAfterAction: false } as never);
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub archive', {}, { timeout: 5000 }));
    await waitFor(() => expect(selectedId()).toBe('m2'));
  });

  it('stays on the message when the archive confirm is cancelled', async () => {
    useSettingsStore.setState({ confirmArchive: true } as never);
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub archive', {}, { timeout: 5000 }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(selectedId()).toBe('m1');
    expect(client.moveEmail).not.toHaveBeenCalled();
  });
});

describe.each([
  ['Mountain View', { interfaceLayout: 'mountain-view' }],
  ['the default layout', { interfaceLayout: 'default' }],
])('Delete on the open message in %s', (_name, layout) => {
  beforeEach(() => useSettingsStore.setState(layout as never));

  it('goes back to the list without opening the next message', async () => {
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub delete', {}, { timeout: 5000 }));
    await waitFor(() => expect(client.moveToTrash).toHaveBeenCalled());
    await waitFor(() => expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['m2', 'm3']));
    expect(selectedId()).toBeNull();
    expect(opened).not.toContain('m2');
  });

  it('stays on the message when the delete confirm is cancelled', async () => {
    useSettingsStore.setState({ confirmDelete: true } as never);
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub delete', {}, { timeout: 5000 }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(selectedId()).toBe('m1');
    expect(client.moveToTrash).not.toHaveBeenCalled();
  });
});

describe.each([
  ['Mountain View', { interfaceLayout: 'mountain-view' }],
  ['the default layout', { interfaceLayout: 'default' }],
])('Moving the open message out of the folder in %s', (_name, layout) => {
  beforeEach(() => useSettingsStore.setState(layout as never));

  async function click(label: string) {
    render(<MailApp />);
    fireEvent.click(await screen.findByText(label, {}, { timeout: 5000 }));
  }
  async function expectBackInList() {
    await waitFor(() => expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['m2', 'm3']));
    expect(selectedId()).toBeNull();
    expect(opened).not.toContain('m2');
  }

  it('goes back to the list after Move to', async () => {
    await click('stub move');
    await waitFor(() => expect(client.moveEmail).toHaveBeenCalledWith('m1', 'work', undefined));
    await expectBackInList();
  });

  it('goes back to the list after Report spam', async () => {
    await click('stub spam');
    await waitFor(() => expect(client.markAsSpam).toHaveBeenCalledWith('m1', undefined, false));
    await expectBackInList();
  });

  it('goes back to the list after Not spam in Junk', async () => {
    const junk = { junk: true };
    showFolder('junk', [row('m1', 30, junk), row('m2', 20, junk), row('m3', 10, junk)]);
    await click('stub not spam');
    await waitFor(() => expect(client.undoSpam).toHaveBeenCalledWith('m1', 'inbox', undefined));
    await expectBackInList();
  });

  it('goes back to the list after Remove from this folder', async () => {
    showFolder('inbox', [row('m1', 30, { inbox: true, work: true }), row('m2', 20), row('m3', 10)]);
    await click('stub remove from folder');
    await waitFor(() => expect(client.removeEmailsFromMailbox).toHaveBeenCalledWith(['m1'], 'inbox', undefined));
    await expectBackInList();
  });

  it('opens the next message after Move to with the setting off', async () => {
    useSettingsStore.setState({ returnToListAfterAction: false } as never);
    await click('stub move');
    await waitFor(() => expect(selectedId()).toBe('m2'));
  });

  // The Unread filter drops a message once it is read; the store then finds
  // the open message through the selection (#695).
  it('still reports a message as spam that the list no longer holds', async () => {
    const [m1, ...rest] = inbox();
    useEmailStore.setState({ emails: rest, selectedEmail: m1 } as never);
    await click('stub spam');
    await waitFor(() => expect(client.markAsSpam).toHaveBeenCalledWith('m1', undefined, false));
    await waitFor(() => expect(selectedId()).toBeNull());
    expect(opened).not.toContain('m2');
  });
});

// With the list beside the reading pane (split, horizontal) the setting,
// while nobody has changed it, opens the next message instead, as Outlook
// does. A choice the user made wins, on every layout and device.
describe('Archive with the list beside the reading pane', () => {
  beforeEach(() => {
    useSettingsStore.setState({ interfaceLayout: 'default', mailLayout: 'split', explicitSettings: [] } as never);
    useEmailStore.setState({ listRows: null } as never);
  });

  it('opens the next message while the setting is untouched', async () => {
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub archive', {}, { timeout: 5000 }));
    await waitFor(() => expect(client.moveEmail).toHaveBeenCalledWith('m1', 'archive', undefined));
    await waitFor(() => expect(selectedId()).toBe('m2'));
  });

  it('opens the next row in the order the list shows', async () => {
    useEmailStore.setState({
      listRows: [{ key: 'm1', members: ['m1'] }, { key: 'm3', members: ['m3'] }, { key: 'm2', members: ['m2'] }],
    } as never);
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub archive', {}, { timeout: 5000 }));
    await waitFor(() => expect(client.moveEmail).toHaveBeenCalledWith('m1', 'archive', undefined));
    await waitFor(() => expect(selectedId()).toBe('m3'));
    expect(opened).not.toContain('m2');
  });

  it('goes back to the list when the user switched the setting on', async () => {
    useSettingsStore.setState({ returnToListAfterAction: true, explicitSettings: ['returnToListAfterAction'] } as never);
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub archive', {}, { timeout: 5000 }));
    await waitFor(() => expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['m2', 'm3']));
    expect(selectedId()).toBeNull();
    expect(opened).not.toContain('m2');
  });

  it('opens the archived message again on Undo', async () => {
    client.restoreEmails = vi.fn().mockResolvedValue(undefined);
    useEmailStore.setState({
      refreshCurrentMailbox: vi.fn(async () => { useEmailStore.setState({ emails: inbox() } as never); }),
    } as never);
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub archive', {}, { timeout: 5000 }));
    await waitFor(() => expect(selectedId()).toBe('m2'));
    const archived = await waitFor(() => {
      const found = useToastStore.getState().toasts.find((toast) => toast.title === 'notifications.email_archived');
      expect(found?.action).toBeTruthy();
      return found!;
    });
    act(() => { archived.action!.onClick(); });
    await waitFor(() => expect(client.restoreEmails).toHaveBeenCalled());
    await waitFor(() => expect(selectedId()).toBe('m1'));
  });
});

describe('Delete with the list beside the reading pane', () => {
  beforeEach(() => {
    useSettingsStore.setState({ interfaceLayout: 'default', mailLayout: 'horizontal', explicitSettings: [] } as never);
    useEmailStore.setState({ listRows: null } as never);
  });

  it('opens the next message while the setting is untouched', async () => {
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub delete', {}, { timeout: 5000 }));
    await waitFor(() => expect(client.moveToTrash).toHaveBeenCalled());
    await waitFor(() => expect(selectedId()).toBe('m2'));
  });
});

describe('A list collapsed under an open message (focused layout)', () => {
  const list = () => screen.getByText('message list').closest('section')!;

  it('is out of the Tab order while the message is open', async () => {
    render(<MailApp />);
    await screen.findByText('stub archive', {}, { timeout: 5000 });
    expect(list()).toHaveAttribute('inert');
  });

  it('comes back for the / shortcut, whose search field lives in it', async () => {
    render(<MailApp />);
    await screen.findByText('stub archive', {}, { timeout: 5000 });
    act(() => { fireEvent.keyDown(window, { key: '/' }); });
    await waitFor(() => expect(selectedId()).toBeNull());
    await waitFor(() => expect(list()).not.toHaveAttribute('inert'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('stub search field')));
  });

  it('keeps the selection for the / shortcut while a linked message is still arriving', async () => {
    // The mailboxes never arrive, so the link stays unapplied and the list collapsed for it.
    useEmailStore.setState({ fetchMailboxes: vi.fn(() => new Promise(() => {})) } as never);
    render(<MailApp linkSegments={['message', 'm2']} />);
    expect(list()).toHaveAttribute('inert');
    act(() => { fireEvent.keyDown(window, { key: '/' }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(selectedId()).toBe('m1');
  });
});

describe('The e shortcut in Mountain View', () => {
  beforeEach(() => {
    useSettingsStore.setState({ interfaceLayout: 'mountain-view' } as never);
    useEmailStore.setState({ selectedEmail: null } as never);
  });

  const press = (key: string) => act(() => { fireEvent.keyDown(window, { key }); });

  it('moves the list cursor on to the next row', async () => {
    render(<MailApp />);
    await screen.findByText('message list', {}, { timeout: 5000 });
    await press('j');
    await waitFor(() => expect(selectedId()).toBe('m1'));
    await press('e');
    await waitFor(() => expect(client.moveEmail).toHaveBeenCalledWith('m1', 'archive', undefined));
    await waitFor(() => expect(selectedId()).toBe('m2'));
  });

  it('goes back to the list from a message opened with Enter', async () => {
    render(<MailApp />);
    await screen.findByText('message list', {}, { timeout: 5000 });
    await press('j');
    await waitFor(() => expect(selectedId()).toBe('m1'));
    await press('Enter');
    await press('e');
    await waitFor(() => expect(client.moveEmail).toHaveBeenCalledWith('m1', 'archive', undefined));
    await waitFor(() => expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['m2', 'm3']));
    expect(selectedId()).toBeNull();
    expect(opened).not.toContain('m2');
  });
});
