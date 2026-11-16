import { describe, it, expect } from 'vitest';
import {
  applyEmailDarkMode,
  contrastRatio,
  darkenBackground,
  DARK_PENDING_CLASS,
  emailColorScheme,
  ensureContrast,
  parseComputedColor,
  resolveColorSchemeMedia,
  type Rgba,
} from '../email-dark-mode';
import { sanitizeEmailBodyForIframe } from '../email-sanitization';

const c = (value: string): Rgba => parseComputedColor(value)!;
const lightness = ({ r, g, b }: Rgba) => (r + g + b) / 3;

describe('darkenBackground', () => {
  it('turns white into a dark canvas', () => {
    expect(lightness(darkenBackground(c('rgb(255, 255, 255)')))).toBeLessThan(40);
  });

  it('keeps a light grey canvas lighter than a white card on it', () => {
    const card = darkenBackground(c('rgb(255, 255, 255)'));
    const canvas = darkenBackground(c('rgb(244, 244, 244)'));
    expect(lightness(canvas)).toBeGreaterThan(lightness(card));
  });

  it('keeps the hue of a light tint', () => {
    const out = darkenBackground(c('rgb(214, 233, 248)'));
    expect(lightness(out)).toBeLessThan(80);
    expect(out.b).toBeGreaterThan(out.r);
  });

  it('leaves vivid brand colours and dark fills as sent', () => {
    const red = c('rgb(227, 6, 19)');
    const green = c('rgb(115, 215, 0)');
    const navy = c('rgb(0, 32, 91)');
    expect(darkenBackground(red)).toBe(red);
    expect(darkenBackground(green)).toBe(green);
    expect(darkenBackground(navy)).toBe(navy);
  });

  it('keeps alpha', () => {
    expect(darkenBackground(c('rgba(255, 255, 255, 0.5)')).a).toBe(0.5);
  });
});

describe('ensureContrast', () => {
  const dark = c('rgb(20, 20, 20)');

  it('keeps text that already reads', () => {
    const white = c('rgb(255, 255, 255)');
    expect(ensureContrast(white, dark, 4.5)).toBe(white);
  });

  it('lifts dark text above 4.5:1 on a dark background', () => {
    const out = ensureContrast(c('rgb(51, 51, 51)'), dark, 4.5);
    expect(contrastRatio(out, dark)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the order of text greys', () => {
    const black = ensureContrast(c('rgb(0, 0, 0)'), dark, 4.5);
    const grey = ensureContrast(c('rgb(102, 102, 102)'), dark, 4.5);
    expect(lightness(black)).toBeGreaterThan(lightness(grey));
  });

  it('keeps a red link red', () => {
    const out = ensureContrast(c('rgb(200, 0, 0)'), dark, 4.5);
    expect(out.r).toBeGreaterThan(out.g + 60);
  });
});

describe('resolveColorSchemeMedia', () => {
  const html = '<style>@media (prefers-color-scheme: dark) { .a { color: white } } @media (prefers-color-scheme:light) { .b {} }</style><p>(prefers-color-scheme: dark)</p>';

  it('turns the dark query on and the light one off in dark mode', () => {
    const out = resolveColorSchemeMedia(html, true);
    expect(out).toContain('@media (min-width: 0px) { .a');
    expect(out).toContain('@media (max-width: 0.001px) { .b');
  });

  it('turns the dark query off in light mode', () => {
    const out = resolveColorSchemeMedia(html, false);
    expect(out).toContain('@media (max-width: 0.001px) { .a');
    expect(out).toContain('@media (min-width: 0px) { .b');
  });

  it('leaves text outside <style> alone', () => {
    expect(resolveColorSchemeMedia(html, true)).toContain('<p>(prefers-color-scheme: dark)</p>');
  });
});

describe('emailColorScheme', () => {
  it('is dark only for a mail with its own dark styles shown dark', () => {
    expect(emailColorScheme(true, true)).toBe('dark');
    expect(emailColorScheme(true, false)).toBe('light');
    expect(emailColorScheme(false, true)).toBe('light');
  });
});

describe('applyEmailDarkMode', () => {
  const render = (body: string) => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const doc = frame.contentDocument!;
    doc.documentElement.className = DARK_PENDING_CLASS;
    doc.documentElement.style.backgroundColor = 'rgb(20, 20, 20)';
    doc.body.innerHTML = body;
    applyEmailDarkMode(doc);
    return doc;
  };

  // jsdom doesn't map presentational attributes (bgcolor) into computed
  // style, so these use inline styles; browsers treat both the same.
  it('darkens a white cell', () => {
    const doc = render('<table><tr><td id="a" style="background-color:#fff">y</td></tr></table>');
    const bg = c(doc.getElementById('a')!.style.getPropertyValue('background-color'));
    expect(lightness(bg)).toBeLessThan(40);
  });

  it('makes dark text on a darkened cell readable', () => {
    const doc = render('<div style="background-color:#fff"><p id="p" style="color:#222">text</p></div>');
    const color = c(doc.getElementById('p')!.style.getPropertyValue('color'));
    expect(contrastRatio(color, c('rgb(30, 30, 30)'))).toBeGreaterThan(4.5);
  });

  it('keeps a brand button and its label as sent', () => {
    const doc = render('<a id="btn" style="background-color:#e30613;color:#ffffff">Buy</a>');
    const btn = doc.getElementById('btn')!;
    expect(btn.style.getPropertyPriority('background-color')).toBe('');
    expect(btn.style.getPropertyPriority('color')).toBe('');
  });

  it('leaves text on a background image as sent', () => {
    const doc = render('<div style="background-image:url(data:image/png;base64,AAAA);background-color:#ffffff"><p id="p" style="color:#111">On the photo</p></div>');
    expect(doc.getElementById('p')!.style.getPropertyPriority('color')).toBe('');
  });

  it('converts a cell whose remote background the blocker stripped', () => {
    const { html } = sanitizeEmailBodyForIframe(
      '<table><tr><td id="hero" background="https://example.com/hero.jpg" style="background-color:#ffffff;background-image:url(https://example.com/hero.jpg)"><p id="p" style="color:#111">Headline</p></td></tr></table>',
      true,
    );
    const doc = render(html);
    expect(lightness(c(doc.getElementById('hero')!.style.getPropertyValue('background-color')))).toBeLessThan(40);
    expect(doc.getElementById('p')!.style.getPropertyPriority('color')).toBe('important');
  });

  it('leaves the dark canvas behind a mail without colours alone', () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const doc = frame.contentDocument!;
    doc.documentElement.style.backgroundColor = 'rgb(20, 20, 20)';
    doc.body.style.backgroundColor = 'rgb(20, 20, 20)';
    doc.body.innerHTML = '<p>Plain text</p>';
    applyEmailDarkMode(doc);
    expect(c(doc.defaultView!.getComputedStyle(doc.body).backgroundColor)).toEqual(c('rgb(20, 20, 20)'));
  });

  // A sender's own dark block - an HTML signature card, a dark header - was
  // lifted to grey to stand out from the darkened page, and its subtle frame
  // and inner rules were mirrored to near white.
  it('keeps a dark card that has its own border as sent', () => {
    const doc = render(
      '<table id="card" style="background:#0a0e16;border:1px solid #1d2430;border-left:3px solid #c6f24e">'
      + '<tr><td><div id="rule" style="border-top:1px solid #1d2430">&nbsp;</div>'
      + '<p id="name" style="color:#e7ecf3">Name</p></td></tr></table>',
    );
    const card = doc.getElementById('card')!;
    expect(card.style.getPropertyPriority('background-color')).toBe('');
    expect(c(doc.defaultView!.getComputedStyle(card).backgroundColor)).toEqual(c('rgb(10, 14, 22)'));
    expect(doc.getElementById('rule')!.style.getPropertyPriority('border-top-color')).toBe('');
    expect(doc.getElementById('name')!.style.getPropertyPriority('color')).toBe('');
  });

  it('lifts the frame of a dark card just enough to show on the dark page', () => {
    const doc = render('<div id="card" style="background:#0a0e16;border:1px solid #1d2430">x</div>');
    const frame = c(doc.getElementById('card')!.style.getPropertyValue('border-top-color'));
    expect(contrastRatio(frame, c('rgb(20, 20, 20)'))).toBeGreaterThanOrEqual(1.6);
    expect(lightness(frame)).toBeLessThan(110);
    // Same hue: still bluer than it is red.
    expect(frame.b).toBeGreaterThan(frame.r);
  });

  it('still lifts a borderless near-black button off the darkened page', () => {
    const doc = render('<div style="background-color:#ffffff"><a id="btn" style="background-color:#111111;color:#ffffff">Go</a></div>');
    expect(doc.getElementById('btn')!.style.getPropertyPriority('background-color')).toBe('important');
  });

  it('keeps a rule on a brand banner as sent, but darkens the frame of a light card on it', () => {
    const doc = render(
      '<div style="background:#1a73e8"><p id="rule" style="border-bottom:2px solid #ffffff">Rule</p>'
      + '<div id="card" style="background:#ffffff;border:1px solid #dddddd">Card</div></div>',
    );
    expect(doc.getElementById('rule')!.style.getPropertyPriority('border-bottom-color')).toBe('');
    const card = doc.getElementById('card')!;
    expect(lightness(c(card.style.getPropertyValue('background-color')))).toBeLessThan(40);
    expect(lightness(c(card.style.getPropertyValue('border-top-color')))).toBeLessThan(80);
  });

  it('un-hides the body', () => {
    const doc = render('<p>hi</p>');
    expect(doc.documentElement.classList.contains(DARK_PENDING_CLASS)).toBe(false);
  });

  // Newsletters (Lieferando) paint the canvas through `html { background }`.
  // The pass only looked at the body, so that white stayed behind the mail
  // and was taken for our dark canvas.
  it('darkens a canvas the mail paints on <html>', () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const doc = frame.contentDocument!;
    doc.documentElement.className = DARK_PENDING_CLASS;
    doc.documentElement.style.backgroundColor = '#ffffff';
    doc.body.style.backgroundColor = '#ffffff';
    doc.body.innerHTML = '<p>hi</p>';
    applyEmailDarkMode(doc);
    const bgOf = (el: Element) => c(doc.defaultView!.getComputedStyle(el).backgroundColor);
    expect(lightness(bgOf(doc.documentElement))).toBeLessThan(40);
    expect(lightness(bgOf(doc.body))).toBeLessThan(40);
  });
});

// #693: cells coloured through the legacy bgcolor attribute stayed white in
// dark mode. Browsers map bgcolor to background-color as a presentational hint
// (below every author style), which the pass reads back through computed
// style. jsdom has no presentational hints, so the helper below adds the same
// mapping as zero-specificity rules at the top of the cascade.
describe('applyEmailDarkMode with bgcolor', () => {
  const mapBgcolorLikeBrowser = (doc: Document) => {
    const rules: string[] = [];
    doc.querySelectorAll('[bgcolor]').forEach((el, i) => {
      el.setAttribute('data-bgcolor-hint', String(i));
      rules.push(`:where([data-bgcolor-hint="${i}"]) { background-color: ${el.getAttribute('bgcolor')}; }`);
    });
    const sheet = doc.createElement('style');
    sheet.textContent = rules.join('\n');
    doc.head.prepend(sheet);
  };

  const render = (mail: string, bodyBgcolor?: string) => {
    const { html } = sanitizeEmailBodyForIframe(mail, true);
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const doc = frame.contentDocument!;
    doc.documentElement.className = DARK_PENDING_CLASS;
    doc.documentElement.style.backgroundColor = 'rgb(20, 20, 20)';
    if (bodyBgcolor) doc.body.setAttribute('bgcolor', bodyBgcolor);
    doc.body.innerHTML = html;
    mapBgcolorLikeBrowser(doc);
    applyEmailDarkMode(doc);
    return doc;
  };

  // The darkened colour the pass wrote over the sender's one.
  const rewrittenBg = (el: HTMLElement) => {
    expect(el.style.getPropertyPriority('background-color')).toBe('important');
    return c(el.ownerDocument.defaultView!.getComputedStyle(el).backgroundColor);
  };

  it.each([
    ['td', '<table><tr><td id="x" bgcolor="#ffffff"><p id="p" style="color:#333333">Hello</p></td></tr></table>'],
    ['tr', '<table><tr id="x" bgcolor="#ffffff"><td><p id="p" style="color:#333333">Hello</p></td></tr></table>'],
    ['table', '<table id="x" bgcolor="#ffffff" width="100%"><tr><td><p id="p" style="color:#333333">Hello</p></td></tr></table>'],
    ['td with a named colour', '<table><tr><td id="x" bgcolor="white"><p id="p" style="color:#333333">Hello</p></td></tr></table>'],
    ['td with a light tint', '<table><tr><td id="x" bgcolor="#f4f4f4"><p id="p" style="color:#333333">Hello</p></td></tr></table>'],
  ])('darkens a light bgcolor on %s and keeps its text readable', (_, mail) => {
    const doc = render(mail);
    const bg = rewrittenBg(doc.getElementById('x')!);
    expect(lightness(bg)).toBeLessThan(40);
    const text = c(doc.defaultView!.getComputedStyle(doc.getElementById('p')!).color);
    expect(contrastRatio(text, bg)).toBeGreaterThan(4.5);
  });

  it('darkens the inline background when a cell has both', () => {
    const doc = render('<table><tr><td id="x" bgcolor="#000000" style="background-color:#ffffff">Hello</td></tr></table>');
    expect(lightness(rewrittenBg(doc.getElementById('x')!))).toBeLessThan(40);
  });

  it('keeps a vivid bgcolor as sent', () => {
    const doc = render('<table><tr><td id="x" bgcolor="#e30613" style="color:#ffffff">Sale</td></tr></table>');
    const cell = doc.getElementById('x')!;
    expect(c(doc.defaultView!.getComputedStyle(cell).backgroundColor)).toEqual(c('rgb(227, 6, 19)'));
    expect(cell.style.getPropertyValue('background-color')).toBe('');
  });

  it('darkens a white body bgcolor', () => {
    const doc = render('<p id="p" style="color:#222222">Hello</p>', '#ffffff');
    expect(lightness(rewrittenBg(doc.body))).toBeLessThan(40);
  });
});
