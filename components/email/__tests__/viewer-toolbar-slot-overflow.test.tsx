import { render, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import type { Email, Mailbox } from '@/lib/jmap/types';

// A plugin's frame in the reader's toolbar row gets its width after it has
// mounted. The row used to be measured only when its children changed, so the
// frame pushed More and the panel button out of the window.

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({
  PluginSlot: ({ name }: { name: string }) => React.createElement('div', { 'data-plugin-slot': name }),
}));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));

const observed: Array<{ el: Element; fire: () => void }> = [];
class FakeResizeObserver {
  constructor(private cb: (entries: unknown[]) => void) {}
  observe(el: Element) { observed.push({ el, fire: () => this.cb([{ contentRect: { width: 800 } }]) }); }
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

describe('reader toolbar with a plugin frame', () => {
  it('gives way when the frame grows, without any change to the row\'s children', async () => {
    let frameWidth = 0;
    const scrollWidth = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => 400 + frameWidth);
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    const offsetWidth = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(80);
    try {
      const { container } = render(<EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
      const items = () => Array.from(container.querySelectorAll<HTMLElement>('[data-overflow-item]'));
      expect(items().length).toBeGreaterThan(0);
      expect(items().some((item) => item.style.display === 'none')).toBe(false);

      const slot = container.querySelector('[data-plugin-slot="toolbar-actions"]');
      const entry = observed.find((o) => o.el === slot);
      expect(entry).toBeDefined();

      frameWidth = 400;
      await act(async () => {
        entry!.fire();
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      expect(items().some((item) => item.style.display === 'none')).toBe(true);
    } finally {
      scrollWidth.mockRestore();
      clientWidth.mockRestore();
      offsetWidth.mockRestore();
    }
  });
});
