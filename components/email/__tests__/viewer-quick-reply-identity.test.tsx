import { render, act, fireEvent, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { clearAllHooks, identityHooks } from '@/lib/plugin-hooks';
import type { ReplyIdentityContext } from '@/lib/plugin-types';
import { useAuthStore } from '@/stores/auth-store';

// #1694: a plugin picks the From of a quick reply. The box shows the address
// it goes out from, and Send and the sign-out draft carry the pick.

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

// Forwarded from a Gmail account: To names a list, only Delivered-To the account.
const message = {
  id: 'm1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Ben Carter', email: 'ben.carter@example.com' }], to: [{ name: 'List', email: 'list@example.net' }],
  headers: { 'Delivered-To': ' kaan.b@gmail.example' },
  subject: 'Hello', receivedAt: '2026-01-01T00:00:00Z', preview: 'Hello', hasAttachment: false, size: 100,
  textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [{ partId: '1', type: 'text/plain' }], attachments: [],
  bodyValues: { '1': { value: 'Plain body' } },
} as unknown as Email;

beforeEach(() => {
  clearAllHooks();
  useAuthStore.setState({
    identities: [
      { id: 'me', email: 'me@example.org', name: 'Me' },
      { id: 'gmail-b', email: 'kaan.b@gmail.example', name: 'Kaan' },
    ],
  } as never);
});

async function startQuickReply(onQuickReply = vi.fn(async (_text: string, _options?: { identityId?: string }) => true)) {
  render(<EmailViewer email={message} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onQuickReply={onQuickReply} onReply={vi.fn()} />);
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  const box = screen.getByPlaceholderText(/^quick_reply_to/);
  fireEvent.focus(box);
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  fireEvent.change(box, { target: { value: 'Thanks' } });
  return onQuickReply;
}

describe('quick reply From picked by a plugin', () => {
  it('asks once the user starts on it, shows the pick and sends with it', async () => {
    // Bulwark's own pick is the Delivered-To match; the plugin wants the other.
    const handler = vi.fn((ctx: ReplyIdentityContext) => (ctx.identityId === 'gmail-b' ? 'me' : undefined));
    identityHooks.onSelectReplyIdentity.register('p', handler);

    const onQuickReply = await startQuickReply();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ mode: 'quick-reply', email: { deliveredTo: ['kaan.b@gmail.example'] } });
    expect(screen.getByTestId('quick-reply-from')).toHaveTextContent('from: Me <me@example.org>');

    await act(async () => { fireEvent.click(screen.getByText('send')); });
    expect(onQuickReply).toHaveBeenCalledWith('Thanks', expect.objectContaining({ identityId: 'me' }));
  });

  it('shows the address Bulwark picked when no plugin listens', async () => {
    const onQuickReply = await startQuickReply();
    expect(screen.getByTestId('quick-reply-from')).toHaveTextContent('from: Kaan <kaan.b@gmail.example>');
    await act(async () => { fireEvent.click(screen.getByText('send')); });
    expect(onQuickReply.mock.calls[0][1]).not.toHaveProperty('identityId');
  });
});
