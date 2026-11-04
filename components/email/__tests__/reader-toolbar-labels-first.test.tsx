import { render, act, fireEvent, screen } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import type { Email, Mailbox } from '@/lib/jmap/types';

// The reader toolbar hid whole buttons (Forward, Archive, Move, at 1024 px
// even Reply) while their labels stayed. Now the labels go first, and Reply,
// Reply all, Forward, Archive and Move stay while anything else can give way.

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
  { id: 'clients', name: 'Clients', role: null, parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];
const email = {
  id: 'e1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Alice', email: 'alice@example.com' }], to: [], subject: 'Hello', receivedAt: '2026-01-01T00:00:00Z',
  preview: '', hasAttachment: false, size: 1, textBody: [], htmlBody: [], attachments: [], bodyValues: {},
} as unknown as Email;

const REQUIRED = ['1', '2', '3', '4', '5'];

/**
 * A toolbar 600 px wide whose two groups need `labelled` px each with labels
 * and `compact` px each without; every item is 40 px.
 */
function layout(labelled: number, compact: number) {
  const spies = [
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.closest('[data-toolbar-compact]') ? compact : labelled;
    }),
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600),
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(40),
  ];
  return () => spies.forEach((spy) => spy.mockRestore());
}

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });

const viewer = (props: Partial<React.ComponentProps<typeof EmailViewer>> = {}) => render(
  <EmailViewer
    email={email}
    mailboxes={mailboxes}
    selectedMailbox="inbox"
    currentMailboxRole="inbox"
    onReply={vi.fn()}
    onReplyAll={vi.fn()}
    onForward={vi.fn()}
    onArchive={vi.fn()}
    onDelete={vi.fn()}
    onMoveToMailbox={vi.fn()}
    onMarkAsSpam={vi.fn()}
    {...props}
  />,
);
const toolbar = (container: HTMLElement) => container.querySelector<HTMLElement>('[class*="@container/reader-toolbar"]')!;
const hiddenPriorities = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-overflow-item]'))
    .filter((item) => item.style.display === 'none')
    .map((item) => item.dataset.overflowPriority!);

describe('reader toolbar overflow', () => {
  it('keeps its labels when everything fits', () => {
    restore = layout(250, 150);
    const { container } = viewer();
    expect(toolbar(container).hasAttribute('data-toolbar-compact')).toBe(false);
    expect(hiddenPriorities(container)).toEqual([]);
  });

  it('drops the labels before any button', () => {
    restore = layout(400, 250);
    const { container } = viewer();
    expect(toolbar(container).hasAttribute('data-toolbar-compact')).toBe(true);
    expect(hiddenPriorities(container)).toEqual([]);
    // Every label is marked, so the compact toolbar shows icons only.
    const labels = Array.from(container.querySelectorAll('[data-toolbar-label]')).map((label) => label.textContent);
    expect(labels).toEqual(expect.arrayContaining(['reply', 'reply_all', 'forward', 'archive', 'delete', 'move']));
  });

  it('then hides the optional buttons, never Reply, Reply all, Forward, Archive or Move', () => {
    restore = layout(500, 400);
    const { container } = viewer();
    const hidden = hiddenPriorities(container);
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.filter((p) => REQUIRED.includes(p))).toEqual([]);
    // The least important first: the dark-mode toggle before the read state.
    expect(hidden).toContain('11');
  });

  it('hides the required ones only in a reader too narrow for their icons, Reply last', () => {
    restore = layout(2000, 1000);
    const { container } = viewer();
    const hidden = hiddenPriorities(container);
    expect(hidden).toEqual(expect.arrayContaining(REQUIRED));
    restore();
    // A little more room keeps Reply.
    restore = layout(2000, 470);
    const { container: roomier } = viewer();
    const kept = hiddenPriorities(roomier);
    expect(kept).not.toContain('1');
  });

  it('offers Open in new window and Fullscreen in the more menu when they have no room', async () => {
    restore = layout(500, 400);
    viewer({ onOpenInWindow: vi.fn(), onToggleFullscreen: vi.fn() });
    expect(screen.getByTestId('viewer-open-in-window').hasAttribute('data-overflow-item')).toBe(true);
    // jsdom lays nothing out, so every toolbar button reads as hidden here.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'more_actions' })); });
    expect(await screen.findByRole('menuitem', { name: 'open_in_window' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'fullscreen' })).toBeTruthy();
  });
});
