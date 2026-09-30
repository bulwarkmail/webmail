import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

// The menu's only far-reaching child - the plugin host iframe slot. It is
// never what these tests are about, so stub it out.
vi.mock('@/components/plugins/plugin-slot', () => ({
  PluginSlot: () => null,
}));

// vitest.setup.ts mocks next-intl's useTranslations to return the key itself,
// so labels render as raw keys ("forward_as_attachments" etc.).

import { EmailContextMenu } from '../email-context-menu';

const email: Email = {
  id: 'e1',
  blobId: 'b1',
  threadId: 't1',
  mailboxIds: { inbox: true },
  keywords: { $seen: true },
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  subject: 'Hello',
  receivedAt: '2026-01-01T00:00:00Z',
  hasAttachment: false,
  size: 100,
} as unknown as Email;

const mailboxes: Mailbox[] = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

type MenuProps = React.ComponentProps<typeof EmailContextMenu>;

function renderMenu(props: Partial<MenuProps> = {}) {
  const onClose = vi.fn();
  render(
    <EmailContextMenu
      email={email}
      position={{ x: 10, y: 10 }}
      isOpen
      onClose={onClose}
      menuRef={{ current: null }}
      mailboxes={mailboxes}
      selectedMailbox="inbox"
      currentMailboxRole="inbox"
      {...props}
    />,
  );
  return { onClose };
}

describe('EmailContextMenu batch forward as attachment', () => {
  it('shows the batch header and batch forward item when the right-clicked email is in a multi-selection', () => {
    renderMenu({ isMultiSelect: true, selectedCount: 3, onBatchForwardAsAttachment: vi.fn() });
    expect(screen.getByTestId('ctx-batch-forward-as-attachment')).toBeInTheDocument();
    expect(screen.getByText('items_selected')).toBeInTheDocument();
  });

  it('clicking the batch item invokes onBatchForwardAsAttachment and closes the menu', () => {
    const onBatchForwardAsAttachment = vi.fn();
    const { onClose } = renderMenu({ isMultiSelect: true, selectedCount: 3, onBatchForwardAsAttachment });
    fireEvent.click(screen.getByTestId('ctx-batch-forward-as-attachment'));
    expect(onBatchForwardAsAttachment).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hides the single-message forward-as-attachment item in batch mode', () => {
    renderMenu({ isMultiSelect: true, selectedCount: 3, onBatchForwardAsAttachment: vi.fn() });
    // vitest's next-intl mock renders labels as raw keys; the singular key
    // must be absent while the plural batch key is present.
    expect(screen.queryByText('forward_as_attachment')).toBeNull();
    expect(screen.getByText('forward_as_attachments')).toBeInTheDocument();
  });

  it('hides the batch item when only one email is selected', () => {
    renderMenu({ isMultiSelect: true, selectedCount: 1, onBatchForwardAsAttachment: vi.fn() });
    expect(screen.queryByTestId('ctx-batch-forward-as-attachment')).toBeNull();
  });

  it('hides the batch item when the right-clicked email is outside the selection', () => {
    renderMenu({ isMultiSelect: false, selectedCount: 3, onBatchForwardAsAttachment: vi.fn() });
    expect(screen.queryByTestId('ctx-batch-forward-as-attachment')).toBeNull();
  });

  it('hides the batch item for scheduled emails', () => {
    const scheduled = { ...email, isScheduled: true } as unknown as Email;
    renderMenu({
      email: scheduled,
      isMultiSelect: true,
      selectedCount: 3,
      onBatchForwardAsAttachment: vi.fn(),
    });
    expect(screen.queryByTestId('ctx-batch-forward-as-attachment')).toBeNull();
  });

  it('disables the batch item when no handler is passed', () => {
    renderMenu({ isMultiSelect: true, selectedCount: 3 });
    expect((screen.getByTestId('ctx-batch-forward-as-attachment') as HTMLButtonElement).disabled).toBe(true);
  });
});
