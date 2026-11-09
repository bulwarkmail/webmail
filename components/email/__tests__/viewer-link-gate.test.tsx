// The reader's link check: links in a plain-text mail render in the page,
// not in the body iframe, and opened without the check; a middle-click in
// the iframe opened the link in a new tab without it too. With no link
// check listening, a click stays the browser's.
import { render, act, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { clearAllHooks, pluginErrorTracker, uiHooks } from '@/lib/plugin-hooks';
import type { ExternalLinkContext } from '@/lib/plugin-types';

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

const message = (type: 'text/plain' | 'text/html', value: string) => ({
  id: 'm1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Sender', email: 'sender@other.test' }], to: [{ email: 'me@example.org' }],
  subject: 'Hello', receivedAt: '2026-01-01T00:00:00Z', preview: 'Hello', hasAttachment: false, size: 100,
  textBody: [{ partId: '1', type }], htmlBody: [{ partId: '1', type }], attachments: [],
  bodyValues: { '1': { value } },
}) as unknown as Email;

async function open(email: Email) {
  const view = render(<EmailViewer email={email} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  return view;
}

function watch(answer: unknown) {
  const seen: ExternalLinkContext[] = [];
  uiHooks.onBeforeExternalLink.register('link-check', (ctx: ExternalLinkContext) => { seen.push(ctx); return answer; });
  return seen;
}

let open$: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  clearAllHooks();
  pluginErrorTracker.resetAll();
  open$ = vi.spyOn(window, 'open').mockReturnValue(null);
});
afterEach(() => vi.restoreAllMocks());

describe('plain-text mail', () => {
  it('sends a link click through the link check, with the message and the address the browser opens', async () => {
    const seen = watch(false);
    const { container } = await open(message('text/plain', 'Log in at http://evil.example\\@good.example/login today'));
    const link = container.querySelector('[data-plugin-source="email-body"] a') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(fireEvent.click(link)).toBe(false);
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ href: 'http://evil.example/@good.example/login', emailId: 'm1' });
    expect(open$).not.toHaveBeenCalled();
  });

  it('leaves the click to the browser while no link check listens', async () => {
    const { container } = await open(message('text/plain', 'See https://site.example/a'));
    const link = container.querySelector('[data-plugin-source="email-body"] a') as HTMLAnchorElement;
    expect(fireEvent.click(link)).toBe(true);
    expect(open$).not.toHaveBeenCalled();
  });
});

// The body iframe's middle-click (jsdom doesn't load srcdoc, so the viewer
// never wires it here) is covered by the conversation view's test of the
// same handler and by integration/tests/22-ent-plugins.spec.ts.
