// Text out of the formats that already are text: plain text, CSV, HTML,
// calendar files (ICS) and address cards (VCF).

import { htmlToPlainText } from '@/lib/html-to-text';
import { parseVCard } from '@/lib/vcard';
import type { ContactCard } from '@/lib/jmap/types';

/**
 * Bytes as text: UTF-8 (with or without a byte order mark), UTF-16 with a
 * byte order mark, else Windows-1252, which never fails.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** True when the bytes look like text rather than a binary file (no NUL bytes in the first 4 KB). */
export function looksLikeText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 4096);
  if (head[0] === 0xff && head[1] === 0xfe) return true;
  if (head[0] === 0xfe && head[1] === 0xff) return true;
  return !head.includes(0);
}

/** The readable text of an HTML file: no scripts, styles or head. */
export function htmlText(html: string): string {
  const body = html.replace(/<(script|style|noscript|template|head)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  return htmlToPlainText(body, { paragraphSpacing: true, mailMarkup: true, imageAlt: (alt) => `[Image: ${alt}]` });
}

// ─── ICS ─────────────────────────────────────────────────────

interface IcsLine { name: string; params: Record<string, string>; value: string }

function unfold(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseIcsLine(line: string): IcsLine | null {
  // NAME;PARAM=a;PARAM="b:c":value. A colon inside a quoted parameter is not the separator.
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ':' && !quoted) { colon = i; break; }
  }
  if (colon < 0) return null;
  const [name, ...rawParams] = line.slice(0, colon).split(';');
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

function icsText(value: string): string {
  return value.replace(/\\[nN]/g, ' ').replace(/\\([,;\\])/g, '$1').trim();
}

/** 20261105T090000Z → "2026-11-05 09:00 UTC"; with TZID the zone in brackets; a date alone stays a date. */
function icsWhen(line: IcsLine | undefined): string {
  if (!line) return '';
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{0,2}(Z?))?$/.exec(line.value.trim());
  if (!m) return line.value.trim();
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4]) return date;
  const zone = m[6] ? ' UTC' : line.params.TZID ? ` (${line.params.TZID})` : '';
  return `${date} ${m[4]}:${m[5]}${zone}`;
}

function organiser(line: IcsLine | undefined): string {
  if (!line) return '';
  const address = line.value.replace(/^mailto:/i, '').trim();
  const name = line.params.CN?.trim();
  return name && address ? `${name} <${address}>` : (name || address);
}

/** One line per event and task: "event: title, start, end, location, organiser …". */
export function icsToText(ics: string): string {
  const out: string[] = [];
  let current: Map<string, IcsLine> | null = null;
  let kind = '';
  for (const raw of unfold(ics)) {
    const line = parseIcsLine(raw);
    if (!line) continue;
    if (line.name === 'BEGIN' && /^(VEVENT|VTODO)$/i.test(line.value.trim())) {
      current = new Map();
      kind = line.value.trim().toUpperCase() === 'VTODO' ? 'task' : 'event';
      continue;
    }
    if (line.name === 'END' && current && /^(VEVENT|VTODO)$/i.test(line.value.trim())) {
      const parts = [
        icsText(current.get('SUMMARY')?.value ?? '') || '(no title)',
        icsWhen(current.get('DTSTART')),
        icsWhen(current.get('DTEND') ?? current.get('DUE')),
        icsText(current.get('LOCATION')?.value ?? ''),
      ];
      const org = organiser(current.get('ORGANIZER'));
      if (org) parts.push(`organiser ${org}`);
      out.push(`${kind}: ${parts.filter(Boolean).join(', ')}`);
      const description = icsText(current.get('DESCRIPTION')?.value ?? '');
      if (description) out.push(`  ${description}`);
      current = null;
      continue;
    }
    if (current && !current.has(line.name)) current.set(line.name, line);
  }
  return out.join('\n');
}

// ─── VCF ─────────────────────────────────────────────────────

function cardName(card: ContactCard): string {
  const full = card.name?.full?.trim();
  if (full) return full;
  return (card.name?.components ?? [])
    .filter((c) => c.kind !== 'separator')
    .map((c) => c.value)
    .join(' ')
    .trim();
}

/** One block per card: name, email addresses, phone numbers, organisation. */
export function vcfText(vcf: string): string {
  return parseVCard(vcf).map((card) => {
    const lines = [`contact: ${cardName(card) || '(no name)'}`];
    const emails = Object.values(card.emails ?? {}).map((e) => e.address).filter(Boolean);
    const phones = Object.values(card.phones ?? {}).map((p) => p.number).filter(Boolean);
    const orgs = Object.values(card.organizations ?? {}).map((o) => o.name).filter(Boolean);
    if (emails.length) lines.push(`  email: ${emails.join(', ')}`);
    if (phones.length) lines.push(`  phone: ${phones.join(', ')}`);
    if (orgs.length) lines.push(`  organisation: ${orgs.join(', ')}`);
    return lines.join('\n');
  }).join('\n');
}
