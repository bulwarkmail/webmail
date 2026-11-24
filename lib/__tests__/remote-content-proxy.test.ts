import { describe, expect, it } from 'vitest';
import { emailIframeCsp, sanitizeEmailBodyForIframe } from '../email-sanitization';
import { decodeRemoteUrl, encodeRemoteUrl, normalizeRemoteUrl, proxiedResourceUrl, remoteContentProxyBase } from '../remote-content-proxy';

// #1021: allowed remote pictures load through /api/remote-content on the
// webmail's own origin. The sanitizer points every picture reference there,
// drops what the route doesn't serve, and the frame's CSP allows pictures
// from that folder only.

const BASE = 'https://mail.example.com/api/remote-content/';
const via = (url: string) => `${BASE}${encodeRemoteUrl(url)}`;

function body(html: string) {
  const doc = new DOMParser().parseFromString(sanitizeEmailBodyForIframe(html, false, BASE).html, 'text/html');
  return { doc, html: doc.body.innerHTML };
}

describe('the route address', () => {
  it('round-trips a remote address through the token', () => {
    const url = 'https://t.example/p.gif?u=1&ü=2';
    const normalized = normalizeRemoteUrl(url)!;
    expect(decodeRemoteUrl(encodeRemoteUrl(normalized))).toBe(normalized);
    expect(encodeRemoteUrl(normalized)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('reads references the way a browser does', () => {
    expect(normalizeRemoteUrl('//t.example/a.png')).toBe('https://t.example/a.png');
    expect(normalizeRemoteUrl(' ht\ttps://t.example/a.png#x')).toBe('https://t.example/a.png');
    expect(normalizeRemoteUrl('https:\\\\t.example\\a.png')).toBe('https://t.example/a.png');
  });

  it.each([
    'data:image/gif;base64,R0lGOD', 'cid:part1', '/api/account', 'javascript:alert(1)', 'ftp://t.example/a.png',
    'https://user:pw@t.example/a.png', `https://t.example/${'a'.repeat(5000)}`,
  ])('leaves %s alone', (value) => {
    expect(proxiedResourceUrl(value, BASE)).toBeNull();
  });

  it.each([
    ['not base64', '!!!'],
    ['not a web address', encodeRemoteUrl('file:///etc/passwd')],
    ['a non-canonical form', encodeRemoteUrl('HTTPS://T.example/a.png')],
    ['empty', ''],
  ])('refuses a token that is %s', (_what, token) => {
    expect(decodeRemoteUrl(token)).toBeNull();
  });

  it('names the folder under the base path', () => {
    expect(remoteContentProxyBase('https://mail.example.com', '/webmail/')).toBe('https://mail.example.com/webmail/api/remote-content/');
    expect(remoteContentProxyBase('https://mail.example.com')).toBe(BASE);
    expect(remoteContentProxyBase("https://x; img-src *")).toBeNull();
  });
});

describe('sanitizeEmailBodyForIframe with a proxy', () => {
  it('points every picture reference at the proxy', () => {
    const { doc } = body(`
      <img id="a" src="https://t.example/a.png">
      <img id="b" srcset="https://t.example/b1.png 1x, //t.example/b2.png 2x">
      <picture><source id="c" srcset="https://t.example/c.webp"><img alt=""></picture>
      <table><tr><td id="d" background="https://t.example/d.png">x</td></tr></table>
      <div id="e" style="background-image: url('https://t.example/e.png'); color: red">x</div>
      <video id="f" poster="https://t.example/f.jpg"></video>
    `);
    expect(doc.getElementById('a')!.getAttribute('src')).toBe(via('https://t.example/a.png'));
    expect(doc.getElementById('b')!.getAttribute('srcset')).toBe(`${via('https://t.example/b1.png')} 1x, ${via('https://t.example/b2.png')} 2x`);
    expect(doc.getElementById('c')!.getAttribute('srcset')).toBe(via('https://t.example/c.webp'));
    expect(doc.getElementById('d')!.getAttribute('background')).toBe(via('https://t.example/d.png'));
    expect(doc.getElementById('e')!.getAttribute('style')).toContain(`url("${via('https://t.example/e.png')}")`);
    expect(doc.getElementById('e')!.getAttribute('style')).toContain('color: red');
    expect(doc.getElementById('f')!.getAttribute('poster')).toBe(via('https://t.example/f.jpg'));
  });

  it('finds escaped urls in styles and rewrites <style> blocks, dropping @import', () => {
    const { doc } = body(`
      <style>@import url(https://t.example/sheet.css); .x { background: url(https://t.example/s.png) }</style>
      <div id="e" style="background: \\75 rl(https://t.example/esc.png)">x</div>
    `);
    const css = doc.querySelector('style')!.textContent!;
    expect(css).not.toContain('@import');
    expect(css).toContain(`url("${via('https://t.example/s.png')}")`);
    expect(doc.getElementById('e')!.getAttribute('style')).toContain(via('https://t.example/esc.png'));
  });

  it('drops remote audio and video sources, which the route does not serve', () => {
    const { doc } = body(`
      <video id="v" src="https://t.example/v.mp4"><source id="s" src="https://t.example/v.webm"></video>
      <audio id="a" src="https://t.example/a.mp3"></audio>
    `);
    expect(doc.getElementById('v')!.hasAttribute('src')).toBe(false);
    expect(doc.getElementById('s')!.hasAttribute('src')).toBe(false);
    expect(doc.getElementById('a')!.hasAttribute('src')).toBe(false);
  });

  it('leaves no address of the sender in a picture attribute', () => {
    const { html } = body('<img src="https://t.example/p.gif"><img srcset="https://t.example/q.gif"><table><tr><td background="//t.example/r.gif">x</td></tr></table>');
    expect(html).not.toMatch(/(src|srcset|background)="(https?:)?\/\/t\.example/);
  });

  it('leaves inline pictures and links alone', () => {
    const { doc } = body('<img id="i" src="data:image/png;base64,iVBORw0KGgo="><a id="l" href="https://t.example/page">x</a>');
    expect(doc.getElementById('i')!.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(doc.getElementById('l')!.getAttribute('href')).toBe('https://t.example/page');
  });

  it('loads straight from the sender without a proxy, as before', () => {
    const out = sanitizeEmailBodyForIframe('<img src="https://t.example/a.png">', false).html;
    expect(out).toContain('src="https://t.example/a.png"');
  });

  it('still blocks when remote content is not allowed', () => {
    const out = sanitizeEmailBodyForIframe('<img src="https://t.example/a.png">', true, BASE);
    expect(out.html).not.toContain(BASE);
    expect(out.blockedExternalContent).toBe(true);
  });
});

describe('emailIframeCsp with a proxy', () => {
  const directive = (csp: string, name: string) => new RegExp(`${name} ([^;]*)`).exec(csp)?.[1];

  it('allows pictures from the proxy folder only, and no remote fonts or media', () => {
    const csp = emailIframeCsp(false, [], BASE);
    expect(directive(csp, 'img-src')).toBe(`data: blob: ${BASE}`);
    expect(directive(csp, 'font-src')).toBe('data:');
    expect(directive(csp, 'media-src')).toBe('data: blob:');
  });

  it('stays strict while remote content is blocked', () => {
    expect(directive(emailIframeCsp(true, [], BASE), 'img-src')).toBe('data: blob:');
  });

  it('ignores a proxy value that is not a folder address', () => {
    expect(directive(emailIframeCsp(false, [], "https://x/; script-src *"), 'img-src')).toBe('data: blob: http: https:');
  });
});
