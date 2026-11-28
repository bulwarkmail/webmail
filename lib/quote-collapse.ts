/**
 * Quote collapsing for the email viewer (issue #480).
 *
 * When a reply carries the original message as a trailing quote, hide it by
 * default and inject a Gmail-style "•••" pill that toggles it. An explicit
 * quote container followed by other content starts expanded, with a manual
 * toggle, so interleaved replies stay visible on open. Runs against
 * the live iframe DOM from the parent frame AFTER sanitization, so the
 * injected toggle is not subject to the sanitizer.
 *
 * The toggle works without any script: a checkbox inside a <label> holds the
 * state and an injected stylesheet hides the quote while it is unchecked.
 * WebKit does not run parent-attached listeners on nodes of a frame that is
 * sandboxed without allow-scripts, so a click handler never fired in Safari.
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
  // Outlook for Windows: the same header block without the id, marked only by
  // its top rule (#1476). Older versions draw it in #B5C4DF.
  'div[style*="border-top:solid #E1E1E1" i]',
  'div[style*="border-top: solid #E1E1E1" i]',
  'div[style*="border-top:solid #B5C4DF" i]',
  'div[style*="border-top: solid #B5C4DF" i]',
  // Outlook for iOS and Android.
  '#mail-editor-reference-message-container',
  // Thunderbird attribution line ("On …, X wrote:"); the blockquote follows.
  'div.moz-cite-prefix',
];

const ALL_SELECTORS = [...CONTAINER_SELECTORS, ...SEPARATOR_SELECTORS].join(',');

/** Marks the injected toggle label (also the idempotence guard). */
export const QUOTE_TOGGLE_ATTR = 'data-quote-toggle';
/** Marks the elements the toggle folds; hidden while its checkbox is unchecked. */
export const QUOTE_COLLAPSED_ATTR = 'data-quote-collapsed';
/** Marks the toggle's two labels; value is the state it names ("show" or "hide"). */
export const QUOTE_LABEL_ATTR = 'data-quote-label';

/**
 * Hides the folded elements while the toggle's checkbox is unchecked, and
 * shows the label that matches its state. !important beats the mail's own inline display, which stays untouched and
 * comes back as it was on expand. Without :has() support the quote just stays
 * visible.
 */
const QUOTE_COLLAPSE_CSS =
  `html:has([${QUOTE_TOGGLE_ATTR}] > input:not(:checked)) [${QUOTE_COLLAPSED_ATTR}]{display:none !important}` +
  `[${QUOTE_TOGGLE_ATTR}]>input:checked~[${QUOTE_LABEL_ATTR}="show"],` +
  `[${QUOTE_TOGGLE_ATTR}]>input:not(:checked)~[${QUOTE_LABEL_ATTR}="hide"]{display:none !important}` +
  `[${QUOTE_TOGGLE_ATTR}]:hover{background:#d4d8dd !important}` +
  `[${QUOTE_TOGGLE_ATTR}]:has(> input:focus-visible){outline:2px solid #1a73e8;outline-offset:2px}`;

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
      // The reader appends its own stylesheet to body; CSS is not mail text.
      if (node.parentElement?.tagName === 'STYLE') continue;
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
 * True when every visible piece of content after `marker` sits inside a quote
 * container. iPhone Mail puts its attribution line in a cite blockquote of its
 * own and the original in a second one, so the first quote is followed by
 * more quote, not by a reply below it (#1476).
 */
function onlyQuotesAfter(body: HTMLElement, marker: Element): boolean {
  const containers = CONTAINER_SELECTORS.join(',');
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const rel = marker.compareDocumentPosition(node);
    if (rel & Node.DOCUMENT_POSITION_CONTAINED_BY) continue;
    if (!(rel & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    if (node.nodeType === Node.TEXT_NODE && node.parentElement?.tagName === 'STYLE') continue;
    const visible = node.nodeType === Node.TEXT_NODE
      ? (node.nodeValue || '').trim() !== ''
      : (node as Element).tagName === 'IMG' && !(node as Element).hasAttribute('data-blocked-src');
    if (!visible) continue;
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element;
    if (!el?.closest(containers)) return false;
  }
  return true;
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
 * Detect a quoted original in `doc` and add a "•••" toggle button. Trailing
 * quotes collapse by default; explicit containers followed by other content
 * start expanded and only fold on the user's click. No-op when no marker is
 * found, when the quote IS the whole message, or when a bare-blockquote
 * fallback has content after it and its boundary is less certain.
 *
 * `onToggle` runs after each user toggle so the reader can resize its frame,
 * even when the document's scroll height is still pinned to the old viewport.
 * It does not run in Safari (see above), so the reader must not rely on it.
 * Idempotent per document. Returns true when a quote toggle was initialized.
 */
export function setupQuoteCollapse(doc: Document, labels: QuoteCollapseLabels, onToggle?: () => void): boolean {
  const body = doc.body;
  if (!body || body.querySelector(`[${QUOTE_TOGGLE_ATTR}]`)) return false;

  const marker = body.querySelector(ALL_SELECTORS) ?? findAttributedBlockquote(body);
  if (!marker) return false;

  let isSeparator = SEPARATOR_SELECTORS.some((sel) => marker.matches(sel));
  let initiallyExpanded = false;

  // Never collapse the entire message down to just the toggle.
  if (!hasVisibleContent(body, marker, 'before')) return false;
  if (!isSeparator && hasVisibleContent(body, marker, 'after')) {
    if (onlyQuotesAfter(body, marker)) {
      // More quote follows: fold the whole run from here to the end.
      isSeparator = true;
    } else if (CONTAINER_SELECTORS.some((sel) => marker.matches(sel))) {
      // A reply or signature follows an explicit container. Keep everything
      // visible on open, but let the user fold just that container.
      initiallyExpanded = true;
    } else {
      return false;
    }
  }

  const hidden = isSeparator
    ? collectSeparatorRange(body, marker)
    : [marker as HTMLElement];

  const toggle = doc.createElement('label');
  toggle.setAttribute(QUOTE_TOGGLE_ATTR, '');
  const checkbox = doc.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = initiallyExpanded;
  // Visually hidden but still focusable, so the pill works from the keyboard.
  checkbox.style.cssText =
    'position:absolute;width:1px;height:1px;margin:0;padding:0;opacity:0;pointer-events:none;';
  // Both labels are in the markup and the stylesheet shows the one matching
  // the checkbox, so the tooltip and the checkbox's accessible name follow the
  // state without a listener.
  const stateLabel = (state: 'show' | 'hide') => {
    const span = doc.createElement('span');
    span.setAttribute(QUOTE_LABEL_ATTR, state);
    span.title = labels[state];
    span.style.cssText = 'display:inline-block;padding:3px 12px;';
    const dots = doc.createElement('span');
    dots.setAttribute('aria-hidden', 'true');
    dots.textContent = '•••';
    const text = doc.createElement('span');
    text.textContent = labels[state];
    text.style.cssText =
      'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;';
    span.append(dots, text);
    return span;
  };
  toggle.append(checkbox, stateLabel('show'), stateLabel('hide'));
  // Inline styles only: the iframe has no app CSS, and style-src allows
  // inline. Neutral grays read fine after the dark-mode invert filter too.
  toggle.style.cssText =
    'position:relative;display:inline-block;margin:12px 0 4px;padding:0;border:none;' +
    'border-radius:999px;background:#e3e6ea;color:#3c4043;font-size:11px;' +
    'line-height:1;letter-spacing:2px;cursor:pointer;font-family:inherit;user-select:none;';

  const style = doc.createElement('style');
  style.textContent = QUOTE_COLLAPSE_CSS;
  (doc.head ?? body).appendChild(style);

  marker.parentNode?.insertBefore(toggle, marker);
  hidden.forEach((el) => el.setAttribute(QUOTE_COLLAPSED_ATTR, ''));

  // Only where the frame runs parent listeners (not in Safari): lets the
  // reader resize right away. The fold and the labels never depend on this.
  checkbox.addEventListener('change', () => onToggle?.());

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
