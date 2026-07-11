import DOMPurify from 'dompurify';

/**
 * Unified DOMPurify configuration for email content
 * Blocks all script execution vectors while preserving formatting
 * NOTE: <style> tags are forbidden to prevent global CSS injection
 * Inline style attributes are still allowed for element-specific styling
 */
export const EMAIL_SANITIZE_CONFIG = {
  ADD_TAGS: [],
  ADD_ATTR: ['target', 'rel', 'style', 'class', 'width', 'height', 'align', 'valign', 'bgcolor', 'color'],
  ALLOW_DATA_ATTR: false,
  FORCE_BODY: true,
  // Allow blob: URIs so authenticated inline images (CID) are not stripped.
  // data: is restricted to a fixed set of raster image types. SVG (image/svg+xml)
  // is excluded because DOMPurify cannot inspect bytes inside a data: URI, so an
  // SVG payload can carry <script>/<foreignObject> that the surrounding sanitizer
  // never sees. The `(?=[;,])` anchor prevents prefix matches like image/png-evil.
  // eslint-disable-next-line no-useless-escape
  ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|blob):|data:image\/(?:png|jpe?g|gif|webp|bmp|avif|x-icon|vnd\.microsoft\.icon)(?=[;,])|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  FORBID_TAGS: [
    'script', 'iframe', 'object', 'embed', 'form',
    'input', 'button', 'meta', 'link', 'base',
    'svg', 'math', 'style'
  ],
  FORBID_ATTR: [
    'onerror', 'onload', 'onclick', 'onmouseover',
    'onfocus', 'onblur', 'onchange', 'onsubmit',
    'onkeydown', 'onkeyup', 'onmousedown', 'onmouseup'
  ],
};

/**
 * Sanitize email HTML content
 * @param html - Raw HTML content from email
 * @returns Sanitized HTML safe for rendering
 */
export function sanitizeEmailHtml(html: string): string {
  return DOMPurify.sanitize(html, EMAIL_SANITIZE_CONFIG);
}

/**
 * Sanitize config for emails rendered inside a sandboxed iframe.
 * Allows <style> tags because CSS is scoped to the iframe document and
 * cannot leak into the host app. Scripts are still blocked by the sandbox
 * attribute (no allow-scripts). Use ONLY for iframe-rendered content –
 * never for content rendered into the main DOM.
 */
export const EMAIL_IFRAME_SANITIZE_CONFIG = {
  ...EMAIL_SANITIZE_CONFIG,
  FORBID_TAGS: EMAIL_SANITIZE_CONFIG.FORBID_TAGS.filter((t) => t !== 'style'),
};

/**
 * Sanitize email HTML for rendering inside a sandboxed iframe.
 * Preserves <style> tags so the email's own CSS is applied.
 */
export function sanitizeEmailHtmlForIframe(html: string): string {
  return DOMPurify.sanitize(html, EMAIL_IFRAME_SANITIZE_CONFIG);
}

/**
 * Sanitize HTML signature with stricter rules
 * Allows basic formatting plus <img> for company logos, plus table-based
 * layouts (the de-facto standard for email signatures).
 */
export const SIGNATURE_SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'b', 'strong', 'i', 'em', 'u', 'a', 'span', 'div', 'img',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  ],
  ALLOWED_ATTR: [
    'href', 'style', 'class', 'src', 'alt', 'width', 'height', 'title',
    'cellpadding', 'cellspacing', 'border', 'valign', 'align', 'bgcolor',
    'colspan', 'rowspan',
  ],
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'video', 'audio'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
};

/** Drop images whose src isn't https: or a base64 raster data: URI. */
function restrictSignatureImages(node: Element): void {
  if (node.tagName !== 'IMG') return;
  const src = node.getAttribute('src');
  if (!src || !/^(?:https:\/\/|data:image\/(?:png|jpe?g|gif|webp);base64,)/i.test(src)) {
    node.remove();
  }
}

/**
 * Sanitize an HTML signature for storage and for the outgoing message.
 * img src is restricted to https: or base64-embedded raster data: URIs
 * (png/jpeg/gif/webp). SVG is excluded because DOMPurify cannot inspect
 * bytes inside a data: URI. Images with a disallowed src are removed
 * entirely so they don't render as broken-image icons.
 *
 * Deliberately does NOT force target="_blank": what we store, and what the
 * recipient receives, should stay as the user wrote it. Use
 * `sanitizeSignatureHtmlForDisplay` for anything rendered in our own DOM.
 * @param html - User-provided HTML signature
 * @returns Sanitized signature (no scripts, no external resources)
 */
export function sanitizeSignatureHtml(html: string): string {
  if (!html?.trim()) return '';
  DOMPurify.addHook('afterSanitizeAttributes', restrictSignatureImages);
  try {
    return DOMPurify.sanitize(html, SIGNATURE_SANITIZE_CONFIG);
  } finally {
    DOMPurify.removeAllHooks();
  }
}

const SIGNATURE_DISPLAY_CONFIG = {
  ...SIGNATURE_SANITIZE_CONFIG,
  ALLOWED_ATTR: [...SIGNATURE_SANITIZE_CONFIG.ALLOWED_ATTR, 'target', 'rel'],
};

/**
 * Sanitize an HTML signature for rendering inside our own DOM — the identity
 * form's live preview and the composer's signature block. Both inject into the
 * main document rather than the sandboxed iframe used for message bodies, so a
 * link without target="_blank" navigates the whole app away, taking any unsent
 * draft or unsaved signature with it. Force every anchor to open a new tab.
 */
export function sanitizeSignatureHtmlForDisplay(html: string): string {
  if (!html?.trim()) return '';
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    restrictSignatureImages(node);
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
  try {
    return DOMPurify.sanitize(html, SIGNATURE_DISPLAY_CONFIG);
  } finally {
    DOMPurify.removeAllHooks();
  }
}

/**
 * Sanitizer for translation strings that contain inline markup (e.g. a
 * documentation link). The translation catalog is trusted today, but using
 * dangerouslySetInnerHTML on a translation makes that trust permanent and
 * implicit; this allowlist limits the blast radius if a translation ever
 * becomes attacker-influenced (community PR, crowdsourced service).
 */
const I18N_SANITIZE_CONFIG = {
  ALLOWED_TAGS: ['a', 'b', 'strong', 'i', 'em', 'u', 'span', 'br', 'code'],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
  ALLOW_DATA_ATTR: false,
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|\/|#)/i,
};

export function sanitizeI18nHtml(html: string): string {
  return DOMPurify.sanitize(html, I18N_SANITIZE_CONFIG);
}

/**
 * Sanitizer for the non-iframe branch of email rendering (plain-text bodies,
 * S/MIME plain-text, TNEF text, no-body fallbacks). The producer
 * (`plainTextToSafeHtml`) already escapes text and emits only safe <a> tags,
 * so this is defense-in-depth: it ensures the render site is safe even if a
 * future code path passes raw HTML in by mistake.
 */
const PLAIN_TEXT_RENDERED_CONFIG = {
  ALLOWED_TAGS: ['a', 'br', 'p', 'div', 'span'],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'style'],
  // DOMPurify URI-tests every attribute value not on its URI-safe list, so the
  // strict ALLOWED_URI_REGEXP below would strip target="_blank" (and rel) —
  // "_blank" is not a URI. This branch renders into the main document rather
  // than the sandboxed iframe, so losing target turns every link into a
  // whole-app navigation. Exempt the two from the URI check.
  ADD_URI_SAFE_ATTR: ['target', 'rel'],
  ALLOW_DATA_ATTR: false,
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|cid:|#)/i,
};

export function sanitizePlainTextRenderedHtml(html: string): string {
  return DOMPurify.sanitize(html, PLAIN_TEXT_RENDERED_CONFIG);
}

/**
 * 1x1 transparent SVG used to replace a blocked external <img> so the layout
 * doesn't reflow to a broken-image icon. The real URL is stashed in
 * `data-blocked-src` for restore.
 */
export const TRANSPARENT_BLOCKED_PIXEL =
  'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMSIgaGVpZ2h0PSIxIiB2aWV3Qm94PSIwIDAgMSAxIiBmaWxsPSJub25lIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPgo8cmVjdCB3aWR0aD0iMSIgaGVpZ2h0PSIxIiBmaWxsPSJ0cmFuc3BhcmVudCIvPgo8L3N2Zz4=';

/**
 * True if a resource URL would trigger an external (network) fetch once the
 * browser normalizes it. The URL parser removes ASCII tab/newline characters
 * anywhere in the string and trims leading/trailing C0-control + space before
 * resolving, so `"\n\nhttps://t"` and `"h\ttps://t"` are both external even
 * though they don't literally start with "https://" (the `imgNewlineSrc`
 * tracking bypass). Protocol-relative `//host` is external too. data:, blob:,
 * and cid: are inline/local and never count as external.
 */
export function isExternalResourceUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  // Mirror the URL parser: drop every ASCII C0-control and space char it
  // ignores (leading/trailing trim plus tab/newline/CR removed anywhere).
  // eslint-disable-next-line no-control-regex
  const normalized = value.replace(/[\u0000-\u0020]+/g, '');
  return /^(?:https?:\/\/|\/\/)/i.test(normalized);
}


/**
 * Decode CSS escape sequences so escaped tracking URLs can be recognised.
 * `\68ttp://x` and `\000068ttp://x` both decode to `http://x` (the `cssEscape`
 * bypass). Handles the two CSS escape forms: 1-6 hex digits (optionally
 * followed by one whitespace) and a backslash before any other character.
 */
export function decodeCssEscapes(value: string): string {
  return value.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_full, hex, char) => {
    if (hex) {
      const code = parseInt(hex, 16);
      return code ? String.fromCodePoint(code) : '';
    }
    return char ?? '';
  });
}

const CSS_URL_PATTERN = /url\(\s*(['"]?)([^)]*?)\1\s*\)/gi;

/** True if any `url(...)` in a CSS string resolves to an external resource. */
export function styleHasExternalUrl(style: string): boolean {
  let found = false;
  style.replace(CSS_URL_PATTERN, (full, _q, inner) => {
    if (isExternalResourceUrl(decodeCssEscapes(inner))) found = true;
    return full;
  });
  return found;
}

/** Replace every external `url(...)` in a CSS string with an empty `url()`. */
export function stripExternalCssUrls(style: string): string {
  return style.replace(CSS_URL_PATTERN, (full, _q, inner) =>
    isExternalResourceUrl(decodeCssEscapes(inner)) ? 'url()' : full
  );
}

/** True if a srcset attribute lists at least one external candidate URL. */
function srcsetHasExternalUrl(srcset: string): boolean {
  return srcset
    .split(',')
    .some((candidate) => isExternalResourceUrl(candidate.trim().split(/\s+/)[0]));
}

/**
 * Neutralise every external-resource vector on a single sanitized element,
 * stashing the original value in a `data-blocked-*` attribute for later
 * restore. Covers the vectors Email Privacy Tester exercises beyond a bare
 * `<img src>`: whitespace/newline in src, `<picture><source srcset>`,
 * `<video poster>`/media src, the legacy `background` attribute, and inline
 * `style` url() (including CSS-escaped URLs).
 *
 * This is the first line of defence (it drives the "external content blocked"
 * banner and placeholder swap); the iframe's strict img-src/media-src/font-src
 * CSP is the guaranteed network-level backstop for anything expressed in ways
 * the DOM walk can't see (e.g. `<style>`-tag rules).
 *
 * @returns true if anything on the node was blocked.
 */
export function blockExternalResourcesOnNode(node: Element): boolean {
  let blocked = false;
  const tag = node.tagName;

  if (tag === 'IMG') {
    const src = node.getAttribute('src');
    if (isExternalResourceUrl(src)) {
      node.setAttribute('data-blocked-src', src!.trim());
      node.setAttribute('src', TRANSPARENT_BLOCKED_PIXEL);
      node.setAttribute('alt', '');
      (node as HTMLElement).style.display = 'none';
      blocked = true;
    }
  }

  // Responsive images: <img srcset> and <picture><source srcset>.
  if (tag === 'IMG' || tag === 'SOURCE') {
    const srcset = node.getAttribute('srcset');
    if (srcset && srcsetHasExternalUrl(srcset)) {
      node.setAttribute('data-blocked-srcset', srcset);
      node.removeAttribute('srcset');
      blocked = true;
    }
  }

  // <source src> for <video>/<audio> (and rare <picture> src).
  if (tag === 'SOURCE') {
    const src = node.getAttribute('src');
    if (isExternalResourceUrl(src)) {
      node.setAttribute('data-blocked-src', src!.trim());
      node.removeAttribute('src');
      blocked = true;
    }
  }

  // <video poster> and direct <video>/<audio> src.
  if (tag === 'VIDEO' || tag === 'AUDIO') {
    const poster = node.getAttribute('poster');
    if (isExternalResourceUrl(poster)) {
      node.setAttribute('data-blocked-poster', poster!.trim());
      node.removeAttribute('poster');
      blocked = true;
    }
    const src = node.getAttribute('src');
    if (isExternalResourceUrl(src)) {
      node.setAttribute('data-blocked-src', src!.trim());
      node.removeAttribute('src');
      blocked = true;
    }
  }

  // Legacy table/cell background attribute.
  const bgAttr = node.getAttribute('background');
  if (isExternalResourceUrl(bgAttr)) {
    node.setAttribute('data-blocked-background', bgAttr!.trim());
    node.removeAttribute('background');
    blocked = true;
  }

  // Inline style url() — read the raw attribute so CSS escapes survive for
  // decoding, then strip only the external urls.
  const styleAttr = node.getAttribute('style');
  if (styleAttr && styleHasExternalUrl(styleAttr)) {
    node.setAttribute('data-blocked-style', styleAttr);
    node.setAttribute('style', stripExternalCssUrls(styleAttr));
    blocked = true;
  }

  return blocked;
}

/**
 * Safe HTML parsing without execution
 * Use instead of innerHTML for detection/parsing
 */
export function parseHtmlSafely(html: string): Document {
  const parser = new DOMParser();
  return parser.parseFromString(html, 'text/html');
}

/**
 * Detect if HTML content has rich formatting
 * Safe alternative to innerHTML parsing
 */
export function hasRichFormatting(html: string): boolean {
  const doc = parseHtmlSafely(html);
  return !!doc.querySelector(
    'table, img, style, b, strong, i, em, u, font, ' +
    'div[style], span[style], p[style], ' +
    'h1, h2, h3, h4, h5, h6, ul, ol, blockquote'
  );
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Render a plain-text email body as HTML, HTML-escaping all content and
 * linkifying http(s) URLs. URLs terminate at whitespace or any character that
 * would break an attribute (`"`, `'`, `<`, `>`), so attribute-escaping is
 * enforced even if escaping has bugs.
 */
export function plainTextToSafeHtml(text: string, linkClass = ''): string {
  const urlRegex = /(https?:\/\/[^\s<>"']+)/g;
  const classAttr = linkClass ? ` class="${escapeHtml(linkClass)}"` : '';
  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(text)) !== null) {
    result += escapeHtml(text.slice(lastIndex, match.index));
    const url = escapeHtml(match[0]);
    result += `<a href="${url}" target="_blank" rel="noopener noreferrer"${classAttr}>${url}</a>`;
    lastIndex = match.index + match[0].length;
  }
  result += escapeHtml(text.slice(lastIndex));
  return result;
}

/**
 * Collapse empty containers left behind when external images are blocked.
 * Walks up from each blocked img to find the nearest table cell or wrapper div
 * and hides it if it contains no meaningful visible content.
 */
export function collapseBlockedImageContainers(html: string): string {
  const doc = parseHtmlSafely(html);
  const blockedImages = doc.querySelectorAll('img[data-blocked-src]');

  blockedImages.forEach((img) => {
    let el: HTMLElement | null = img.parentElement;
    while (el && el !== doc.body) {
      if (el.tagName === 'TD' || el.tagName === 'TH' || (el.tagName === 'DIV' && el.parentElement?.tagName === 'TD')) {
        const hasVisibleText = el.textContent?.replace(/[\s\u00A0]+/g, '').trim();
        const hasVisibleMedia = el.querySelector('img:not([data-blocked-src]), video, canvas');
        const hasLinks = el.querySelector('a[href]');
        if (!hasVisibleText && !hasVisibleMedia && !hasLinks) {
          el.setAttribute('data-blocked-collapsed-style', el.style.cssText);
          el.style.display = 'none';
          el.style.height = '0';
          el.style.padding = '0';
          el.style.overflow = 'hidden';
        }
        break;
      }
      if (el.tagName === 'TABLE' || el.tagName === 'TR') break;
      el = el.parentElement;
    }
  });

  return doc.body.innerHTML;
}
