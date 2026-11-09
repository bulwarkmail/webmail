/**
 * The watermark of the device policy `watermark` (lib/device-policy.ts): the
 * user's address and the date, repeated across the reader and printouts.
 * Real text elements, not a background image, so printers show it even
 * when "print backgrounds" is off. A fixed layer repeats on every printed
 * page.
 *
 * It can be removed with the browser's tools; the docs say so.
 */

import { escapeHtml } from '@/lib/email-sanitization';

/** How many copies of the text the layer holds (rows x columns). */
export const WATERMARK_ROWS = 8;
export const WATERMARK_COLUMNS = 3;

/** Styles for the layer and its copies, shared by the React overlay and the print documents. */
export const WATERMARK_CSS = `
.bulwark-watermark { position: absolute; inset: 0; overflow: hidden; pointer-events: none; user-select: none; z-index: 6;
  display: grid; grid-template-columns: repeat(${WATERMARK_COLUMNS}, 1fr); align-content: space-around; justify-items: center; }
.bulwark-watermark[data-fixed] { position: fixed; z-index: 2147483000; }
.bulwark-watermark span { transform: rotate(-30deg); white-space: nowrap; font: 600 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: rgba(120, 120, 120, 0.22); padding: 40px 8px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
@media print { .bulwark-watermark span { color: rgba(90, 90, 90, 0.28); } }
`;

/** The layer as HTML for a print document (escaped). `fixed` repeats it on every page. */
export function watermarkHtml(text: string, options: { fixed?: boolean } = {}): string {
  const copy = `<span>${escapeHtml(text)}</span>`;
  return `<div class="bulwark-watermark" aria-hidden="true" data-testid="watermark"${options.fixed ? ' data-fixed=""' : ''}>${copy.repeat(WATERMARK_ROWS * WATERMARK_COLUMNS)}</div>`;
}

/** The styles and layer for the head and body of a print document. */
export function watermarkForPrint(text: string): { style: string; html: string } {
  return { style: `<style>${WATERMARK_CSS}</style>`, html: watermarkHtml(text, { fixed: true }) };
}
