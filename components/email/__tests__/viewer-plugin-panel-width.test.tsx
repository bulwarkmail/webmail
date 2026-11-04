import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import type { Email, Mailbox } from '@/lib/jmap/types';

// With a plugin panel open at 280 px next to a 300 px message (three panes
// on a laptop), the subject broke after every few letters. The panel now
// starts collapsed when it would leave the message under 480 px.

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({
  PluginSlot: ({ name }: { name: string }) => React.createElement('div', { 'data-testid': `slot-${name}` }),
}));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({
  usePluginSlotOffers: (slot: string) => (slot === 'email-detail-sidebar' ? [{ pluginId: 'notes', order: 100 }] : []),
}));

let reportWidth = 0;
const observers: Array<(entries: Array<{ contentRect: { width: number } }>) => void> = [];
class FakeResizeObserver {
  constructor(private cb: (entries: Array<{ contentRect: { width: number } }>) => void) { observers.push(cb); }
  observe() { this.cb([{ contentRect: { width: reportWidth } }]); }
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', FakeResizeObserver);

const { EmailViewer } = await import('../email-viewer');

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];
const email = {
  id: 'e1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Alice', email: 'alice@example.com' }], to: [], subject: 'Hello', receivedAt: '2026-01-01T00:00:00Z',
  preview: '', hasAttachment: false, size: 1, textBody: [], htmlBody: [], attachments: [], bodyValues: {},
} as unknown as Email;

function renderViewer() {
  return render(<EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
}

beforeEach(() => {
  localStorage.clear();
  observers.length = 0;
});

describe('plugin detail panel and narrow messages', () => {
  it('starts collapsed when it would leave the message too narrow', () => {
    reportWidth = 640;
    renderViewer();

    expect(screen.queryByTestId('slot-email-detail-sidebar')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'plugin_panel', pressed: false })).toBeInTheDocument();
  });

  it('opens anyway when the user asks', () => {
    reportWidth = 640;
    renderViewer();

    act(() => { fireEvent.click(screen.getByRole('button', { name: 'plugin_panel', pressed: false })); });

    expect(screen.getByTestId('slot-email-detail-sidebar')).toBeInTheDocument();
  });

  it('is open when there is room', () => {
    reportWidth = 1100;
    renderViewer();

    expect(screen.getByTestId('slot-email-detail-sidebar')).toBeInTheDocument();
  });
});
