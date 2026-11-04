import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useSettingsStore } from '@/stores/settings-store';

vi.mock('@/components/plugins/plugin-slot', () => ({
  PluginSlot: () => null,
}));

import { EmailContextMenu } from '../email-context-menu';
import { messageActionShortcut } from '../message-action-shortcuts';

const email = {
  id: 'e1',
  blobId: 'b1',
  threadId: 't1',
  mailboxIds: { inbox: true },
  keywords: {},
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  subject: 'Hello',
  receivedAt: '2026-01-01T00:00:00Z',
  hasAttachment: false,
  size: 100,
} as unknown as Email;

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

function renderMenu(props: Partial<React.ComponentProps<typeof EmailContextMenu>> = {}) {
  render(
    <EmailContextMenu
      email={email}
      position={{ x: 10, y: 10 }}
      isOpen
      onClose={vi.fn()}
      menuRef={{ current: null }}
      mailboxes={mailboxes}
      selectedMailbox="inbox"
      currentMailboxRole="inbox"
      onReply={vi.fn()}
      onReplyAll={vi.fn()}
      onForward={vi.fn()}
      onDelete={vi.fn()}
      onToggleStar={vi.fn()}
      onMarkAsRead={vi.fn()}
      onMarkAsSpam={vi.fn()}
      {...props}
    />,
  );
}

const row = (name: string) => screen.getByText(name).closest('button') as HTMLElement;

describe('message menu key hints', () => {
  afterEach(() => useSettingsStore.setState({ singleKeyShortcuts: true }));

  it('shows the keys the list runs each action with', () => {
    renderMenu();
    expect(within(row('reply')).getByText('R')).toBeInTheDocument();
    expect(within(row('reply_all')).getByText('Shift + R')).toBeInTheDocument();
    expect(within(row('forward')).getByText('F')).toBeInTheDocument();
    expect(within(row('star')).getByText('S')).toBeInTheDocument();
    expect(within(row('mark_read')).getByText('Shift + I')).toBeInTheDocument();
    expect(within(row('mark_as_spam')).getByText('!')).toBeInTheDocument();
    expect(within(screen.getByTestId('ctx-delete')).getByText('Del')).toBeInTheDocument();
  });

  it('leaves single keys out when they are turned off, and keeps Del', () => {
    useSettingsStore.setState({ singleKeyShortcuts: false });
    renderMenu();
    expect(within(row('reply')).queryByText('R')).toBeNull();
    expect(within(row('star')).queryByText('S')).toBeNull();
    expect(within(screen.getByTestId('ctx-delete')).getByText('Del')).toBeInTheDocument();
  });

  it('shows them on a selection too', () => {
    renderMenu({ isMultiSelect: true, selectedCount: 2, onBatchDelete: vi.fn(), onBatchMarkAsRead: vi.fn(), onBatchMarkAsSpam: vi.fn() });
    expect(within(screen.getByTestId('ctx-delete')).getByText('Del')).toBeInTheDocument();
    expect(within(screen.getByTestId('ctx-mark-read')).getByText('Shift + I')).toBeInTheDocument();
    expect(within(screen.getByTestId('ctx-spam')).getByText('!')).toBeInTheDocument();
  });

  it('matches the read state: U marks a read message unread', () => {
    expect(messageActionShortcut('read', { unread: false, singleKeys: true })).toBe('U');
    expect(messageActionShortcut('read', { unread: true, singleKeys: true })).toBe('Shift + I');
    expect(messageActionShortcut('print', { singleKeys: true })).toBeUndefined();
  });
});

describe('message menu offline', () => {
  afterEach(async () => {
    const { useOfflineStore } = await import('@/lib/offline/state');
    useOfflineStore.setState({ browserOffline: false, enabled: [] });
  });

  it('greys out changes that would fail without a connection, and says why', async () => {
    const { useOfflineStore } = await import('@/lib/offline/state');
    useOfflineStore.setState({ browserOffline: true, enabled: [] });
    renderMenu();
    expect(screen.getByText('offline_header')).toBeInTheDocument();
    expect((screen.getByTestId('ctx-delete') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('ctx-star') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('ctx-mark-read') as HTMLButtonElement).disabled).toBe(true);
    // Writing a reply still works: the composer keeps the draft.
    expect(row('reply')).not.toBeDisabled();
  });

  it('leaves them on while online', () => {
    renderMenu();
    expect(screen.queryByText('offline_header')).toBeNull();
    expect((screen.getByTestId('ctx-delete') as HTMLButtonElement).disabled).toBe(false);
  });
});
