import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

// The admin policy's archiveActionEnabled gate (#1257): off, Bulwark offers no
// Archive action anywhere. vitest.setup.ts renders labels as their raw keys.

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/pro/pro-interface-redirect', () => ({ useProInterfaceActive: () => false }));
vi.mock('@/components/tour/tour-provider', () => ({ useTour: () => ({ startTour: vi.fn() }) }));

const { EmailContextMenu } = await import('../email-context-menu');
const { EmailHoverActions } = await import('../email-hover-actions');
const { MvListToolbar } = await import('../mv-list-toolbar');
const { KeyboardShortcutsModal } = await import('@/components/keyboard-shortcuts-modal');
const { usePolicyStore } = await import('@/stores/policy-store');
const { useEmailStore, ensureArchiveMailbox } = await import('@/stores/email-store');
const { useAuthStore } = await import('@/stores/auth-store');
const { useSettingsStore } = await import('@/stores/settings-store');

function setArchiveGate(on: boolean) {
  usePolicyStore.setState((state) => ({
    policy: { ...state.policy, features: { ...state.policy.features, archiveActionEnabled: on } },
  }));
}

// Each test starts from the stores as they were before the first one.
const initial = {
  policy: usePolicyStore.getState(),
  email: useEmailStore.getState(),
  auth: useAuthStore.getState(),
  settings: useSettingsStore.getState(),
};
afterEach(() => {
  usePolicyStore.setState(initial.policy, true);
  useEmailStore.setState(initial.email, true);
  useAuthStore.setState(initial.auth, true);
  useSettingsStore.setState(initial.settings, true);
});

const rights = {
  mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true,
  maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true,
};
const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, sortOrder: 0, totalEmails: 0,
  unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true, myRights: rights } as unknown as Mailbox;
const email = {
  id: 'e1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Alice', email: 'alice@example.com' }], subject: 'Hello',
  receivedAt: '2026-01-01T00:00:00Z', hasAttachment: false, size: 100,
} as unknown as Email;

function contextMenu(props: Partial<React.ComponentProps<typeof EmailContextMenu>> = {}) {
  render(
    <EmailContextMenu
      email={email}
      position={{ x: 10, y: 10 }}
      isOpen
      onClose={vi.fn()}
      menuRef={{ current: null }}
      mailboxes={[inbox]}
      selectedMailbox="inbox"
      currentMailboxRole="inbox"
      onArchive={vi.fn()}
      onBatchArchive={vi.fn()}
      {...props}
    />,
  );
}

describe('the Archive action gate', () => {
  it('context menu: archive for one message while the gate is on', () => {
    contextMenu();
    expect(screen.getByText('archive')).toBeInTheDocument();
  });

  it('context menu: no archive entry for one message with the gate off', () => {
    setArchiveGate(false);
    contextMenu();
    expect(screen.queryByText('archive')).toBeNull();
  });

  it('context menu: archive for a multi-selection while the gate is on', () => {
    contextMenu({ isMultiSelect: true, selectedCount: 3 });
    expect(screen.getByText('archive')).toBeInTheDocument();
  });

  it('context menu: no archive entry for a multi-selection with the gate off', () => {
    setArchiveGate(false);
    contextMenu({ isMultiSelect: true, selectedCount: 3 });
    expect(screen.queryByText('archive')).toBeNull();
  });

  it('hover actions: the configured archive button is left out with the gate off', () => {
    useSettingsStore.setState({ hoverActions: ['archive', 'delete'], interfaceLayout: 'default' } as never);
    const { unmount } = render(<EmailHoverActions email={email} onArchive={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByTestId('hover-action-archive')).toBeInTheDocument();
    unmount();

    setArchiveGate(false);
    render(<EmailHoverActions email={email} onArchive={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.queryByTestId('hover-action-archive')).toBeNull();
    expect(screen.getByTestId('hover-action-delete')).toBeInTheDocument();
  });

  it("Mountain View's selection bar: no archive button with the gate off", () => {
    const emails = [{ ...email, id: 'a' }, { ...email, id: 'b' }] as Email[];
    useAuthStore.setState({ client: {} as never } as never);
    useEmailStore.setState({
      emails, mailboxes: [inbox], selectedMailbox: 'inbox',
      selectedEmailKeys: new Set(['a', 'b']), isUnifiedView: false, unifiedRole: null,
    } as never);
    const { unmount } = render(<MvListToolbar loadedCount={2} onRefresh={() => {}} />);
    expect(screen.getByLabelText('archive')).toBeInTheDocument();
    unmount();

    setArchiveGate(false);
    render(<MvListToolbar loadedCount={2} onRefresh={() => {}} />);
    expect(screen.queryByLabelText('archive')).toBeNull();
  });

  it('shortcut help: the E row is listed only while the gate is on', () => {
    const { unmount } = render(<KeyboardShortcutsModal isOpen onClose={() => {}} />);
    expect(screen.getByText('shortcuts.actions.archive')).toBeInTheDocument();
    unmount();

    setArchiveGate(false);
    render(<KeyboardShortcutsModal isOpen onClose={() => {}} />);
    expect(screen.queryByText('shortcuts.actions.archive')).toBeNull();
  });

  it('the Archive folder: with the gate off none is created, an existing one not used', async () => {
    setArchiveGate(false);
    const client = { createMailbox: vi.fn() };
    const archive = { ...inbox, id: 'archive', name: 'Archive', role: 'archive' } as Mailbox;
    const refresh = vi.fn();
    await expect(ensureArchiveMailbox({ client: client as never, mailboxes: [inbox], selectedMailboxId: 'inbox', refresh }))
      .resolves.toBeNull();
    await expect(ensureArchiveMailbox({ client: client as never, mailboxes: [inbox, archive], selectedMailboxId: 'inbox', refresh }))
      .resolves.toBeNull();
    expect(client.createMailbox).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('the Archive folder: with the gate on it is created when missing', async () => {
    const archive = { ...inbox, id: 'archive', name: 'Archive', role: 'archive' } as Mailbox;
    const client = { createMailbox: vi.fn().mockResolvedValue(archive) };
    await expect(ensureArchiveMailbox({
      client: client as never, mailboxes: [inbox], selectedMailboxId: 'inbox',
      refresh: async () => [inbox, archive],
    })).resolves.toMatchObject({ id: 'archive' });
    expect(client.createMailbox).toHaveBeenCalledWith('Archive', undefined, undefined, { role: 'archive' });
  });

  it('batch archive: with the gate off nothing is asked of the server', async () => {
    setArchiveGate(false);
    const request = vi.fn();
    const client = { request, createMailbox: vi.fn(), batchMoveEmails: vi.fn() };
    useEmailStore.setState({ emails: [email], mailboxes: [inbox], selectedEmailKeys: new Set(['e1']) } as never);
    await expect(useEmailStore.getState().batchArchive(client as never)).resolves.toBe(false);
    expect(client.createMailbox).not.toHaveBeenCalled();
    expect(client.batchMoveEmails).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
