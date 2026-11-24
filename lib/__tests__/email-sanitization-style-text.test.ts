import { describe, expect, it } from 'vitest';
import { sanitizeEmailBodyForIframe } from '../email-sanitization';

// A <style> block whose remote url() the sanitizer rewrites is written back
// decoded. Its text is serialized as it is, so an escaped `</style>` that
// decoding brought back must not end the element.
const STYLE_WITH_ESCAPED_MARKUP =
  '<p>hi</p><style>p{background:url(https://example.org/a.png)} \\3c /style\\3e \\3c img src=x onerror=alert(1)\\3e \\3c meta http-equiv=refresh content="0;url=https://example.org/"\\3e</style><p>end</p>';

const PROXY_BASE = 'https://mail.example.com/api/remote-content/';

function reparse(html: string): Document {
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
}

describe('style blocks rewritten by the sanitizer', () => {
  it.each([
    ['remote content blocked', true, null],
    ['remote content through this server', false, PROXY_BASE],
  ] as const)('keep escaped markup inside the style element (%s)', (_name, blockExternal, proxyBase) => {
    const { html } = sanitizeEmailBodyForIframe(STYLE_WITH_ESCAPED_MARKUP, blockExternal, proxyBase);
    const doc = reparse(html);
    expect(doc.querySelectorAll('img, meta')).toHaveLength(0);
    expect(doc.querySelectorAll('style')).toHaveLength(1);
    expect([...doc.body.children].map((el) => el.tagName)).toEqual(['P', 'STYLE', 'P']);
    // The remote picture is still handled.
    const css = doc.querySelector('style')!.textContent ?? '';
    expect(css).not.toContain('https://example.org/a.png');
  });
});
