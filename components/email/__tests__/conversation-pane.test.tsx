import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useSettingsStore } from '@/stores/settings-store';

// The default layout's reading pane shows the whole conversation, as Mountain
// View does: the newest message open, the older ones folded to a line each
// and unfolded in place. Without `conversationPane` it shows the message alone.

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

function mail(n: number, overrides: Partial<Email> = {}): Email {
  return {
    id: `m${n}`, blobId: `b${n}`, threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
    from: [{ name: `Sender ${n}`, email: `s${n}@example.com` }], to: [{ name: 'Me', email: 'me@example.com' }],
    subject: 'Offsite agenda', receivedAt: `2026-01-0${n}T10:00:00Z`, preview: `Preview ${n}`,
    hasAttachment: false, size: 100, ...overrides,
  } as unknown as Email;
}
function withBody(e: Email, text: string): Email {
  return {
    ...e, textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [], attachments: [],
    bodyValues: { '1': { value: text, isTruncated: false } },
  } as unknown as Email;
}

const foldedIds = (c: HTMLElement) =>
  [...c.querySelectorAll('[data-mv-conversation-card]')].map((e) => e.getAttribute('data-email-id'));
const expandedIds = (c: HTMLElement) =>
  [...c.querySelectorAll('[data-mv-conversation-expanded]')].map((e) => e.getAttribute('data-email-id'));

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

describe('The conversation in the default layout\'s reading pane', () => {
  beforeEach(() => {
    useSettingsStore.setState({ interfaceLayout: 'default', markAsReadDelay: 0 });
  });

  it('shows the older messages folded above the open newest one', () => {
    const open = withBody(mail(6), 'Newest body');
    const conversation = [mail(1), mail(2), mail(3), mail(4), mail(5), open];
    const { container } = renderViewer(conversation, open, { conversationPane: true });

    // A long run keeps its first and last message around a count.
    expect(foldedIds(container)).toEqual(['m1', 'm5']);
    expect(container.querySelector('[data-mv-conversation-before]')).not.toBeNull();
    expect(screen.getByText('Newest body')).toBeInTheDocument();

    // The count names what it does, and shows the rest.
    fireEvent.click(screen.getByRole('button', { name: 'show_older' }));
    expect(foldedIds(container)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
  });

  it('unfolds an older message in place and loads its body', () => {
    const open = withBody(mail(3), 'Newest body');
    const onLoad = vi.fn();
    const { container } = renderViewer([mail(1), mail(2), open], open, {
      conversationPane: true,
      onLoadConversationEmail: onLoad,
    });
    fireEvent.click(screen.getByText('Sender 1'));
    expect(expandedIds(container)).toEqual(['m1']);
    expect(onLoad).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }));
  });

  it('opens unread older messages unfolded and marks them read', () => {
    const open = withBody(mail(3), 'Newest body');
    const onRead = vi.fn();
    const { container } = renderViewer([mail(1), mail(2, { keywords: {} }), open], open, {
      conversationPane: true,
      onMarkConversationEmailRead: onRead,
    });
    expect(expandedIds(container)).toEqual(['m2']);
    expect(onRead).toHaveBeenCalledWith(expect.objectContaining({ id: 'm2' }));
  });

  it('shows the message alone without it ("Show emails as individual messages")', () => {
    const open = withBody(mail(3), 'Newest body');
    const { container } = renderViewer([mail(1), mail(2), open], open);
    expect(foldedIds(container)).toEqual([]);
    expect(container.querySelector('[data-mv-conversation-before]')).toBeNull();
    expect(screen.getByText('Newest body')).toBeInTheDocument();
  });
});
