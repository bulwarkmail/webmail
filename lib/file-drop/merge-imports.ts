/**
 * Several .ics or .vcf files added at once go into one import list (pim-p2-10): the import
 * dialogs read one file, so the files become one. vCards follow each other in a file as they
 * are. Calendars become one VCALENDAR: the first file's own lines (VERSION, PRODID, …), then
 * every file's components (VEVENT, VTODO, VTIMEZONE), in order.
 */

const CRLF = '\r\n';

function lines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/** The component blocks of one VCALENDAR, and the calendar's own lines before the first of them. */
function calendarParts(text: string): { head: string[]; components: string[] } {
  const all = lines(text);
  const begin = all.findIndex((line) => /^BEGIN:VCALENDAR\s*$/i.test(line));
  let end = -1;
  for (let i = all.length - 1; i >= 0; i--) {
    if (/^END:VCALENDAR\s*$/i.test(all[i])) { end = i; break; }
  }
  if (begin === -1 || end <= begin) return { head: [], components: [] };
  const inner = all.slice(begin + 1, end);
  const first = inner.findIndex((line) => /^BEGIN:/i.test(line));
  return first === -1
    ? { head: inner.filter(Boolean), components: [] }
    : { head: inner.slice(0, first).filter(Boolean), components: inner.slice(first).filter(Boolean) };
}

export function mergeCalendarTexts(texts: string[]): string {
  const parts = texts.map(calendarParts);
  const head = parts.find((part) => part.head.length > 0)?.head ?? ['VERSION:2.0'];
  return ['BEGIN:VCALENDAR', ...head, ...parts.flatMap((part) => part.components), 'END:VCALENDAR', ''].join(CRLF);
}

export function mergeVCardTexts(texts: string[]): string {
  return texts.map((text) => text.replace(/\r\n?/g, '\n').trim()).filter(Boolean).join('\n').replace(/\n/g, CRLF) + CRLF;
}

/** One file holding them all, named after the first; a single file stays as it is. */
export async function mergeImportFiles(kind: 'calendar' | 'contacts', files: File[]): Promise<File> {
  if (files.length === 1) return files[0];
  const texts = await Promise.all(files.map((file) => file.text()));
  const [first] = files;
  return kind === 'calendar'
    ? new File([mergeCalendarTexts(texts)], first.name, { type: 'text/calendar' })
    : new File([mergeVCardTexts(texts)], first.name, { type: 'text/vcard' });
}
