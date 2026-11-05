import { render, act, fireEvent, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useSettingsStore } from '@/stores/settings-store';
import { archiveInboxTarget } from '@/lib/archive-inbox';

// mail-p3-4: Archive offered "Archive" for mail already in Archive. There
// the first filing action now brings it back: "Move to Inbox", in the
// reader's toolbar and in the row menu, as Trash does with Restore.

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
  useIsMobile: () => false,
}));
vi.mock('@/components/plugins/plugin-actions', () => ({
  PluginActions: () => null,
  usePluginActions: () => [],
  useMessageActionTarget: () => ({ accountKind: 'personal', keywords: [] }),
  useRowActionTarget: (target: unknown) => target,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('../email-viewer');
const { EmailContextMenu } = await import('../email-context-menu');
const { EmailHoverActions } = await import('../email-hover-actions');
const { useEmailStore } = await import('@/stores/email-store');

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
  { id: 'archive', name: 'Archive', role: 'archive', parentId: null, myRights: { mayAddItems: true } },
  { id: 'y2026', name: '2026', role: null, parentId: 'archive', myRights: { mayAddItems: true } },
  { id: 'clients', name: 'Clients', role: null, parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

const message = (folder: string) => ({
  id: 'm1', blobId: 'b1', threadId: 't1', mailboxIds: { [folder]: true }, keywords: { $seen: true },
  from: [{ name: 'Dave', email: 'dave@example.net' }], to: [{ name: 'Alice', email: 'alice@example.org' }],
  subject: 'Hello', receivedAt: '2026-01-01T00:00:00Z', preview: 'Hello', hasAttachment: false, size: 100,
  textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [{ partId: '1', type: 'text/plain' }], attachments: [],
  bodyValues: { '1': { value: 'Plain body' } },
}) as unknown as Email;

const archiveButton = () => document.querySelector('button[title="archive (E)"]');

async function viewer(folder: string, role: string | undefined, selected = folder) {
  const h = { onArchive: vi.fn(), onDelete: vi.fn(), onMoveToMailbox: vi.fn() };
  render(<EmailViewer email={message(folder)} isLoading={false} mailboxes={mailboxes} selectedMailbox={selected} currentMailboxRole={role} {...h} />);
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  return h;
}

beforeEach(() => {
  useSettingsStore.setState({ deleteAction: 'trash', permanentlyDeleteJunk: false });
});

describe('archiveInboxTarget', () => {
  it('finds the Inbox from Archive and from a folder under it', () => {
    expect(archiveInboxTarget(mailboxes, 'archive')?.id).toBe('inbox');
    expect(archiveInboxTarget(mailboxes, 'y2026')?.id).toBe('inbox');
  });

  it('is nothing elsewhere', () => {
    expect(archiveInboxTarget(mailboxes, 'inbox')).toBeUndefined();
    expect(archiveInboxTarget(mailboxes, 'clients')).toBeUndefined();
    expect(archiveInboxTarget(mailboxes, '')).toBeUndefined();
  });
});

describe('reader toolbar in Archive', () => {
  it('offers Move to Inbox in place of Archive, keeping E', async () => {
    const h = await viewer('archive', 'archive');
    expect(archiveButton()).toBeNull();
    const button = screen.getByTestId('reader-move-to-inbox');
    expect(button.getAttribute('title')).toBe('move_to_inbox (E)');
    fireEvent.click(button);
    expect(h.onMoveToMailbox).toHaveBeenCalledWith('inbox');
    expect(h.onArchive).not.toHaveBeenCalled();
  });

  it('does so in a year folder under Archive too', async () => {
    await viewer('y2026', undefined);
    expect(screen.getByTestId('reader-move-to-inbox')).toBeTruthy();
  });

  it('a message window, which browses no folder, goes by the message', async () => {
    await viewer('archive', 'archive', '');
    expect(screen.getByTestId('reader-move-to-inbox')).toBeTruthy();
  });

  it('keeps Archive elsewhere', async () => {
    await viewer('clients', undefined);
    expect(archiveButton()).toBeTruthy();
    expect(screen.queryByTestId('reader-move-to-inbox')).toBeNull();
  });
});

describe('row menu in Archive', () => {
  it('has Move to Inbox and no Archive', async () => {
    const onMoveToMailbox = vi.fn();
    const onArchive = vi.fn();
    render(
      <EmailContextMenu
        email={message('archive')}
        position={{ x: 10, y: 10 }}
        isOpen
        onClose={() => {}}
        menuRef={{ current: null }}
        mailboxes={mailboxes}
        selectedMailbox="archive"
        currentMailboxRole="archive"
        onArchive={onArchive}
        onDelete={() => {}}
        onMoveToMailbox={onMoveToMailbox}
      />,
    );
    expect(screen.queryByRole('menuitem', { name: /^archive/ })).toBeNull();
    fireEvent.click(screen.getByTestId('ctx-move-to-inbox'));
    expect(onMoveToMailbox).toHaveBeenCalledWith('inbox');
    expect(onArchive).not.toHaveBeenCalled();
  });
});

describe('row hover actions in Archive', () => {
  it('name the archive button Move to Inbox there, and Archive elsewhere', () => {
    useSettingsStore.setState({ hoverActions: ['archive', 'delete'], interfaceLayout: 'default', hoverActionsMode: 'inline' } as never);
    useEmailStore.setState({ mailboxes, selectedMailbox: 'archive' });
    const onArchive = vi.fn();
    const { unmount } = render(<EmailHoverActions email={message('archive')} onArchive={onArchive} onDelete={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'move_to_inbox' }));
    expect(onArchive).toHaveBeenCalled();
    unmount();
    useEmailStore.setState({ selectedMailbox: 'clients' });
    render(<EmailHoverActions email={message('clients')} onArchive={onArchive} onDelete={() => {}} />);
    expect(screen.getByRole('button', { name: 'archive' })).toBeTruthy();
  });
});
