// Finds text the sender meant to replace before sending: template
// placeholders, bracketed fill-ins that AI drafts and copied templates leave
// behind, and markers like TODO.

// Template syntax, as in template-utils. Spaces inside the braces are allowed
// because templates pasted from other tools often have them.
const TEMPLATE_PLACEHOLDER = /\{\{\s*[\w.-]+\s*(?::[^{}<>\n]*)?\}\}/g;

// [TIME], [PRICE], [YOUR NAME]. Not followed by "(", which would make it a
// Markdown link.
const CAPS_BRACKET = /\[[\p{Lu}\d][\p{Lu}\d _./-]{0,28}[\p{Lu}\d]\](?!\()/gu;

// [Name], [Company], [First Name]: one to three capitalised words, the way
// templates name a fill-in. A lowercase word ([Yours truly]) or a number
// ([Anlage 2]) makes it ordinary text.
const TITLE_BRACKET = /\[\p{Lu}[\p{Ll}'’-]+(?: \p{Lu}[\p{Ll}'’-]+){0,2}\](?!\()/gu;

/**
 * The words that mark a fill-in in one language. They live in each locale
 * file under email_composer.placeholder_words, so a new translation brings
 * its own.
 *
 * - `before` opens a fill-in: "your" in [Your name], "insert" in [Insert date].
 * - `after` closes one, for languages that put the verb or "your" last:
 *   "einfügen" in [Datum einfügen].
 * - A "-" on the joining side means the word is written onto the next one
 *   without a space: "您的-" for [您的姓名], "-ınız" for [Adınız].
 * - `unfinished` are words in capitals that mark unfinished text, like TODO.
 *   They match as written, so "todo" in a sentence does not count.
 */
export interface PlaceholderWords {
  before?: unknown;
  after?: unknown;
  unfinished?: unknown;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alternation = (words: string[]) => words.map(escapeRegExp).join('|');

// The lists come from locale files that contributors edit, so anything that
// is not a list of strings is skipped.
function wordsOf(lists: PlaceholderWords[], key: keyof PlaceholderWords): string[] {
  const words = new Set<string>();
  for (const list of lists) {
    const value = list?.[key];
    if (!Array.isArray(value)) continue;
    for (const word of value) {
      if (typeof word === 'string' && word.replace(/-/g, '').trim()) words.add(word.trim());
    }
  }
  return Array.from(words);
}

// Plain brackets, and the full-width and lenticular ones of CJK text.
const OPEN = '[\\[［【]';
const CLOSE = '[\\]］】]';
const INNER = '[^\\[\\]［］【】\\n]';

function promptBracketPattern(lists: PlaceholderWords[]): RegExp | null {
  const before = wordsOf(lists, 'before');
  const after = wordsOf(lists, 'after');
  const branches: string[] = [];
  const add = (words: string[], branch: (alt: string) => string) => {
    if (words.length > 0) branches.push(branch(alternation(words)));
  };
  add(before.filter((w) => !w.endsWith('-')), (alt) => `(?:${alt})\\s${INNER}{1,40}`);
  add(before.filter((w) => w.endsWith('-')).map((w) => w.slice(0, -1)), (alt) => `(?:${alt})${INNER}{1,40}`);
  add(after.filter((w) => !w.startsWith('-')), (alt) => `${INNER}{1,40}\\s(?:${alt})`);
  add(after.filter((w) => w.startsWith('-')).map((w) => w.slice(1)), (alt) => `${INNER}{1,40}(?:${alt})`);
  if (branches.length === 0) return null;
  return new RegExp(`${OPEN}(?:${branches.join('|')})${CLOSE}(?!\\()`, 'giu');
}

function unfinishedWordPattern(lists: PlaceholderWords[]): RegExp | null {
  const words = wordsOf(lists, 'unfinished');
  if (words.length === 0) return null;
  return new RegExp(`(?<![\\p{L}\\d_])(?:${alternation(words)})(?![\\p{L}\\d_])`, 'gu');
}

// Japanese and Korean stand-ins for a name or number: 〇〇様, ○○○ 님. Signs
// rather than words, so they are not in the locale files.
const CIRCLE_MARKER = /[〇○◯]{2,}/gu;

const SIGNATURE_START_SELECTOR = '[data-signature-block="separator"], [data-signature-block="start"]';
const SIGNATURE_END_SELECTOR = '[data-signature-block="end"]';

interface Match {
  start: number;
  end: number;
  text: string;
}

function collect(text: string, patterns: RegExp[]): Match[] {
  const matches: Match[] = [];
  for (const pattern of patterns) {
    for (const m of text.matchAll(pattern)) {
      if (pattern === CAPS_BRACKET && (m[0].match(/\p{Lu}/gu)?.length ?? 0) < 2) continue;
      matches.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    }
  }
  // "[TODO]" is a bracket and a word; keep the outer match only.
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Match[] = [];
  for (const match of matches) {
    const last = kept[kept.length - 1];
    if (last && match.start < last.end) continue;
    kept.push(match);
  }
  return kept;
}

/**
 * The unfilled placeholders in a message, each once, subject first. The
 * subject is only checked for template placeholders: it often carries tags
 * like [EXTERNAL] or words from the original message, which the sender did
 * not write. `bodyText` should be the text the sender wrote, without quoted
 * replies and the signature. `words` are the fill-in words of the languages
 * to check (see PlaceholderWords).
 */
export function findUnfilledPlaceholders(subject: string, bodyText: string, words: PlaceholderWords[] = []): string[] {
  const bodyPatterns = [TEMPLATE_PLACEHOLDER, CAPS_BRACKET, TITLE_BRACKET, CIRCLE_MARKER];
  const prompt = promptBracketPattern(words);
  const unfinished = unfinishedWordPattern(words);
  if (prompt) bodyPatterns.push(prompt);
  if (unfinished) bodyPatterns.push(unfinished);
  const found = [
    ...collect(subject, [TEMPLATE_PLACEHOLDER]),
    ...collect(bodyText, bodyPatterns),
  ].map((m) => m.text);
  return Array.from(new Set(found));
}

/**
 * A compose body without its embedded signature. A signature is the same in
 * every message, so a placeholder in it would stop every send.
 */
export function stripEmbeddedSignatureHtml(html: string): string {
  if (!html.includes('data-signature-block')) return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const startEl = doc.querySelector(SIGNATURE_START_SELECTOR);
  if (startEl) {
    const endEl = doc.querySelector(SIGNATURE_END_SELECTOR);
    let cursor: Node | null = startEl;
    while (cursor) {
      const next: Node | null = cursor.nextSibling;
      const isEnd = cursor === endEl;
      cursor.parentNode?.removeChild(cursor);
      if (isEnd) break;
      cursor = next;
    }
  }
  doc.querySelectorAll('[data-signature-block-node]').forEach((el) => el.remove());
  return doc.body.innerHTML;
}
