// "Drucker-Thema": printouts can be styled. A theme sets --print-* variables
// (fonts, colours, margins) and the printout follows them; a plugin registers
// a print style (CSS and a letterhead) that the user picks under Settings >
// Appearance > Printing. Before, every printout looked the same whatever
// the theme, and plugins had no way in.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useSettingsStore } from '@/stores/settings-store';

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
  useIsMobile: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const { EmailViewer } = await import('@/components/email/email-viewer');
const { PrintingSection } = await import('@/components/settings/printing-settings');
const { registerPrintTheme, resetPrintThemes } = await import('@/lib/plugin-sandbox/print-themes');

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

function htmlMail(): Email {
  return {
    id: 'e1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
    from: [{ name: 'Anna Becker', email: 'anna@example.com' }], to: [{ name: 'Bob', email: 'bob@example.com' }],
    subject: 'Quarterly report', receivedAt: '2026-11-03T09:00:00Z', preview: 'Hi', hasAttachment: false, size: 100,
    textBody: [{ partId: '1', type: 'text/html' }], htmlBody: [{ partId: '1', type: 'text/html' }], attachments: [],
    bodyValues: { '1': { value: '<p>The numbers are in.</p>', isTruncated: false }},
  } as unknown as Email;
}

function viewer() {
  return render(<EmailViewer email={htmlMail()} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
}

function printCopy(): HTMLElement {
  return document.body.querySelector<HTMLElement>(':scope > [data-print-root]')!;
}

function printWindow(): string {
  let written = '';
  const popup = {
    opener: window as Window | null,
    document: { write: (html: string) => { written += html; }, close: () => {} },
    focus: vi.fn(),
    print: vi.fn(),
  };
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  fireEvent.click(screen.getAllByTitle('print')[0]);
  expect(popup.print).toHaveBeenCalled();
  return written;
}

beforeEach(() => {
  (HTMLElement.prototype as unknown as { checkVisibility: () => boolean }).checkVisibility = () => true;
  useSettingsStore.setState({ printTheme: 'standard' });
  resetPrintThemes();
});

afterEach(() => {
  act(() => { window.dispatchEvent(new Event('afterprint')); });
  delete (HTMLElement.prototype as unknown as { checkVisibility?: unknown }).checkVisibility;
  document.documentElement.removeAttribute('style');
  vi.restoreAllMocks();
});

describe("a theme's print CSS", () => {
  beforeEach(() => {
    // What a theme's :root block sets.
    document.documentElement.style.setProperty('--print-font-family', 'Georgia, serif');
    document.documentElement.style.setProperty('--print-heading-color', '#1373d9');
    document.documentElement.style.setProperty('--print-page-margin', '20mm 15mm');
  });

  it("sets the page margin of a message's print copy (Ctrl+P)", () => {
    viewer();
    act(() => { window.dispatchEvent(new Event('beforeprint')); });
    expect(printCopy().querySelector('style')!.textContent).toBe('@page { size: portrait; margin: 20mm 15mm; }');
  }, 30_000);

  it('goes into the Print window with the variables it set', () => {
    viewer();
    const page = printWindow();
    expect(page).toContain(':root { --print-font-family: Georgia, serif; --print-heading-color: #1373d9; --print-page-margin: 20mm 15mm; }');
    expect(page).toContain('font-family: var(--print-font-family');
    expect(page).toContain('@page { margin: 20mm 15mm; }');
  }, 30_000);

  it('leaves the printout as it was without a theme', () => {
    document.documentElement.removeAttribute('style');
    viewer();
    const page = printWindow();
    expect(page).not.toContain('--print-');
    expect(page).not.toContain('data-print-theme');
    act(() => { window.dispatchEvent(new Event('beforeprint')); });
    expect(printCopy().querySelector('style')!.textContent).toBe('@page { size: portrait; margin: 12mm; }');
    expect(printCopy().hasAttribute('data-print-theme')).toBe(false);
  }, 30_000);
});

describe("a plugin's print style", () => {
  beforeEach(() => {
    registerPrintTheme('letterhead', 'Letterhead', {
      id: 'company',
      label: 'Company letterhead',
      css: '@import "https://evil.example/a.css"; .pr-title { color: #003366; background: url(https://evil.example/p.png) } @page { margin: 25mm }',
      header: 'Example GmbH <script>alert(1)</script>',
      footer: 'Main Street 1, Berlin',
    });
  });

  it('is listed under Settings > Appearance > Printing, Standard by default', () => {
    render(<PrintingSection />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('standard');
    expect([...select.options].map((o) => o.value)).toEqual(['standard', 'letterhead/company']);
    fireEvent.change(select, { target: { value: 'letterhead/company' } });
    expect(useSettingsStore.getState().printTheme).toBe('letterhead/company');
  });

  it('is applied to the print copy once picked, without remote URLs or scripts', () => {
    useSettingsStore.setState({ printTheme: 'letterhead/company' });
    viewer();
    act(() => { window.dispatchEvent(new Event('beforeprint')); });
    const copy = printCopy();
    expect(copy.getAttribute('data-print-theme')).toBe('letterhead/company');
    const css = copy.querySelector('[data-print-theme-css]')!.textContent!;
    expect(css).toContain('[data-print-theme] .pr-title { color: #003366;');
    expect(css).not.toContain('evil.example');
    expect(copy.querySelector('style')!.textContent).toContain('margin: 25mm');
    const header = copy.querySelector('[data-print-letterhead="header"]')!;
    expect(header.textContent).toBe('Example GmbH <script>alert(1)</script>');
    expect(copy.querySelector('script')).toBeNull();
    expect(copy.querySelector('[data-print-letterhead="footer"]')!.textContent).toBe('Main Street 1, Berlin');
  }, 30_000);

  it('is applied in the Print window too', () => {
    useSettingsStore.setState({ printTheme: 'letterhead/company' });
    viewer();
    const page = printWindow();
    expect(page).toContain('data-print-theme="letterhead/company"');
    expect(page).toContain('[data-print-theme] .pr-title { color: #003366;');
    expect(page).toContain('Example GmbH &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page).not.toContain('<script>');
    expect(page).not.toContain('evil.example');
    expect(page).toContain('@page { margin: 25mm; }');
  }, 30_000);

  it('is not applied while Standard is picked', () => {
    viewer();
    act(() => { window.dispatchEvent(new Event('beforeprint')); });
    expect(printCopy().hasAttribute('data-print-theme')).toBe(false);
    expect(printCopy().querySelector('[data-print-letterhead]')).toBeNull();
  }, 30_000);
});
