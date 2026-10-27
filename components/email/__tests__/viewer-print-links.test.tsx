// Print opens an about:blank popup of the app and writes the message into it.
// A link in the message without target navigated that popup to the sender's
// page, which still held window.opener: the webmail tab, open to redirection
// (reverse tabnabbing). The sender's own target/rel came along as written too.
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

const HTML = '<p>Hi</p><a id="plain" href="https://site.example/a">plain</a>'
  + '<a id="opener" href="https://site.example/b" target="_blank" rel="opener">opener</a>';

function mail(): Email {
  return {
    id: 'e1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
    from: [{ name: 'Alice', email: 'alice@example.com' }], to: [{ name: 'Bob', email: 'bob@example.com' }],
    subject: 'Hello there', receivedAt: '2026-01-01T00:00:00Z', preview: 'Hi', hasAttachment: false, size: 100,
    textBody: [], htmlBody: [{ partId: '1', type: 'text/html' }], attachments: [],
    bodyValues: { '1': { value: HTML, isTruncated: false } },
  } as unknown as Email;
}

afterEach(() => vi.restoreAllMocks());

describe('print', () => {
  it('cuts the popup off from the app and opens its links in a new tab without opener', () => {
    const popupDoc = document.implementation.createHTMLDocument('print');
    let written = '';
    const popup = {
      opener: window as Window | null,
      document: {
        write: (html: string) => { written += html; },
        close: () => { popupDoc.documentElement.innerHTML = written; },
      },
      focus: vi.fn(),
      print: vi.fn(),
    };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);

    render(<EmailViewer email={mail()} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
    fireEvent.click(screen.getAllByTitle('print')[0]);

    expect(popup.print).toHaveBeenCalled();
    expect(popup.opener).toBeNull();
    for (const id of ['plain', 'opener']) {
      const link = popupDoc.getElementById(id)!;
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    }
  }, 30_000);
});
