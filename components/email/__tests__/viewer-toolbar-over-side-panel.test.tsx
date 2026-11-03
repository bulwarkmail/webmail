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
const { useSettingsStore } = await import('@/stores/settings-store');

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
  ?? (screen.getByLabelText('plugin_panel').closest('div') as HTMLElement);

/** An item of the top toolbar. */
const toolbarItem = () => document.querySelector('[data-overflow-item]') as HTMLElement;

afterEach(() => {
  cleanup();
  device.isMobile = false;
  useSettingsStore.setState({ toolbarPosition: 'top' });
});

const view = (props: { email: Email | null; isLoading: boolean }) => (
  <EmailViewer mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onDelete={() => {}} {...props} />
);
/** The panel button: there is exactly one, in a toolbar row at the top of the reader, never in the panel. */
const theToggle = () => {
  const all = document.querySelectorAll('[data-plugin-panel-toggle]');
  expect(all).toHaveLength(1);
  const toggle = all[0] as HTMLElement;
  expect(toggle.closest('[data-viewer-top-toolbar="full-width"]')).toBeTruthy();
  expect(toggle.closest('[data-plugin-detail-panel]')).toBeNull();
  const root = document.querySelector('[data-tour="email-viewer"]') ?? toggle.closest('.relative.flex-col');
  expect(root!.firstElementChild!.contains(toggle)).toBe(true);
  return toggle;
};

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
    expect(toggle.getAttribute('aria-label')).toBe('plugin_panel');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    // A landmark for screen readers, named after its plugin.
    expect(screen.getByRole('complementary')).toBe(document.querySelector('[data-plugin-detail-panel]'));
    act(() => { fireEvent.click(toggle); });
    expect(document.querySelector('[data-plugin-detail-panel]')).toBeNull();
    // Folded, the panel leaves no strip of its own: the toolbar button brings it back.
    expect(screen.getAllByLabelText('plugin_panel')).toHaveLength(1);
    act(() => { fireEvent.click(screen.getByLabelText('plugin_panel')); });
    expect(document.querySelector('[data-plugin-detail-panel]')).toBeTruthy();
  });

  it('puts the panel button in the same toolbar row with no message open, folded or not, and while one loads', () => {
    const { rerender } = render(view({ email: null, isLoading: false }));
    const row = () => theToggle().closest('[data-viewer-top-toolbar]') as HTMLElement;
    expect(row().hasAttribute('data-toolbar-toggle-only')).toBe(true);
    // As high as the full toolbar.
    expect(row().firstElementChild!.className).toContain('h-14');
    expect(theToggle().getAttribute('title')).toBe('plugin_panel');
    expect(theToggle().getAttribute('aria-pressed')).toBe('true');
    act(() => { fireEvent.click(theToggle()); });
    // Folded: no strip and no row of the panel's own, the same button in the same row.
    expect(document.querySelector('[data-plugin-detail-panel]')).toBeNull();
    expect(document.querySelector('[data-reader-side-panel]')!.children).toHaveLength(0);
    expect(theToggle().getAttribute('aria-label')).toBe('plugin_panel');
    expect(theToggle().getAttribute('aria-pressed')).toBe('false');
    act(() => { fireEvent.click(theToggle()); });
    // Open: the panel holds no button row above the plugin's own header.
    const panel = document.querySelector('[data-plugin-detail-panel]') as HTMLElement;
    expect(panel.querySelector('button')).toBeNull();
    rerender(view({ email: null, isLoading: true }));
    theToggle();
  });

  it('keeps the panel button for a scheduled message', () => {
    const scheduled = { ...email, id: 'e3', isScheduled: true, scheduledSendAt: '2030-01-01T10:00:00Z', scheduledUndoStatus: 'pending' } as unknown as Email;
    render(view({ email: scheduled, isLoading: false }));
    theToggle();
  });

  it('keeps the panel button at the top when the toolbar is below the subject', () => {
    useSettingsStore.setState({ toolbarPosition: 'below-subject' });
    render(view({ email, isLoading: false }));
    expect(theToggle().closest('[data-toolbar-toggle-only]')).toBeTruthy();
  });

  it('keeps the side panel frame from a message to none and back', () => {
    mounts['email-detail-sidebar'] = 0;
    const { rerender } = render(view({ email, isLoading: false }));
    rerender(view({ email: null, isLoading: true }));
    rerender(view({ email: null, isLoading: false }));
    rerender(view({ email, isLoading: false }));
    expect(mounts['email-detail-sidebar']).toBe(1);
  });

  it('loads a message with its toolbar where the loaded reader puts it', () => {
    // The loading state lifts the toolbar above the message row too, so the
    // row stays put when the message arrives: the same element at the same
    // place (a moved row counts as a layout shift).
    const { container, rerender } = render(view({ email: null, isLoading: true }));
    const root = container.firstElementChild as HTMLElement;
    expect(root.children).toHaveLength(2);
    const row = root.children[1];
    expect(row.className).toContain('flex-row');
    expect(root.children[0].querySelector('.sk-shape')).toBeTruthy();
    rerender(view({ email, isLoading: false }));
    expect(root.querySelector('[data-viewer-top-toolbar="full-width"]')).toBe(root.children[0]);
    expect(root.children[1]).toBe(row);
  });

  it('loads a message on a phone with the toolbar in the message column', () => {
    device.isMobile = true;
    const { container } = render(
      <EmailViewer email={null} isLoading mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onDelete={() => {}} />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.children).toHaveLength(1);
  });

  it('keeps the toolbar in the message column on a phone', () => {
    device.isMobile = true;
    show();
    expect(document.querySelector('[data-viewer-top-toolbar="full-width"]')).toBeNull();
    expect(document.querySelector('[data-viewer-top-toolbar="column"]')).toBeTruthy();
  });
});
