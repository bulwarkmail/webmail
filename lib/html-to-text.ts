import { parseHtmlSafely } from '@/lib/email-sanitization';

// Block-level tags whose boundaries become line breaks in the plain-text
// rendering. Without this, the DOM's textContent would run every block
// together on a single line (#421).
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'div',
  'dd',
  'dl',
  'dt',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'li',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tr',
  'ul',
]);

// Paragraph-level blocks that, with `paragraphSpacing` enabled, are separated by
// a blank line rather than a single newline - matching how they render visually.
const PARAGRAPH_TAGS = new Set([
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ol',
  'p',
  'pre',
  'table',
  'ul',
]);

export interface HtmlToPlainTextOptions {
  /**
   * Separate paragraph-level blocks (<p>, headings, lists, ...) with a blank
   * line instead of a single newline. Use for email bodies where paragraphs
   * are visually spaced; leave off for compact output like signatures.
   */
  paragraphSpacing?: boolean;
  /**
   * Mark quoted text (<blockquote>, the composer's quoted original) with "> "
   * and list items with "- " or "1. ", as plain-text mail does. Without them
   * the text part of a reply could not tell the reply from the quote.
   */
  mailMarkup?: boolean;
}

function normalizeLineBreaks(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(new RegExp(String.fromCharCode(160), 'g'), ' ')
    // Trims trailing spaces, but keeps the one that makes "-- " the RFC 3676
    // signature delimiter, so the text part still marks the signature.
    .split('\n')
    .map((line) => (/^--[ \t]*$/.test(line) ? '-- ' : line.replace(/[ \t]+$/, '')))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Converts HTML into readable plain text, preserving line structure from block
 * elements and <br> tags. Links render as `text <href>` unless the text already
 * is the href. Used to derive the text/plain alternative of an HTML email.
 */
export function htmlToPlainText(html: string, options: HtmlToPlainTextOptions = {}): string {
  return nodesToPlainText(parseHtmlSafely(html).body.childNodes, options);
}

function nodesToPlainText(nodes: NodeListOf<ChildNode>, options: HtmlToPlainTextOptions): string {
  const { paragraphSpacing = false, mailMarkup = false } = options;
  const chunks: string[] = [];

  const appendText = (value: string) => {
    if (!value) return;
    const normalized = value.replace(/\s+/g, ' ');
    if (!normalized.trim()) return;
    const previous = chunks[chunks.length - 1];
    if (previous && !previous.endsWith('\n') && !previous.endsWith(' ') && !normalized.startsWith(' ')) {
      chunks.push(' ');
    }
    chunks.push(normalized);
  };

  // Number of newline characters already trailing the accumulated output.
  const trailingNewlines = (): number => {
    let count = 0;
    for (let i = chunks.length - 1; i >= 0; i--) {
      const chunk = chunks[i];
      let j = chunk.length - 1;
      let inner = 0;
      while (j >= 0 && chunk[j] === '\n') {
        inner++;
        j--;
      }
      count += inner;
      if (j >= 0) break; // chunk had non-newline content, stop counting
    }
    return count;
  };

  // Ensures at least `min` trailing newlines, without emitting leading ones.
  const ensureNewlines = (min: number) => {
    if (chunks.length === 0) return;
    for (let current = trailingNewlines(); current < min; current++) {
      chunks.push('\n');
    }
  };

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node.textContent || '');
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const element = node as HTMLElement;
    const tagName = element.tagName.toLowerCase();

    if (tagName === 'br') {
      // Additive so consecutive <br> can form a blank line (capped by normalize).
      if (chunks.length > 0) chunks.push('\n');
      return;
    }

    if (tagName === 'a') {
      const text = element.textContent?.replace(/\s+/g, ' ').trim() || '';
      const href = element.getAttribute('href')?.trim() || '';
      const normalizedHref = href.replace(/^mailto:/i, '');
      if (text && normalizedHref && text === normalizedHref) {
        appendText(text);
        return;
      }
      // An @mention reads as just "@Name"; the address is in the To or Cc.
      if (/^mailto:/i.test(href) && text.startsWith('@') && element.children.length === 0) {
        appendText(text);
        return;
      }
      if (text && href && text !== href) {
        appendText(`${text} <${href}>`);
        return;
      }
    }

    const separator = paragraphSpacing && PARAGRAPH_TAGS.has(tagName) ? 2 : 1;
    const isBlock = BLOCK_TAGS.has(tagName);

    if (mailMarkup && (tagName === 'blockquote' || element.hasAttribute('data-quoted-html'))) {
      // The quote's own nodes: parsing its innerHTML again made each level
      // re-read everything inside it, quadratic in a deeply nested reply.
      const quoted = nodesToPlainText(element.childNodes, options);
      if (quoted) {
        ensureNewlines(separator);
        chunks.push(quoted.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n'));
        ensureNewlines(separator);
      }
      return;
    }

    if (mailMarkup && tagName === 'li') {
      const list = element.parentElement;
      let marker = '- ';
      if (list?.tagName.toLowerCase() === 'ol') {
        const start = Number(list.getAttribute('start') ?? 1) || 1;
        const position = Array.from(list.children).filter((child) => child.tagName.toLowerCase() === 'li').indexOf(element);
        marker = `${start + position}. `;
      }
      ensureNewlines(1);
      chunks.push(marker);
      Array.from(element.childNodes).forEach(walk);
      ensureNewlines(1);
      return;
    }

    if (isBlock) {
      ensureNewlines(separator);
    }

    Array.from(element.childNodes).forEach(walk);

    if (isBlock) {
      ensureNewlines(separator);
    }
  };

  Array.from(nodes).forEach(walk);
  return normalizeLineBreaks(chunks.join(''));
}
