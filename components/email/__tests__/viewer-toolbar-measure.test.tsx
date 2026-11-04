import { render, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { clearAllHooks } from '@/lib/plugin-hooks';

// The toolbar moves what doesn't fit into its More menu, which takes reading
// every button's width: a forced layout. Opening another message usually
// leaves the toolbar as it was, and then the last answer is applied without
// reading any width. A resize still measures again.

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));

// Reports a size once observing starts, as browsers do, and on demand.
const observers = new Set<{ cb: ResizeObserverCallback; width: number }>();
class ReportingResizeObserver {
  private entry: { cb: ResizeObserverCallback; width: number };
  constructor(cb: ResizeObserverCallback) { this.entry = { cb, width: 800 }; }
  observe() {
    observers.add(this.entry);
    const { cb } = this.entry;
    queueMicrotask(() => cb([{ contentRect: { width: this.entry.width } } as ResizeObserverEntry], this as never));
  }
  unobserve() {}
  disconnect() { observers.delete(this.entry); }
}
vi.stubGlobal('ResizeObserver', ReportingResizeObserver);

const { EmailViewer } = await import('../email-viewer');

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];
const full = (id: string) => ({
  id, blobId: `b-${id}`, threadId: `t-${id}`, mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Alice', email: 'alice@example.com' }], to: [{ name: 'Bob', email: 'bob@example.com' }],
  subject: `Subject ${id}`, receivedAt: '2026-01-01T00:00:00Z', preview: 'Hello', hasAttachment: false, size: 100,
  textBody: [{ partId: '1', type: 'text/html' }], htmlBody: [{ partId: '1', type: 'text/html' }], attachments: [],
  bodyValues: { '1': { value: `<p>Body of ${id}</p>` } },
}) as unknown as Email;

let widthReads = 0;
beforeEach(() => {
  clearAllHooks();
  widthReads = 0;
  // A width read in the toolbar: its groups' (every measuring pass) and its
  // items' (only a pass that has to hide some).
  const inToolbar = (el: HTMLElement) => !!el.closest('[class*="@container/reader-toolbar"]');
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { if (inToolbar(this)) widthReads++; return 40; });
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) { if (inToolbar(this)) widthReads++; return 0; });
});
afterEach(() => vi.restoreAllMocks());

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const pane = (email: Email, isLoading = false) => (
  <EmailViewer email={email} isLoading={isLoading} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />
);

describe('toolbar overflow measuring', () => {
  it('measures once, not again for the next message with the same toolbar', async () => {
    // An open shows the message loading, then loaded.
    const { rerender } = render(pane(full('a'), true));
    await settle();
    rerender(pane(full('a')));
    await settle();
    expect(widthReads).toBeGreaterThan(0);

    widthReads = 0;
    rerender(pane(full('b'), true));
    await settle();
    rerender(pane(full('b')));
    await settle();
    expect(widthReads).toBe(0);
  });

  it('measures again when the toolbar is resized', async () => {
    const { rerender } = render(pane(full('a')));
    await settle();
    rerender(pane(full('b')));
    await settle();

    widthReads = 0;
    await act(async () => {
      for (const o of observers) { o.width = 500; o.cb([{ contentRect: { width: 500 } } as ResizeObserverEntry], {} as ResizeObserver); }
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(widthReads).toBeGreaterThan(0);
  });
});
