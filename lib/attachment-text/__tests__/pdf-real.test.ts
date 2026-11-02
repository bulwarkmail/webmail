import { afterEach, describe, expect, it } from 'vitest';
import { extractText } from '@/lib/attachment-text';
import { setPdfLoader, type PdfLib } from '@/lib/attachment-text/pdf';

// The PDF the test rig seeds: one page, Helvetica, a few lines of text.
function pdf(lines: string[]): Uint8Array {
  const content = `BT /F1 12 Tf 72 720 Td ${lines.map((l, i) => `${i ? '0 -16 Td ' : ''}(${l.replace(/[()\\]/g, (m) => '\\' + m)}) Tj`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

afterEach(() => setPdfLoader());

describe('PDF with the real pdf.js', () => {
  it('reads the text of a one-page PDF', async () => {
    // The app loads the browser build with its worker file; vitest runs in
    // Node, which needs the legacy build (its worker runs in the same thread).
    setPdfLoader(async () => {
      const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
      // pdf.js takes an already loaded worker module from here.
      // @ts-expect-error -- pdf.js ships no types for the worker module
      (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
      return lib as unknown as PdfLib;
    });
    const out = await extractText(pdf(['Workshop agenda', '09:30 Launch plan (codeword PELICAN)']), { name: 'agenda.pdf' });
    expect(out).toMatchObject({ status: 'ok', pages: 1 });
    expect(out.text).toContain('codeword PELICAN');
  }, 30_000);
});
