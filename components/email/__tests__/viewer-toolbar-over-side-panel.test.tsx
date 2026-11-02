import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import React, { useEffect } from 'react';
import { cleanup } from '@testing-library/react';
import type { Email, Mailbox } from '@/lib/jmap/types';

// On a desktop the reader's top toolbar runs over the plugin side panel to
// the right edge; the panel starts below it. On a phone the toolbar stays in
// the message column. Its menus close when a click goes into a frame. The
// panel is the reader's, not the message's: its frame lives on from one
// message to the next, and its toggle sits at the end of the toolbar.

const device = { isMobile: false };
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: device.isMobile, isTablet: false, isDesktop: !device.isMobile }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
const mounts: Record<string, number> = {};
vi.mock('@/components/plugins/plugin-slot', () => ({
  PluginSlot: ({ name }: { name: string }) => {
    useEffect(() => {
      mounts[name] = (mounts[name] ?? 0) + 1;
      // Once per mount on purpose: that is what the test counts.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return React.createElement('div', { 'data-slot': name });
  },
}));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({
  usePluginSlotOffers: (slot: string) => (slot === 'email-detail-sidebar' ? [{ pluginId: 'p', order: 100 }] : []),
}));

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

const email = {
  id: 'e1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Alice', email: 'alice@example.com' }], to: [{ name: 'Bob', email: 'bob@example.com' }],
  subject: 'Hello', receivedAt: '2026-01-01T00:00:00Z', preview: 'Hello', hasAttachment: false, size: 100,
  textBody: [], htmlBody: [], attachments: [], bodyValues: {},
} as unknown as Email;

const show = () => render(
  <EmailViewer email={email} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onDelete={() => {}} />,
);

/** The plugin panel, open or folded to its toggle. */
const sidePanel = () =>
  (document.querySelector('[data-plugin-detail-panel]') as HTMLElement | null)
  ?? (screen.getByLabelText('plugin_panel_show').closest('div') as HTMLElement);

/** An item of the top toolbar. */
const toolbarItem = () => document.querySelector('[data-overflow-item]') as HTMLElement;

afterEach(() => {
  cleanup();
  device.isMobile = false;
});

describe('the reader toolbar and the plugin side panel', () => {
  it('runs the toolbar over the side panel on a desktop', () => {
    show();
    const panel = sidePanel();
    const item = toolbarItem();
    expect(item).toBeTruthy();
    // The box that holds the panel does not hold the toolbar...
    expect(panel.parentElement!.contains(item)).toBe(false);
    // ...and the toolbar comes before it, at the top of the reader.
    expect(item.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const root = document.querySelector('[data-tour="email-viewer"]')!;
    expect(root.firstElementChild!.contains(item)).toBe(true);
    expect(root.firstElementChild!.contains(panel)).toBe(false);
  });

  it('closes the More menu when a click goes into a frame', async () => {
    show();
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'more_actions' })); });
    expect(screen.getByRole('menu', { name: 'more_actions' })).toBeTruthy();
    // The menu watches for that from the next tick on.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    // A click in the message body or a plugin panel moves focus into that
    // frame: this document sees no mousedown, only the window losing focus.
    act(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      window.dispatchEvent(new Event('blur'));
    });
    expect(screen.queryByRole('menu', { name: 'more_actions' })).toBeNull();
  });

  it('keeps the side panel frame while the user reads on, and between messages', () => {
    const other = { ...email, id: 'e2', blobId: 'b2', threadId: 't2', subject: 'Second' } as unknown as Email;
    const view = (props: { email: Email | null; isLoading: boolean }) => (
      <EmailViewer mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onDelete={() => {}} {...props} />
    );
    mounts['email-detail-sidebar'] = 0;
    const { rerender } = render(view({ email, isLoading: false }));
    expect(mounts['email-detail-sidebar']).toBe(1);
    // The next message loading, then open; then none at all.
    rerender(view({ email: null, isLoading: true }));
    rerender(view({ email: other, isLoading: false }));
    rerender(view({ email: null, isLoading: false }));
    expect(screen.getByText('no_conversation_selected')).toBeTruthy();
    expect(document.querySelector('[data-slot="email-detail-sidebar"]')).toBeTruthy();
    expect(mounts['email-detail-sidebar']).toBe(1);
  });

  it('folds and unfolds the side panel from the toolbar', () => {
    show();
    const toggle = document.querySelector('[data-plugin-panel-toggle]') as HTMLElement;
    // At the end of the toolbar, not in the panel.
    expect(toggle.closest('[data-plugin-detail-panel]')).toBeNull();
    expect(toggle.getAttribute('aria-label')).toBe('plugin_panel_hide');
    act(() => { fireEvent.click(toggle); });
    expect(document.querySelector('[data-plugin-detail-panel]')).toBeNull();
    // Folded, the panel leaves no strip of its own: the toolbar button brings it back.
    expect(screen.getAllByLabelText('plugin_panel_show')).toHaveLength(1);
    act(() => { fireEvent.click(screen.getByLabelText('plugin_panel_show')); });
    expect(document.querySelector('[data-plugin-detail-panel]')).toBeTruthy();
  });

  it('keeps the toolbar in the message column on a phone', () => {
    device.isMobile = true;
    show();
    expect(document.querySelector('[data-viewer-top-toolbar="full-width"]')).toBeNull();
    expect(document.querySelector('[data-viewer-top-toolbar="column"]')).toBeTruthy();
  });
});


it('navigates the loaded desktop queue and disables unavailable directions', () => {
  const next = vi.fn();
  render(<EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="inbox" listPosition={{index:1,total:3}} onNavigateNext={next} />);
  const navigation = document.querySelector('[data-memail-reader-navigation]')!;
  const buttons = navigation.querySelectorAll('button');
  expect(buttons[0]).toBeDisabled();
  expect(buttons[1]).toBeEnabled();
  fireEvent.click(buttons[1]);
  expect(next).toHaveBeenCalledTimes(1);
});

it('retains the native phone navigation without duplicating the desktop pager', () => {
  device.isMobile = true;
  render(<EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="inbox" listPosition={{index:1,total:3}} onNavigateNext={() => {}} />);
  expect(document.querySelector('[data-memail-reader-navigation]')).toBeNull();
});
