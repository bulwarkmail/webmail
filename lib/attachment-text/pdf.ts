// Text out of a PDF with pdf.js, the same library and worker the Files
// viewer loads. Imported on demand, so nothing is fetched until a PDF is
// read. Runs in the app page (the worker is a same-origin file; the CSP
// refuses blob: workers).

import { liteMountedAssetUrl } from '@/lib/lite';
import { MAX_PDF_PAGES, MIN_PDF_CHARS_PER_PAGE, type ExtractedText } from './types';

/** The part of pdf.js used here (tests pass a stand-in). */
export interface PdfLib {
  getDocument(src: { data: Uint8Array }): { promise: Promise<PdfDoc>; destroy(): Promise<void> };
}
interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>;
}

async function loadPdfJs(): Promise<PdfLib> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = liteMountedAssetUrl(new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString());
  return pdfjs as unknown as PdfLib;
}

let loader: () => Promise<PdfLib> = loadPdfJs;

/** Swap the pdf.js loader (tests). Without an argument the real one comes back. */
export function setPdfLoader(next?: () => Promise<PdfLib>): void {
  loader = next ?? loadPdfJs;
}

/** The text items of one page as lines: a new line where pdf.js marks one. */
function pageText(items: unknown[]): string {
  let out = '';
  for (const item of items) {
    if (!item || typeof item !== 'object' || !('str' in item)) continue;
    const { str, hasEOL } = item as { str: unknown; hasEOL?: unknown };
    if (typeof str === 'string') out += str;
    if (hasEOL === true) out += '\n';
    else if (typeof str === 'string' && str && !/\s$/.test(str)) out += ' ';
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * The text of at most MAX_PDF_PAGES pages, a "Page n" line before each.
 * no_text when the pages hold fewer than MIN_PDF_CHARS_PER_PAGE characters
 * on average (a scan); encrypted for a PDF that needs a password.
 */
export async function pdfText(bytes: Uint8Array): Promise<Omit<ExtractedText, 'format'>> {
  const lib = await loader();
  // pdf.js may take over the buffer: give it a copy.
  const task = lib.getDocument({ data: bytes.slice() });
  try {
    const doc = await task.promise;
    const pages = doc.numPages;
    const read = Math.min(pages, MAX_PDF_PAGES);
    const parts: string[] = [];
    let chars = 0;
    for (let n = 1; n <= read; n++) {
      const page = await doc.getPage(n);
      const text = pageText((await page.getTextContent()).items);
      chars += text.replace(/\s/g, '').length;
      if (text) parts.push(read > 1 ? `Page ${n}\n${text}` : text);
    }
    if (read === 0 || chars / read < MIN_PDF_CHARS_PER_PAGE) {
      return { status: 'no_text', text: '', truncated: false, pages };
    }
    return { status: 'ok', text: parts.join('\n\n'), truncated: pages > read, pages };
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    if (name === 'PasswordException') return { status: 'encrypted', text: '', truncated: false };
    return { status: 'failed', text: '', truncated: false };
  } finally {
    void task.destroy().catch(() => {});
  }
}
