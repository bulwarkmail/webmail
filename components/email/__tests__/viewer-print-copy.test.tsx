// Ctrl+P on an open message printed the app itself: the toolbar, the plugin
// panel beside the message, and only as much of the body as fit the
// reader's fixed height. The reader now puts a print copy of the message
// next to the app, which app/print.css prints instead.
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Email, Mailbox } from '@/lib/jmap/types';

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
  useIsMobile: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('../email-viewer');
const { usePrintStore } = await import('@/stores/print-store');

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

const HTML = '<p class="hidden" id="main">Season one starts today</p><table border="1"><tr><td>Row</td></tr></table>';

function htmlMail(): Email {
  return {
    id: 'e1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
    from: [{ name: 'Call of Duty', email: 'news@example.com' }], to: [{ name: 'Bob', email: 'bob@example.com' }],
    subject: 'New trailer', receivedAt: '2026-11-03T00:09:00Z', preview: 'Season', hasAttachment: false, size: 100,
    textBody: [{ partId: '1', type: 'text/html' }], htmlBody: [{ partId: '1', type: 'text/html' }], attachments: [],
    bodyValues: { '1': { value: HTML, isTruncated: false } },
  } as unknown as Email;
}

let visible = true;

beforeEach(() => {
  visible = true;
  // jsdom lays nothing out; the reader asks whether it is on screen.
  (HTMLElement.prototype as unknown as { checkVisibility: () => boolean }).checkVisibility = () => visible;
});

afterEach(() => {
  act(() => { window.dispatchEvent(new Event('afterprint')); });
  delete (HTMLElement.prototype as unknown as { checkVisibility?: unknown }).checkVisibility;
  vi.restoreAllMocks();
});

function printCopy(): HTMLElement | null {
  return document.body.querySelector(':scope > [data-print-root]');
}

describe('Ctrl+P on an open message', () => {
  it('prints an invitation with its card: when, where and who', async () => {
    const { InvitationPrintSync } = await import('@/lib/print/invitation-print');
    const card = { heading: 'Calendar Invitation', rows: [['Time', 'Thu 5 Nov, 13:00 to 14:00'], ['Location', 'Room 4'], ['Organized by', 'Anna Becker']] as Array<[string, string]> };
    const view = render(<>
      <EmailViewer email={htmlMail()} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />
      <InvitationPrintSync emailId="e1" print={card} />
    </>);
    act(() => { window.dispatchEvent(new Event('beforeprint')); });
    const box = printCopy()!.querySelector('[data-message-print-invitation]')!;
    expect(box.textContent).toContain('Calendar Invitation');
    expect(box.textContent).toContain('Thu 5 Nov, 13:00 to 14:00');
    expect(box.textContent).toContain('Room 4');
    expect(box.textContent).toContain('Anna Becker');
    act(() => { window.dispatchEvent(new Event('afterprint')); });
    // The card gone (another message opened): the next printout has no box.
    view.rerender(<EmailViewer email={htmlMail()} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
    act(() => { window.dispatchEvent(new Event('beforeprint')); });
    expect(printCopy()!.querySelector('[data-message-print-invitation]')).toBeNull();
  }, 30_000);

  it('prints the message alone, next to the app', () => {
    render(<EmailViewer email={htmlMail()} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
    expect(printCopy()).toBeNull();

    act(() => { window.dispatchEvent(new Event('beforeprint')); });

    const copy = printCopy()!;
    expect(copy).not.toBeNull();
    expect(copy.querySelector('h1')!.textContent).toBe('New trailer');
    expect(copy.textContent).toContain('Call of Duty <news@example.com>');
    expect(copy.textContent).toContain('Bob <bob@example.com>');

    // The body keeps out of the app's CSS: it sits in a shadow root.
    const body = copy.querySelector<HTMLElement>('[data-message-print-body]')!;
    expect(body.shadowRoot).not.toBeNull();
    expect(body.shadowRoot!.textContent).toContain('Season one starts today');
    expect(body.shadowRoot!.querySelector('table')).not.toBeNull();

    act(() => { window.dispatchEvent(new Event('afterprint')); });
    expect(printCopy()).toBeNull();
  }, 30_000);

  it('keeps remote content out while it is blocked, as the copy has no frame CSP', () => {
    const mail = htmlMail();
    mail.bodyValues = { '1': { value: '<p>Hello</p><img src="https://tracker.example/pixel.png"><div style="background:url(https://tracker.example/bg.png)">x</div>', isTruncated: false } } as Email['bodyValues'];
    render(<EmailViewer email={mail} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);

    act(() => { window.dispatchEvent(new Event('beforeprint')); });

    const shadow = printCopy()!.querySelector<HTMLElement>('[data-message-print-body]')!.shadowRoot!;
    expect(shadow.textContent).toContain('Hello');
    expect(shadow.innerHTML).not.toContain('tracker.example');
  }, 30_000);

  it('prints a plain-text mail with its line breaks and its quote opened', () => {
    const mail = htmlMail();
    mail.textBody = [{ partId: '1', type: 'text/plain' }] as Email['textBody'];
    mail.htmlBody = [{ partId: '1', type: 'text/plain' }] as Email['htmlBody'];
    mail.bodyValues = { '1': { value: 'line one\nline two\n\nOn Monday you wrote:\n> the old question\n', isTruncated: false } } as Email['bodyValues'];
    render(<EmailViewer email={mail} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);

    act(() => { window.dispatchEvent(new Event('beforeprint')); });

    const shadow = printCopy()!.querySelector<HTMLElement>('[data-message-print-body]')!.shadowRoot!;
    expect(shadow.querySelector('.plain')!.textContent).toContain('line one\nline two');
    expect(shadow.querySelector('style')!.textContent).toMatch(/\.plain \{ white-space: pre-wrap/);
    expect(shadow.querySelector('details')!.hasAttribute('open')).toBe(true);
  }, 30_000);

  it('leaves the copy out for a reader that is not on screen', () => {
    visible = false;
    render(<EmailViewer email={htmlMail()} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);

    act(() => { window.dispatchEvent(new Event('beforeprint')); });

    expect(usePrintStore.getState().printing).toBe(true);
    expect(printCopy()).toBeNull();
  }, 30_000);

  it('prints nothing of its own with no message open', () => {
    render(<EmailViewer email={null} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);

    act(() => { window.dispatchEvent(new Event('beforeprint')); });

    expect(printCopy()).toBeNull();
  }, 30_000);
});
