import { describe, it, expect } from 'vitest';
import DOMPurify from 'dompurify';
import {
  sanitizeEmailHtml,
  sanitizeSignatureHtml,
  sanitizeSignatureHtmlForDisplay,
  parseHtmlSafely,
  hasRichFormatting,
  plainTextToSafeHtml,
  sanitizePlainTextRenderedHtml,
  EMAIL_SANITIZE_CONFIG,
  EMAIL_IFRAME_SANITIZE_CONFIG,
  isExternalResourceUrl,
  decodeCssEscapes,
  styleHasExternalUrl,
  stripExternalCssUrls,
  blockExternalResourcesOnNode,
  TRANSPARENT_BLOCKED_PIXEL,
} from '../email-sanitization';

describe('email-sanitization', () => {
  describe('sanitizeEmailHtml', () => {
    it('should remove script tags', () => {
      const malicious = '<p>Hello</p><script>alert("XSS")</script>';
      const clean = sanitizeEmailHtml(malicious);
      expect(clean).not.toContain('<script>');
      expect(clean).toContain('Hello');
    });

    it('should remove event handlers', () => {
      const malicious = '<img src="x" onerror="alert(\'XSS\')">';
      const clean = sanitizeEmailHtml(malicious);
      expect(clean).not.toContain('onerror');
    });

    it('should remove iframe, object, embed tags', () => {
      const malicious = '<div>Content</div><iframe src="evil.com"></iframe><object></object>';
      const clean = sanitizeEmailHtml(malicious);
      expect(clean).not.toContain('<iframe');
      expect(clean).not.toContain('<object');
      expect(clean).toContain('Content');
    });

    it('should remove meta, link, base tags', () => {
      const malicious = '<p>Text</p><meta charset="utf-8"><link rel="stylesheet" href="evil.css">';
      const clean = sanitizeEmailHtml(malicious);
      expect(clean).not.toContain('<meta');
      expect(clean).not.toContain('<link');
      expect(clean).toContain('Text');
    });

    it('should preserve safe HTML structure', () => {
      const safe = '<p>Paragraph</p><div><span>Nested</span></div><table><tr><td>Cell</td></tr></table>';
      const clean = sanitizeEmailHtml(safe);
      expect(clean).toContain('<p>');
      expect(clean).toContain('<div>');
      expect(clean).toContain('<table>');
      expect(clean).toContain('Cell');
    });

    it('should preserve safe attributes', () => {
      const withAttrs = '<p style="color: red;" class="text">Styled</p>';
      const clean = sanitizeEmailHtml(withAttrs);
      expect(clean).toContain('style');
      expect(clean).toContain('class');
    });

    it('should handle empty input', () => {
      expect(sanitizeEmailHtml('')).toBe('');
      expect(sanitizeEmailHtml('   ')).toBeTruthy();
    });

    it('should handle malformed HTML', () => {
      const malformed = '<p>Unclosed<div>Tags';
      const clean = sanitizeEmailHtml(malformed);
      expect(clean).toContain('Unclosed');
      expect(clean).toContain('Tags');
    });
  });

  describe('sanitizeSignatureHtml', () => {
    it('should allow basic formatting tags', () => {
      const signature = '<p><strong>John Doe</strong><br><em>Software Engineer</em></p>';
      const clean = sanitizeSignatureHtml(signature);
      expect(clean).toContain('<strong>');
      expect(clean).toContain('<em>');
      expect(clean).toContain('John Doe');
    });

    it('should allow img with https src', () => {
      const signature = '<p>John</p><img src="https://cdn.example.com/logo.png" alt="Logo" width="120" height="40">';
      const clean = sanitizeSignatureHtml(signature);
      expect(clean).toContain('<img');
      expect(clean).toContain('src="https://cdn.example.com/logo.png"');
      expect(clean).toContain('alt="Logo"');
      expect(clean).toContain('width="120"');
      expect(clean).toContain('height="40"');
    });

    it('should allow img with data:image/png;base64 src', () => {
      const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX/AAAZ4gk3AAAAAXRSTlPM0jRW/QAAAAlwSFlzAAALEwAACxMBAJqcGAAAAA1JREFUCNdjYGBgAAAABAABc7Rs9wAAAABJRU5ErkJggg==';
      const signature = `<img src="${dataUri}" alt="Logo">`;
      const clean = sanitizeSignatureHtml(signature);
      expect(clean).toContain('<img');
      expect(clean).toContain('data:image/png;base64,');
    });

    it('should allow img with data:image/jpeg, gif, webp', () => {
      const cases = ['data:image/jpeg;base64,AAA', 'data:image/jpg;base64,AAA', 'data:image/gif;base64,AAA', 'data:image/webp;base64,AAA'];
      for (const src of cases) {
        const clean = sanitizeSignatureHtml(`<img src="${src}" alt="x">`);
        expect(clean).toContain('<img');
        expect(clean).toContain(src);
      }
    });

    it('should strip img with http: src (https only)', () => {
      const signature = '<img src="http://insecure.example.com/logo.png" alt="Logo">';
      const clean = sanitizeSignatureHtml(signature);
      expect(clean).not.toContain('http://insecure.example.com');
      expect(clean).not.toContain('<img');
    });

    it('should strip img with javascript: src', () => {
      const signature = '<img src="javascript:alert(1)" alt="x">';
      const clean = sanitizeSignatureHtml(signature);
      expect(clean).not.toContain('javascript:');
      expect(clean).not.toContain('<img');
    });

    it('should strip img with data:image/svg+xml src (SVG forbidden)', () => {
      const signature = '<img src="data:image/svg+xml;base64,PHN2Zy8+" alt="x">';
      const clean = sanitizeSignatureHtml(signature);
      expect(clean).not.toContain('data:image/svg');
      expect(clean).not.toContain('<img');
    });

    it('should strip img with non-image data: URI', () => {
      const signature = '<img src="data:text/html;base64,PHA+aGk8L3A+" alt="x">';
      const clean = sanitizeSignatureHtml(signature);
      expect(clean).not.toContain('data:text/html');
      expect(clean).not.toContain('<img');
    });

    it('should strip event handlers on img', () => {
      const signature = '<img src="https://cdn.example.com/logo.png" alt="x" onerror="alert(1)" onload="alert(2)">';
      const clean = sanitizeSignatureHtml(signature);
      expect(clean).not.toContain('onerror');
      expect(clean).not.toContain('onload');
      expect(clean).toContain('https://cdn.example.com/logo.png');
    });

    it('should remove video and audio tags', () => {
      const signature = '<p>John</p><video src="vid.mp4"></video><audio src="sound.mp3"></audio>';
      const clean = sanitizeSignatureHtml(signature);
      expect(clean).not.toContain('<video');
      expect(clean).not.toContain('<audio');
    });

    it('should preserve links with safe attributes', () => {
      const signature = '<p><a href="https://example.com" style="color: blue;">Website</a></p>';
      const clean = sanitizeSignatureHtml(signature);
      expect(clean).toContain('<a');
      expect(clean).toContain('href');
      expect(clean).toContain('example.com');
    });

    it('should remove script tags', () => {
      const malicious = '<p>Signature</p><script>alert("XSS")</script>';
      const clean = sanitizeSignatureHtml(malicious);
      expect(clean).not.toContain('<script>');
      expect(clean).toContain('Signature');
    });

    it('should handle empty signatures', () => {
      expect(sanitizeSignatureHtml('')).toBe('');
      expect(sanitizeSignatureHtml('   ')).toBe('');
    });

    it('should be stricter than email sanitization for script-bearing tags', () => {
      const html = '<p>Text</p><table><tr><td>Data</td></tr></table><video src="v.mp4"></video><iframe src="x"></iframe>';
      const emailClean = sanitizeEmailHtml(html);
      const signatureClean = sanitizeSignatureHtml(html);

      // Both preserve tables (signatures are universally table-based)
      expect(emailClean).toContain('<table>');
      expect(signatureClean).toContain('<table');
      expect(signatureClean).toContain('Data');

      // Signature still blocks media and frames
      expect(signatureClean).not.toContain('<video');
      expect(signatureClean).not.toContain('<iframe');
      expect(signatureClean).toContain('Text');
    });

    it('should preserve table layout attributes used by email signatures', () => {
      const signature = '<table cellpadding="0" cellspacing="0" border="0"><tr><td valign="top" align="left" bgcolor="#fafafa" colspan="2">Name</td></tr></table>';
      const clean = sanitizeSignatureHtml(signature);
      expect(clean).toContain('cellpadding');
      expect(clean).toContain('cellspacing');
      expect(clean).toContain('valign');
      expect(clean).toContain('align');
      expect(clean).toContain('bgcolor');
      expect(clean).toContain('colspan');
    });
  });

  describe('parseHtmlSafely', () => {
    it('should return a valid Document', () => {
      const html = '<p>Test</p>';
      const doc = parseHtmlSafely(html);
      expect(doc).toBeInstanceOf(Document);
    });

    it('should not execute scripts', () => {
      let executed = false;
      const html = '<script>executed = true;</script>';
      parseHtmlSafely(html);
      expect(executed).toBe(false);
    });

    it('should handle malformed HTML gracefully', () => {
      const malformed = '<p>Unclosed<div>Tags';
      const doc = parseHtmlSafely(malformed);
      expect(doc).toBeInstanceOf(Document);
      expect(doc.body.textContent).toContain('Unclosed');
    });
  });

  describe('hasRichFormatting', () => {
    it('should detect tables', () => {
      const html = '<table><tr><td>Data</td></tr></table>';
      expect(hasRichFormatting(html)).toBe(true);
    });

    it('should detect images', () => {
      const html = '<img src="pic.jpg">';
      expect(hasRichFormatting(html)).toBe(true);
    });

    it('should detect inline styles', () => {
      const html = '<div style="color: red;">Styled</div>';
      expect(hasRichFormatting(html)).toBe(true);
    });

    it('should detect formatting tags', () => {
      expect(hasRichFormatting('<b>Bold</b>')).toBe(true);
      expect(hasRichFormatting('<strong>Strong</strong>')).toBe(true);
      expect(hasRichFormatting('<em>Emphasized</em>')).toBe(true);
    });

    it('should detect headings', () => {
      expect(hasRichFormatting('<h1>Title</h1>')).toBe(true);
      expect(hasRichFormatting('<h3>Subtitle</h3>')).toBe(true);
    });

    it('should detect lists', () => {
      expect(hasRichFormatting('<ul><li>Item</li></ul>')).toBe(true);
      expect(hasRichFormatting('<ol><li>Item</li></ol>')).toBe(true);
    });

    it('should return false for plain text', () => {
      const plain = '<p>Just plain text</p>';
      expect(hasRichFormatting(plain)).toBe(false);
    });

    it('should return false for simple paragraphs', () => {
      const simple = '<p>Line 1</p><p>Line 2</p>';
      expect(hasRichFormatting(simple)).toBe(false);
    });

    it('should handle empty HTML', () => {
      expect(hasRichFormatting('')).toBe(false);
      expect(hasRichFormatting('   ')).toBe(false);
    });
  });

  describe('inline CID image handling', () => {
    it('should preserve blob: URLs for CID-replaced images (not treated as external)', () => {
      // Simulate what the component does: replace cid: with blob: object URLs
      const html = '<p>See image:</p><img src="blob:http://localhost/abc-123">';
      const clean = sanitizeEmailHtml(html);
      expect(clean).toContain('blob:');
    });

    it('should preserve data: URLs for CID placeholder images', () => {
      const html = '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">';
      const clean = sanitizeEmailHtml(html);
      expect(clean).toContain('data:image/gif');
    });

    it('should not leave raw JMAP download URLs after CID replacement pattern', () => {
      // This tests the regex pattern used for CID replacement
      const htmlWithCid = '<img src="cid:image001@example.com">';
      // Simulate the component's replacement: all cid: refs should become blob: or data: URLs
      const replaced = htmlWithCid.replace(
        /\bcid:([^"'\s)]+)/gi,
        () => 'blob:http://localhost/safe-object-url'
      );
      expect(replaced).not.toContain('cid:');
      expect(replaced).toContain('blob:');
    });

    it('should block external http(s) images but not blob/data URLs via DOMPurify hook', () => {
      const html = `
        <img src="blob:http://localhost/inline-ok">
        <img src="https://tracker.evil.com/pixel.png">
        <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
      `;

      const config = { ...EMAIL_SANITIZE_CONFIG };

      DOMPurify.addHook('afterSanitizeAttributes', (node) => {
        if (node.tagName === 'IMG') {
          const src = node.getAttribute('src');
          if (src && (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//'))) {
            node.setAttribute('data-blocked-src', src);
            node.removeAttribute('src');
            node.setAttribute('alt', '[Image blocked]');
          }
        }
      });

      const clean = DOMPurify.sanitize(html, config);
      DOMPurify.removeAllHooks();

      // External https image should be blocked
      expect(clean).toContain('data-blocked-src');
      expect(clean).toContain('tracker.evil.com');
      // blob: and data: URLs should NOT be blocked (they don't start with http/https)
      expect(clean).toContain('blob:');
      expect(clean).toContain('data:image/gif');
    });
  });

  describe('isExternalResourceUrl', () => {
    it('detects http(s) and protocol-relative URLs', () => {
      expect(isExternalResourceUrl('https://tracker.example/p.png')).toBe(true);
      expect(isExternalResourceUrl('http://tracker.example/p.png')).toBe(true);
      expect(isExternalResourceUrl('//tracker.example/p.png')).toBe(true);
    });

    it('sees through leading whitespace/newlines (imgNewlineSrc bypass)', () => {
      expect(isExternalResourceUrl('\n\nhttps://tracker.example/p.png')).toBe(true);
      expect(isExternalResourceUrl('  \t https://tracker.example/p.png')).toBe(true);
      // Tab/newline removed anywhere in the URL by the parser.
      expect(isExternalResourceUrl('h\nttps://tracker.example/p.png')).toBe(true);
      expect(isExternalResourceUrl('ht\ttps://tracker.example/p.png')).toBe(true);
    });

    it('treats inline/local schemes as not external', () => {
      expect(isExternalResourceUrl('data:image/png;base64,AAAA')).toBe(false);
      expect(isExternalResourceUrl('blob:http://localhost/abc')).toBe(false);
      expect(isExternalResourceUrl('cid:image001@example.com')).toBe(false);
      expect(isExternalResourceUrl('/relative/path.png')).toBe(false);
      expect(isExternalResourceUrl('')).toBe(false);
      expect(isExternalResourceUrl(null)).toBe(false);
      expect(isExternalResourceUrl(undefined)).toBe(false);
    });
  });

  describe('decodeCssEscapes', () => {
    it('decodes hex escapes (cssEscape bypass)', () => {
      expect(decodeCssEscapes('\\68ttp://x')).toBe('http://x');
      expect(decodeCssEscapes('\\000068ttps://x')).toBe('https://x');
      // Hex escape consumes one trailing whitespace separator.
      expect(decodeCssEscapes('\\68 ttp')).toBe('http');
    });

    it('decodes single-character escapes', () => {
      expect(decodeCssEscapes('\\h\\t\\t\\p')).toBe('http');
    });
  });

  describe('styleHasExternalUrl / stripExternalCssUrls', () => {
    it('detects and strips plain external url()', () => {
      const style = 'background:url(https://tracker.example/p.png)';
      expect(styleHasExternalUrl(style)).toBe(true);
      expect(stripExternalCssUrls(style)).toBe('background:url()');
    });

    it('detects and strips CSS-escaped external url()', () => {
      const style = 'background:url(\\68ttps://tracker.example/p.png)';
      expect(styleHasExternalUrl(style)).toBe(true);
      expect(stripExternalCssUrls(style)).toBe('background:url()');
    });

    it('detects url() with whitespace/quotes', () => {
      expect(styleHasExternalUrl("background: url( '\n https://t/p.png' )")).toBe(true);
    });

    it('leaves data: and relative url() untouched', () => {
      const style = "background:url('data:image/png;base64,AAAA')";
      expect(styleHasExternalUrl(style)).toBe(false);
      expect(stripExternalCssUrls(style)).toBe(style);
    });
  });

  describe('blockExternalResourcesOnNode (anti-tracking vectors)', () => {
    function el(html: string): Element {
      return parseHtmlSafely(`<body>${html}</body>`).body.firstElementChild!;
    }

    it('blocks an img whose src is hidden behind a leading newline', () => {
      const img = el('<img src="">');
      img.setAttribute('src', '\n\nhttps://tracker.example/pixel.png');
      expect(blockExternalResourcesOnNode(img)).toBe(true);
      expect(img.getAttribute('data-blocked-src')).toBe('https://tracker.example/pixel.png');
      expect(img.getAttribute('src')).toBe(TRANSPARENT_BLOCKED_PIXEL);
    });

    it('blocks img srcset', () => {
      const img = el('<img srcset="https://tracker.example/1x.png 1x, https://tracker.example/2x.png 2x">');
      expect(blockExternalResourcesOnNode(img)).toBe(true);
      expect(img.hasAttribute('srcset')).toBe(false);
      expect(img.getAttribute('data-blocked-srcset')).toContain('tracker.example');
    });

    it('blocks <picture><source srcset> (pictureSource)', () => {
      const source = el('<source srcset="https://tracker.example/pic.webp" type="image/webp">');
      expect(blockExternalResourcesOnNode(source)).toBe(true);
      expect(source.hasAttribute('srcset')).toBe(false);
    });

    it('blocks <source src> for media', () => {
      const source = el('<source src="https://tracker.example/v.mp4">');
      expect(blockExternalResourcesOnNode(source)).toBe(true);
      expect(source.hasAttribute('src')).toBe(false);
      expect(source.getAttribute('data-blocked-src')).toContain('tracker.example');
    });

    it('blocks <video poster> (videoPoster)', () => {
      const video = el('<video poster="https://tracker.example/poster.jpg"></video>');
      expect(blockExternalResourcesOnNode(video)).toBe(true);
      expect(video.hasAttribute('poster')).toBe(false);
      expect(video.getAttribute('data-blocked-poster')).toContain('tracker.example');
    });

    it('blocks video src', () => {
      const video = el('<video src="https://tracker.example/v.mp4"></video>');
      expect(blockExternalResourcesOnNode(video)).toBe(true);
      expect(video.hasAttribute('src')).toBe(false);
    });

    it('blocks the legacy background attribute', () => {
      // <td> is foster-parented out of <body>, so build it directly.
      const td = document.createElement('td');
      td.setAttribute('background', 'https://tracker.example/bg.png');
      expect(blockExternalResourcesOnNode(td)).toBe(true);
      expect(td.hasAttribute('background')).toBe(false);
      expect(td.getAttribute('data-blocked-background')).toContain('tracker.example');
    });

    it('strips external inline style url() including CSS escapes (cssEscape)', () => {
      const div = el('<div style="background:url(\\68ttps://tracker.example/p.png)">x</div>');
      expect(blockExternalResourcesOnNode(div)).toBe(true);
      expect(div.getAttribute('style')).not.toContain('tracker.example');
      expect(div.getAttribute('data-blocked-style')).toContain('tracker.example');
    });

    it('does not block inline/local resources', () => {
      const img = el('<img src="blob:http://localhost/inline">');
      expect(blockExternalResourcesOnNode(img)).toBe(false);
      expect(img.getAttribute('src')).toBe('blob:http://localhost/inline');

      const dataImg = el('<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">');
      expect(blockExternalResourcesOnNode(dataImg)).toBe(false);

      const cidImg = el('<img src="cid:logo@example.com">');
      expect(blockExternalResourcesOnNode(cidImg)).toBe(false);
    });

    it('works as a DOMPurify afterSanitizeAttributes hook across all vectors', () => {
      const html = `
        <img src="&#10;&#10;https://tracker.example/a.png">
        <picture><source srcset="https://tracker.example/b.webp"><img src="https://tracker.example/c.png"></picture>
        <div style="background:url(\\68ttps://tracker.example/d.png)">bg</div>
      `;
      DOMPurify.addHook('afterSanitizeAttributes', (node) => {
        blockExternalResourcesOnNode(node as Element);
      });
      const clean = DOMPurify.sanitize(html, EMAIL_SANITIZE_CONFIG);
      DOMPurify.removeAllHooks();

      const doc = parseHtmlSafely(clean);
      // No live src/srcset/style references the tracker anymore.
      doc.querySelectorAll('img, source').forEach((node) => {
        expect(node.getAttribute('src') ?? '').not.toContain('tracker.example');
        expect(node.getAttribute('srcset') ?? '').not.toContain('tracker.example');
      });
      expect(doc.querySelector('div')?.getAttribute('style') ?? '').not.toContain('tracker.example');
      // The originals are stashed for the banner/affordance.
      expect(clean).toContain('data-blocked-src');
      expect(clean).toContain('data-blocked-srcset');
      expect(clean).toContain('data-blocked-style');
    });
  });

  describe('Email Privacy Tester exact payloads (iframe render path)', () => {
    function render(html: string): string {
      DOMPurify.addHook('afterSanitizeAttributes', (node) =>
        blockExternalResourcesOnNode(node as Element)
      );
      const out = DOMPurify.sanitize(html, EMAIL_IFRAME_SANITIZE_CONFIG);
      DOMPurify.removeAllHooks();
      return out;
    }

    it('pictureSource: <picture><source srcset> does not keep a live external ref', () => {
      const source = parseHtmlSafely(render('<picture><source srcset="http://TRACK/"><img src="#"></picture>')).querySelector('source')!;
      expect(source.hasAttribute('srcset')).toBe(false);
      expect(source.getAttribute('data-blocked-srcset')).toContain('TRACK');
    });

    it('imgNewlineSrc: newline after the first slash (protocol-relative) is blocked', () => {
      const img = parseHtmlSafely(render('<img src="/\n/TRACK_HOST/PATH">')).querySelector('img')!;
      expect(img.getAttribute('src')).toBe(TRANSPARENT_BLOCKED_PIXEL);
      expect(img.getAttribute('data-blocked-src')).toContain('TRACK_HOST');
    });

    it('videoPoster: poster and src are both stripped', () => {
      const video = parseHtmlSafely(render('<video poster="http://TRACK/" autoplay="true" src="http://OTHER/"></video>')).querySelector('video')!;
      expect(video.hasAttribute('poster')).toBe(false);
      expect(video.hasAttribute('src')).toBe(false);
      expect(video.getAttribute('data-blocked-poster')).toContain('TRACK');
      expect(video.getAttribute('data-blocked-src')).toContain('OTHER');
    });

    it('anchor href is preserved (links stay clickable; DNS prefetch is disabled via iframe meta)', () => {
      const out = render('<a href="http://TRACK/">link</a>');
      expect(out).toContain('href="http://TRACK/"');
    });
  });

  describe('plainTextToSafeHtml', () => {
    it('escapes HTML-special characters in surrounding text', () => {
      const result = plainTextToSafeHtml('<script>alert(1)</script> & "q" \'q\'');
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
      expect(result).toContain('&amp;');
      expect(result).toContain('&quot;');
      expect(result).toContain('&#39;');
    });

    it('linkifies http(s) URLs', () => {
      const result = plainTextToSafeHtml('visit http://example.com/path now');
      expect(result).toContain('<a href="http://example.com/path"');
      expect(result).toContain('target="_blank"');
      expect(result).toContain('rel="noopener noreferrer"');
    });

    it('prevents attribute breakout via quote in URL (CVE regression)', () => {
      const payload = 'http://evil.tld/"onmouseover="alert(1)"x="';
      const result = plainTextToSafeHtml(payload);
      // The anchor tag must not contain any unescaped attribute beyond href/target/rel.
      expect(result).not.toMatch(/<a [^>]*onmouseover/i);
      expect(result).not.toMatch(/<a [^>]*style=/i);
      // Quotes from the payload must be entity-encoded wherever they land.
      expect(result).toContain('&quot;');
    });

    it('prevents attribute breakout via style injection', () => {
      const payload = 'http://evil.tld/"style="background:red"x="';
      const result = plainTextToSafeHtml(payload);
      expect(result).not.toMatch(/href="[^"]*"[^>]*style=/);
    });

    it('terminates URL at quote, keeping rest as escaped text', () => {
      const result = plainTextToSafeHtml('http://evil.tld/"injected');
      expect(result).toContain('<a href="http://evil.tld/"');
      expect(result).toContain('&quot;injected');
    });

    it('applies linkClass when provided and escapes it', () => {
      const result = plainTextToSafeHtml('http://x.com', 'text-primary hover:underline');
      expect(result).toContain('class="text-primary hover:underline"');
    });

    it('does not linkify non-http schemes', () => {
      const result = plainTextToSafeHtml('try javascript:alert(1) or file:///etc/passwd');
      expect(result).not.toContain('<a ');
      expect(result).toContain('javascript:alert(1)');
    });
  });

  describe('sanitizeSignatureHtmlForDisplay', () => {
    // Signatures render into the main document (identity-form preview, composer
    // block), not the sandboxed iframe, so a target-less anchor navigates the
    // whole app away and takes the unsaved draft/signature with it.
    it('forces target=_blank and rel on signature links', () => {
      const clean = sanitizeSignatureHtmlForDisplay('<p><a href="https://example.com">Site</a></p>');
      expect(clean).toContain('target="_blank"');
      expect(clean).toContain('rel="noopener noreferrer"');
    });

    it('overrides a target the user supplied themselves', () => {
      const clean = sanitizeSignatureHtmlForDisplay('<a href="https://example.com" target="_top">x</a>');
      expect(clean).toContain('target="_blank"');
      expect(clean).not.toContain('_top');
    });

    it('keeps the image restrictions of the storage sanitizer', () => {
      const clean = sanitizeSignatureHtmlForDisplay(
        '<img src="http://insecure.example.com/l.png"><img src="https://cdn.example.com/l.png">',
      );
      expect(clean).not.toContain('insecure.example.com');
      expect(clean).toContain('https://cdn.example.com/l.png');
    });

    it('does not leak target into the stored or sent signature', () => {
      // sanitizeSignatureHtml feeds both storage and the outgoing message body.
      const stored = sanitizeSignatureHtml('<p><a href="https://example.com">Site</a></p>');
      expect(stored).toContain('href="https://example.com"');
      expect(stored).not.toContain('target=');
    });

    it('handles empty input', () => {
      expect(sanitizeSignatureHtmlForDisplay('')).toBe('');
      expect(sanitizeSignatureHtmlForDisplay('   ')).toBe('');
    });
  });

  describe('sanitizePlainTextRenderedHtml', () => {
    // This branch renders into the main document, not the sandboxed iframe, so
    // an anchor that loses target="_blank" navigates the whole app away.
    it('preserves target and rel on links emitted by plainTextToSafeHtml', () => {
      const rendered = sanitizePlainTextRenderedHtml(
        plainTextToSafeHtml('see https://github.com/honzup/webmail/pull/560'),
      );
      expect(rendered).toContain('target="_blank"');
      expect(rendered).toContain('rel="noopener noreferrer"');
    });

    it('still strips dangerous schemes and tags', () => {
      const rendered = sanitizePlainTextRenderedHtml(
        '<a href="javascript:alert(1)" target="_blank">x</a><script>alert(1)</script>',
      );
      expect(rendered).not.toContain('javascript:');
      expect(rendered).not.toContain('<script');
    });
  });
});
