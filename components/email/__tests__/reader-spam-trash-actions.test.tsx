import { render, act, fireEvent, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useSettingsStore } from '@/stores/settings-store';

// Spam and Trash showed the Inbox's toolbar. Spam now has "Not spam" in
// Archive's place and no quick reply; Trash has "Restore" there and its
// Delete says "Delete forever".

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
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

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
  { id: 'junk', name: 'Junk', role: 'junk', parentId: null, myRights: { mayAddItems: true } },
  { id: 'trash', name: 'Trash', role: 'trash', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

const message = (folder: string) => ({
  id: 'm1', blobId: 'b1', threadId: 't1', mailboxIds: { [folder]: true }, keywords: { $seen: true },
  from: [{ name: 'Dave', email: 'dave@example.net' }], to: [{ name: 'Alice', email: 'alice@example.org' }],
  subject: 'Hello', receivedAt: '2026-01-01T00:00:00Z', preview: 'Hello', hasAttachment: false, size: 100,
  textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [{ partId: '1', type: 'text/plain' }], attachments: [],
  bodyValues: { '1': { value: 'Plain body' } },
}) as unknown as Email;

const handlers = () => ({
  onArchive: vi.fn(),
  onDelete: vi.fn(),
  onMarkAsSpam: vi.fn(),
  onUndoSpam: vi.fn(),
  onMoveToMailbox: vi.fn(),
  onQuickReply: vi.fn(async () => true),
});

async function viewer(folder: string, h = handlers()) {
  render(<EmailViewer email={message(folder)} isLoading={false} mailboxes={mailboxes} selectedMailbox={folder} currentMailboxRole={folder} {...h} />);
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  return h;
}

const archiveButton = () => document.querySelector('button[title="tooltips.archive"]');

beforeEach(() => {
  useSettingsStore.setState({ deleteAction: 'trash', permanentlyDeleteJunk: false, quickReplyEnabled: true });
});

describe('reader toolbar in Spam', () => {
  it('offers Not spam in place of Archive', async () => {
    const h = await viewer('junk');
    expect(archiveButton()).toBeNull();
    fireEvent.click(screen.getByTestId('reader-not-spam'));
    expect(h.onUndoSpam).toHaveBeenCalled();
    // Only once: the old spam button no longer says it as well.
    expect(document.querySelectorAll('button[title="spam.not_spam_title"]')).toHaveLength(1);
  });

  it('has no quick reply', async () => {
    await viewer('junk');
    expect(screen.queryByPlaceholderText('quick_reply_placeholder')).toBeNull();
  });
});

describe('reader toolbar in Trash', () => {
  it('offers Restore in place of Archive, back to the Inbox', async () => {
    const h = await viewer('trash');
    expect(archiveButton()).toBeNull();
    fireEvent.click(screen.getByTestId('reader-restore'));
    expect(h.onMoveToMailbox).toHaveBeenCalledWith('inbox');
  });

  it('says Delete forever', async () => {
    await viewer('trash');
    expect(screen.getByTestId('reader-delete').textContent).toContain('delete_forever');
  });
});

describe('reader toolbar in the Inbox', () => {
  it('keeps Archive, Delete and quick reply', async () => {
    await viewer('inbox');
    expect(archiveButton()).not.toBeNull();
    expect(screen.queryByTestId('reader-restore')).toBeNull();
    expect(screen.queryByTestId('reader-not-spam')).toBeNull();
    expect(screen.getByTestId('reader-delete').textContent).not.toContain('delete_forever');
    expect(screen.getByPlaceholderText('quick_reply_placeholder')).toBeTruthy();
  });
});

