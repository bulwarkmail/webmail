/**
 * Quote collapsing for the email viewer (issue #480).
 *
 * When a reply carries the original message as a trailing quote, hide it by
 * default and inject a Gmail-style "•••" pill that toggles it. Runs against
 * the live iframe DOM from the parent frame AFTER sanitization, so the
 * injected button and its click listener are not subject to the sanitizer or
 * the iframe's script-blocking CSP (parent-attached DOM listeners still fire).
 *
 * Two kinds of markers:
 *  - container: an element that wraps the entire quoted original. Hiding the
 *    element hides the quote.
 *  - separator: a header/divider element ("From: …" block, attribution line)
 *    that the quoted original FOLLOWS as siblings. Everything from the marker
 *    to the end of the body is hidden.
 */

// Order matters only for readability - document order decides which marker
// wins when several are present (querySelector on the comma-joined list).
const CONTAINER_SELECTORS = [
  // Bulwark's own reply/forward island (see components/email/quoted-html.ts).
  // The attribute survives sanitization via an explicit ADD_ATTR entry.
  'div[data-quoted-html]',
  // Gmail: gmail_quote_container (2023+) wraps gmail_attr + gmail_quote.
  'div.gmail_quote_container',
  'div.gmail_quote',
  // Apple Mail / Thunderbird quoted body.
  'blockquote[type="cite"]',
  'div.yahoo_quoted',
  'blockquote.protonmail_quote',
  'div.protonmail_quote',
];

const SEPARATOR_SELECTORS = [
  // Outlook (desktop + OWA): "From:/Sent:/To:/Subject:" header block; the
  // quoted message body follows as siblings.
  '#divRplyFwdMsg',
  '#appendonsend',
  // Thunderbird attribution line ("On …, X wrote:"); the blockquote follows.
  'div.moz-cite-prefix',
];

const ALL_SELECTORS = [...CONTAINER_SELECTORS, ...SEPARATOR_SELECTORS].join(',');

/** Marks the injected toggle button (also the idempotence guard). */
export const QUOTE_TOGGLE_ATTR = 'data-quote-toggle';
/** Marks elements hidden by the collapse; value stores the original inline display. */
export const QUOTE_COLLAPSED_ATTR = 'data-quote-collapsed';

export interface QuoteCollapseLabels {
  /** Accessible label/tooltip while collapsed, e.g. "Show quoted text". */
  show: string;
  /** Accessible label/tooltip while expanded, e.g. "Hide quoted text". */
  hide: string;
}

/** True when any text node outside `marker` on the given side of it has visible content. */
function hasVisibleContent(body: HTMLElement, marker: Element, side: 'before' | 'after'): boolean {
  const positionBit = side === 'before'
    ? Node.DOCUMENT_POSITION_PRECEDING
    : Node.DOCUMENT_POSITION_FOLLOWING;
  const doc = body.ownerDocument;
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const rel = marker.compareDocumentPosition(node);
    // Skip the marker's own subtree and anything not on the requested side.
    if (rel & Node.DOCUMENT_POSITION_CONTAINED_BY) continue;
    if (!(rel & positionBit)) continue;
    if (node.nodeType === Node.TEXT_NODE) {
      if ((node.nodeValue || '').trim() !== '') return true;
    } else if ((node as Element).tagName === 'IMG') {
      // An image counts as content (image-only replies exist), but not the
      // 1x1 placeholders left by blocked external images.
      const img = node as HTMLImageElement;
      if (!img.hasAttribute('data-blocked-src') && (img.style.display !== 'none')) return true;
    }
  }
  return false;
}

/**
 * Fallback for replies whose quote is a bare <blockquote> (no type/class -
 * e.g. Bulwark's own reply to a plain-text original, and various mobile
 * clients): an outermost blockquote directly preceded by an attribution line.
 * Attribution is sniffed language-agnostically as the nearest preceding text
 * ending with a colon ("On …, X wrote:", "Am … schrieb X:", "… a écrit :").
 */
function findAttributedBlockquote(body: HTMLElement): Element | null {
  // One walk in document order, remembering the last non-blank text: a
  // blockquote is reached before its own text, so that is the text preceding
  // it. Walking from the start again per blockquote cost quadratic time.
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let last: string | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.nodeValue || '').trim();
      if (text !== '') last = text;
      continue;
    }
    const el = node as Element;
    if (el.tagName !== 'BLOCKQUOTE' || el.parentElement?.closest('blockquote')) continue; // outermost only
    if (last !== null && last.endsWith(':')) return el;
  }
  return null;
}

/** Hide an element, remembering its original inline display for restore. */
function hideElement(el: HTMLElement): void {
  el.setAttribute(QUOTE_COLLAPSED_ATTR, el.style.display || '');
  el.style.display = 'none';
}

/**
 * The elements to hide for a separator marker: the marker itself plus
 * everything after it in document order (climbing to body handles markers
 * nested inside wrapper divs).
 */
function collectSeparatorRange(body: HTMLElement, marker: Element): HTMLElement[] {
  const range: HTMLElement[] = [marker as HTMLElement];
  let el: Element | null = marker;
  while (el && el !== body) {
    for (let sib = el.nextElementSibling; sib; sib = sib.nextElementSibling) {
      range.push(sib as HTMLElement);
    }
    el = el.parentElement;
  }
  return range;
}

/**
 * Detect a trailing quoted original in `doc` and collapse it behind a "•••"
 * toggle button. No-op (returns false) when no marker is found, when the
 * quote IS the whole message (nothing visible before it - collapsing would
 * render the mail as a lone button), or - for container markers - when
 * visible content follows the quote (interleaved/bottom-posted reply, where
 * hiding "the rest" would swallow real content).
 *
 * Idempotent per document. Returns true when a quote was collapsed.
 */
export function setupQuoteCollapse(doc: Document, labels: QuoteCollapseLabels): boolean {
  const body = doc.body;
  if (!body || body.querySelector(`[${QUOTE_TOGGLE_ATTR}]`)) return false;

  const marker = body.querySelector(ALL_SELECTORS) ?? findAttributedBlockquote(body);
  if (!marker) return false;

  const isSeparator = SEPARATOR_SELECTORS.some((sel) => marker.matches(sel));

  // Never collapse the entire message down to just the toggle.
  if (!hasVisibleContent(body, marker, 'before')) return false;
  // Interleaved reply: real content after the quote container - leave as is.
  if (!isSeparator && hasVisibleContent(body, marker, 'after')) return false;

  const hidden = isSeparator
    ? collectSeparatorRange(body, marker)
    : [marker as HTMLElement];

  const button = doc.createElement('button');
  button.type = 'button';
  button.setAttribute(QUOTE_TOGGLE_ATTR, '');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', labels.show);
  button.title = labels.show;
  button.textContent = '•••';
  // Inline styles only: the iframe has no app CSS, and style-src allows
  // inline. Neutral grays read fine after the dark-mode invert filter too.
  button.style.cssText =
    'display:inline-block;margin:12px 0 4px;padding:3px 12px;border:none;' +
    'border-radius:999px;background:#e3e6ea;color:#3c4043;font-size:11px;' +
    'line-height:1;letter-spacing:2px;cursor:pointer;font-family:inherit;';
  button.addEventListener('mouseenter', () => { button.style.background = '#d4d8dd'; });
  button.addEventListener('mouseleave', () => { button.style.background = '#e3e6ea'; });

  marker.parentNode?.insertBefore(button, marker);
  hidden.forEach(hideElement);

  button.addEventListener('click', () => {
    const expanded = button.getAttribute('aria-expanded') === 'true';
    hidden.forEach((el) => {
      if (expanded) {
        hideElement(el);
      } else {
        el.style.display = el.getAttribute(QUOTE_COLLAPSED_ATTR) || '';
        el.removeAttribute(QUOTE_COLLAPSED_ATTR);
      }
    });
    button.setAttribute('aria-expanded', String(!expanded));
    const label = expanded ? labels.show : labels.hide;
    button.setAttribute('aria-label', label);
    button.title = label;
  });

  return true;
}

const escapeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/**
 * Collapse the trailing ">"-quoted block of a plain-text email.
 *
 * Operates on the ESCAPED html produced by plainTextToSafeHtml (lines are
 * plain text with entities plus <a> tags, still newline-separated), because
 * the plain-text branch renders into the main DOM via dangerouslySetInnerHTML
 * - there is no post-render hook to attach a JS toggle to. Instead the quote
 * run is wrapped in native <details>/<summary>, which toggles without any
 * script and survives sanitizePlainTextRenderedHtml (details/summary are
 * whitelisted there for exactly this markup).
 *
 * Collapsed: the last run of "&gt;"-prefixed lines (interior blank lines
 * included). Left visible: everything before it (reply + attribution line),
 * and a trailing "-- " signature block after it. No-op when real content
 * follows the run (bottom-posted/interleaved reply), when there is no content
 * before it, or when there are no quote lines at all.
 */
export function collapsePlainTextQuotes(safeHtml: string, labels: QuoteCollapseLabels): string {
  const lines = safeHtml.split('\n');
  const isQuote = (l: string) => /^\s*&gt;/.test(l);

  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isQuote(lines[i])) { end = i; break; }
  }
  if (end === -1) return safeHtml;

  // Everything after the run must be blank or a "-- " signature block.
  let inSignature = false;
  for (let i = end + 1; i < lines.length; i++) {
    if (inSignature || lines[i].trim() === '') continue;
    if (/^--\s*$/.test(lines[i].trim())) { inSignature = true; continue; }
    return safeHtml;
  }

  // Walk back to the start of the run; blank lines BETWEEN quote lines are
  // part of it (start only ever lands on a quote line).
  let start = end;
  for (let i = end - 1; i >= 0; i--) {
    if (isQuote(lines[i])) start = i;
    else if (lines[i].trim() !== '') break;
  }

  // Never collapse the entire message down to just the toggle.
  if (!lines.slice(0, start).some((l) => l.trim() !== '')) return safeHtml;

  const before = lines.slice(0, start).join('\n');
  const quoted = lines.slice(start, end + 1).join('\n');
  const after = lines.slice(end + 1).join('\n');
  // Same pill look as the HTML-path toggle button; list-style:none hides the
  // native disclosure triangle.
  const summary =
    `<summary title="${escapeAttr(labels.show)}" style="display:inline-block;` +
    'list-style:none;margin:4px 0;padding:3px 12px;border-radius:999px;' +
    'background:#e3e6ea;color:#3c4043;font-size:11px;line-height:1;' +
    `letter-spacing:2px;cursor:pointer;">•••</summary>`;
  return `${before}\n<details>${summary}${quoted}</details>${after ? '\n' + after : ''}`;
}
