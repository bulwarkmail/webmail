import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

// The viewer reaches far beyond the toolbar - iframes, plugins, the tour, drag
// handling. None of that is what these tests are about, so it is stubbed down
// to the pieces the More menu actually reads.
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

// jsdom ships no ResizeObserver; the toolbar's overflow measurement wants one.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('../email-viewer');
const { useSettingsStore } = await import('@/stores/settings-store');

const email: Email = {
  id: 'e1',
  blobId: 'b1',
  threadId: 't1',
  mailboxIds: { inbox: true },
  keywords: { $seen: true },
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  to: [{ name: 'Bob', email: 'bob@example.com' }],
  subject: 'Hello',
  receivedAt: '2026-01-01T00:00:00Z',
  preview: 'Hello',
  hasAttachment: false,
  size: 100,
  textBody: [],
  htmlBody: [],
  attachments: [],
  bodyValues: {},
} as unknown as Email;

const mailboxes: Mailbox[] = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
  { id: 'archive', name: 'Archive', role: 'archive', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

function renderViewer(props: Partial<React.ComponentProps<typeof EmailViewer>> = {}) {
  return render(
    <EmailViewer
      email={email}
      mailboxes={mailboxes}
      selectedMailbox="inbox"
      currentMailboxRole="inbox"
      onMoveToMailbox={vi.fn()}
      onSetTag={vi.fn()}
      {...props}
    />,
  );
}

/** Focus is handed over a frame late so the sub-view can render first. */
function flushFrames() {
  act(() => {
    vi.advanceTimersByTime(32);
  });
}

/** How a tap reaches the page: the outside-click watcher listens on mousedown. */
function tap(element: HTMLElement) {
  fireEvent.mouseDown(document.body === element ? element : element, { bubbles: true });
  fireEvent.click(element);
}

function openMoreMenu() {
  tap(screen.getByRole('button', { name: 'more_actions' }));
  flushFrames();
}

describe('email viewer More actions menu', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout'] });
    useSettingsStore.setState({
      emailKeywords: [{ id: 'work', label: 'Work', color: 'blue' }],
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the tag sub-view instead of closing the menu (#779)', () => {
    renderViewer();
    openMoreMenu();

    const menu = screen.getByRole('menu', { name: 'more_actions' });
    tap(within(menu).getByRole('menuitem', { name: /tag/i }));
    flushFrames();

    // The panel is still on screen, now showing the tags rather than the top level.
    const subMenu = screen.getByRole('menu', { name: 'tag' });
    expect(subMenu).not.toHaveAttribute('inert');
    expect(within(subMenu).getByRole('menuitemcheckbox', { name: /Work/ })).toBeInTheDocument();
  });

  it('offers Move to as a sub-view of its own', () => {
    const onMoveToMailbox = vi.fn();
    renderViewer({ onMoveToMailbox });
    openMoreMenu();

    const menu = screen.getByRole('menu', { name: 'more_actions' });
    tap(within(menu).getByRole('menuitem', { name: /move_to/i }));
    flushFrames();

    const subMenu = screen.getByRole('menu', { name: 'move_to' });
    tap(within(subMenu).getByRole('menuitem', { name: /Archive/ }));

    expect(onMoveToMailbox).toHaveBeenCalledWith('archive');
  });

  it('moves focus into the sub-view and back onto the row that opened it', () => {
    renderViewer();
    openMoreMenu();

    const menu = screen.getByRole('menu', { name: 'more_actions' });
    tap(within(menu).getByRole('menuitem', { name: /tag/i }));
    flushFrames();

    expect(document.activeElement).toBe(
      within(screen.getByRole('menu', { name: 'tag' })).getByRole('menuitemcheckbox', { name: /Work/ }),
    );

    fireEvent.keyDown(screen.getByRole('menu', { name: 'tag' }), { key: 'Escape' });
    flushFrames();

    // Escape backs out of the sub-view rather than dismissing the whole menu.
    const reopened = screen.getByRole('menu', { name: 'more_actions' });
    expect(document.activeElement).toBe(within(reopened).getByRole('menuitem', { name: /tag/i }));
  });

  it('still closes when the tap lands outside the panel', () => {
    renderViewer();
    openMoreMenu();

    fireEvent.mouseDown(document.body);

    expect(screen.getByRole('menu', { name: 'more_actions' })).toHaveAttribute('inert');
  });
});
