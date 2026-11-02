// Text out of a PDF with pdf.js, the same library and worker the Files
// viewer loads. Imported on demand, so nothing is fetched until a PDF is
// read. Runs in the app page (the worker is a same-origin file; the CSP
// refuses blob: workers).

import { liteMountedAssetUrl } from '@/lib/lite';
import { MAX_PDF_PAGES, MAX_TEXT_CHARS, MIN_PDF_CHARS_PER_PAGE, TEXT_BUDGET_SLACK, type ExtractedText } from './types';
import { TextSink } from './sink';

/** The part of pdf.js used here (tests pass a stand-in). */
export interface PdfLib {
  getDocument(src: { data: Uint8Array; isEvalSupported?: boolean }): { promise: Promise<PdfDoc>; destroy(): Promise<void> };
}
interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>;
}

/** Longest a PDF may take to read before the read gives up. */
export const PDF_TIMEOUT_MS = 30_000;

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

class TimedOut extends Error {}

export interface PdfOptions {
  /** Characters to read at most; reading stops at the page that fills it. */
  budget?: number;
  /** Longest the read may take (default PDF_TIMEOUT_MS). */
  timeoutMs?: number;
}

/**
 * The text of at most MAX_PDF_PAGES pages, a "Page n" line before each,
 * stopping once `budget` characters are read. no_text when no page has
 * MIN_PDF_CHARS_PER_PAGE characters (a scan; a typed cover letter in front
 * of one is read); encrypted for a PDF that needs a password; failed after
 * `timeoutMs`. Scripts in the PDF are never evaluated.
 */
export async function pdfText(bytes: Uint8Array, { budget = MAX_TEXT_CHARS + TEXT_BUDGET_SLACK, timeoutMs = PDF_TIMEOUT_MS }: PdfOptions = {}): Promise<Omit<ExtractedText, 'format'>> {
  const lib = await loader();
  // pdf.js may take over the buffer: give it a copy.
  const task = lib.getDocument({ data: bytes.slice(), isEvalSupported: false });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TimedOut()), timeoutMs); });
  const read = async (): Promise<Omit<ExtractedText, 'format'>> => {
    const doc = await task.promise;
    const pages = doc.numPages;
    const last = Math.min(pages, MAX_PDF_PAGES);
    const sink = new TextSink(budget);
    let readable = false;
    let n = 0;
    while (n < last && !sink.full) {
      n++;
      const page = await doc.getPage(n);
      const text = pageText((await page.getTextContent()).items);
      if (text.replace(/\s/g, '').length >= MIN_PDF_CHARS_PER_PAGE) readable = true;
      if (!text) continue;
      if (pages > 1) sink.line(`${n > 1 ? '\n' : ''}Page ${n}`);
      sink.line(text);
    }
    if (!readable) return { status: 'no_text', text: '', truncated: false, pages };
    return { status: 'ok', text: sink.text(), truncated: sink.full || n < pages, pages };
  };
  try {
    return await Promise.race([read(), timeout]);
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    if (name === 'PasswordException') return { status: 'encrypted', text: '', truncated: false };
    return { status: 'failed', text: '', truncated: false };
  } finally {
    clearTimeout(timer);
    // Also stops a read still running after the timeout.
    void task.destroy().catch(() => {});
  }
}
