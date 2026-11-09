/**
 * The Markdown of an extension's changelog, as a small tree the admin UI
 * renders with React elements. Changelogs come from the extension directory
 * and are not covered by the bundle signature, so they never become HTML:
 * only headings, paragraphs, lists, code, bold and http(s) links are read,
 * and everything else stays text.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] };

export type Block =
  | { t: 'heading'; c: Inline[] }
  | { t: 'para'; c: Inline[] }
  | { t: 'list'; ordered: boolean; items: Inline[][] }
  | { t: 'code'; v: string };

const MAX_LENGTH = 20_000;
const INLINE = /`([^`\n]+)`|\*\*(.+?)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: 'code', v: m[1] });
    else if (m[2] !== undefined) out.push({ t: 'strong', c: parseInline(m[2]) });
    else if (/^https?:\/\//i.test(m[4])) out.push({ t: 'link', href: m[4], c: parseInline(m[3]) });
    else out.push({ t: 'text', v: m[3] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

const ITEM = /^\s{0,3}([-*+]|\d{1,3}[.)])\s+(.*)$/;

export function parseChangelog(markdown: string): Block[] {
  const lines = markdown.slice(0, MAX_LENGTH).replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (para.length) blocks.push({ t: 'para', c: parseInline(para.join(' ')) });
    if (list) blocks.push({ t: 'list', ordered: list.ordered, items: list.items.map(parseInline) });
    para = [];
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      const fence = line.trim().slice(0, 3);
      const code: string[] = [];
      while (++i < lines.length && !lines[i].trim().startsWith(fence)) code.push(lines[i]);
      blocks.push({ t: 'code', v: code.join('\n') });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    if (heading) { flush(); blocks.push({ t: 'heading', c: parseInline(heading[1]) }); continue; }
    const item = line.match(ITEM);
    if (item) {
      const ordered = /\d/.test(item[1]);
      if (para.length || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, items: [] };
      list.items.push(item[2]);
      continue;
    }
    // An indented line goes on with the list item above it.
    if (list && /^\s+\S/.test(line)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
    if (list) flush();
    para.push(line.trim());
  }
  flush();
  return blocks;
}
