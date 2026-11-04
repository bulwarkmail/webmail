import { render, act, fireEvent, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { clearAllHooks } from '@/lib/plugin-hooks';
import { useAuthStore } from '@/stores/auth-store';

// The quick reply box counted characters, hid the full editor behind "More
// options" and didn't say who the reply goes to. It now names the
// recipients in its placeholder and offers "Open full editor".

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
  from: [{ name: 'Ben Carter', email: 'ben.carter@example.com' }], to: [{ name: 'Me', email: 'me@example.org' }],
  subject: 'Hello', receivedAt: '2026-01-01T00:00:00Z', preview: 'Hello', hasAttachment: false, size: 100,
  textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [{ partId: '1', type: 'text/plain' }], attachments: [],
  bodyValues: { '1': { value: 'Plain body' } },
} as unknown as Email;

beforeEach(() => {
  clearAllHooks();
  useAuthStore.setState({ identities: [{ id: 'me', email: 'me@example.org', name: 'Me' }] } as never);
});

async function renderViewer(email: Email, onReply = vi.fn()) {
  render(<EmailViewer email={email} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onQuickReply={vi.fn()} onReply={onReply} />);
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
}

describe('quick reply wording', () => {
  it('says who the reply goes to', async () => {
    await renderViewer(message);
    expect(screen.getByPlaceholderText('quick_reply_to:{"names":"Ben Carter"}')).toBeTruthy();
  });

  it('names the Reply-To address over the sender, by address when it has no name', async () => {
    await renderViewer({ ...message, replyTo: [{ email: 'team@example.com' }] } as unknown as Email);
    expect(screen.getByPlaceholderText('quick_reply_to:{"names":"team@example.com"}')).toBeTruthy();
  });

  it('drops the character count and opens the full editor with the typed text', async () => {
    const onReply = vi.fn();
    await renderViewer(message, onReply);
    const box = screen.getByPlaceholderText(/^quick_reply_to/);
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'Thanks, will do' } });

    expect(screen.queryByText(/characters_count/)).toBeNull();
    expect(screen.queryByText('more_options')).toBeNull();
    const full = screen.getByTestId('quick-reply-full-editor');
    expect(full).toHaveTextContent('open_full_editor');
    fireEvent.click(full);
    expect(onReply).toHaveBeenCalledWith('Thanks, will do');
  });
});

// compose-p2-17: the toasts lift over the box by its height (toast.tsx).
describe('quick reply box and the toasts', () => {
  it('marks the box and gives the page its height, and takes both back when it goes', async () => {
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(96);
    const { unmount } = render(<EmailViewer email={message} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onQuickReply={vi.fn()} onReply={vi.fn()} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });

    expect(document.querySelector('[data-quick-reply-box]')).not.toBeNull();
    expect(document.documentElement.style.getPropertyValue('--quick-reply-height')).toBe('96px');
    unmount();
    expect(document.documentElement.style.getPropertyValue('--quick-reply-height')).toBe('');
    height.mockRestore();
  });
});
