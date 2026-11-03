// Area b of the assistant's host APIs: what the message view adds to each
// attachment. An image the HTML shows inline (`<img src="cid:…">`) gets its
// Content-ID and the alt text the sender wrote for it, so the assistant can
// name a picture without looking at it.

import type { Email } from '@/lib/jmap/types';
import type { AttachmentExtrasB, EmailReadViewExtrasB } from './b.types';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** The value of one attribute of a tag's source, or null. */
function attribute(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (!m) return null;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? '');
}

/** "<logo1@aa>", "logo1@aa", "cid:logo1%40aa" → "logo1@aa" (lower case, for comparing). */
export function normaliseCid(value: string): string {
  let id = value.trim().replace(/^cid:/i, '').replace(/^<|>$/g, '');
  try { id = decodeURIComponent(id); } catch { /* keep it as written */ }
  return id.toLowerCase();
}

/** Content-ID → alt text, from the `<img src="cid:…" alt="…">` tags of the message's HTML. */
export function cidAltTexts(email: Pick<Email, 'htmlBody' | 'bodyValues'>): Map<string, string> {
  const out = new Map<string, string>();
  const values = email.bodyValues ?? {};
  for (const part of email.htmlBody ?? []) {
    const html = values[part.partId]?.value;
    if (typeof html !== 'string') continue;
    for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
      const src = attribute(tag, 'src');
      if (!src || !/^cid:/i.test(src.trim())) continue;
      const alt = (attribute(tag, 'alt') ?? attribute(tag, 'title') ?? '').replace(/\s+/g, ' ').trim();
      const cid = normaliseCid(src);
      if (alt && !out.has(cid)) out.set(cid, alt.slice(0, 500));
    }
  }
  return out;
}

/** EmailReadView.blobsReadable: false when the signed-in login can't read the message's parts, else left out. */
export function readability(readable: boolean): EmailReadViewExtrasB {
  return readable ? {} : { blobsReadable: false };
}

/** `cid` and `alt` of one attachment, for EmailReadView.attachments (empty for a plain attachment). */
export function attachmentExtras(part: { cid?: string | null }, alts: Map<string, string>): AttachmentExtrasB {
  if (!part.cid) return {};
  const cid = part.cid.replace(/^<|>$/g, '');
  const alt = alts.get(normaliseCid(cid));
  return { cid, ...(alt ? { alt } : {}) };
}
