import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Attachments always sit right under the message header and its security
// warnings (forged sender, reported phishing, the plugins' S/MIME and PGP
// banners), above the "External content" banner and the body, in every
// reader surface
// (reading pane, pop-outs, Pro tabs, the phone and Mountain View
// conversations, an attached .eml and the printout). There is no setting
// for it any more. Inline images stay in the body, and a message with only
// those draws no strip.

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
  useIsMobile: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.mock('@/hooks/use-wopi-status', () => ({ useWopiStatus: () => ({ enabled: false }), canWopiOpen: () => false }));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('../email-viewer');
const { ConversationEmailBody } = await import('../thread-conversation-view');
const { EmlPreview } = await import('@/components/files/eml-preview');
const { useAuthStore } = await import('@/stores/auth-store');
const { useSettingsStore } = await import('@/stores/settings-store');
const { usePrintRequestStore } = await import('@/hooks/use-message-file-actions');
const { emailKeyFor } = await import('@/lib/thread-utils');
const { PHISHING_KEYWORD } = await import('@/lib/phishing-report');
const { parseAuthenticationResults } = await import('@/lib/email-headers');

const mailboxes = [{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } }] as unknown as Mailbox[];

const REMOTE_HTML = '<p>Here is the invoice.</p><img src="https://tracker.example/pixel.png">';

function mail(over: Partial<Email> = {}): Email {
  return {
    id: 'e1',
    blobId: 'b1',
    threadId: 't1',
    mailboxIds: { inbox: true },
    keywords: { $seen: true },
    from: [{ name: 'Sarah Kim', email: 'sarah@example.com' }],
    to: [{ email: 'me@example.com' }],
    subject: 'Invoice and prototype',
    receivedAt: '2026-01-01T00:00:00Z',
    preview: 'Here is the invoice',
    hasAttachment: true,
    size: 100,
    textBody: [],
    htmlBody: [{ partId: '1', type: 'text/html' }],
    bodyValues: { '1': { value: REMOTE_HTML, isTruncated: false } },
    attachments: [
      { partId: '2', blobId: 'blob-pdf', name: 'Invoice-2026-089.pdf', type: 'application/pdf', size: 51200, disposition: 'attachment' },
      { partId: '3', blobId: 'blob-zip', name: 'icons.zip', type: 'application/zip', size: 2048, disposition: 'attachment' },
    ],
    ...over,
  } as unknown as Email;
}

// Only inline images, which the body shows itself.
const inlineOnly = () => mail({
  bodyValues: { '1': { value: '<p>Our logo:</p><img src="cid:logo@example.com">', isTruncated: false } } as Email['bodyValues'],
  attachments: [
    { partId: '2', blobId: 'blob-logo', name: 'logo.png', type: 'image/png', size: 900, disposition: 'inline', cid: 'logo@example.com' },
  ] as Email['attachments'],
});

// Inline images plus a copy of each declared as an attachment, with the same
// Content-ID, type and size (seen from Exchange Online).
const inlineWithCopies = (withInvoice = false) => mail({
  bodyValues: { '1': { value: '<p>Regards</p><img src="cid:image001.png"><img src="cid:image002.png">', isTruncated: false } } as Email['bodyValues'],
  attachments: [
    { partId: '2', blobId: 'blob-image1', name: 'image001.png', type: 'image/png', size: 23567, disposition: 'inline', cid: 'image001.png' },
    { partId: '3', blobId: 'blob-image2', name: 'image002.png', type: 'image/png', size: 26526, disposition: 'inline', cid: 'image002.png' },
    { partId: '4', blobId: 'blob-image1-copy', name: 'image001.png', type: 'image/png', size: 23567, disposition: 'attachment', cid: 'image001.png' },
    { partId: '5', blobId: 'blob-image2-copy', name: 'image002.png', type: 'image/png', size: 26526, disposition: 'attachment', cid: 'image002.png' },
    ...(withInvoice ? [{ partId: '6', blobId: 'blob-pdf', name: 'Invoice-2026-089.pdf', type: 'application/pdf', size: 51200, disposition: 'attachment' }] : []),
  ] as Email['attachments'],
});

// Reported as phishing, from a sender whose domain failed DMARC.
const dangerous = () => mail({
  keywords: { $seen: true, [PHISHING_KEYWORD]: true },
  authenticationResults: parseAuthenticationResults(['mx.example.org; spf=fail smtp.mailfrom=bank.example; dkim=fail header.d=bank.example; dmarc=fail header.from=example.com']),
  authenticationResultsOnReceipt: true,
} as Partial<Email>);

const client = new Proxy({ getAccountId: () => 'me' } as Record<string, unknown>, {
  get: (target, prop) => (prop in target ? target[prop as string] : prop === 'then' ? undefined : vi.fn().mockResolvedValue(null)),
}) as unknown as IJMAPClient;

/** a comes after b in the document. */
const follows = (a: Element, b: Element) => !!(b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);

function fakePrintWindow() {
  const write = vi.fn();
  const win = { closed: false, opener: {}, document: { write, close: () => {} }, focus: () => {}, print: () => {}, close: () => {} };
  return { write, win: win as unknown as Window };
}

beforeEach(() => {
  useAuthStore.setState({ client } as never);
  useSettingsStore.setState({ markAsReadDelay: -1, externalContentPolicy: 'ask', trustedSenders: [], hideInlineImageAttachments: true, mailViewMode: 'html' });
});

afterEach(() => {
  usePrintRequestStore.getState().setRequest(null);
});

describe('the reader (reading pane, pop-outs, Pro tabs)', () => {
  it('puts the attachments under the header, before the external-content banner and the body', async () => {
    const { container } = render(<EmailViewer email={mail()} mailboxes={mailboxes} selectedMailbox="inbox" />);
    const notice = await screen.findByTestId('external-content-notice');
    const sections = container.querySelectorAll('[data-testid="reader-attachments"]');
    expect(sections).toHaveLength(1);
    expect(sections[0].querySelectorAll('[data-testid="attachment"]')).toHaveLength(2);
    const body = container.querySelector('[data-reader-body]')!;
    expect(follows(notice, sections[0])).toBe(true);
    expect(follows(body, sections[0])).toBe(true);
    // And under the sender and recipients.
    expect(follows(sections[0], screen.getAllByText('show_details')[0])).toBe(true);
    // No jump link, no second copy after the body.
    expect(screen.queryByTestId('attachments-jump')).toBeNull();
  });

  it('shows security warnings before the attachments, and other notices after them', async () => {
    const { container } = render(<EmailViewer email={dangerous()} mailboxes={mailboxes} selectedMailbox="inbox" />);
    const notice = await screen.findByTestId('external-content-notice');
    const strip = container.querySelector('[data-testid="reader-attachments"]')!;
    const phishing = screen.getByTestId('phishing-mark-banner');
    const forged = screen.getByTestId('sender-check-warning');
    expect(follows(strip, phishing)).toBe(true);
    expect(follows(strip, forged)).toBe(true);
    expect(follows(notice, strip)).toBe(true);
  });

  it('keeps them on top whatever an older build stored as their position', async () => {
    useSettingsStore.setState({ attachmentPosition: 'below-message' } as never);
    const { container } = render(<EmailViewer email={mail()} mailboxes={mailboxes} selectedMailbox="inbox" />);
    const notice = await screen.findByTestId('external-content-notice');
    const sections = container.querySelectorAll('[data-testid="reader-attachments"]');
    expect(sections).toHaveLength(1);
    expect(follows(notice, sections[0])).toBe(true);
  });

  it('draws no strip for a message whose only attachments are inline images', async () => {
    const { container } = render(<EmailViewer email={inlineOnly()} mailboxes={mailboxes} selectedMailbox="inbox" />);
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    expect(container.querySelector('[data-testid="reader-attachments"]')).toBeNull();
    expect(container.querySelector('[data-reader-attachments-strip]')).toBeNull();
  });

  it('draws no strip for a message whose attachments only repeat its inline images', async () => {
    const { container } = render(<EmailViewer email={inlineWithCopies()} mailboxes={mailboxes} selectedMailbox="inbox" />);
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    expect(container.querySelector('[data-testid="reader-attachments"]')).toBeNull();
    expect(container.querySelector('[data-reader-attachments-strip]')).toBeNull();
  });

  it('lists only the real file next to such copies', async () => {
    const { container } = render(<EmailViewer email={inlineWithCopies(true)} mailboxes={mailboxes} selectedMailbox="inbox" />);
    await waitFor(() => expect(container.querySelector('[data-testid="reader-attachments"]')).not.toBeNull());
    const chips = container.querySelectorAll('[data-testid="reader-attachments"] [data-testid="attachment"]');
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toContain('Invoice-2026-089.pdf');
  });

  it('lists the copies with the inline images when the user shows inline images', async () => {
    useSettingsStore.setState({ hideInlineImageAttachments: false });
    const { container } = render(<EmailViewer email={inlineWithCopies()} mailboxes={mailboxes} selectedMailbox="inbox" />);
    await waitFor(() => expect(container.querySelector('[data-testid="reader-attachments"]')).not.toBeNull());
    expect(container.querySelectorAll('[data-testid="reader-attachments"] [data-testid="attachment"]')).toHaveLength(4);
  });

  it('lists the copies when the message is shown as plain text, since the body shows no image then', async () => {
    useSettingsStore.setState({ mailViewMode: 'plain' });
    const { container } = render(<EmailViewer email={inlineWithCopies()} mailboxes={mailboxes} selectedMailbox="inbox" />);
    await waitFor(() => expect(container.querySelector('[data-testid="reader-attachments"]')).not.toBeNull());
    const chips = container.querySelectorAll('[data-testid="reader-attachments"] [data-testid="attachment"]');
    expect(chips).toHaveLength(2);
    expect(chips[0].textContent).toContain('image001.png');
    expect(chips[1].textContent).toContain('image002.png');
  });
});

describe('a conversation message (phone thread, Mountain View)', () => {
  it('puts the attachments before the external-content banner and the body', async () => {
    const { container } = render(<ConversationEmailBody email={mail()} allowExternal={false} onAllowExternal={() => {}} />);
    const notice = await screen.findByTestId('external-content-notice');
    const file = screen.getByText('Invoice-2026-089.pdf');
    expect(follows(notice, file)).toBe(true);
    expect(follows(container.querySelector('iframe')!, file)).toBe(true);
  });

  it('shows the phishing warning before the attachments', async () => {
    render(<ConversationEmailBody email={dangerous()} allowExternal={false} onAllowExternal={() => {}} />);
    await screen.findByTestId('external-content-notice');
    expect(follows(screen.getByText('Invoice-2026-089.pdf'), screen.getByTestId('phishing-mark-banner'))).toBe(true);
  });

  it('draws no strip for a message whose only attachments are inline images', async () => {
    const { container } = render(<ConversationEmailBody email={inlineOnly()} allowExternal={false} onAllowExternal={() => {}} />);
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    expect(container.querySelector('[data-conversation-attachments]')).toBeNull();
    expect(container.textContent).not.toContain('logo.png');
  });

  it('draws no strip for a message whose attachments only repeat its inline images', async () => {
    const { container } = render(<ConversationEmailBody email={inlineWithCopies()} allowExternal={false} onAllowExternal={() => {}} />);
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    expect(container.querySelector('[data-conversation-attachments]')).toBeNull();
    expect(screen.queryByText('image001.png')).toBeNull();
  });

  it('lists only the real file next to such copies', async () => {
    const { container } = render(<ConversationEmailBody email={inlineWithCopies(true)} allowExternal={false} onAllowExternal={() => {}} />);
    await screen.findByText('Invoice-2026-089.pdf');
    expect(container.querySelectorAll('[data-conversation-attachments] [data-row-item]')).toHaveLength(1);
    expect(screen.queryByText('image001.png')).toBeNull();
    expect(screen.queryByText('image002.png')).toBeNull();
  });

  it('lists the copies when mail is shown as plain text, since the body shows no image then', async () => {
    useSettingsStore.setState({ mailViewMode: 'plain' });
    const { container } = render(<ConversationEmailBody email={inlineWithCopies()} allowExternal={false} onAllowExternal={() => {}} />);
    await screen.findByText('image001.png');
    expect(container.querySelectorAll('[data-conversation-attachments] [data-row-item]')).toHaveLength(2);
    expect(screen.getByText('image002.png')).toBeTruthy();
  });

  it('keeps many attachments to one line, the rest behind "Show N more"', () => {
    // Four chips fit on a line here.
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const parent = this.parentElement;
      const index = parent ? Array.from(parent.children).indexOf(this) : 0;
      return { top: Math.floor(index / 4) * 40, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    try {
      const files = Array.from({ length: 9 }, (_, i) => ({
        partId: `p${i}`, blobId: `blob-${i}`, name: `file-${i}.pdf`, type: 'application/pdf', size: 100, disposition: 'attachment',
      }));
      const { container } = render(<ConversationEmailBody email={mail({ attachments: files } as Partial<Email>)} allowExternal={false} onAllowExternal={() => {}} />);
      const strip = container.querySelector('[data-conversation-attachments]')!;
      // Three files and "Show 6 more" fill the line.
      expect(strip.querySelectorAll('[data-row-item]')).toHaveLength(3);
      act(() => screen.getByRole('button', { name: /attachments_show_more/ }).click());
      expect(strip.querySelectorAll('[data-row-item]')).toHaveLength(9);
      act(() => screen.getByRole('button', { name: /attachments_show_fewer/ }).click());
      expect(strip.querySelectorAll('[data-row-item]')).toHaveLength(3);
    } finally {
      rect.mockRestore();
    }
  });
});

describe('an attached .eml', () => {
  it('lists its attachments under its header, before the body', () => {
    const { container } = render(
      <EmlPreview message={{ subject: 'Forwarded', html: '<p>Inner body</p>', attachments: [{ filename: 'plan.pdf', mimeType: 'application/pdf', content: new Uint8Array([1]) }] }} />,
    );
    const file = screen.getByText('plan.pdf');
    expect(follows(container.querySelector('iframe')!, file)).toBe(true);
  });
});

describe('the printout', () => {
  it('lists the attachments in the header, above the body (Ctrl+P)', () => {
    (HTMLElement.prototype as unknown as { checkVisibility: () => boolean }).checkVisibility = () => true;
    try {
      render(<EmailViewer email={mail()} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
      act(() => { window.dispatchEvent(new Event('beforeprint')); });
      const copy = document.body.querySelector<HTMLElement>(':scope > [data-print-root]')!;
      const header = copy.querySelector('header')!;
      expect(header.textContent).toContain('attachments:');
      expect(header.textContent).toContain('Invoice-2026-089.pdf (50 KB)');
      expect(header.textContent).toContain('icons.zip');
      expect(follows(copy.querySelector('[data-message-print-body]')!, header)).toBe(true);
    } finally {
      act(() => { window.dispatchEvent(new Event('afterprint')); });
      delete (HTMLElement.prototype as unknown as { checkVisibility?: unknown }).checkVisibility;
    }
  });

  it('lists the attachments above the body in the Print window', async () => {
    const { write, win } = fakePrintWindow();
    const email = mail();
    usePrintRequestStore.getState().setRequest({ key: emailKeyFor(email), win });
    render(<EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
    await waitFor(() => expect(write).toHaveBeenCalled());
    const html = write.mock.calls[0][0] as string;
    const list = html.indexOf('data-print-attachments');
    expect(list).toBeGreaterThan(0);
    expect(html.slice(list)).toMatch(/^[^<]*<strong>attachments:<\/strong> Invoice-2026-089\.pdf \(50 KB\), icons\.zip \(2 KB\)<\/div>/);
    expect(list).toBeLessThan(html.indexOf('<div class="body'));
  });

  it('prints no attachment line for a message with only inline images', async () => {
    const { write, win } = fakePrintWindow();
    const email = inlineOnly();
    usePrintRequestStore.getState().setRequest({ key: emailKeyFor(email), win });
    render(<EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
    await waitFor(() => expect(write).toHaveBeenCalled());
    expect(write.mock.calls[0][0]).not.toContain('data-print-attachments');
  });

  it('prints only the real file next to copies of inline images', async () => {
    const { write, win } = fakePrintWindow();
    const email = inlineWithCopies(true);
    usePrintRequestStore.getState().setRequest({ key: emailKeyFor(email), win });
    render(<EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
    await waitFor(() => expect(write).toHaveBeenCalled());
    const html = write.mock.calls[0][0] as string;
    const list = html.indexOf('data-print-attachments');
    expect(list).toBeGreaterThan(0);
    expect(html.slice(list)).toMatch(/^[^<]*<strong>attachments:<\/strong> Invoice-2026-089\.pdf \(50 KB\)<\/div>/);
  });
});
