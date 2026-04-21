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
  // data: is restricted to image/* MIME types to prevent SVG script injection.
  // eslint-disable-next-line no-useless-escape
  ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|blob):|data:image\/|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
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
 * attribute (no allow-scripts). Use ONLY for iframe-rendered content —
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
 * Only allows basic formatting, no external resources
 */
export const SIGNATURE_SANITIZE_CONFIG = {
  ALLOWED_TAGS: ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 'a', 'span', 'div'],
  ALLOWED_ATTR: ['href', 'style', 'class'],
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'img', 'video', 'audio'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
};

/**
 * Sanitize HTML signature for storage and display
 * @param html - User-provided HTML signature
 * @returns Sanitized signature (no scripts, no external resources)
 */
export function sanitizeSignatureHtml(html: string): string {
  if (!html?.trim()) return '';
  return DOMPurify.sanitize(html, SIGNATURE_SANITIZE_CONFIG);
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

function escapeHtml(str: string): string {
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
