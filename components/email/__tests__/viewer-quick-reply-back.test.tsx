import { render, act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { clearAllHooks } from '@/lib/plugin-hooks';

// A quick reply that a pre-send question stopped (Back on the external
// recipient confirm) must keep the typed text; one that went out clears it.

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
] as unknown as Mailbox[];

const message = {
  id: 'm1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Dave', email: 'org-dave@org-two.test' }], to: [{ name: 'Alice', email: 'org-alice@example.org' }],
  subject: 'Hello', receivedAt: '2026-01-01T00:00:00Z', preview: 'Hello', hasAttachment: false, size: 100,
  textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [{ partId: '1', type: 'text/plain' }], attachments: [],
  bodyValues: { '1': { value: 'Plain body' } },
} as unknown as Email;

beforeEach(() => clearAllHooks());

async function typeAndSend(onQuickReply: (body: string) => Promise<boolean | void>) {
  render(<EmailViewer email={message} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onQuickReply={onQuickReply} />);
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  const box = screen.getByPlaceholderText('quick_reply_to') as HTMLTextAreaElement;
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: 'My answer' } });
  fireEvent.click(screen.getByRole('button', { name: 'send' }));
  await waitFor(() => expect(onQuickReply).toHaveBeenCalledWith('My answer'));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  return box;
}

describe('quick reply', () => {
  it('keeps the text when nothing was sent', async () => {
    const box = await typeAndSend(vi.fn(async () => false));
    expect(box.value).toBe('My answer');
  });

  it('clears the text after a send', async () => {
    const box = await typeAndSend(vi.fn(async () => true));
    expect(box.value).toBe('');
  });
});

// mail-p2-12: toasts covered the right half of the quick reply box.
describe('quick reply and toasts', () => {
  it('counts as a bottom bar, so toasts sit above it', async () => {
    document.documentElement.style.removeProperty('--bottom-controls-height');
    const { unmount } = render(<EmailViewer email={message} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onQuickReply={vi.fn()} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(document.querySelector('[data-quick-reply-box]')).not.toBeNull();
    expect(document.documentElement.style.getPropertyValue('--bottom-controls-height')).not.toBe('');
    unmount();
    expect(document.documentElement.style.getPropertyValue('--bottom-controls-height')).toBe('');
  });
});

// mail-p2-8: Undo send on a quick reply brings its text back into this box.
describe('quick reply after Undo send', () => {
  it('takes the undone text back into the box of the message it answered', async () => {
    const { useQuickReplyRestoreStore } = await import('@/stores/quick-reply-restore-store');
    useQuickReplyRestoreStore.setState({ pending: null });
    render(<EmailViewer email={message} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onQuickReply={vi.fn()} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const box = screen.getByPlaceholderText('quick_reply_to') as HTMLTextAreaElement;
    act(() => { useQuickReplyRestoreStore.getState().restore('other', 'Not for this one'); });
    expect(box.value).toBe('');
    act(() => { useQuickReplyRestoreStore.getState().restore('m1', 'My answer'); });
    await waitFor(() => expect(box.value).toBe('My answer'));
    expect(useQuickReplyRestoreStore.getState().pending).toBeNull();
  });
});

describe('automatic sign-out while the external recipient question is open', () => {
  it('answers Back and keeps the typed reply as a draft, without asking again', async () => {
    const { useExternalRecipientConfirmStore } = await import('@/stores/external-recipient-confirm-store');
    const { flushComposers, resetComposeFlushRegistry } = await import('@/lib/compose-flush-registry');
    resetComposeFlushRegistry();
    useExternalRecipientConfirmStore.setState({ pending: null, queue: [] });
    const onQuickReply = vi.fn((body: string) => {
      void body;
      return useExternalRecipientConfirmStore.getState().ask([{ address: 'org-dave@org-two.test', domain: 'org-two.test', field: 'to' }]);
    });
    const onSaveQuickReplyDraft = vi.fn(async () => {});
    render(<EmailViewer email={message} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox"
      onQuickReply={onQuickReply} onSaveQuickReplyDraft={onSaveQuickReplyDraft} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const box = screen.getByPlaceholderText('quick_reply_to') as HTMLTextAreaElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'My answer' } });
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    await waitFor(() => expect(useExternalRecipientConfirmStore.getState().pending).not.toBeNull());

    await act(async () => { await flushComposers(2000); });
    expect(onSaveQuickReplyDraft).toHaveBeenCalledWith('My answer');
    expect(useExternalRecipientConfirmStore.getState().pending).toBeNull();
    expect(box.value).toBe('My answer');
    expect(onQuickReply).toHaveBeenCalledTimes(1);
  });
});
