// A message frame's links only go live once the app has wired its link gate,
// and where the browser skips the gate's listener (WebKit, no allow-scripts)
// the links go through the open-link page or get no href at all.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HELD_HREF_ATTR, frameListenersRun, holdFrameLinks, releaseFrameLinks } from '@/lib/email-frame-links';
import { gateMessageLink, resetLinkGateHolder } from '@/lib/link-gate-holder';

const BODY = [
  '<a id="web" href="https://site.example/a" target="_blank" rel="noopener noreferrer">web</a>',
  '<a id="app" href="/settings/accounts">app</a>',
  '<a id="data" href="data:text/html,x">data</a>',
  '<a id="cid" href="blob:http://localhost:3000/9f1c">part</a>',
  '<a id="mail" href="mailto:a@b.example">mail</a>',
  '<a id="tel" href="tel:+4930123">tel</a>',
  '<a id="frag" href="#top">top</a>',
  '<map><area id="area" href="https://map.example/" alt="map"></map>',
  '<a id="none">no href</a>',
].join('');

function frameDoc(html: string): Document {
  const doc = document.implementation.createHTMLDocument('frame');
  doc.body.innerHTML = html;
  return doc;
}

/** WebKit with a frame that may not run scripts: listeners register but never run. */
function asWebKit(doc: Document): Document {
  vi.spyOn(doc, 'addEventListener').mockImplementation(() => {});
  return doc;
}

afterEach(() => {
  vi.restoreAllMocks();
  resetLinkGateHolder();
});

describe('holdFrameLinks', () => {
  it('leaves no link with an href in the frame HTML', () => {
    const held = frameDoc(holdFrameLinks(BODY));
    expect(held.querySelectorAll('a[href], area[href]')).toHaveLength(0);
    expect(held.getElementById('web')!.getAttribute(HELD_HREF_ATTR)).toBe('https://site.example/a');
    expect(held.getElementById('area')!.getAttribute(HELD_HREF_ATTR)).toBe('https://map.example/');
    expect(held.getElementById('none')!.hasAttribute(HELD_HREF_ATTR)).toBe(false);
  });

  it('returns HTML without links as it is', () => {
    expect(holdFrameLinks('<p>hi</p>')).toBe('<p>hi</p>');
  });
});

describe('frameListenersRun', () => {
  it('is true where the browser calls the listeners and false where it skips them', () => {
    expect(frameListenersRun(frameDoc(''))).toBe(true);
    expect(frameListenersRun(asWebKit(frameDoc('')))).toBe(false);
  });
});

describe('releaseFrameLinks', () => {
  it('gives every link its href back where the click listener runs', () => {
    const doc = frameDoc(holdFrameLinks(BODY));
    expect(releaseFrameLinks(doc, gateMessageLink('e1'))).toBe('listener');
    const attrs = (d: Document) => Array.from(d.querySelectorAll('a, area'), (el) =>
      Object.fromEntries(Array.from(el.attributes, (a) => [a.name, a.value])));
    expect(attrs(doc)).toEqual(attrs(frameDoc(BODY)));
  });

  it('routes web links through the open-link page and drops the rest where the listener is skipped', () => {
    const doc = asWebKit(frameDoc(holdFrameLinks(BODY)));
    expect(releaseFrameLinks(doc, gateMessageLink('e1'))).toBe('routed');
    const href = (id: string) => doc.getElementById(id)!.getAttribute('href');

    for (const id of ['web', 'area', 'tel']) {
      expect(href(id)).toMatch(/^http:\/\/localhost(?::\d+)?\/open-link#[0-9a-f]{32}$/);
    }
    expect(doc.getElementById('web')!.getAttribute('target')).toBe('_blank');
    expect(doc.getElementById('web')!.getAttribute('rel')).toBe('noopener noreferrer');
    // Each link has its own token.
    expect(href('web')).not.toBe(href('area'));
    // Nothing that would land inside the app, nor a cid: part's blob.
    for (const id of ['app', 'data', 'cid']) expect(href(id)).toBeNull();
    expect(href('mail')).toBe('mailto:a@b.example');
    expect(href('frag')).toBe('#top');
    expect(doc.querySelectorAll(`[${HELD_HREF_ATTR}]`)).toHaveLength(0);
  });

  it('leaves a link without an href when the route fails', () => {
    const doc = asWebKit(frameDoc(holdFrameLinks(BODY)));
    releaseFrameLinks(doc, () => { throw new Error('no'); });
    expect(doc.querySelectorAll('a[href], area[href]')).toHaveLength(0);
  });
});
