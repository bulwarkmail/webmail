import { afterEach, describe, expect, it, vi } from 'vitest';
import { pdfText, setPdfLoader, type PdfLib } from '@/lib/attachment-text/pdf';
import { extractText } from '@/lib/attachment-text';

// pdf.js is stood in for: each page is a list of text lines.

const calls = { pages: 0, sources: [] as unknown[], destroyed: 0 };

function fakePdf(pages: string[][], { hang = false } = {}): PdfLib {
  return {
    getDocument: (src) => {
      calls.sources.push(src);
      return {
        promise: hang ? new Promise(() => {}) : Promise.resolve({
          numPages: pages.length,
          getPage: async (n: number) => {
            calls.pages++;
            return { getTextContent: async () => ({ items: pages[n - 1].map((str, i, all) => ({ str, hasEOL: i < all.length - 1 })) }) };
          },
        }),
        destroy: async () => { calls.destroyed++; },
      };
    },
  };
}

const pdf = new TextEncoder().encode('%PDF-1.4');

afterEach(() => {
  setPdfLoader();
  calls.pages = 0;
  calls.sources.length = 0;
  calls.destroyed = 0;
});

describe('pdfText', () => {
  it('reads a typed cover letter in front of a scan', async () => {
    setPdfLoader(async () => fakePdf([['Dear Alice, please find the signed contract attached.'], [''], [''], ['']]));
    const out = await extractText(pdf, { name: 'scan.pdf' });
    expect(out).toMatchObject({ status: 'ok', pages: 4 });
    expect(out.text).toContain('signed contract');
  });

  it('stops reading pages once the budget is used up', async () => {
    setPdfLoader(async () => fakePdf(Array.from({ length: 50 }, (_, i) => [`Page ${i + 1}: ${'word '.repeat(200)}`])));
    const out = await pdfText(pdf, { budget: 2_500 });
    expect(out).toMatchObject({ status: 'ok', truncated: true, pages: 50 });
    expect(calls.pages).toBeLessThanOrEqual(4);
    expect(out.text.length).toBeLessThanOrEqual(2_500);
  });

  it('never lets pdf.js evaluate scripts', async () => {
    setPdfLoader(async () => fakePdf([['Some text that is long enough to count']]));
    await pdfText(pdf);
    expect(calls.sources[0]).toMatchObject({ isEvalSupported: false });
  });

  it('gives up after the timeout and stops pdf.js', async () => {
    vi.useFakeTimers();
    try {
      setPdfLoader(async () => fakePdf([], { hang: true }));
      const pending = pdfText(pdf, { timeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_001);
      expect(await pending).toMatchObject({ status: 'failed' });
      expect(calls.destroyed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
