import { render, act, fireEvent, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { clearAllHooks } from '@/lib/plugin-hooks';
import { useAuthStore } from '@/stores/auth-store';

// compose-p2-6: a reply saved as a draft was nowhere to be seen on the
// message it answers. The reader shows it under the message, marked Draft,
// with Edit and Discard, where the quick reply box would be.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  useLocale: () => 'en',
  useFormatter: () => ({
    dateTime: (d: Date | string) => String(d),
    relativeTime: (d: Date | string) => String(d),
    number: (n: number) => String(n),
  }),
}));
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const { EmailViewer } = await import('../email-viewer');

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

const message = {
  id: 'm1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Ben Carter', email: 'ben.carter@example.com' }], to: [{ name: 'Me', email: 'me@example.org' }],
  subject: 'Hello', receivedAt: '2026-01-01T00:00:00Z', preview: 'Hello', hasAttachment: false, size: 100,
  textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [{ partId: '1', type: 'text/plain' }], attachments: [],
  bodyValues: { '1': { value: 'Plain body' } },
} as unknown as Email;

beforeEach(() => {
  clearAllHooks();
  useAuthStore.setState({ identities: [{ id: 'me', email: 'me@example.org', name: 'Me' }] } as never);
});

async function renderViewer(replyDraft: { preview?: string; onEdit: () => void; onDiscard: () => void } | null) {
  render(<EmailViewer email={message} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onQuickReply={vi.fn()} onReply={vi.fn()} replyDraft={replyDraft} />);
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
}

describe('a reply draft under its message', () => {
  it('shows Draft with its text, Edit and Discard, instead of the quick reply box', async () => {
    const onEdit = vi.fn();
    const onDiscard = vi.fn();
    await renderViewer({ preview: 'my answer', onEdit, onDiscard });
    const card = screen.getByTestId('reply-draft');
    expect(card.textContent).toContain('draft');
    expect(card.textContent).toContain('my answer');
    expect(screen.queryByPlaceholderText(/^quick_reply_to/)).toBeNull();
    fireEvent.click(screen.getByTestId('reply-draft-edit'));
    fireEvent.click(screen.getByTestId('reply-draft-discard'));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  // compose-p2-17: toasts lift over it as over the quick reply box.
  it('counts as the quick reply box for the toasts', async () => {
    await renderViewer({ preview: 'my answer', onEdit: vi.fn(), onDiscard: vi.fn() });
    expect(screen.getByTestId('reply-draft')).toHaveAttribute('data-quick-reply-box');
  });

  // compose-p3-3: the reader's Reply all and Forward handed their click event
  // on, which the host took for text to start with and skipped the draft.
  it('calls Reply all and Forward with nothing, not the click', async () => {
    const onReplyAll = vi.fn();
    const onForward = vi.fn();
    render(<EmailViewer email={message} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onQuickReply={vi.fn()} onReply={vi.fn()} onReplyAll={onReplyAll} onForward={onForward} replyDraft={null} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    for (const button of screen.getAllByTitle(/^reply_all/)) fireEvent.click(button);
    for (const button of screen.getAllByTitle(/^forward/)) fireEvent.click(button);
    expect(onReplyAll).toHaveBeenCalled();
    expect(onForward).toHaveBeenCalled();
    for (const call of [...onReplyAll.mock.calls, ...onForward.mock.calls]) expect(call).toEqual([]);
  });

  it('keeps the quick reply box when there is none', async () => {
    await renderViewer(null);
    expect(screen.queryByTestId('reply-draft')).toBeNull();
    expect(screen.getByPlaceholderText(/^quick_reply_to/)).toBeTruthy();
  });
});
