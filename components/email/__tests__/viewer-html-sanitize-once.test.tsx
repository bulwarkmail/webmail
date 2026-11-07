import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Email } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// An HTML mail goes to the reader's frame, sanitized once for it. The
// plain-text body's sanitizer is for plain-text mail only: running it on an
// HTML mail too cost a second full pass over the mail on every open.

const plainSanitize = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/lib/email-sanitization', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/email-sanitization')>();
  return {
    ...real,
    sanitizePlainTextRenderedHtml: (html: string) => { plainSanitize.calls++; return real.sanitizePlainTextRenderedHtml(html); },
  };
});
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
const { useAuthStore } = await import('@/stores/auth-store');

const base = {
  blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'News', email: 'news@example.org' }], to: [{ email: 'me@example.org' }],
  subject: 'Weekly', receivedAt: '2026-01-01T00:00:00Z', preview: 'Hello', hasAttachment: false, size: 100,
};
const htmlMail = {
  ...base, id: 'h1',
  textBody: [], htmlBody: [{ partId: '1', type: 'text/html' }],
  bodyValues: { 1: { value: '<html><body><table><tr><td><h2>Weekly</h2><p>Hello <b>there</b></p></td></tr></table></body></html>' } },
} as unknown as Email;
const textMail = {
  ...base, id: 't1',
  textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [{ partId: '1', type: 'text/plain' }],
  bodyValues: { 1: { value: 'Hello there' } },
} as unknown as Email;

const client = new Proxy({ getAccountId: () => 'me' } as Record<string, unknown>, {
  get: (target, prop) => (prop in target ? target[prop as string] : prop === 'then' ? undefined : vi.fn().mockResolvedValue(null)),
}) as unknown as IJMAPClient;

describe('sanitizing the opened body', () => {
  beforeEach(() => {
    useAuthStore.setState({ client } as never);
    plainSanitize.calls = 0;
  });

  it('does not run the plain-text sanitizer on an HTML mail', () => {
    const { container } = render(<EmailViewer email={htmlMail} mailboxes={[]} selectedMailbox="inbox" />);
    expect(container.querySelector('iframe')).toBeTruthy();
    expect(plainSanitize.calls).toBe(0);
  });

  it('still runs it on a plain-text mail', () => {
    const { container } = render(<EmailViewer email={textMail} mailboxes={[]} selectedMailbox="inbox" />);
    expect(container.querySelector('.email-content-text')?.textContent).toContain('Hello there');
    expect(plainSanitize.calls).toBeGreaterThan(0);
  });
});
