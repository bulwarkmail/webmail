import DOMPurify from 'dompurify';

/**
 * Unified DOMPurify configuration for email content
 * Blocks all script execution vectors while preserving formatting
 * NOTE: <style> tags are forbidden to prevent global CSS injection
 * Inline style attributes are still allowed for element-specific styling
 */
export const EMAIL_SANITIZE_CONFIG = {
  ADD_TAGS: [],
  // data-quoted-html is Bulwark's own reply-quote marker (see
  // components/email/quoted-html.ts). Explicitly whitelisted despite
  // ALLOW_DATA_ATTR:false so the viewer can detect and collapse the quoted
  // original (lib/quote-collapse.ts); it's inert otherwise.
  ADD_ATTR: ['target', 'rel', 'style', 'class', 'width', 'height', 'align', 'valign', 'bgcolor', 'color', 'data-quoted-html'],
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
 * Sanitize with `restrictDataUriResourcesOnNode` applied - the config alone
 * cannot express it, because DOMPurify's data:-URI carve-out for media tags
 * short-circuits ALLOWED_URI_REGEXP and is not removable via config.
 */
function sanitizeWithDataUriGuard(html: string, config: typeof EMAIL_SANITIZE_CONFIG): string {
  DOMPurify.addHook('afterSanitizeAttributes', restrictDataUriResourcesOnNode);
  try {
    return DOMPurify.sanitize(html, config);
  } finally {
    DOMPurify.removeAllHooks();
  }
}

/**
 * Sanitize email HTML content
 * @param html - Raw HTML content from email
 * @returns Sanitized HTML safe for rendering
 */
export function sanitizeEmailHtml(html: string): string {
  return sanitizeWithDataUriGuard(html, EMAIL_SANITIZE_CONFIG);
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
  return sanitizeWithDataUriGuard(html, EMAIL_IFRAME_SANITIZE_CONFIG);
}

/** Outcome of {@link sanitizeEmailBodyForIframe}. */
export interface IframeBodySanitizeResult {
  /** Sanitized HTML, ready for the iframe srcDoc. */
  html: string;
  /**
   * True if at least one external resource was actually neutralised, i.e. the
   * "external content blocked" banner has something to offer. Distinct from the
   * caller's `blockExternal` input, which decides how strict the iframe CSP is.
   */
  blockedExternalContent: boolean;
}

/**
 * The single entry point for turning an email body into iframe-ready HTML.
 *
 * Every body the viewer renders goes through here - the message's own HTML, a
 * TNEF/winmail.dat extraction, an unwrapped message/rfc822, and crucially the
 * HTML a plugin hands back from `onRenderEmailBody` (decrypted PGP or S/MIME).
 * Plugin-provided bodies used to take a sanitize-only path, so a decrypted
 * newsletter fetched its tracking pixels regardless of the user's
 * external-content preference (#797). Enforcement lives here so no render path
 * can opt out of it by accident.
 *
 * @param html Body HTML (cid: references already rewritten to blob URLs).
 * @param blockExternal Whether the user's policy blocks external resources for
 *   this message ('block', or 'ask' before the user allowed, and sender not
 *   trusted).
 */
export function sanitizeEmailBodyForIframe(
  html: string,
  blockExternal: boolean,
): IframeBodySanitizeResult {
  const config = blockExternal
    ? {
        ...EMAIL_IFRAME_SANITIZE_CONFIG,
        // <link rel=stylesheet> would pull a remote sheet the node walk can't see.
        FORBID_TAGS: [...EMAIL_IFRAME_SANITIZE_CONFIG.FORBID_TAGS, 'link'],
      }
    : EMAIL_IFRAME_SANITIZE_CONFIG;

  let blockedExternalContent = false;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (blockExternal) {
      // Blocks every external-resource vector (img src incl. whitespace/newline
      // tricks, srcset, <source>, <video poster>, media src, background attr,
      // inline style url() incl. CSS escapes, <style> block CSS). The strict
      // iframe CSP the caller derives from `blockExternal` is the network backstop.
      if (blockExternalResourcesOnNode(node)) {
        blockedExternalContent = true;
      }
    }
    // http(s) links open in a new tab; other schemes keep their default.
    applyNewTabToAnchor(node);
    // Re-apply the data:-URI allowlist DOMPurify skips on media tags.
    restrictDataUriResourcesOnNode(node);
  });

  let clean: string;
  try {
    clean = DOMPurify.sanitize(html, config);
  } finally {
    DOMPurify.removeAllHooks();
  }

  // Collapse empty containers left behind by blocked images.
  if (blockedExternalContent) {
    clean = collapseBlockedImageContainers(clean);
  }

  return { html: clean, blockedExternalContent };
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
 * Sanitizer for HTML a plugin asks the composer to insert into the message
 * being written - today the link block an `onBeforeBlobUpload` handler returns
 * when it offloads an attachment (see `ExternalAttachmentResult`).
 *
 * An untrusted plugin runs in a null-origin iframe, but whatever it returns
 * here lands in the host document and in the message the user then sends, so
 * it gets the same allowlist as a user-authored signature: formatting, links,
 * images and tables, no script, no event handlers, no external URI schemes.
 */
export function sanitizePluginBodyHtml(html: string): string {
  return sanitizeSignatureHtml(html);
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
  // A custom ALLOWED_URI_REGEXP makes DOMPurify strip target/rel from trusted
  // translated links (e.g. settings.security.not_available's docs link); keep
  // them, and force rel on _blank to prevent tab-nabbing when the catalog omits it.
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName === 'target' || data.attrName === 'rel') {
      data.forceKeepAttr = true;
    }
  });
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.getAttribute('target') === '_blank') {
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
  try {
    return DOMPurify.sanitize(html, I18N_SANITIZE_CONFIG);
  } finally {
    DOMPurify.removeAllHooks();
  }
}

/**
 * Sanitizer for the non-iframe branch of email rendering (plain-text bodies,
 * S/MIME plain-text, TNEF text, no-body fallbacks). The producer
 * (`plainTextToSafeHtml`) already escapes text and emits only safe <a> tags,
 * so this is defense-in-depth: it ensures the render site is safe even if a
 * future code path passes raw HTML in by mistake.
 */
const PLAIN_TEXT_RENDERED_CONFIG = {
  // details/summary/title carry the script-less quote-collapse toggle emitted
  // by collapsePlainTextQuotes (lib/quote-collapse.ts).
  ALLOWED_TAGS: ['a', 'br', 'p', 'div', 'span', 'details', 'summary'],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'style', 'title'],
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
  // target/rel survive the URI check via ADD_URI_SAFE_ATTR (#594); the plaintext
  // linkifier only emits http(s), so no per-scheme handling is needed here.
  return DOMPurify.sanitize(html, PLAIN_TEXT_RENDERED_CONFIG);
}

/**
 * 1x1 transparent GIF used to replace a blocked external <img> so the layout
 * doesn't reflow to a broken-image icon. The real URL is stashed in
 * `data-blocked-src` for restore.
 *
 * Deliberately a raster GIF, not an SVG: `restrictDataUriResourcesOnNode`
 * removes every non-raster data: URI from media elements, and it runs in the
 * same afterSanitizeAttributes pass as the external-content blocking above.
 * An SVG placeholder would depend on which of the two happens to run first.
 */
export const TRANSPARENT_BLOCKED_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * Media elements where DOMPurify waves any `data:` URI through. Its attribute
 * check short-circuits on `DATA_URI_TAGS` *before* ALLOWED_URI_REGEXP is
 * consulted, and the set can only be extended via config (ADD_DATA_URI_TAGS),
 * never trimmed - so the regexp's careful SVG exclusion is unreachable for
 * these tags and has to be re-applied by hand. `<image>` is absent on purpose:
 * the HTML parser rewrites it to `<img>`.
 */
const DATA_URI_BYPASS_TAGS = new Set(['IMG', 'VIDEO', 'AUDIO', 'SOURCE', 'TRACK']);

/** Raster image types that stay allowed as a data: URI (mirrors ALLOWED_URI_REGEXP). */
const RASTER_IMAGE_DATA_URI =
  /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif|x-icon|vnd\.microsoft\.icon)[;,]/i;

/**
 * True if a `srcset` value carries a `data:` URI that isn't an allowed inline
 * raster image. srcset candidates are comma-separated, but a data: URI itself
 * contains commas, so the value can't be split into candidates reliably.
 * Instead every `data:` occurrence is checked where it stands: its MIME type
 * must be on the raster allowlist. The token is captured through the first
 * comma so the plain form (`data:image/gif,...`) keeps the `[;,]` terminator
 * the raster regexp requires - same verdict as the src path for the same URI.
 * One disallowed hit condemns the whole attribute. No whitespace
 * pre-normalization here: whitespace splits srcset tokens before the URL
 * parser ever runs, so unlike in `src` it cannot hide a scheme inside a
 * candidate.
 */
function srcsetHasDisallowedDataUri(srcset: string): boolean {
  const dataUris = srcset.match(/data:[^,\s]*,?/gi);
  if (!dataUris) return false;
  return dataUris.some((uri) => !RASTER_IMAGE_DATA_URI.test(uri));
}

/**
 * Drop `data:` URIs that aren't inline raster images from media elements.
 * DOMPurify cannot inspect the bytes inside a data: URI, so an SVG payload can
 * carry <script>/<foreignObject> that the surrounding sanitizer never sees -
 * the same reason ALLOWED_URI_REGEXP excludes image/svg+xml for every other
 * element. Browsers render SVG-in-<img> in secure static mode, so this closes
 * the gap between what the sanitizer promises and what it enforces rather than
 * a live script vector.
 */
export function restrictDataUriResourcesOnNode(node: Element): void {
  if (!DATA_URI_BYPASS_TAGS.has(node.tagName)) return;
  for (const attr of ['src', 'href', 'xlink:href']) {
    const value = node.getAttribute(attr);
    if (!value) continue;
    // Mirror the URL parser (and isExternalResourceUrl): C0 controls and
    // spaces are ignored, so they can't be used to hide the scheme.
    // eslint-disable-next-line no-control-regex
    const normalized = value.replace(/[\u0000-\u0020]+/g, '');
    if (/^data:/i.test(normalized) && !RASTER_IMAGE_DATA_URI.test(normalized)) {
      node.removeAttribute(attr);
    }
  }
  // DOMPurify URI-tests srcset as one string, so an allowed first candidate
  // waves every later one through - re-check per candidate. The external
  // blocker's data-blocked-srcset stash gets the same treatment: it shares
  // this hook pass with no ordering guarantee, and a stashed disallowed
  // candidate must not outlive the live attribute.
  for (const attr of ['srcset', 'data-blocked-srcset']) {
    const value = node.getAttribute(attr);
    if (value && srcsetHasDisallowedDataUri(value)) {
      node.removeAttribute(attr);
    }
  }
}

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
 * True for external web links (http/https or protocol-relative `//host`) that
 * should open in a new tab — unlike `mailto:`/`tel:`/`#fragments`, which navigate
 * in place or hand off to the OS handler. Strips C0 controls first so obfuscated
 * schemes (`"h\ttps://x"`) don't slip through.
 */
export function isHttpLinkHref(href: string | null | undefined): boolean {
  if (!href) return false;
  // eslint-disable-next-line no-control-regex
  const normalized = href.replace(/[\u0000-\u0020]+/g, '');
  return /^(?:https?:\/\/|\/\/)/i.test(normalized);
}

/**
 * Give one `<a>` the new-tab treatment uniformly across the iframe render paths
 * (the DOMPurify hook and the post-render DOM walk in email-viewer): http(s)
 * links get target=_blank + rel; other schemes have them stripped so they don't
 * spawn a blank tab. (The plaintext path relies on ADD_URI_SAFE_ATTR instead.)
 */
export function applyNewTabToAnchor(node: Element): void {
  if (node.tagName !== 'A') return;
  if (isHttpLinkHref(node.getAttribute('href'))) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  } else {
    node.removeAttribute('target');
    node.removeAttribute('rel');
  }
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

/**
 * Neutralise external references in a full stylesheet (a kept `<style>` block).
 * The iframe sanitiser keeps `<style>`, so its CSS can auto-load remote
 * resources (background `url()`, `@font-face`, `@import`) that the per-node
 * attribute walk in `blockExternalResourcesOnNode` never sees. The strict
 * iframe CSP already blocks those fetches at the network level; this strips the
 * references from the CSS text itself as defence-in-depth.
 *
 * Escapes are decoded on the WHOLE block first because the "css escape" tracker
 * escapes the `url` keyword itself (`\75\72\6C(` -> `url(`) - a literal `url(`
 * match would miss it. Returns the original (escapes intact) when nothing
 * external is present, so callers can detect a change by identity. (#457)
 */
export function stripExternalStyleSheetCss(css: string): string {
  if (!css) return css;
  const decoded = decodeCssEscapes(css);
  if (!/url\(|@import/i.test(decoded)) return css;
  let changed = false;
  // External url(...) anywhere in the sheet (also covers `@import url(...)`).
  let result = decoded.replace(CSS_URL_PATTERN, (full, _q, inner: string) => {
    if (isExternalResourceUrl(inner)) {
      changed = true;
      return 'url()';
    }
    return full;
  });
  // Bare-string remote import: `@import "http://…"` / `@import '//…'`.
  result = result.replace(
    /@import\s+(['"])\s*(?:https?:)?\/\/[^'"]*\1[^;]*;?/gi,
    () => {
      changed = true;
      return '';
    },
  );
  return changed ? result : css;
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

  // <style> block CSS: the iframe sanitiser keeps these, so url()/@font-face/
  // @import inside them can auto-load remote resources the attribute walk above
  // never sees. Strip external refs from the stylesheet text (the strict iframe
  // CSP is the network backstop; this is defence-in-depth). (#457)
  if (tag === 'STYLE') {
    const css = node.textContent || '';
    const cleaned = stripExternalStyleSheetCss(css);
    if (cleaned !== css) {
      node.textContent = cleaned;
      blocked = true;
    }
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
