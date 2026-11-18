import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const hoisted = vi.hoisted(() => ({
  printPdfUrl: vi.fn(async () => true),
  printFile: vi.fn(async (..._args: unknown[]) => true),
  printMessageInWindow: vi.fn((..._args: unknown[]) => {}),
  noPrint: false,
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock('@/lib/print-pdf', () => ({ printPdfUrl: hoisted.printPdfUrl }));
vi.mock('@/lib/print-file', async (original) => ({ ...(await original<typeof import('@/lib/print-file')>()), printFile: hoisted.printFile }));
vi.mock('@/components/email/message-print-window', () => ({ printMessageInWindow: hoisted.printMessageInWindow }));
vi.mock('@/hooks/use-device-policy', () => ({
  useDevicePolicy: () => ({ noDownloads: false, noPrint: hoisted.noPrint }),
  useStrictestDevices: () => ({ noDownloads: false, noPrint: hoisted.noPrint }),
}));

import { FilePreviewModal } from '../file-preview-modal';
import { fileDocument, type PrintableFile } from '@/lib/print-file';

// The preview prints a PDF from its header, the same way in every browser
// and the desktop app, and brings the print dialog up by itself for a PDF a
// plugin asked to print (api.ui.print with `pdf`).

const pdf = () => ({ blob: new Blob(['%PDF-1.7'], { type: 'application/pdf' }), contentType: 'application/pdf' });

beforeEach(() => {
  hoisted.noPrint = false;
  hoisted.printPdfUrl.mockClear();
  hoisted.printFile.mockClear();
  hoisted.printMessageInWindow.mockClear();
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:test-pdf');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  // A desktop browser with its own PDF viewer.
  Object.defineProperty(navigator, 'pdfViewerEnabled', { configurable: true, get: () => true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function renderPdf(props: { autoPrint?: boolean } = {}) {
  const view = render(<FilePreviewModal name="Akte.pdf" onClose={() => {}} onDownload={() => {}} getFileContent={async () => pdf()} {...props} />);
  await screen.findByTitle('Akte.pdf');
  return view;
}

describe('FilePreviewModal printing a PDF', () => {
  it('offers Print, which prints the PDF itself', async () => {
    await renderPdf();
    fireEvent.click(screen.getByTestId('preview-print'));
    // With the PDF's Blob: the desktop app can't fetch the blob: URL (CSP connect-src).
    expect(hoisted.printPdfUrl).toHaveBeenCalledWith('blob:test-pdf', undefined, expect.any(Blob));
  });

  it('prints once by itself when asked to', async () => {
    const view = await renderPdf({ autoPrint: true });
    await act(async () => { await Promise.resolve(); });
    expect(hoisted.printPdfUrl).toHaveBeenCalledTimes(1);
    view.rerender(<FilePreviewModal name="Akte.pdf" onClose={() => {}} onDownload={() => {}} getFileContent={async () => pdf()} autoPrint />);
    await act(async () => { await Promise.resolve(); });
    expect(hoisted.printPdfUrl).toHaveBeenCalledTimes(1);
  });

  it('offers no Print and prints nothing while the organisation turns printing off', async () => {
    hoisted.noPrint = true;
    render(<FilePreviewModal name="Akte.pdf" onClose={() => {}} onDownload={() => {}} getFileContent={async () => pdf()} autoPrint />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByTestId('preview-print')).toBeNull();
    expect(hoisted.printPdfUrl).not.toHaveBeenCalled();
  });

});

const file = (body: BlobPart, type: string) => async () => ({ blob: new Blob([body], { type }), contentType: type });

function renderFile(name: string, getFileContent: () => Promise<{ blob: Blob; contentType: string }>) {
  return render(<FilePreviewModal name={name} onClose={() => {}} onDownload={() => {}} getFileContent={getFileContent} />);
}

/** The page printFile was asked to print, as it would print. */
function printedDocument(): string {
  const [title, printable, watermark] = hoisted.printFile.mock.calls[0] as [string, PrintableFile, string | null | undefined];
  return fileDocument(title, printable, watermark);
}

const EML = [
  'From: Ana Example <ana@example.org>',
  'To: Bo <bo@example.org>',
  'Cc: Cy <cy@example.org>',
  'Subject: Quarterly figures',
  'Date: Fri, 6 Nov 2026 10:00:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Numbers <attached> below.',
].join('\r\n');

describe('FilePreviewModal printing other files', () => {
  it('prints an image by itself, as a data: URL', async () => {
    renderFile('scan.png', file(new Uint8Array([137, 80, 78, 71]), 'image/png'));
    await screen.findByAltText('scan.png');
    fireEvent.click(await screen.findByTestId('preview-print'));
    await waitFor(() => expect(hoisted.printFile).toHaveBeenCalledOnce());
    const [title, printable] = hoisted.printFile.mock.calls[0] as [string, PrintableFile];
    expect(title).toBe('scan.png');
    expect(printable).toMatchObject({ kind: 'image', src: expect.stringMatching(/^data:image\/png;base64,/) });
    expect(printedDocument()).toContain('<img src="data:image/png;base64,');
  });

  it('prints an SVG as a data: picture', async () => {
    renderFile('logo.svg', file('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'image/svg+xml'));
    fireEvent.click(await screen.findByTestId('preview-print'));
    await waitFor(() => expect(hoisted.printFile).toHaveBeenCalledOnce());
    expect((hoisted.printFile.mock.calls[0][1] as PrintableFile)).toMatchObject({ kind: 'image', src: expect.stringMatching(/^data:image\/svg\+xml;base64,/) });
  });

  it('prints a text file as escaped text', async () => {
    renderFile('notes.txt', file('a < b && <script>x()</script>', 'text/plain'));
    fireEvent.click(await screen.findByTestId('preview-print'));
    await waitFor(() => expect(hoisted.printFile).toHaveBeenCalledOnce());
    const doc = printedDocument();
    expect(doc).toContain('<pre>a &lt; b &amp;&amp; &lt;script&gt;x()&lt;/script&gt;</pre>');
    expect(doc).not.toContain('<script>');
  });

  it('prints Markdown as the preview renders it', async () => {
    renderFile('README.md', file('# Title\n- item **bold**\n> quoted', 'text/markdown'));
    fireEvent.click(await screen.findByTestId('preview-print'));
    await waitFor(() => expect(hoisted.printFile).toHaveBeenCalledOnce());
    expect(hoisted.printFile.mock.calls[0][1]).toMatchObject({ kind: 'markdown' });
    const doc = printedDocument();
    expect(doc).toMatch(/<h1[^>]*>Title<\/h1>/);
    expect(doc).toMatch(/<li[^>]*>item <strong>bold<\/strong><\/li>/);
    expect(doc).toMatch(/<blockquote[^>]*>quoted<\/blockquote>/);
  });

  it('prints an HTML attachment sanitised, with remote content blocked', async () => {
    renderFile('invoice.html', file('<p id="text">Invoice 4711</p><script>alert(1)</script><img src="https://evil.example/b.png">', 'text/html'));
    fireEvent.click(await screen.findByTestId('preview-print'));
    await waitFor(() => expect(hoisted.printFile).toHaveBeenCalledOnce());
    expect(hoisted.printFile.mock.calls[0][1]).toMatchObject({ kind: 'html', blockRemote: true });
    const doc = printedDocument();
    expect(doc).toContain('Invoice 4711');
    expect(doc).not.toContain('<script');
    expect(doc).not.toMatch(/\ssrc="https:\/\/evil/);
    expect(doc).toContain("img-src data: blob:;");
  });

  it('prints an attached message like one from the reader', async () => {
    renderFile('figures.eml', file(EML, 'message/rfc822'));
    fireEvent.click(await screen.findByTestId('preview-print'));
    expect(hoisted.printMessageInWindow).toHaveBeenCalledOnce();
    const [fields, options] = hoisted.printMessageInWindow.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(fields).toMatchObject({
      subject: 'Quarterly figures',
      sender: 'Ana Example <ana@example.org>',
      to: 'Bo <bo@example.org>',
      cc: 'Cy <cy@example.org>',
      plain: true,
    });
    expect(fields.bodyHtml).toContain('Numbers &lt;attached&gt; below.');
    expect(fields.date).not.toBe('');
    expect(options).toMatchObject({ externalBlocked: true, labels: { from: 'from', to: 'to', cc: 'cc', date: 'date', attachments: 'attachments' } });
    expect(hoisted.printFile).not.toHaveBeenCalled();
  });

  it.each([
    ['song.mp3', 'audio/mpeg'],
    ['clip.mp4', 'video/mp4'],
  ])('offers no Print for %s', async (name, type) => {
    renderFile(name, file(new Uint8Array([0, 0, 0, 0]), type));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(document.querySelector(`[src="blob:test-pdf"]`)).not.toBeNull();
    expect(screen.queryByTestId('preview-print')).toBeNull();
  });

  it.each([
    ['scan.png', 'image/png', new Uint8Array([137, 80, 78, 71]) as BlobPart],
    ['notes.txt', 'text/plain', 'hello'],
    ['README.md', 'text/markdown', '# hi'],
    ['invoice.html', 'text/html', '<p>hi</p>'],
    ['figures.eml', 'message/rfc822', EML],
  ])('offers no Print for %s while the organisation turns printing off', async (name, type, body) => {
    hoisted.noPrint = true;
    renderFile(name, file(body, type));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByText(/loading/)).toBeNull();
    expect(screen.queryByTestId('preview-print')).toBeNull();
  });

  it('offers no Print while the file loads or when it failed', async () => {
    let fail: (e: Error) => void = () => {};
    renderFile('notes.txt', () => new Promise((_, reject) => { fail = reject; }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('preview-print')).toBeNull();
    await act(async () => { fail(new Error('gone')); await Promise.resolve(); });
    await screen.findByText('preview_error');
    expect(screen.queryByTestId('preview-print')).toBeNull();
  });
});
