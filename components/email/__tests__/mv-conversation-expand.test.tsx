import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useSettingsStore } from '@/stores/settings-store';

// #1222: Mountain View showed one message of a conversation at a time. Every
// message now folds and unfolds in place, unread ones start unfolded (so
// opening the thread reads all of them), and the open message folds too.

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
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
    ...overrides,
  } as unknown as Email;
}

function withBody(e: Email, text: string): Email {
  return {
    ...e,
    textBody: [{ partId: '1', type: 'text/plain' }],
    htmlBody: [],
    attachments: [],
    bodyValues: { '1': { value: text, isTruncated: false } },
  } as unknown as Email;
}

const expandedIds = (c: HTMLElement) =>
  [...c.querySelectorAll('[data-mv-conversation-expanded]')].map((e) => e.getAttribute('data-email-id'));
const foldedIds = (c: HTMLElement) =>
  [...c.querySelectorAll('[data-mv-conversation-card]')].map((e) => e.getAttribute('data-email-id'));

function renderViewer(conversation: Email[], open: Email, props: Partial<Parameters<typeof EmailViewer>[0]> = {}) {
  return render(
    <EmailViewer
      email={open}
      mailboxes={mailboxes}
      selectedMailbox="inbox"
      currentMailboxRole="inbox"
      mvConversation={conversation}
      {...props}
    />,
  );
}

describe('Mountain View conversation folding (#1222)', () => {
  beforeEach(() => {
    useSettingsStore.setState({ interfaceLayout: 'mountain-view', markAsReadDelay: 0 });
  });

  it('opens with every unread message unfolded, fetches their bodies and marks them read', () => {
    const open = withBody(mail(4, { keywords: {} }), 'Open body');
    const conversation = [mail(1), mail(2, { keywords: {} }), mail(3, { keywords: {} }), open];
    const onLoad = vi.fn();
    const onRead = vi.fn();
    const { container } = renderViewer(conversation, open, {
      onLoadConversationEmail: onLoad,
      onMarkConversationEmailRead: onRead,
    });

    expect(expandedIds(container)).toEqual(['m2', 'm3']);
    expect(foldedIds(container)).toEqual(['m1']);
    expect(onLoad.mock.calls.map(([e]) => e.id).sort()).toEqual(['m2', 'm3']);
    expect(onRead.mock.calls.map(([e]) => e.id).sort()).toEqual(['m2', 'm3']);
  });

  it('unfolds a folded message in place and folds it again from its header', () => {
    const open = withBody(mail(3), 'Open body');
    const conversation = [withBody(mail(1), 'First body'), mail(2), open];
    const { container, rerender } = renderViewer(conversation, open);

    expect(expandedIds(container)).toEqual([]);
    fireEvent.click(screen.getByText('Sender 1'));
    expect(expandedIds(container)).toEqual(['m1']);
    expect(screen.getByText('First body')).toBeInTheDocument();

    // A second message can be open at the same time.
    fireEvent.click(screen.getByText('Sender 2'));
    expect(expandedIds(container)).toEqual(['m1', 'm2']);

    // The reply button acts on its own and leaves the message unfolded.
    const onReply = vi.fn();
    rerender(
      <EmailViewer
        email={open}
        mailboxes={mailboxes}
        selectedMailbox="inbox"
        currentMailboxRole="inbox"
        mvConversation={conversation}
        onReplyConversationEmail={onReply}
      />,
    );
    const header = container.querySelector('[data-mv-conversation-expanded][data-email-id="m1"] [data-mv-conversation-header]')!;
    fireEvent.click(header.querySelector('button[aria-label]')!);
    expect(onReply).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }));
    expect(expandedIds(container)).toEqual(['m1', 'm2']);

    fireEvent.click(header);
    expect(expandedIds(container)).toEqual(['m2']);
    expect(foldedIds(container)).toContain('m1');
  });

  it('replies to all from the selected header and keeps the bottom action', () => {
    const open = withBody(mail(2), 'Open body');
    const onReply = vi.fn();
    const onReplyAll = vi.fn();
    const { container } = renderViewer([mail(1), open], open, { onReply, onReplyAll });
    const header = container.querySelector('[data-mv-open-header]')!;
    const actions = header.querySelector('[data-mv-sender-actions]')!;
    const buttons = actions.querySelectorAll('button');
    expect(buttons[1]).toHaveAttribute('aria-label', 'reply');
    expect(buttons[2]).toHaveAttribute('aria-label', 'reply_all');
    fireEvent.click(buttons[2]);
    expect(onReplyAll).toHaveBeenCalledTimes(1);
    expect(onReply).not.toHaveBeenCalled();
    expect(container.querySelector('[data-mv-open-folded]')).toBeNull();
    expect(container.querySelector('[data-mv-reply-row]')).not.toBeNull();
  });

  it('replies to all from the clicked sibling without folding it or targeting the selected message', () => {
    const first = withBody(mail(1, { to: [{ email: 'team@example.com' }], keywords: {} }), 'First body');
    const open = withBody(mail(2), 'Open body');
    const selectedReplyAll = vi.fn();
    const siblingReplyAll = vi.fn();
    const { container } = renderViewer([first, open], open, {
      onReplyAll: selectedReplyAll,
      onReplyAllConversationEmail: siblingReplyAll,
    });
    const header = container.querySelector('[data-mv-conversation-expanded] [data-mv-conversation-header]')!;
    fireEvent.click(header.querySelector('button[aria-label="reply_all"]')!);
    expect(siblingReplyAll).toHaveBeenCalledWith(first);
    expect(selectedReplyAll).not.toHaveBeenCalled();
    expect(expandedIds(container)).toEqual(['m1']);
  });

  it.each([{ keywords: { $draft: true } }, { isScheduled: true }])('does not add a selected-header reply-all action for %o', (flags) => {
    const open = withBody(mail(2, flags), 'Open body');
    const { container } = renderViewer([mail(1), open], open, { onReplyAll: vi.fn() });
    expect(container.querySelector('[data-mv-sender-actions] button[aria-label="reply_all"]')).toBeNull();
  });

  it.each([{ keywords: { $draft: true } }, { isScheduled: true }])('does not add sibling-header reply actions for %o', (flags) => {
    const first = withBody(mail(1, { ...flags, keywords: { ...flags.keywords, $seen: true } }), 'First body');
    const open = withBody(mail(2), 'Open body');
    const { container } = renderViewer([first, open], open, {
      onReplyConversationEmail: vi.fn(),
      onReplyAllConversationEmail: vi.fn(),
    });
    fireEvent.click(screen.getByText('Sender 1'));
    expect(expandedIds(container)).toEqual(['m1']);
    const header = container.querySelector('[data-mv-conversation-expanded] [data-mv-conversation-header]')!;
    expect(header.querySelector('button[aria-label="reply"]')).toBeNull();
    expect(header.querySelector('button[aria-label="reply_all"]')).toBeNull();
  });

  it('folds the open message from its sender line and unfolds it again', () => {
    const open = withBody(mail(2), 'Open body');
    const conversation = [mail(1), open];
    const { container } = renderViewer(conversation, open);

    const header = container.querySelector('[data-mv-open-header]') as HTMLElement;
    expect(header).not.toBeNull();
    fireEvent.click(header);
    expect(container.querySelector('[data-mv-open-header]')).toBeNull();
    expect(foldedIds(container)).toEqual(['m1', 'm2']);
    // The body stays mounted, only hidden, so unfolding does not reload it.
    expect(container.querySelector('.email-content-wrapper')).toHaveClass('hidden');

    act(() => {
      fireEvent.click(container.querySelector('[data-mv-open-folded] [data-mv-conversation-card]')!);
    });
    expect(container.querySelector('[data-mv-open-header]')).not.toBeNull();
    expect(container.querySelector('.email-content-wrapper')).not.toHaveClass('hidden');
  });

  // #1223: the message used to show alone, then jump down under the earlier
  // messages once the conversation arrived.
  it('holds the message back while its conversation is on its way', () => {
    const open = withBody(mail(3), 'Open body');
    const otherThread = [mail(1, { id: 'x1', threadId: 't0' } as Partial<Email>), mail(2, { id: 'x2', threadId: 't0' } as Partial<Email>)];
    const { container, rerender } = renderViewer(otherThread, open, { mvConversationPending: true });

    expect(container.querySelector('[data-mv-conversation-pending]')).not.toBeNull();
    expect(container.querySelector('[data-mv-open-header]')).toBeNull();
    expect(container.querySelector('.email-content-wrapper')).toHaveClass('hidden');
    expect(container.querySelector('[data-mv-reply-row]')).toBeNull();

    rerender(
      <EmailViewer
        email={open}
        mailboxes={mailboxes}
        selectedMailbox="inbox"
        currentMailboxRole="inbox"
        mvConversation={[mail(1), mail(2), open]}
        mvConversationPending={false}
      />,
    );
    expect(container.querySelector('[data-mv-conversation-pending]')).toBeNull();
    expect(container.querySelector('[data-mv-open-header]')).not.toBeNull();
    expect(foldedIds(container)).toEqual(['m1', 'm2']);
  });

  it('does not wait when the open message is already in the conversation', () => {
    const open = withBody(mail(2), 'Open body');
    const { container } = renderViewer([mail(1), open], open, { mvConversationPending: true });
    expect(container.querySelector('[data-mv-conversation-pending]')).toBeNull();
    expect(container.querySelector('[data-mv-open-header]')).not.toBeNull();
  });

  it('shows a single message once its thread turns out to have no other messages', () => {
    const open = withBody(mail(1), 'Only body');
    const { container } = renderViewer(undefined as unknown as Email[], open, { mvConversationPending: false });
    expect(container.querySelector('[data-mv-conversation-pending]')).toBeNull();
    expect(container.querySelector('.email-content-wrapper')).not.toHaveClass('hidden');
  });

  it('does not fold a message that has no conversation around it', () => {
    const open = withBody(mail(1), 'Only body');
    const { container } = render(
      <EmailViewer email={open} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />,
    );
    expect(container.querySelector('[data-mv-open-header]')).toBeNull();
  });
});
