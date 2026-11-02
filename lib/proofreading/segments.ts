// The user's own text cut into paragraphs ("segments") for a text checker.
//
// A segment is one text block of the user's own text (see composer-edit.ts:
// everything above the signature and the quote). Its text has exactly one
// character per editor position, so an offset into it maps to the document
// without a table:
// - text is itself (JS strings and ProseMirror both count UTF-16 units),
// - a hard break is "\n",
// - any other inline object (mention chip, inline image) is U+FFFC, which a
//   checker is told to skip.
// Dropping U+FFFC, joining the segments with "\n" and trimming gives the
// same text as readOwnContent, less its empty lines.
//
// A segment's id is a hash of its text plus how many earlier segments have
// the same text. A paragraph keeps its id while the user edits elsewhere and
// gets a new one when it changes, so a checker can cache by id and the host
// never has to track nodes through edits.

import type { Node as PMNode } from '@tiptap/pm/model';
import { ownRange, plainOwnRange, type OwnTextOptions, type PlainOwnOptions } from '@/lib/plugin-sandbox/composer-edit';

export const OBJECT_CHAR = '\uFFFC';

export interface Segment {
  id: string;
  text: string;
  /**
   * Where the text starts: a document position in the rich editor (the
   * first position inside the block), an index into the textarea's value
   * in the plain-text composer.
   */
  start: number;
}

// Code is not prose; a checker would only flag it.
const SKIPPED_BLOCKS = new Set(['codeBlock']);

/** cyrb53: a fast 53-bit string hash. Not for security, only for ids. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function withIds(parts: { text: string; start: number }[]): Segment[] {
  const seen = new Map<string, number>();
  return parts.map(({ text, start }) => {
    const base = hash(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { id: n ? `${base}.${n}` : base, text, start };
  });
}

/** The text of a text block, one character per position. */
export function blockText(node: PMNode): string {
  let text = '';
  node.forEach((child) => {
    if (child.isText) text += child.text ?? '';
    else if (child.type.name === 'hardBreak') text += '\n';
    else text += OBJECT_CHAR.repeat(child.nodeSize);
  });
  return text;
}

/** Segments of the rich editor's document. Empty paragraphs are left out. */
export function richSegments(doc: PMNode, opts: OwnTextOptions = {}): Segment[] {
  const { from, to } = ownRange(doc, opts);
  const parts: { text: string; start: number }[] = [];
  if (to <= from) return [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    if (SKIPPED_BLOCKS.has(node.type.name)) return false;
    const text = blockText(node);
    if (text.split(OBJECT_CHAR).join('').trim()) parts.push({ text, start: pos + 1 });
    return false;
  });
  return withIds(parts);
}

/**
 * Segments of a plain-text body: the user's own text (as plainOwnRange
 * finds it) cut at blank lines. A single line break stays inside its
 * paragraph as "\n".
 */
export function plainSegments(body: string, opts: PlainOwnOptions = {}): Segment[] {
  const { to } = plainOwnRange(body, opts);
  const own = body.slice(0, to);
  const parts: { text: string; start: number }[] = [];
  const blank = /\n[ \t]*\n/g;
  let at = 0;
  const push = (end: number) => {
    let s = at;
    let e = end;
    while (s < e && /\s/.test(own[s])) s++;
    while (e > s && /\s/.test(own[e - 1])) e--;
    if (e > s) parts.push({ text: own.slice(s, e), start: s });
  };
  for (let m = blank.exec(own); m; m = blank.exec(own)) {
    push(m.index);
    at = m.index + m[0].length;
  }
  push(own.length);
  return withIds(parts);
}

/** The text a segment list stands for, as readOwnContent gives it (less empty lines). */
export function segmentsAsText(segments: Segment[]): string {
  return segments.map((s) => s.text.split(OBJECT_CHAR).join('')).join('\n');
}
