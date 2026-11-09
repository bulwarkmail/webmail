import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useSettingsStore } from '@/stores/settings-store';

// #1224: on the phone Mountain View showed threads in a separate view, newest
// first and without the to/cc/bcc details. The phone viewer now draws the same
// conversation as the desktop one: oldest first, every message foldable, and
// each unfolded message has its own details.

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: true, isTablet: false, isDesktop: false }),
  useMediaQuery: () => false,
}));

vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));

vi.mock('@/components/plugins/plugin-slot', () => ({
  PluginSlot: () => null,
}));

vi.mock('@/hooks/use-plugin-slot-offers', () => ({
  usePluginSlotOffers: () => [],
}));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('../email-viewer');

const mailboxes: Mailbox[] = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

function mail(n: number, overrides: Partial<Email> = {}): Email {
  return {
    id: `m${n}`,
    blobId: `b${n}`,
    threadId: 't1',
    mailboxIds: { inbox: true },
    keywords: { $seen: true },
    from: [{ name: `Sender ${n}`, email: `s${n}@example.com` }],
    to: [{ name: 'Me', email: 'me@example.com' }],
    subject: 'Subject',
    receivedAt: `2026-01-0${n}T10:00:00Z`,
    preview: `Preview ${n}`,
    hasAttachment: false,
    size: 100,
    textBody: [{ partId: '1', type: 'text/plain' }],
    htmlBody: [],
    attachments: [],
    bodyValues: { '1': { value: `Body ${n}`, isTruncated: false } },
    ...overrides,
  } as unknown as Email;
}

const cardIds = (c: HTMLElement) =>
  [...c.querySelectorAll('[data-mv-conversation-card], [data-mv-conversation-expanded]')].map((e) => e.getAttribute('data-email-id'));

describe('Mountain View conversation on the phone (#1224)', () => {
  beforeEach(() => {
    useSettingsStore.setState({ interfaceLayout: 'mountain-view', markAsReadDelay: -1 });
  });

  it('draws the conversation oldest first around the open message', () => {
    const open = mail(3);
    const { container } = render(
      <EmailViewer email={open} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox"
        mvConversation={[mail(1), mail(2), open]} />,
    );
    expect(cardIds(container)).toEqual(['m1', 'm2']);
    const before = container.querySelector('[data-mv-conversation-before]')!;
    const openHeader = container.querySelector('[data-mv-open-header-mobile]')!;
    expect(before.compareDocumentPosition(openHeader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows cc and bcc of an unfolded message in its details', () => {
    const older = mail(1, {
      cc: [{ name: 'Carol', email: 'carol@example.com' }],
      bcc: [{ name: 'Dave', email: 'dave@example.com' }],
    });
    const open = mail(2);
    const { container } = render(
      <EmailViewer email={open} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox"
        mvConversation={[older, open]} />,
    );
    fireEvent.click(screen.getByText('Sender 1'));
    expect(container.querySelector('[data-mv-conversation-details]')).toBeNull();

    fireEvent.click(container.querySelector('[data-mv-conversation-details-toggle]')!);
    const details = container.querySelector('[data-mv-conversation-details]') as HTMLElement;
    expect(details).not.toBeNull();
    expect(details.textContent).toContain('Carol <carol@example.com>');
    expect(details.textContent).toContain('Dave <dave@example.com>');
    // The toggle does not fold the message it sits in.
    expect(cardIds(container)).toEqual(['m1']);
    expect(container.querySelector('[data-mv-conversation-expanded]')).not.toBeNull();
  });

  it('folds the open message from its phone sender line', () => {
    const open = mail(2);
    const { container } = render(
      <EmailViewer email={open} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox"
        mvConversation={[mail(1), open]} />,
    );
    fireEvent.click(container.querySelector('[data-mv-open-header-mobile]')!);
    expect(container.querySelector('[data-mv-open-folded]')).not.toBeNull();
    expect(cardIds(container)).toEqual(['m1', 'm2']);
  });

  it('replies from the top of the open message without folding it (#1475)', () => {
    const open = mail(2);
    const onReply = vi.fn();
    const onReplyAll = vi.fn();
    const { container } = render(
      <EmailViewer email={open} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox"
        mvConversation={[mail(1), open]} onReply={onReply} onReplyAll={onReplyAll} />,
    );
    const actions = container.querySelector('[data-mv-open-header-mobile] [data-mv-mobile-sender-actions]')!;
    expect(actions).not.toBeNull();
    fireEvent.click(actions.querySelector('button[aria-label="reply"]')!);
    fireEvent.click(actions.querySelector('button[aria-label="reply_all"]')!);
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onReplyAll).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-mv-open-folded]')).toBeNull();
  });

  it.each([{ keywords: { $draft: true } }, { isScheduled: true }])('has no reply at the top of %o', (flags) => {
    const open = mail(2, flags as Partial<Email>);
    const { container } = render(
      <EmailViewer email={open} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox"
        mvConversation={[mail(1), open]} onReply={vi.fn()} onReplyAll={vi.fn()} />,
    );
    expect(container.querySelector('[data-mv-mobile-sender-actions]')).toBeNull();
  });
});
