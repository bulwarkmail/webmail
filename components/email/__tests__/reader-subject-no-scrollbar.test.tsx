import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useSettingsStore } from '@/stores/settings-store';

// #1704: the reader's subject scrolls by itself when it is very long
// (overflow-y: auto). In Mountain View its 22px type sits on a 28px line, and
// Segoe UI's ascent plus descent is about 29px: Chrome counted the extra pixel
// as overflow and drew a scroll bar beside every one-line subject. Padding,
// taken back by an equal negative margin, gives the glyphs room without
// moving anything. jsdom does no layout, so the classes are what is checked.

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
] as unknown as Mailbox[];

const email = {
  id: 'm1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Sender', email: 's@example.com' }], to: [{ name: 'Me', email: 'me@example.com' }],
  subject: 'Your files are ready!', receivedAt: '2026-10-16T15:00:00Z', preview: 'x', hasAttachment: false, size: 100,
  textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [], attachments: [],
  bodyValues: { '1': { value: 'Body', isTruncated: false } },
} as unknown as Email;

afterEach(() => useSettingsStore.setState({ interfaceLayout: 'default' }));

describe('reader subject (#1704)', () => {
  for (const layout of ['mountain-view', 'default'] as const) {
    it(`leaves room for the font around a scrolling subject (${layout})`, () => {
      useSettingsStore.setState({ interfaceLayout: layout, markAsReadDelay: 0 });
      const { container } = render(
        <EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />,
      );
      const subject = container.querySelector('[data-reader-subject] h2') as HTMLElement;
      expect(subject.textContent).toBe('Your files are ready!');
      const classes = subject.className.split(/\s+/);
      expect(classes).toContain('overflow-y-auto');
      // Padding and an equal negative margin: room inside, no shift outside.
      expect(classes).toEqual(expect.arrayContaining(['py-1', '-my-1']));
    });
  }
});
