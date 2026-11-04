import { escapeHtml } from '@/lib/email-sanitization';

/**
 * Plain text as the formatting editor takes it: a paragraph per block of
 * lines, a line break per single newline, everything escaped. Used where a
 * text-only out-of-office reply or signature opens in the editor.
 */
export function textToParagraphHtml(text: string): string {
  const trimmed = text.replace(/\r\n?/g, '\n').trim();
  if (!trimmed) return '';
  return trimmed
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}
