import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const hoisted = vi.hoisted(() => ({ printPdfUrl: vi.fn(async () => true), noPrint: false }));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock('@/lib/print-pdf', () => ({ printPdfUrl: hoisted.printPdfUrl }));
vi.mock('@/hooks/use-device-policy', () => ({
  useDevicePolicy: () => ({ noDownloads: false, noPrint: hoisted.noPrint }),
  useStrictestDevices: () => ({ noDownloads: false, noPrint: hoisted.noPrint }),
}));

import { FilePreviewModal } from '../file-preview-modal';

// The preview prints a PDF from its header, the same way in every browser
// and the desktop app, and brings the print dialog up by itself for a PDF a
// plugin asked to print (api.ui.print with `pdf`).

const pdf = () => ({ blob: new Blob(['%PDF-1.7'], { type: 'application/pdf' }), contentType: 'application/pdf' });

beforeEach(() => {
  hoisted.noPrint = false;
  hoisted.printPdfUrl.mockClear();
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

  it('offers no Print for an image', async () => {
    render(<FilePreviewModal name="scan.png" onClose={() => {}} onDownload={() => {}} getFileContent={async () => ({ blob: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), contentType: 'image/png' })} />);
    await screen.findByAltText('scan.png');
    expect(screen.queryByTestId('preview-print')).toBeNull();
  });
});
