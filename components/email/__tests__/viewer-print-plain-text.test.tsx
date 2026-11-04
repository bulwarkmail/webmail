// Printing a plain-text mail wrote its escaped text into the print window
// with no white-space rule, so every line break collapsed into one run-on
// paragraph, and a trailing ">" quote printed as the collapsed "•••" toggle
// with the quoted text left out.
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

const TEXT = 'Hi Bob,\n\nline one\nline two\n\nOn Monday you wrote:\n> the old question\n> second quoted line\n';

function plainMail(): Email {
  return {
    id: 'e1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
    from: [{ name: 'Alice', email: 'alice@example.com' }], to: [{ name: 'Bob', email: 'bob@example.com' }],
    subject: 'Hello there', receivedAt: '2026-01-01T00:00:00Z', preview: 'Hi', hasAttachment: false, size: 100,
    textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [{ partId: '1', type: 'text/plain' }], attachments: [],
    bodyValues: { '1': { value: TEXT, isTruncated: false } },
  } as unknown as Email;
}

function printToDocument() {
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
  render(<EmailViewer email={plainMail()} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
  fireEvent.click(screen.getAllByTitle('print')[0]);
  expect(popup.print).toHaveBeenCalled();
  return popupDoc;
}

// The declarations of the print stylesheet's rules that apply to `el`.
function appliedRules(doc: Document, el: Element): string {
  const css = Array.from(doc.querySelectorAll('style')).map((s) => s.textContent ?? '').join('\n');
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g);
  return Array.from(rules)
    .filter(([, selector]) => {
      try { return el.matches(selector.trim()); } catch { return false; }
    })
    .map(([, , body]) => body)
    .join(';');
}

afterEach(() => vi.restoreAllMocks());

describe('printing a plain-text email', () => {
  it('keeps its line breaks', () => {
    const doc = printToDocument();
    const body = doc.querySelector('.body')!;

    expect(body.textContent).toContain('line one\nline two');
    expect(appliedRules(doc, body)).toMatch(/white-space:\s*pre-wrap/);
  }, 30_000);

  it('prints the trailing quote opened, without the toggle', () => {
    const doc = printToDocument();
    const details = doc.querySelector('.body details')!;

    expect(details.hasAttribute('open')).toBe(true);
    expect(details.textContent).toContain('> the old question');
    expect(appliedRules(doc, details.querySelector('summary')!)).toMatch(/display:\s*none/);
  }, 30_000);
});
