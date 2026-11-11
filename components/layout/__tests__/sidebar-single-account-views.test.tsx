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
import { DEFAULT_FEATURE_GATES, DEFAULT_POLICY } from '@/lib/admin/types';
import { useSettingsStore, migrateSettings } from '@/stores/settings-store';
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
const row = (id: string) => rows().find((item) => item.getAttribute('data-mailbox-id') === id)!;

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
    explicitSettings: [],
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

describe('single-account virtual sidebar views', () => {
  it.each([
    [true, false, [CROSS_VIEW_IDS.unread]],
    [false, true, [CROSS_VIEW_IDS.starred]],
    [true, true, [CROSS_VIEW_IDS.unread, CROSS_VIEW_IDS.starred]],
  ])('puts unread=%s, starred=%s after Inbox in the own folder section', (unread, starred, expected) => {
    useSettingsStore.setState({ enableCrossUnreadView: unread, enableCrossStarredView: starred });
    render(<MailSidebar />);
    expect(ids()).toEqual(['inbox', ...expected, 'drafts', 'sent']);
    expect(screen.getByText('folders')).toBeInTheDocument();
    expect(screen.queryByText('unified_mailbox')).toBeNull();
    expect(screen.queryByText('all_accounts')).toBeNull();
    expect(screen.queryByText('unified_sent')).toBeNull();
    expect(screen.queryByText('unified_all_unread')).toBeNull();
    expect(screen.queryByText('unified_all_starred')).toBeNull();
    if (unread) expect(row(CROSS_VIEW_IDS.unread)).toHaveTextContent('unread');
    if (starred) expect(row(CROSS_VIEW_IDS.starred)).toHaveTextContent('mailboxes.starred');
  });

  it('keeps selection, unread count, navigation and refreshed badges on the same virtual IDs', () => {
    const onMailboxSelect = vi.fn();
    const { rerender } = render(<MailSidebar selectedMailbox={CROSS_VIEW_IDS.unread} onMailboxSelect={onMailboxSelect} />);
    expect(row(CROSS_VIEW_IDS.unread)).toHaveAttribute('data-selected', 'true');
    expect(row(CROSS_VIEW_IDS.unread).querySelector('[data-testid="folder-counts"]')).toHaveAttribute('data-unread', '17');
    fireEvent.click(row(CROSS_VIEW_IDS.starred).querySelector('button')!);
    expect(onMailboxSelect).toHaveBeenCalledExactlyOnceWith(CROSS_VIEW_IDS.starred);
    rerender(<MailSidebar selectedMailbox={CROSS_VIEW_IDS.starred} crossUnreadCount={8} onMailboxSelect={onMailboxSelect} />);
    expect(row(CROSS_VIEW_IDS.starred)).toHaveAttribute('data-selected', 'true');
    expect(row(CROSS_VIEW_IDS.unread)).not.toHaveAttribute('data-selected');
    expect(row(CROSS_VIEW_IDS.unread).querySelector('[data-testid="folder-counts"]')).toHaveAttribute('data-unread', '8');
    expect(row(CROSS_VIEW_IDS.starred).querySelector('[data-testid="folder-counts"]')).toBeNull();
    fireEvent.click(row(CROSS_VIEW_IDS.unread).querySelector('button')!);
    expect(onMailboxSelect).toHaveBeenLastCalledWith(CROSS_VIEW_IDS.unread);
  });

  it.each(['crossUnreadViewEnabled', 'crossStarredViewEnabled'] as const)('honors admin gate %s even with Unified OFF and the user option on', (gate) => {
    useSettingsStore.setState({ enableUnifiedMailbox: false });
    render(<MailSidebar />);
    act(() => {
      const policy = usePolicyStore.getState().policy;
      usePolicyStore.setState({ policy: { ...policy, features: { ...policy.features, [gate]: false } } });
    });
    const hidden = gate === 'crossUnreadViewEnabled' ? CROSS_VIEW_IDS.unread : CROSS_VIEW_IDS.starred;
    expect(ids()).not.toContain(hidden);
    expect(ids()).toContain(hidden === CROSS_VIEW_IDS.unread ? CROSS_VIEW_IDS.starred : CROSS_VIEW_IDS.unread);
  });

  it.each(['enableCrossUnreadView', 'enableCrossStarredView'] as const)('preserves an explicit user OFF for %s', (setting) => {
    useSettingsStore.getState().updateSetting(setting, false);
    render(<MailSidebar />);
    expect(ids()).not.toContain(setting === 'enableCrossUnreadView' ? CROSS_VIEW_IDS.unread : CROSS_VIEW_IDS.starred);
    expect(useSettingsStore.getState()[setting]).toBe(false);
    expect(useSettingsStore.getState().explicitSettings).toContain(setting);
  });

  it('shows stock feature-gate and new-account defaults without enabling Unified, All mail or cross-account', () => {
    usePolicyStore.setState({ policy: DEFAULT_POLICY, demoFeatureOverrides: {} });
    expect(DEFAULT_FEATURE_GATES.crossUnreadViewEnabled).toBe(true);
    expect(DEFAULT_FEATURE_GATES.crossStarredViewEnabled).toBe(true);
    expect(DEFAULT_FEATURE_GATES.crossAllViewEnabled).toBe(false);
    expect(DEFAULT_FEATURE_GATES.unifiedCrossAccountEnabled).toBe(false);
    useSettingsStore.getState().resetToDefaults();
    useSettingsStore.setState({ enableUnifiedMailbox: false });
    render(<MailSidebar />);
    expect(ids()).toEqual(['inbox', CROSS_VIEW_IDS.unread, CROSS_VIEW_IDS.starred, 'drafts', 'sent']);
    expect(screen.queryByText('unified_mailbox')).toBeNull();
    expect(useSettingsStore.getState().enableUnifiedMailbox).toBe(false);
    expect(useSettingsStore.getState().enableCrossAllView).toBe(false);
    expect(useSettingsStore.getState().unifiedCrossAccount).toBe(false);
  });

  it('shows each virtual row once in Mountain View without its old Starred shortcut', () => {
    useSettingsStore.setState({ interfaceLayout: 'mountain-view' });
    render(<MailSidebar mvShell onOpenStarred={vi.fn()} />);
    expect(ids().filter((id) => id === CROSS_VIEW_IDS.starred)).toHaveLength(1);
    expect(ids().filter((id) => id === CROSS_VIEW_IDS.unread)).toHaveLength(1);
    expect(screen.queryByText('unified_mailbox')).toBeNull();
  });

  it('does not resurrect disabled Starred through the Mountain View shortcut', () => {
    useSettingsStore.setState({ interfaceLayout: 'mountain-view', enableCrossStarredView: false });
    render(<MailSidebar mvShell onOpenStarred={vi.fn()} />);
    expect(ids()).not.toContain(CROSS_VIEW_IDS.starred);
    expect(screen.queryByText('mailboxes.starred')).toBeNull();
  });

  it('retains the virtual rows and active selection in the collapsed rail', () => {
    useUIStore.setState({ sidebarCollapsed: true });
    render(<MailSidebar selectedMailbox={CROSS_VIEW_IDS.unread} />);
    expect(screen.getByRole('navigation', { name: 'folders' })).toHaveAttribute('data-folder-rail');
    expect(ids()).toEqual(['inbox', CROSS_VIEW_IDS.unread, CROSS_VIEW_IDS.starred, 'drafts', 'sent']);
    expect(row(CROSS_VIEW_IDS.unread)).toHaveAttribute('data-selected', 'true');
  });

  it('does not mark a cross view selected while a tag is selected', () => {
    render(<MailSidebar selectedMailbox={CROSS_VIEW_IDS.unread} selectedKeyword="tag" />);
    expect(row(CROSS_VIEW_IDS.unread)).not.toHaveAttribute('data-selected');
  });

  it('keeps an opted-in All mail view reachable without duplicate role folders', () => {
    useSettingsStore.setState({ enableCrossAllView: true });
    render(<MailSidebar />);
    expect(ids()).toContain(CROSS_VIEW_IDS.all);
    expect(row(CROSS_VIEW_IDS.all)).toHaveTextContent('mailboxes.all_mail');
    expect(screen.queryByText('unified_sent')).toBeNull();
  });

  it('keeps views reachable when the account has no Inbox-role folder', () => {
    render(<MailSidebar mailboxes={[box('sent', 'sent')]} />);
    expect(ids()).toEqual([CROSS_VIEW_IDS.unread, CROSS_VIEW_IDS.starred, 'sent']);
  });

  it('moves the same selected row back to Unified when another account connects', () => {
    render(<MailSidebar selectedMailbox={CROSS_VIEW_IDS.unread} />);
    act(() => useAccountStore.setState({ accounts: [account('a'), account('b')] } as never));
    expect(screen.getByText('unified_mailbox')).toBeInTheDocument();
    expect(screen.getByText('unified_all_unread')).toBeInTheDocument();
    expect(ids().filter((id) => id === CROSS_VIEW_IDS.unread)).toHaveLength(1);
    expect(row(CROSS_VIEW_IDS.unread)).toHaveAttribute('data-selected', 'true');
  });
});

describe('existing merged sidebar presentation', () => {
  it('does not add Unified virtual rows for existing multi-account settings on upgrade', () => {
    useAccountStore.setState({ accounts: [account('a'), account('b')] } as never);
    const existing = migrateSettings({ enableUnifiedMailbox: true, unifiedCrossAccount: true, enableCrossUnreadView: false,
      enableCrossStarredView: false, explicitSettings: [] }, 16);
    useSettingsStore.setState(existing);
    render(<MailSidebar crossAccountActive />);
    expect(ids()).not.toContain(CROSS_VIEW_IDS.unread);
    expect(ids()).not.toContain(CROSS_VIEW_IDS.starred);
    expect(screen.getByText('all_accounts')).toBeInTheDocument();
    expect(screen.getByText('unified_sent')).toBeInTheDocument();
  });

  it.each([false, true])('preserves two-account rows with cross-account=%s', (crossAccountActive) => {
    useAccountStore.setState({ accounts: [account('a'), account('b')] } as never);
    render(<MailSidebar crossAccountActive={crossAccountActive} />);
    expect(screen.getByText(crossAccountActive ? 'all_accounts' : 'unified_mailbox')).toBeInTheDocument();
    expect(screen.getByText('unified_sent')).toBeInTheDocument();
    expect(screen.getByText('unified_all_unread')).toBeInTheDocument();
    expect(screen.getByText('unified_all_starred')).toBeInTheDocument();
    expect(screen.queryByText('mailboxes.starred')).toBeNull();
  });

  it.each([
    ['group', { isShared: true }],
    ['delegated', { isShared: true, accountId: 'shared', accountName: 'Shared account' }],
  ] as const)('preserves Unified with a %s mailbox, even if its section is hidden', (_name, shared) => {
    useSettingsStore.setState({ showSharedMailAccounts: false });
    const sharedBoxes = [...mailboxes, box('shared-inbox', 'inbox', shared)];
    useEmailStore.setState({ mailboxes: sharedBoxes });
    render(<MailSidebar mailboxes={sharedBoxes} />);
    expect(screen.getByText('unified_mailbox')).toBeInTheDocument();
    expect(screen.getByText('unified_all_unread')).toBeInTheDocument();
    expect(screen.getByText('unified_all_starred')).toBeInTheDocument();
    expect(screen.getByText('unified_sent')).toBeInTheDocument();
  });
});

describe('aggregation retains the unified master gate', () => {
  it.each(['multiple', 'cross-account', 'shared', 'group'])('keeps Unread/Starred gated for %s', (kind) => {
    useSettingsStore.setState({ enableUnifiedMailbox: false });
    let boxes = mailboxes;
    if (kind === 'multiple' || kind === 'cross-account') {
      useAccountStore.setState({ accounts: [account('a'), account('b')] } as never);
    } else {
      boxes = [...mailboxes, box('shared-inbox', 'inbox', { isShared: true, ...(kind === 'shared' ? { accountId: 'shared' } : {}) })];
      useEmailStore.setState({ mailboxes: boxes });
    }
    render(<MailSidebar mailboxes={boxes} crossAccountActive={kind === 'cross-account'} />);
    expect(ids()).not.toContain(CROSS_VIEW_IDS.unread);
    expect(ids()).not.toContain(CROSS_VIEW_IDS.starred);
  });
});
