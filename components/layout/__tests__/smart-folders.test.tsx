import { useSmartFolder } from '@/hooks/use-smart-folder';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { SmartFolder } from '@/lib/smart-folder-types';
import { smartFolderMailboxId } from '@/lib/smart-folder-types';
import { compileSmartFolder } from '@/lib/smart-folder-query';
import type { ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import { CROSS_VIEW_IDS } from '@/lib/jmap/types';
import { useCrossViews } from '@/hooks/use-cross-views';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ startTour: vi.fn(), resetTourCompletion: vi.fn(), activeTour: null, endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/contexts/drag-drop-context', () => ({ useDragDropContext: () => ({ isDragging: false }) }));
vi.mock('@/hooks/use-mailbox-drop', () => ({
  useMailboxDrop: () => ({ dropHandlers: {}, isValidDropTarget: false, isInvalidDropTarget: false }),
}));
vi.mock('@/hooks/use-tag-drop', () => ({ useTagDrop: () => ({ dropHandlers: {}, isValidDropTarget: false }) }));
vi.mock('../account-switcher', () => ({ AccountSwitcher: () => null }));

const { Sidebar } = await import('../sidebar');
const initial = {
  account: useAccountStore.getState(), auth: useAuthStore.getState(),
  email: useEmailStore.getState(), policy: usePolicyStore.getState(), settings: useSettingsStore.getState(), ui: useUIStore.getState(),
};
const account = (id: string) => ({ id, email: `${id}@example.org`, username: `${id}@example.org`, isConnected: true, cookieSlot: 0 });
const box = (id: string, role: string, extra: Partial<Mailbox> = {}) => ({
  id, name: id, role, parentId: null, totalEmails: 12, unreadEmails: 3,
  myRights: { mayAddItems: true }, ...extra,
}) as Mailbox;
const mailboxes = [box('inbox', 'inbox'), box('drafts', 'drafts'), box('sent', 'sent')];

// Exercise the very same gates used by mail-app, not hand-written gated props.
function MailSidebar(props: Partial<ComponentProps<typeof Sidebar>>) {
  return <Sidebar mailboxes={mailboxes} selectedMailbox="inbox" crossUnreadCount={17} {...useCrossViews()} {...props} />;
}
const rows = () => screen.getAllByTestId('folder-row');
const ids = () => rows().map((row) => row.getAttribute('data-mailbox-id')).filter((id) => id !== null);

beforeEach(() => {
  localStorage.clear();
  useUIStore.setState({ sidebarCollapsed: false, isCompact: false });
  useAccountStore.setState({ accounts: [account('a')], activeAccountId: 'a' } as never);
  useAuthStore.setState({ client: null, activeAccountId: 'a', restoringAccounts: false });
  useSettingsStore.setState({
    enableUnifiedMailbox: true, enableCrossUnreadView: true, enableCrossStarredView: true,
    enableCrossAllView: false, unifiedCrossAccount: false, includeGroupInUnified: true,
    hideAccountSwitcher: true, interfaceLayout: 'default', showFolderTotalCount: false,
    folderCountModes: {}, hiddenSharedMailAccounts: {}, showSharedMailAccounts: true,
    explicitSettings: [], smartFoldersVersion: 1, smartFolders: [],
  });
  const policy = initial.policy.policy;
  usePolicyStore.setState({
    policy: { ...policy, features: { ...policy.features, crossUnreadViewEnabled: true, crossStarredViewEnabled: true, crossAllViewEnabled: true } },
    demoFeatureOverrides: {},
  });
  // Include populated/stale role counts: moving cross views must not display them.
  useEmailStore.setState({
    mailboxes,
    unifiedCounts: [{ role: 'sent', totalEmails: 12, unreadEmails: 3 }],
    selectedKeywordAccountId: null,
  } as never);
});
afterEach(() => {
  cleanup();
  useAccountStore.setState(initial.account, true); useAuthStore.setState(initial.auth, true);
  useEmailStore.setState(initial.email, true); usePolicyStore.setState(initial.policy, true);
  useSettingsStore.setState(initial.settings, true);
  useUIStore.setState(initial.ui, true);
});


const folder: SmartFolder = { id: 'attachments', name: 'Attachments', enabled: true, order: 0,
  scope: 'active-account', match: 'all', conditions: [{ field: 'hasAttachment', value: true }] };
const client = () => ({
  getEmails: vi.fn().mockResolvedValue({ emails: [], hasMore: false, total: 7, threadCounts: {} }),
  getAccountId: () => 'primary', getMaxObjectsInGet: () => 256,
});

function SmartMail({ client, onSelect }: { client: IJMAPClient; onSelect: (id: string) => void }) {
  const selected = useEmailStore((s) => s.selectedMailbox);
  useSmartFolder(selected, client);
  return <MailSidebar selectedMailbox={selected} onMailboxSelect={onSelect} />;
}

describe('smart folder UI and existing message list', () => {
  it('creates, opens, edits and deletes through the actual Sidebar and editor', async () => {
    const c = client();
    const onMailboxSelect = vi.fn(async (id: string) => {
      useEmailStore.getState().selectMailbox(id);
      useEmailStore.getState().clearSearchFilters();
    });
    render(<SmartMail client={c as unknown as IJMAPClient} onSelect={onMailboxSelect} />);
    expect(screen.queryByRole('region', { name: 'title' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'create' }));
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'With attachment' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'save' })));
    expect(screen.getByRole('region', { name: 'title' })).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'With attachment' })));
    const saved = useSettingsStore.getState().smartFolders[0];
    expect(onMailboxSelect).toHaveBeenCalledWith(smartFolderMailboxId(saved.id));
    expect(c.getEmails).toHaveBeenCalledWith(undefined, undefined, 50, 0, undefined, false, compileSmartFolder(saved));
    expect(useEmailStore.getState().totalEmails).toBe(7);
    fireEvent.click(screen.getByRole('button', { name: 'edit_named' }));
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Renamed' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'save' })));
    expect(screen.getByRole('button', { name: 'Renamed' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'edit_named' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'delete' })));
    expect(screen.queryByRole('region', { name: 'title' })).not.toBeInTheDocument();
    expect(useSettingsStore.getState().smartFolders).toEqual([]);
    expect(useEmailStore.getState().selectedMailbox).toBe('inbox');
    expect(ids()).toContain(CROSS_VIEW_IDS.unread); expect(ids()).toContain(CROSS_VIEW_IDS.starred);
  });
  it('cancels without writing, and does not query unselected views', () => {
    const c = client(); useAuthStore.setState({ client: c as unknown as IJMAPClient });
    render(<MailSidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'create' }));
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Cancelled' } });
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(useSettingsStore.getState().smartFolders).toEqual([]); expect(c.getEmails).not.toHaveBeenCalled();
  });
  it('reuses pagination, refresh, totals and search, always on the active own account', async () => {
    const c = client(); const shared = client();
    useSettingsStore.getState().saveSmartFolder(folder);
    useAuthStore.setState({ client: c as unknown as IJMAPClient, getClientForAccount: (() => shared) as never });
    useEmailStore.setState({ viewingAccountId: 'shared', searchQuery: '', emails: [], searchFilters: initial.email.searchFilters });
    useEmailStore.getState().selectMailbox(smartFolderMailboxId(folder.id));
    expect(useEmailStore.getState().viewingAccountId).toBeNull();
    await useEmailStore.getState().fetchEmails(c as unknown as IJMAPClient);
    useEmailStore.setState({ hasMoreEmails: true, emails: [{ id: 'one', receivedAt: '2026-11-01T00:00:00Z', keywords: {}, mailboxIds: { inbox: true } }] as never });
    await useEmailStore.getState().loadMoreEmails(c as unknown as IJMAPClient);
    await useEmailStore.getState().refreshCurrentMailbox(c as unknown as IJMAPClient);
    expect(c.getEmails).toHaveBeenCalledTimes(3);
    expect(c.getEmails.mock.calls[1][3]).toBe(1);
    for (const args of c.getEmails.mock.calls) {
      expect(args[0]).toBeUndefined(); expect(args[1]).toBeUndefined(); expect(args[6]).toEqual(compileSmartFolder(folder));
    }
    await useEmailStore.getState().searchEmails(c as unknown as IJMAPClient, 'invoice');
    expect(JSON.stringify(c.getEmails.mock.lastCall![6])).toContain('invoice');
    expect(JSON.stringify(c.getEmails.mock.lastCall![6])).toContain('hasAttachment');
    expect(shared.getEmails).not.toHaveBeenCalled();
    expect(useEmailStore.getState().totalEmails).toBe(7);
  });
  it('fails closed for disabled/deleted folders and blocks mailbox-wide mutations', async () => {
    const c = client();
    const id = smartFolderMailboxId(folder.id);
    useSettingsStore.getState().saveSmartFolder({ ...folder, enabled: false });
    useEmailStore.getState().selectMailbox(id);
    await useEmailStore.getState().fetchEmails(c as unknown as IJMAPClient);
    expect(useEmailStore.getState().error).toBe('Smart folder unavailable');
    expect(await useEmailStore.getState().emptyMailbox(c as unknown as IJMAPClient, id)).toBe(false);
    expect(await useEmailStore.getState().markMailboxAsRead(c as unknown as IJMAPClient, id)).toBeNull();
    expect(c.getEmails).not.toHaveBeenCalled();
  });
});
