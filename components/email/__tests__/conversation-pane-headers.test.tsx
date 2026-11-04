import { render, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useSettingsStore } from '@/stores/settings-store';

// mail-p2-4: in the default layout's conversation every message has the same
// header (sender, short date with the full one on hover, Reply, Reply all and
// Forward), the subject line has no date of its own, and the newest message
// is open, also when it is your own reply.

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

const { EmailViewer, conversationOpenPlan, conversationShortDate } = await import('../email-viewer');

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

function mail(n: number, overrides: Partial<Email> = {}): Email {
  return {
    id: `m${n}`, blobId: `b${n}`, threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
    from: [{ name: `Sender ${n}`, email: `s${n}@example.com` }], to: [{ name: 'Me', email: 'me@example.com' }],
    subject: 'Offsite agenda', receivedAt: `2026-01-0${n}T10:00:00Z`, sentAt: `2026-01-0${n}T10:00:00Z`, preview: `Preview ${n}`,
    hasAttachment: false, size: 100, ...overrides,
  } as unknown as Email;
}
function withBody(e: Email, text: string): Email {
  return {
    ...e, textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [], attachments: [],
    bodyValues: { '1': { value: text, isTruncated: false } },
  } as unknown as Email;
}

const expandedIds = (c: HTMLElement) =>
  [...c.querySelectorAll('[data-mv-conversation-expanded]')].map((e) => e.getAttribute('data-email-id'));

describe('conversation headers in the default layout', () => {
  beforeEach(() => {
    useSettingsStore.setState({ interfaceLayout: 'default', markAsReadDelay: 0, timeFormat: '24h' });
  });

  it('gives the open message the date and Reply, Reply all, Forward on its sender line', () => {
    const open = withBody(mail(3), 'Newest body');
    const onReply = vi.fn();
    const onReplyAll = vi.fn();
    const onForward = vi.fn();
    const { container } = render(
      <EmailViewer email={open} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox"
        mvConversation={[mail(1), mail(2), open]} conversationPane
        onReply={onReply} onReplyAll={onReplyAll} onForward={onForward} />,
    );
    const header = container.querySelector('[data-mv-open-header]') as HTMLElement;
    const actions = header.querySelector('[data-mv-sender-actions]') as HTMLElement;
    expect(actions).not.toBeNull();
    fireEvent.click(within(actions).getByRole('button', { name: 'reply' }));
    fireEvent.click(within(actions).getByRole('button', { name: 'reply_all' }));
    fireEvent.click(within(actions).getByRole('button', { name: 'forward' }));
    expect(onReply).toHaveBeenCalled();
    expect(onReplyAll).toHaveBeenCalled();
    expect(onForward).toHaveBeenCalled();
    const date = actions.querySelector('time[data-conversation-date]') as HTMLElement;
    expect(date.getAttribute('title')!.length).toBeGreaterThan(date.textContent!.length);
    // No second date on the subject line.
    expect(container.querySelectorAll('time[data-conversation-date]').length).toBe(3);
    expect(container.querySelector('.sm\\:block .whitespace-nowrap')).toBeNull();
  });

  it('gives a conversation of one message the same header (pass 3)', () => {
    const open = withBody(mail(3), 'Only message');
    const onForward = vi.fn();
    // No thread of two or more came back: no mvConversation at all.
    const { container } = render(
      <EmailViewer email={open} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox"
        conversationPane onReply={vi.fn()} onReplyAll={vi.fn()} onForward={onForward} />,
    );
    const actions = container.querySelector('[data-mv-sender-actions]') as HTMLElement;
    expect(actions).not.toBeNull();
    fireEvent.click(within(actions).getByRole('button', { name: 'forward' }));
    expect(onForward).toHaveBeenCalled();
    const date = actions.querySelector('time[data-conversation-date]') as HTMLElement;
    expect(date.getAttribute('title')!.length).toBeGreaterThan(date.textContent!.length);
    // Not the long date beside the subject.
    expect(container.querySelector('.sm\\:block .whitespace-nowrap')).toBeNull();
  });

  it('keeps the plain reader header with "Show emails as individual messages"', () => {
    const open = withBody(mail(3), 'Only message');
    const { container } = render(
      <EmailViewer email={open} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox"
        onReply={vi.fn()} onReplyAll={vi.fn()} onForward={vi.fn()} />,
    );
    expect(container.querySelector('[data-mv-sender-actions]')).toBeNull();
  });

  it('gives an unfolded older message Forward too, in the same short date style', () => {
    const open = withBody(mail(3), 'Newest body');
    const onForward = vi.fn();
    const older = withBody(mail(2, { keywords: {} }), 'Older body');
    const { container } = render(
      <EmailViewer email={open} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox"
        mvConversation={[mail(1), older, open]} conversationPane
        onReplyConversationEmail={vi.fn()} onReplyAllConversationEmail={vi.fn()} onForwardConversationEmail={onForward} />,
    );
    const card = container.querySelector('[data-mv-conversation-expanded][data-email-id="m2"]') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'forward' }));
    expect(onForward).toHaveBeenCalledWith(expect.objectContaining({ id: 'm2' }));
    // Not Gmail's "(n days ago)".
    expect(card.querySelector('time')!.textContent).not.toMatch(/\(/);
  });

  it('opens your own newer reply and folds the read message you clicked', () => {
    const open = withBody(mail(2), 'Their message');
    const mine = mail(3, { from: [{ name: 'Me', email: 'me@example.com' }], mailboxIds: { sent: true } });
    const { container } = render(
      <EmailViewer email={open} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox"
        mvConversation={[mail(1), open, mine]} conversationPane />,
    );
    expect(expandedIds(container)).toEqual(['m3']);
    expect(container.querySelector('[data-mv-open-folded]')).not.toBeNull();
    expect(container.querySelector('[data-mv-open-header]')).toBeNull();
  });
});

describe('conversationOpenPlan', () => {
  it('keeps the open message when it is the newest', () => {
    expect(conversationOpenPlan([mail(1), mail(2)], 'm2')).toEqual({ expanded: [], foldOpen: false, newestId: null });
  });
  it('keeps an unread open message open beside the newest', () => {
    const plan = conversationOpenPlan([mail(1, { keywords: {} }), mail(2)], 'm1');
    expect(plan).toEqual({ expanded: ['m2'], foldOpen: false, newestId: 'm2' });
  });
  it('never picks a draft or a scheduled message as the newest', () => {
    const plan = conversationOpenPlan([mail(1), mail(2, { keywords: { $draft: true, $seen: true } }), mail(3, { isScheduled: true })], 'm1');
    expect(plan.newestId).toBeNull();
  });
});

describe('conversationShortDate', () => {
  const now = new Date('2026-11-04T12:00:00Z');
  it('has no relative part and no year this year', () => {
    const text = conversationShortDate('2026-10-21T13:40:00Z', '24h', now);
    expect(text).not.toMatch(/2026|ago|\(/);
    expect(text).toMatch(/21/);
  });
  it('has the year for older mail', () => {
    expect(conversationShortDate('2025-10-21T13:40:00Z', '24h', now)).toMatch(/2025/);
  });
});
