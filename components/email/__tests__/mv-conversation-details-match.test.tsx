import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useSettingsStore } from '@/stores/settings-store';

// #1743, #1744: an unfolded message of a Mountain View conversation showed
// only "To <name>" under its sender and a short details list without the
// server's checks. It now shows the open message's recipients line (with CC)
// and the same details panel, SPF/DKIM/DMARC included.

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
    textBody: [{ partId: '1', type: 'text/plain' }],
    htmlBody: [],
    attachments: [],
    bodyValues: { '1': { value: `Body ${n}`, isTruncated: false } },
    ...overrides,
  } as unknown as Email;
}

const checked = {
  cc: [{ name: 'Carol', email: 'carol@example.com' }],
  authenticationResults: {
    spf: { result: 'pass', domain: 'example.com' },
    dkim: { result: 'pass', domain: 'example.com' },
    dmarc: { result: 'pass', policy: 'reject' },
  },
} as Partial<Email>;

function renderConversation() {
  const older = mail(1, checked);
  const open = mail(2, checked);
  const utils = render(
    <EmailViewer email={open} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox"
      mvConversation={[older, open]} />,
  );
  fireEvent.click(screen.getByText('Sender 1'));
  const card = utils.container.querySelector('[data-mv-conversation-expanded]') as HTMLElement;
  return { ...utils, card };
}

describe('unfolded conversation message matches the open one (#1743, #1744)', () => {
  beforeEach(() => {
    useSettingsStore.setState({ interfaceLayout: 'mountain-view', markAsReadDelay: -1 });
  });

  it('shows CC next to To under the sender', () => {
    const { card } = renderConversation();
    const line = card.querySelector('[data-message-recipients]') as HTMLElement;
    expect(line).not.toBeNull();
    expect(within(line).getByText('Me')).toBeInTheDocument();
    expect(within(line).getByText('cc:')).toBeInTheDocument();
    expect(within(line).getByText('Carol')).toBeInTheDocument();
    expect(line.querySelector('[data-message-details-toggle]')!.textContent).toBe('show_details');
  });

  it('opens the full details panel with the server checks', () => {
    const { card } = renderConversation();
    fireEvent.click(card.querySelector('[data-message-details-toggle]')!);
    const details = card.querySelector('[data-message-details]') as HTMLElement;
    expect(details).not.toBeNull();
    expect(within(details).getByText('details.authentication_security')).toBeInTheDocument();
    expect(within(details).getByText('SPF')).toBeInTheDocument();
    expect(within(details).getByText('DKIM')).toBeInTheDocument();
    expect(within(details).getByText('DMARC')).toBeInTheDocument();
    // The message stays unfolded.
    expect(card.isConnected).toBe(true);
    expect(card.querySelector('[data-message-details-toggle]')!.textContent).toBe('hide_details');
  });
});
