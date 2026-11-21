import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  adaptTextColor,
  applyEmailDarkMode,
  contrastRatio,
  darkenBackground,
  DARK_PENDING_CLASS,
  emailColorScheme,
  emailDarkModeCss,
  flipFilterMatrix,
  formatColor,
  judgeImagePixels,
  parseColor,
  parseComputedColor,
  readSurfaceColor,
  resolveColorSchemeMedia,
  type Rgba,
} from '../email-dark-mode';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sanitizeEmailBodyForIframe } from '../email-sanitization';
import createEmailDarkModeEngine from '../email-dark-mode-engine';
import { BUILTIN_THEMES } from '../builtin-themes';

const c = (value: string): Rgba => parseComputedColor(value)!;
const lightness = ({ r, g, b }: Rgba) => (r + g + b) / 3;
const WHITE = c('rgb(255, 255, 255)');

const apcaLc = (text: Rgba, bg: Rgba) => {
  const y = ({ r, g, b }: Rgba) => 0.2126729 * (r / 255) ** 2.4 + 0.7151522 * (g / 255) ** 2.4 + 0.072175 * (b / 255) ** 2.4;
  const clamp = (v: number) => (v > 0.022 ? v : v + (0.022 - v) ** 1.414);
  const t = clamp(y(text)), s = clamp(y(bg));
  const lc = s > t ? (s ** 0.56 - t ** 0.57) * 1.14 : (s ** 0.65 - t ** 0.62) * 1.14;
  return Math.abs(lc) < 0.1 ? 0 : (Math.abs(lc) - 0.027) * 100;
};

const CANVASES = ['rgb(10, 10, 10)', 'rgb(46, 52, 64)', 'rgb(30, 30, 46)'];

describe('darkenBackground', () => {
  it.each(CANVASES)('lands white exactly on the surface the mail sits on (%s)', (canvas) => {
    expect(formatColor(darkenBackground(WHITE, c(canvas)))).toBe(canvas);
  });

  it('keeps a light grey page and the white card on it apart', () => {
    const canvas = c('rgb(20, 20, 20)');
    const card = darkenBackground(WHITE, canvas);
    const page = darkenBackground(c('rgb(242, 242, 242)'), canvas);
    expect(contrastRatio(page, card)).toBeGreaterThan(1.1);
    expect(lightness(page)).toBeGreaterThan(lightness(card));
  });

  it.each([
    ['Solarized', 'rgb(0, 43, 54)'],
    ['Nord', 'rgb(46, 52, 64)'],
  ])('gives a dark neutral fill the tint of %s at the same lightness', (_name, hex) => {
    const grey = c('rgb(30, 30, 30)');
    const out = darkenBackground(grey, c(hex));
    expect(out.b).toBeGreaterThan(out.r + 3);
    expect(contrastRatio(out, grey)).toBeLessThan(1.08);
    expect(contrastRatio(out, WHITE)).toBeGreaterThan(14);
  });

  it('leaves dark fills as sent on a neutral surface', () => {
    expect(formatColor(darkenBackground(c('rgb(30, 30, 30)'), c('rgb(10, 10, 10)')))).toBe('rgb(30, 30, 30)');
    expect(formatColor(darkenBackground(c('rgb(0, 0, 0)'), c('rgb(0, 43, 54)')))).toBe('rgb(0, 0, 0)');
  });

  it('keeps the hue of a light tint', () => {
    const out = darkenBackground(c('rgb(214, 233, 248)'));
    expect(lightness(out)).toBeLessThan(80);
    expect(out.b).toBeGreaterThan(out.r);
  });

  it('dims a bright brand fill in its own hue', () => {
    const orange = c('rgb(243, 128, 32)');
    const out = darkenBackground(orange);
    expect(lightness(out)).toBeLessThan(lightness(orange) * 0.7);
    expect(out.r).toBeGreaterThan(out.g);
    expect(out.g).toBeGreaterThan(out.b);
    expect(contrastRatio(WHITE, out)).toBeGreaterThan(4.5);
  });

  it('leaves deep brand colours and dark fills as sent', () => {
    const red = c('rgb(227, 6, 19)');
    const navy = c('rgb(0, 32, 91)');
    expect(darkenBackground(red)).toBe(red);
    expect(darkenBackground(navy)).toBe(navy);
  });

  it('keeps alpha', () => {
    expect(darkenBackground(c('rgba(255, 255, 255, 0.5)')).a).toBe(0.5);
  });
});

describe('adaptTextColor', () => {
  const canvas = c('rgb(20, 20, 20)');

  it.each([
    ['grey fine print on Nord', 'rgb(153, 153, 153)', 'rgb(46, 52, 64)', 'rgb(255, 255, 255)'],
    ['grey fine print on Roundcube Elastic', 'rgb(153, 153, 153)', 'rgb(42, 51, 54)', 'rgb(255, 255, 255)'],
    ['white on a dimmed gold banner', 'rgb(255, 255, 255)', 'rgb(152, 115, 53)', 'rgb(232, 192, 129)'],
    ['grey link on near-black', 'rgb(134, 134, 139)', 'rgb(13, 13, 13)', 'rgb(255, 255, 255)'],
  ])('keeps %s at 4.5:1 once painted', (_name, text, bg, sentBg) => {
    const out = adaptTextColor(c(text), c(bg), c(sentBg));
    const painted = c(formatColor(out));
    expect(contrastRatio(painted, c(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it('turns body text near white, but not glaring', () => {
    const out = adaptTextColor(c('rgb(0, 0, 0)'), canvas, WHITE);
    expect(contrastRatio(out, canvas)).toBeGreaterThan(11.5);
    expect(out.r).toBeLessThan(235);
  });

  it('keeps secondary greys dimmer than body text, and readable', () => {
    const body = adaptTextColor(c('rgb(34, 34, 34)'), canvas, WHITE);
    const muted = adaptTextColor(c('rgb(120, 120, 120)'), canvas, WHITE);
    expect(lightness(muted)).toBeLessThan(lightness(body));
    expect(contrastRatio(muted, canvas)).toBeGreaterThanOrEqual(4.5);
  });

  it('lifts a brand-blue link into a readable blue', () => {
    const out = adaptTextColor(c('rgb(26, 115, 232)'), canvas, WHITE);
    expect(contrastRatio(out, canvas)).toBeGreaterThanOrEqual(4.5);
    expect(out.b).toBeGreaterThan(out.r + 40);
  });

  it('keeps a red link red', () => {
    const out = adaptTextColor(c('rgb(200, 0, 0)'), canvas, WHITE);
    expect(out.r).toBeGreaterThan(out.g + 60);
  });

  it('keeps dark text that reads on a kept mid-tone fill', () => {
    const black = c('rgb(0, 0, 0)');
    const green = c('rgb(0, 150, 0)');
    expect(adaptTextColor(black, green, green)).toBe(black);
  });

  it('leaves light text on a kept dark banner alone', () => {
    const white = c('rgb(255, 255, 255)');
    const navy = c('rgb(0, 32, 91)');
    expect(adaptTextColor(white, navy, navy)).toBe(white);
  });
});

describe('parseColor', () => {
  const painted: string[] = [];
  const probeDoc = (pixel: [number, number, number, number]) => ({
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => {
        let fill = '';
        return {
          set fillStyle(v: string) { fill = v; },
          get fillStyle() { return fill; },
          clearRect() {},
          fillRect() { painted.push(fill); },
          getImageData: () => ({ data: Uint8ClampedArray.from(pixel) }),
        };
      },
    }),
  }) as unknown as Document;

  it('reads the rgb() forms directly', () => {
    expect(parseColor('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseColor('transparent')!.a).toBe(0);
  });

  it('converts oklch() and other modern syntaxes', () => {
    expect(parseColor('oklch(0.62 0.2 255)', probeDoc([40, 120, 230, 255]))).toEqual({ r: 40, g: 120, b: 230, a: 1 });
    expect(painted.at(-1)).toBe('oklch(0.62 0.2 255)');
  });

  it('converts the hex and named colours a host passes', () => {
    expect(parseColor('#0a0a0a', probeDoc([10, 10, 10, 255]))).toEqual({ r: 10, g: 10, b: 10, a: 1 });
  });

  it('gives up on keywords it cannot paint', () => {
    expect(parseColor('currentcolor', probeDoc([0, 0, 0, 255]))).toBeNull();
  });
});

describe('readSurfaceColor', () => {
  const tree = (html: string) => {
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    return host;
  };

  it('is the background of the nearest painted ancestor', () => {
    const host = tree('<section style="background-color: rgb(46, 52, 64)"><div><iframe id="f"></iframe></div></section>');
    expect(readSurfaceColor(host.querySelector('#f')!)).toEqual(c('rgb(46, 52, 64)'));
  });

  it('blends see-through layers onto what is behind them', () => {
    const host = tree('<section style="background-color: rgb(0, 0, 0)"><div style="background-color: rgba(255, 255, 255, 0.1)"><iframe id="f"></iframe></div></section>');
    const out = readSurfaceColor(host.querySelector('#f')!);
    expect(Math.round(out.r)).toBe(26);
    expect(out.a).toBe(1);
  });

  it('falls back to white when nothing is painted', () => {
    const host = tree('<div><iframe id="f"></iframe></div>');
    expect(readSurfaceColor(host.querySelector('#f')!, WHITE)).toEqual(WHITE);
  });
});

describe('judgeImagePixels', () => {
  const bg = c('rgb(20, 20, 20)');
  const image = (w: number, h: number, px: (x: number, y: number) => [number, number, number, number]) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(px(x, y), (y * w + x) * 4);
    return data;
  };

  it('flips a black logo on a see-through background', () => {
    const logo = image(40, 20, (x, y) => (x > 5 && x < 35 && y > 5 && y < 15 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
    expect(judgeImagePixels(logo, bg)).toBe('flip');
  });

  it('leaves a see-through logo that already reads on dark', () => {
    const logo = image(40, 20, (x, y) => (x > 5 && x < 35 && y > 5 && y < 15 ? [243, 128, 32, 255] : [0, 0, 0, 0]));
    expect(judgeImagePixels(logo, bg)).toBe('fine');
  });

  it('flips a flat black wordmark saved on a white box', () => {
    const logo = image(40, 20, (x, y) => (x > 5 && x < 35 && y > 7 && y < 13 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    expect(judgeImagePixels(logo, bg)).toBe('flip');
  });

  it('never touches a photo', () => {
    const photo = image(40, 40, (x, y) => [80 + x * 3, 60 + y * 4, 120 + ((x * y) % 90), 255]);
    expect(judgeImagePixels(photo, bg)).toBe('fine');
  });

  it('leaves a shaded product shot on white', () => {
    const shot = image(40, 40, (x, y) => {
      const d = Math.hypot(x - 20, y - 20);
      const v = d < 14 ? Math.round(60 + d * 10) : 255;
      return [v, v, v, 255];
    });
    expect(judgeImagePixels(shot, bg)).toBe('fine');
  });
});

describe('flipFilterMatrix', () => {
  const apply = (m: number[], { r, g, b }: Rgba): Rgba => {
    const v = [r / 255, g / 255, b / 255, 1];
    const row = (i: number) => Math.min(1, Math.max(0, m[i * 5] * v[0] + m[i * 5 + 1] * v[1] + m[i * 5 + 2] * v[2] + m[i * 5 + 3] * v[3] + m[i * 5 + 4]));
    return { r: row(0) * 255, g: row(1) * 255, b: row(2) * 255, a: 1 };
  };
  const canvas = c('rgb(46, 52, 64)');
  const m = flipFilterMatrix(canvas);

  it('lands white on the surface and black on white', () => {
    expect(formatColor(apply(m, WHITE))).toBe(formatColor(canvas));
    expect(formatColor(apply(m, c('rgb(0, 0, 0)')))).toBe('rgb(255, 255, 255)');
  });

  it('keeps an orange symbol orange', () => {
    const out = apply(m, c('rgb(243, 128, 32)'));
    expect(out.r).toBeGreaterThan(out.g);
    expect(out.g).toBeGreaterThan(out.b);
  });
});

describe('the shared engine source', () => {
  const source = readFileSync(join(__dirname, '../email-dark-mode-engine.js'), 'utf8');
  const expression = source.slice(source.indexOf('export default ') + 'export default '.length);

  it('has no template literals', () => {
    expect(expression).not.toContain('`');
    expect(expression).not.toContain('${');
  });

  it('names no URL', () => {
    expect(expression).not.toMatch(/https?:\/\//);
  });

  it('uses ES5 syntax only', () => {
    const code = expression.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/catch\s*\{/);
    expect(code).not.toMatch(/=>/);
    expect(code).not.toMatch(/\b(let|const|class)\s/);
    expect(code).not.toMatch(/\.\.\./);
  });
});

describe('every built-in theme', () => {
  const darkBackground = (css: string) => {
    const block = css.slice(css.indexOf('.dark {'));
    return block.match(/--color-background:\s*(#[0-9a-f]{6})/i)![1];
  };
  const globals = readFileSync(join(__dirname, '../../app/globals.css'), 'utf8');
  const surfaces: [string, string][] = [
    ['default', darkBackground(globals)],
    ...BUILTIN_THEMES.map((theme): [string, string] => [theme.id, darkBackground(theme.css)]),
  ];

  const hexColor = (hex: string): Rgba => {
    const n = parseInt(hex.slice(1), 16);
    return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, a: 1 };
  };

  it.each(surfaces)('lands white exactly on the dark background of %s (%s)', (_id, hex) => {
    const surface = hexColor(hex);
    expect(formatColor(darkenBackground(WHITE, surface))).toBe(formatColor(surface));
  });

  const apca = apcaLc;
  const SENT: [string, string, string][] = [
    ['body text', 'rgb(34, 34, 34)', 'rgb(255, 255, 255)'],
    ['grey fine print', 'rgb(153, 153, 153)', 'rgb(255, 255, 255)'],
    ['light grey footer', 'rgb(170, 170, 170)', 'rgb(255, 255, 255)'],
    ['a brand-blue link', 'rgb(9, 105, 218)', 'rgb(255, 255, 255)'],
    ['a sky-blue link', 'rgb(0, 148, 231)', 'rgb(255, 255, 255)'],
    ['a green link', 'rgb(0, 160, 100)', 'rgb(255, 255, 255)'],
  ];
  const cases = surfaces.flatMap(([id, hex]) => SENT.map(([what, text, sentBg]) => [id, what, hex, text, sentBg] as const));

  it.each(cases)('on %s, keeps %s readable by APCA', (_id, _what, hex, text, sentBg) => {
    const surface = hexColor(hex);
    const out = c(formatColor(adaptTextColor(c(text), surface, c(sentBg))));
    expect(contrastRatio(out, surface)).toBeGreaterThanOrEqual(4.5);
    expect(apca(out, surface)).toBeGreaterThanOrEqual(60);
  });

  it.each(surfaces)('on %s, gives body text the same perceived contrast', (_id, hex) => {
    const surface = hexColor(hex);
    const body = c(formatColor(adaptTextColor(c('rgb(0, 0, 0)'), surface, WHITE)));
    expect(apca(body, surface)).toBeGreaterThanOrEqual(83);
    expect(apca(body, surface)).toBeLessThanOrEqual(88);
  });

  it.each([
    ['gold', 'rgb(152, 115, 53)', 'rgb(12, 12, 12)'],
    ['mid green', 'rgb(0, 150, 0)', 'rgb(0, 0, 0)'],
    ['trading green', 'rgb(15, 144, 92)', 'rgb(0, 0, 0)'],
    ['Cloudflare orange', 'rgb(243, 128, 32)', 'rgb(255, 255, 255)'],
    ['lime with a dark red label', 'rgb(150, 222, 84)', 'rgb(128, 0, 0)'],
    ['mid green with a red label', 'rgb(0, 150, 0)', 'rgb(200, 0, 0)'],
    ['gold with a red label', 'rgb(152, 115, 53)', 'rgb(200, 0, 0)'],
  ])('lets the label on a %s fill pass both checks', (_what, fill, label) => {
    const canvas = hexColor(surfaces[0][1]);
    const sent = c(fill);
    const out = darkenBackground(sent, canvas);
    const text = c(formatColor(adaptTextColor(c(label), out, sent)));
    expect(contrastRatio(text, out)).toBeGreaterThanOrEqual(4.5);
    expect(apca(text, out)).toBeGreaterThanOrEqual(60);
  });
});

describe('emailDarkModeCss', () => {
  it('paints no canvas of its own, so the surface shows through', () => {
    const css = emailDarkModeCss();
    expect(css).not.toMatch(/background(-color)?:\s*#/);
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
  const surface = c('rgb(46, 52, 64)');
  const frameDoc = () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const doc = frame.contentDocument!;
    doc.documentElement.className = DARK_PENDING_CLASS;
    return doc;
  };
  const render = (body: string) => {
    const doc = frameDoc();
    doc.body.innerHTML = body;
    applyEmailDarkMode(doc, { canvas: surface });
    return doc;
  };
  const bgOf = (el: Element) => c(el.ownerDocument.defaultView!.getComputedStyle(el).backgroundColor);
  const colorOf = (el: Element) => c(el.ownerDocument.defaultView!.getComputedStyle(el).color);
  const seenBehind = (el: Element) => readSurfaceColor(el, surface);

  // jsdom doesn't map presentational attributes (bgcolor) into computed
  // style, so these use inline styles; browsers treat both the same.
  it('lets the surface show through a white cell that sits right on it', () => {
    const doc = render('<table><tr><td id="a" style="background-color:#fff">y</td></tr></table>');
    expect(bgOf(doc.getElementById('a')!).a).toBe(0);
    expect(doc.getElementById('a')!.style.getPropertyPriority('background-color')).toBe('important');
  });

  it('paints a white card on a grey page in the surface colour', () => {
    const doc = render('<div style="background-color:#f2f2f2"><div id="card" style="background-color:#fff">Hi</div></div>');
    expect(bgOf(doc.getElementById('card')!)).toEqual(surface);
  });

  it('makes dark text on a darkened cell readable', () => {
    const doc = render('<div style="background-color:#fff"><p id="p" style="color:#222">text</p></div>');
    const p = doc.getElementById('p')!;
    expect(contrastRatio(colorOf(p), seenBehind(p))).toBeGreaterThan(4.5);
  });

  it('keeps a grey page and a white card on it apart', () => {
    const doc = render('<div id="page" style="background-color:#f2f2f2"><div id="card" style="background-color:#fff">Hi</div></div>');
    expect(contrastRatio(bgOf(doc.getElementById('page')!), bgOf(doc.getElementById('card')!))).toBeGreaterThan(1.1);
  });

  it('dims a bright brand button and keeps its label readable', () => {
    const doc = render('<a id="btn" style="background-color:#f38020;color:#ffffff">Renew</a>');
    const btn = doc.getElementById('btn')!;
    expect(lightness(bgOf(btn))).toBeLessThan(lightness(c('rgb(243, 128, 32)')) * 0.7);
    expect(contrastRatio(colorOf(btn), bgOf(btn))).toBeGreaterThan(4.5);
  });

  it('moves the underline along with a link colour it changes', () => {
    const doc = render('<a id="a" href="#" style="color:#1a73e8">Link</a>');
    const a = doc.getElementById('a')!;
    expect(a.style.getPropertyValue('color')).not.toBe('');
    expect(c(a.style.getPropertyValue('color'))).not.toEqual(c('rgb(26, 115, 232)'));
    expect(a.style.getPropertyValue('text-decoration-color')).toBe(a.style.getPropertyValue('color'));
  });

  const fadeOf = (el: Element) => {
    let o = 1;
    for (let e: Element | null = el; e; e = e.parentElement) o *= parseFloat(el.ownerDocument.defaultView!.getComputedStyle(e).opacity || '1');
    return o;
  };
  const paintedText = (el: Element) => {
    const col = colorOf(el), bg = seenBehind(el), a = col.a * fadeOf(el);
    return { r: Math.round(col.r * a + bg.r * (1 - a)), g: Math.round(col.g * a + bg.g * (1 - a)), b: Math.round(col.b * a + bg.b * (1 - a)), a: 1 };
  };

  it('folds a footer fade into its text colour, so it reads', () => {
    const doc = render(
      '<div id="pre" style="opacity:0;color:#000">Preview text</div>' +
      '<p id="body" style="color:#191919">Body text</p>' +
      '<div id="foot" style="font-size:12px;opacity:0.5;color:#696969">Our Blog | <a id="link" href="#" style="color:#696969">Help Center</a></div>' +
      '<p id="copy" style="color:#191919;opacity:0.4">Home</p>' +
      '<div id="logo" style="opacity:0.5;color:#fff">Powered by <img id="mark" alt="" src="data:image/png;base64,AAAA"></div>',
    );
    const get = (id: string) => doc.getElementById(id)!;
    for (const id of ['foot', 'link', 'copy', 'logo']) {
      const seen = paintedText(get(id));
      expect(contrastRatio(seen, seenBehind(get(id)))).toBeGreaterThanOrEqual(4.5);
      expect(apcaLc(seen, seenBehind(get(id)))).toBeGreaterThanOrEqual(60);
    }
    expect(lightness(paintedText(get('copy')))).toBeLessThan(lightness(paintedText(get('body'))));
    expect(fadeOf(get('pre'))).toBe(0);
    expect(fadeOf(get('mark'))).toBeCloseTo(0.5);
  });

  it('keeps a folded box its own stacking context', () => {
    const doc = render('<div style="position:absolute;left:0;top:0;width:200px;height:40px;background:red"></div><div id="foot" style="opacity:0.5;color:#000">Footer</div>');
    const foot = doc.getElementById('foot')!;
    expect(fadeOf(foot)).toBe(1);
    expect(foot.style.getPropertyValue('isolation')).toBe('isolate');
  });

  it('keeps a fade it cannot fold safely', () => {
    const doc = render(
      '<div style="opacity:0.25;color:#000"><span id="twice" style="opacity:0.25">Hidden preheader</span></div>' +
      '<div style="opacity:0.1;color:#000"><span id="under" style="opacity:0.5">Near invisible</span></div>' +
      '<div style="opacity:0.5;color:#000">Powered by <picture><img id="nested" alt="" style="opacity:0.8" src="data:image/png;base64,AAAA"></picture></div>' +
      '<div style="background-image:url(data:image/png;base64,AAAA)"><div style="opacity:0.5;color:#000">Powered by <img id="onpic" alt="" style="opacity:0.8" src="data:image/png;base64,AAAA"></div></div>' +
      '<div id="stacked" style="position:relative;opacity:0.5;color:#000">Footer <span style="position:absolute;z-index:10">A</span></div>' +
      '<div id="hidden" style="opacity:0.5;color:#000"><span style="display:none">x</span><img alt="" src="data:image/png;base64,AAAA"></div>',
    );
    const get = (id: string) => doc.getElementById(id)!;
    expect(fadeOf(get('twice'))).toBeCloseTo(0.0625);
    expect(fadeOf(get('under'))).toBeCloseTo(0.05);
    expect(fadeOf(get('nested'))).toBeCloseTo(0.4);
    expect(fadeOf(get('onpic'))).toBeCloseTo(0.4);
    expect(fadeOf(get('stacked'))).toBeCloseTo(0.5);
    expect(fadeOf(get('hidden'))).toBeCloseTo(0.5);
  });

  it('keeps the fade over a positioned picture', () => {
    const doc = render('<div id="box" style="opacity:0.5;color:#000">Footer <img alt="" style="position:absolute;z-index:10" src="data:image/png;base64,AAAA"></div>');
    expect(fadeOf(doc.getElementById('box')!)).toBeCloseTo(0.5);
  });

  it('keeps a fade over overlapping pictures, shadows and outlines', () => {
    const doc = render(
      '<div id="pulled" style="opacity:0.5;color:#000">Footer <img alt="" width="40" src="data:image/png;base64,AAAA"><img alt="" width="40" style="margin-left:-40px" src="data:image/png;base64,AAAA"></div>' +
      '<div id="shadow" style="opacity:0.5;color:#000;box-shadow:0 0 0 10px red">Footer</div>' +
      '<div id="glow" style="opacity:0.5;color:#000"><span style="text-shadow:0 0 4px red">Footer</span></div>' +
      '<div id="outline" style="opacity:0.5;color:#000;outline-style:solid;outline-width:2px;outline-color:red">Footer</div>',
    );
    for (const id of ['pulled', 'shadow', 'glow', 'outline']) expect(fadeOf(doc.getElementById(id)!)).toBeCloseTo(0.5);
  });

  it('decides folds in one pass', () => {
    const doc = frameDoc();
    doc.body.innerHTML = '<div style="opacity:0.999">'.repeat(400) + '<span id="deep">Footer</span>' + '</div>'.repeat(400);
    const win = doc.defaultView!;
    const spy = vi.spyOn(win, 'getComputedStyle');
    applyEmailDarkMode(doc, { canvas: surface });
    expect(spy.mock.calls.length).toBeLessThan(6000);
    spy.mockRestore();
    expect(fadeOf(doc.getElementById('deep')!)).toBe(1);
  });

  it('folds a footer after a long faded section', () => {
    const doc = render(
      '<div style="opacity:0.9"><div style="opacity:0.9"><div style="opacity:0.9">' + '<span>x</span>'.repeat(2100) + '</div></div></div>' +
      '<div id="foot" style="opacity:0.5;color:#000">Footer</div>',
    );
    expect(fadeOf(doc.getElementById('foot')!)).toBe(1);
  }, 20000);

  it('keeps a fade under one that stays', () => {
    const doc = render('<div style="opacity:0.5;background-color:red"><span id="inner" style="opacity:0.8;color:#000">Footer</span></div>');
    expect(fadeOf(doc.getElementById('inner')!)).toBeCloseTo(0.4);
    const page = frameDoc();
    page.documentElement.style.opacity = '0.1';
    page.body.innerHTML = '<div id="pre" style="opacity:0.5;color:#000">Hidden preheader</div>';
    applyEmailDarkMode(page, { canvas: surface });
    expect(page.defaultView!.getComputedStyle(page.getElementById('pre')!).opacity).toBe('0.5');
  });

  it('keeps a fade over filters, blending and list markers', () => {
    const doc = render(
      '<div id="filter" style="opacity:0.5;color:#000;filter:drop-shadow(0 0 4px red)">Footer</div>' +
      '<div id="blend" style="opacity:0.5;color:#000"><span style="mix-blend-mode:multiply">Footer</span></div>' +
      '<ul id="list" style="opacity:0.5;color:#000"><li>Footer</li></ul>' +
      '<div id="frame" style="opacity:0.5;color:#000;border:4px solid transparent;border-image-source:linear-gradient(red, blue);border-image-slice:1">Footer</div>',
    );
    for (const id of ['filter', 'blend', 'list', 'frame']) expect(fadeOf(doc.getElementById(id)!)).toBeCloseTo(0.5);
  });

  it('keeps a faded border as faint as sent', () => {
    const doc = render(
      '<div id="faded" style="opacity:0.5;color:#000;border-top:2px solid #000">Footer</div>' +
      '<div id="solid" style="color:#000;border-top:2px solid #000">Footer</div>',
    );
    const rule = (el: Element) => {
      const b = c(el.ownerDocument.defaultView!.getComputedStyle(el).borderTopColor);
      const bg = seenBehind(el), a = b.a * fadeOf(el);
      return contrastRatio({ r: b.r * a + bg.r * (1 - a), g: b.g * a + bg.g * (1 - a), b: b.b * a + bg.b * (1 - a), a: 1 }, bg);
    };
    expect(rule(doc.getElementById('faded')!)).toBeLessThan(rule(doc.getElementById('solid')!));
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
    expect(seenBehind(doc.getElementById('hero')!)).toEqual(surface);
    expect(doc.getElementById('p')!.style.getPropertyPriority('color')).toBe('important');
  });

  it('lets the surface show through a mail without colours', () => {
    const doc = render('<p id="p">Plain text</p>');
    expect(bgOf(doc.body).a).toBe(0);
    expect(bgOf(doc.documentElement).a).toBe(0);
  });

  it('reads the document past named elements of the mail', () => {
    const doc = render('<img name="body" alt=""><img name="documentElement" alt=""><img name="defaultView" alt=""><img name="createElement" alt=""><img name="getElementById" alt=""><div id="a" style="background-color:#fff">Hi</div>');
    const real = <T,>(name: string) => Object.getOwnPropertyDescriptor(Document.prototype, name)!.get!.call(doc) as T;
    const html = real<HTMLElement>('documentElement');
    const cell = html.querySelector<HTMLElement>('#a')!;
    expect(cell.style.getPropertyPriority('background-color')).toBe('important');
    expect(c(real<Window>('defaultView').getComputedStyle(cell).backgroundColor).a).toBe(0);
    expect(html.classList.contains(DARK_PENDING_CLASS)).toBe(false);
  });

  // A sender's own dark block - an HTML signature card, a dark header - was
  // lifted to grey to stand out from the darkened page, and its subtle frame
  // and inner rules were mirrored to near white.
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

  it('un-hides the body', () => {
    const doc = render('<p>hi</p>');
    expect(doc.documentElement.classList.contains(DARK_PENDING_CLASS)).toBe(false);
  });

  // Newsletters (Lieferando) paint the canvas through `html { background }`.
  // The pass only looked at the body, so that white stayed behind the mail
  // and was taken for our dark canvas.
  it('darkens a canvas the mail paints on <html>', () => {
    const doc = frameDoc();
    doc.documentElement.style.backgroundColor = '#ffffff';
    doc.body.style.backgroundColor = '#ffffff';
    doc.body.innerHTML = '<p>hi</p>';
    applyEmailDarkMode(doc, { canvas: surface });
    expect(bgOf(doc.documentElement).a).toBe(0);
    expect(bgOf(doc.body).a).toBe(0);
  });

  it('darkens a grey canvas the mail paints on <html>, a step off the surface', () => {
    const doc = frameDoc();
    doc.documentElement.style.backgroundColor = '#f2f2f2';
    doc.body.innerHTML = '<p>hi</p>';
    applyEmailDarkMode(doc, { canvas: surface });
    const html = bgOf(doc.documentElement);
    expect(html.a).toBe(1);
    expect(contrastRatio(html, surface)).toBeGreaterThan(1.1);
  });

  it.each([
    ['a positioned card over a coloured block', '<div style="background-color:#2e7d32;height:40px"></div><div id="card" style="position:absolute;top:0;background-color:#fff"><p id="p" style="color:#000">Text</p></div>'],
    ['a card inside a positioned box', '<div style="background-color:#2e7d32;height:40px"></div><div style="position:absolute;top:0"><div id="card" style="background-color:#fff"><p id="p" style="color:#000">Text</p></div></div>'],
    ['a card pulled up by a negative margin', '<div style="background-color:#2e7d32;height:40px"></div><div id="card" style="margin-top:-30px;background-color:#fff"><p id="p" style="color:#000">Text</p></div>'],
    ['a card on a gradient', '<div style="background-image:linear-gradient(#2e7d32, #2e7d32)"><div id="card" style="background-color:#fff"><p id="p" style="color:#000">Text</p></div></div>'],
    ['a card in a mail with something behind its content', '<div style="position:absolute;z-index:-1;background-color:#2e7d32;inset:0"></div><div id="card" style="background-color:#fff"><p id="p" style="color:#000">Text</p></div>'],
    ['a card on a grid cell shared with a coloured block', '<div style="display:grid"><div style="grid-area:1/1;background-color:#c62828;height:40px"></div><div id="card" style="grid-area:1/1;background-color:#fff"><p id="p" style="color:#000">Text</p></div></div>'],
  ])('keeps the fill of %s', (_, mail) => {
    const doc = render(mail);
    const card = bgOf(doc.getElementById('card')!);
    expect(card).toEqual(surface);
    expect(contrastRatio(colorOf(doc.getElementById('p')!), card)).toBeGreaterThan(4.5);
  });

  it('keeps the body fill when the mail puts a picture on <html>', () => {
    const doc = frameDoc();
    doc.documentElement.style.backgroundImage = 'linear-gradient(#2e7d32, #2e7d32)';
    doc.body.style.backgroundColor = '#ffffff';
    doc.body.innerHTML = '<p>hi</p>';
    applyEmailDarkMode(doc, { canvas: surface });
    expect(bgOf(doc.body)).toEqual(surface);
  });

  const stopsOf = (el: Element) =>
    (el.ownerDocument.defaultView!.getComputedStyle(el).backgroundImage.match(/rgba?\([^()]*\)/g) ?? []).map(c);

  it('darkens a light gradient the mail paints on <html> under the text it lightens', () => {
    const doc = frameDoc();
    doc.documentElement.style.backgroundImage = 'linear-gradient(rgb(255, 255, 255), rgb(255, 255, 255))';
    doc.body.innerHTML = '<p id="p" style="color:#000">Hello</p>';
    applyEmailDarkMode(doc, { canvas: surface });
    const stops = stopsOf(doc.documentElement);
    expect(stops.length).toBeGreaterThan(0);
    const text = colorOf(doc.getElementById('p')!);
    stops.forEach((stop) => expect(contrastRatio(text, stop)).toBeGreaterThanOrEqual(4.5));
  });

  it.each([
    ['one grey', 'rgb(170, 170, 170), rgb(170, 170, 170)'],
    ['white to grey', 'rgb(255, 255, 255), rgb(170, 170, 170)'],
  ])('keeps text readable on every stop of a %s gradient', (_, stopsCss) => {
    const doc = render(`<p id="p" style="background-image:linear-gradient(${stopsCss});color:rgb(153, 153, 153)">Text</p>`);
    const p = doc.getElementById('p')!;
    const stops = stopsOf(p);
    expect(stops.length).toBe(2);
    stops.forEach((stop) => expect(contrastRatio(colorOf(p), stop)).toBeGreaterThanOrEqual(4.5));
  });

  it('keeps text readable under a fade it keeps on a box whose white fill it clears', () => {
    const doc = render('<div id="box" style="background-color:#fff;opacity:0.55"><span id="t" style="color:#000">Footer</span></div>');
    const box = doc.getElementById('box')!;
    const keep = parseFloat(doc.defaultView!.getComputedStyle(box).opacity);
    expect(keep).toBeCloseTo(0.55);
    const behind = readSurfaceColor(box.parentElement!, surface);
    const fill = bgOf(box);
    const under = fill.a > 0 ? { ...fill, a: 1 } : behind;
    const text = colorOf(doc.getElementById('t')!);
    const groupBg = { r: under.r * keep + behind.r * (1 - keep), g: under.g * keep + behind.g * (1 - keep), b: under.b * keep + behind.b * (1 - keep), a: 1 };
    const shown = { r: text.r * keep + behind.r * (1 - keep), g: text.g * keep + behind.g * (1 - keep), b: text.b * keep + behind.b * (1 - keep), a: 1 };
    expect(contrastRatio(shown, groupBg)).toBeGreaterThanOrEqual(4.5);
  });

  it('converts a mail only once', () => {
    const doc = render('<div id="a" style="background-color:#ffd60a"><span id="t" style="color:#5c5c5c">Label</span></div>');
    const once = [bgOf(doc.getElementById('a')!), colorOf(doc.getElementById('t')!)];
    applyEmailDarkMode(doc, { canvas: surface });
    expect([bgOf(doc.getElementById('a')!), colorOf(doc.getElementById('t')!)]).toEqual(once);
  });

  const onCanvas = (canvas: Rgba, body: string) => {
    const doc = frameDoc();
    doc.body.innerHTML = body;
    applyEmailDarkMode(doc, { canvas });
    return doc;
  };
  const side = (el: Element, which: string) => c(el.ownerDocument.defaultView!.getComputedStyle(el).getPropertyValue(`border-${which}-color`));
  const SIGNATURE = '<table id="card" cellpadding="0" cellspacing="0" style="background-color:#0a0e16;border-top:1px solid #1d2430;border-right:1px solid #1d2430;border-bottom:1px solid #1d2430;border-left:3px solid #c6f24e"><tbody><tr><td style="padding:16px 20px">'
    + '<div id="name" style="color:#e7ecf3">Jane Doe</div><div id="role" style="color:#c6f24e">Engineer</div>'
    + '<div id="rule" style="border-top:1px solid #1d2430;margin:11px 0">&nbsp;</div></td></tr></tbody></table>';

  it.each(CANVASES.slice(0, 2))('keeps a framed dark card and what the sender drew inside it on %s', (canvasCss) => {
    const canvas = c(canvasCss);
    const doc = onCanvas(canvas, SIGNATURE);
    const card = doc.getElementById('card')!;
    const fill = bgOf(card);
    expect(lightness(fill)).toBeLessThan(lightness(c('rgb(10, 14, 22)')) + 6);
    expect(side(doc.getElementById('rule')!, 'top')).toEqual(c('rgb(29, 36, 48)'));
    expect(side(card, 'left')).toEqual(c('rgb(198, 242, 78)'));
    expect(contrastRatio(colorOf(doc.getElementById('name')!), fill)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colorOf(doc.getElementById('role')!), fill)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(CANVASES.slice(0, 2))('lifts the thin frame of a dark card in its own hue until it shows on %s', (canvasCss) => {
    const canvas = c(canvasCss);
    const doc = onCanvas(canvas, SIGNATURE);
    const frame = side(doc.getElementById('card')!, 'top');
    expect(contrastRatio(frame, canvas)).toBeGreaterThanOrEqual(1.6);
    expect(lightness(frame)).toBeLessThan(110);
    expect(frame.b).toBeGreaterThan(frame.r);
  });

  it.each(CANVASES.slice(0, 2))('keeps a borderless near-black button on a white card apart from the page on %s', (canvasCss) => {
    const canvas = c(canvasCss);
    const doc = onCanvas(canvas, '<div id="card" style="background-color:#fff;padding:20px"><a id="btn" href="#" style="display:inline-block;background-color:#111111;color:#fff;padding:10px 16px">Get started</a></div>');
    const btn = doc.getElementById('btn')!;
    const around = readSurfaceColor(doc.getElementById('card')!, canvas);
    const fill = readSurfaceColor(btn, canvas);
    expect(contrastRatio(fill, around)).toBeGreaterThanOrEqual(1.8);
    expect(contrastRatio(colorOf(btn), fill)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(CANVASES.slice(0, 2))('keeps a rule on a brand banner as sent, but darkens the frame of a light card on it on %s', (canvasCss) => {
    const doc = onCanvas(c(canvasCss),
      '<div id="banner" style="background-color:#1a73e8"><p id="rule" style="border-bottom:2px solid #ffffff;color:#fff">Rule</p>'
      + '<div id="card" style="background-color:#ffffff;border:1px solid #dddddd">Card</div></div>');
    expect(bgOf(doc.getElementById('banner')!)).toEqual(c('rgb(26, 115, 232)'));
    expect(side(doc.getElementById('rule')!, 'bottom')).toEqual(WHITE);
    const card = doc.getElementById('card')!;
    expect(lightness(bgOf(card))).toBeLessThan(80);
    expect(lightness(side(card, 'top'))).toBeLessThan(110);
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
    if (bodyBgcolor) doc.body.setAttribute('bgcolor', bodyBgcolor);
    doc.body.innerHTML = html;
    mapBgcolorLikeBrowser(doc);
    applyEmailDarkMode(doc, { canvas: c('rgb(20, 20, 20)') });
    return doc;
  };

  const rewrittenBg = (el: HTMLElement) => {
    expect(el.style.getPropertyPriority('background-color')).toBe('important');
    return readSurfaceColor(el, c('rgb(20, 20, 20)'));
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

  it('keeps a deep brand bgcolor as sent', () => {
    const doc = render('<table><tr><td id="x" bgcolor="#e30613" style="color:#ffffff">Sale</td></tr></table>');
    const cell = doc.getElementById('x')!;
    expect(c(doc.defaultView!.getComputedStyle(cell).backgroundColor)).toEqual(c('rgb(227, 6, 19)'));
    expect(cell.style.getPropertyValue('background-color')).toBe('');
  });

  it('turns a white body bgcolor into the surface', () => {
    const doc = render('<p id="p" style="color:#222222">Hello</p>', '#ffffff');
    expect(rewrittenBg(doc.body)).toEqual(c('rgb(20, 20, 20)'));
    expect(c(doc.defaultView!.getComputedStyle(doc.body).backgroundColor).a).toBe(0);
  });
});

describe('image flips', () => {
  const surface = c('rgb(20, 22, 26)');
  const blackLogo = (() => {
    const data = new Uint8ClampedArray(40 * 20 * 4);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) {
      if (x > 5 && x < 35 && y > 5 && y < 15) data.set([0, 0, 0, 255], (y * 40 + x) * 4);
    }
    return data;
  })();

  const setup = (readable: boolean, src = 'data:image/png;base64,AAAA', size: [number, number] = [40, 20]) => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const doc = frame.contentDocument!;
    const win = frame.contentWindow as unknown as typeof globalThis;
    vi.spyOn(win.HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
      drawImage() {},
      getImageData() {
        if (!readable) throw new Error('tainted');
        return { data: blackLogo };
      },
    })) as never);
    doc.body.innerHTML = `<div id="cell" style="background-color:#f2f2f2"><img id="logo" src="${src}" alt=""></div>`;
    const img = doc.getElementById('logo') as HTMLImageElement;
    Object.defineProperty(img, 'complete', { value: true });
    Object.defineProperty(img, 'naturalWidth', { value: size[0] });
    Object.defineProperty(img, 'naturalHeight', { value: size[1] });
    return { doc, img };
  };

  afterEach(() => vi.restoreAllMocks());

  it('flips a see-through black logo with a filter that lands white on the section around it', async () => {
    const { doc, img } = setup(true);
    await createEmailDarkModeEngine().apply(doc, { canvas: surface });
    const section = c(doc.defaultView!.getComputedStyle(doc.getElementById('cell')!).backgroundColor);
    expect(section).not.toEqual(surface);
    const id = /url\(["']?#([^"')]+)/.exec(img.style.getPropertyValue('filter'))![1];
    const filter = doc.getElementById(id)!;
    expect(filter.namespaceURI).toMatch(/svg$/);
    const values = filter.querySelector('feColorMatrix')!.getAttribute('values')!.split(' ').map(Number);
    flipFilterMatrix(section).forEach((v, i) => expect(values[i]).toBeCloseTo(v, 2));
    expect(filter.closest('svg')!.outerHTML).not.toMatch(/https?:/);
  });

  it('keeps a filter the sender set on a logo it flips', async () => {
    const { doc, img } = setup(true);
    img.style.setProperty('filter', 'grayscale(1)');
    await createEmailDarkModeEngine().apply(doc, { canvas: surface });
    expect(img.style.getPropertyValue('filter')).toMatch(/^grayscale\(1\) url\([^)]*\)$/);
  });

  it('flips a logo the sender turns black with a filter, after that filter', async () => {
    const { doc, img } = setup(true);
    const win = doc.defaultView as unknown as typeof globalThis;
    const whiteLogo = blackLogo.map((v, i) => (i % 4 === 3 ? v : 255));
    vi.spyOn(win.HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
      filter: 'none',
      drawImage() {},
      getImageData() {
        return { data: /brightness\(0\)/.test(this.filter) ? blackLogo : whiteLogo };
      },
    })) as never);
    img.style.setProperty('filter', 'brightness(0)');
    await createEmailDarkModeEngine().apply(doc, { canvas: surface });
    expect(img.style.getPropertyValue('filter')).toMatch(/^brightness\(0\) url\([^)]*\)$/);
  });

  it.each([
    ['brightness(0)', 255],
    ['invert(1)', 255],
    ['invert(100%)', 255],
  ])('judges a logo as the sender\'s %s draws it where the canvas has no filter', async (filter, channel) => {
    const { doc, img } = setup(true);
    const win = doc.defaultView as unknown as typeof globalThis;
    const lightLogo = blackLogo.map((v, i) => (i % 4 === 3 ? v : channel));
    vi.spyOn(win.HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
      drawImage() {},
      getImageData() {
        return { data: lightLogo };
      },
    })) as never);
    img.style.setProperty('filter', filter);
    await createEmailDarkModeEngine().apply(doc, { canvas: surface });
    expect(img.style.getPropertyValue('filter')).toMatch(/url\(/);
    expect(lightLogo[0 + (6 * 40 + 6) * 4]).toBe(channel);
  });

  it('keeps a light logo under a sender filter that leaves it light', async () => {
    const { doc, img } = setup(true);
    const win = doc.defaultView as unknown as typeof globalThis;
    const lightLogo = blackLogo.map((v, i) => (i % 4 === 3 ? v : 255));
    vi.spyOn(win.HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
      drawImage() {},
      getImageData() {
        return { data: lightLogo };
      },
    })) as never);
    img.style.setProperty('filter', 'grayscale(1)');
    await createEmailDarkModeEngine().apply(doc, { canvas: surface });
    expect(img.style.getPropertyValue('filter')).toBe('grayscale(1)');
  });

  it('darkens the white box of a <picture> around a logo it flips', async () => {
    const { doc, img } = setup(true);
    const picture = doc.createElement('picture');
    picture.style.cssText = 'display:block;background-color:#fff';
    img.replaceWith(picture);
    picture.appendChild(img);
    await createEmailDarkModeEngine().apply(doc, { canvas: surface });
    const box = c(doc.defaultView!.getComputedStyle(picture).backgroundColor);
    expect(img.style.getPropertyValue('filter')).toMatch(/url\(/);
    expect(lightness(box)).toBeLessThan(128);
  });

  it('flips a logo in a mail that names its elements after the document', async () => {
    const { doc, img } = setup(true);
    doc.getElementById('cell')!.insertAdjacentHTML('beforeend', '<img name="createElement" alt=""><img name="getElementById" alt=""><img name="body" alt="">');
    await createEmailDarkModeEngine().apply(doc, { canvas: surface });
    expect(img.style.getPropertyValue('filter')).toMatch(/^url\(/);
  });

  it('puts the original light box behind a logo it cannot read', async () => {
    const { doc, img } = setup(false);
    await createEmailDarkModeEngine().apply(doc, { canvas: surface });
    expect(img.style.getPropertyValue('filter')).toBe('');
    expect(c(img.style.getPropertyValue('background-color'))).toEqual(c('rgb(242, 242, 242)'));
  });

  it('makes no request for unreadable pixels while remote content is blocked', async () => {
    const { doc, img } = setup(false, 'https://example.com/logo.png');
    const created = vi.spyOn(Document.prototype, 'createElement');
    await createEmailDarkModeEngine().apply(doc, { canvas: surface });
    expect(created.mock.calls.some(([tag]) => tag === 'img')).toBe(false);
    expect(img.style.getPropertyValue('filter')).toBe('');
  });

  it('reads a remote image once more, with CORS and no referrer, only when remote content is allowed', async () => {
    const { doc } = setup(false, 'https://example.com/logo.png');
    const created = vi.spyOn(Document.prototype, 'createElement');
    void createEmailDarkModeEngine().apply(doc, { canvas: surface, remoteContentAllowed: true });
    await new Promise((r) => setTimeout(r, 0));
    const copies = created.mock.results.filter((r, i) => created.mock.calls[i][0] === 'img').map((r) => r.value as HTMLImageElement);
    expect(copies).toHaveLength(1);
    expect(copies[0].crossOrigin).toBe('anonymous');
    expect(copies[0].referrerPolicy).toBe('no-referrer');
    expect(copies[0].src).toBe('https://example.com/logo.png');
  });
});

describe('one-colour picture backgrounds', () => {
  const surface = c('rgb(46, 52, 64)');
  const flat = (rgb: number[], alpha = 255) => {
    const data = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([...rgb, alpha], i);
    return data;
  };
  const photo = (() => {
    const data = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([(i * 37) % 255, (i * 11) % 255, (i * 5) % 255, 255], i);
    return data;
  })();

  const setup = (pixels: Uint8ClampedArray | null, cellStyle: string, src = 'data:image/webp;base64,AAAA') => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const doc = frame.contentDocument!;
    const win = frame.contentWindow as unknown as typeof globalThis;
    doc.documentElement.className = DARK_PENDING_CLASS;
    vi.spyOn(win.HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
      drawImage() {},
      getImageData() {
        if (!pixels) throw new Error('tainted');
        return { data: pixels };
      },
    })) as never);
    vi.spyOn(win.HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
    vi.spyOn(win.HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(4);
    vi.spyOn(win.HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(4);
    doc.body.innerHTML = `<div style="color:#1a1a1a"><div id="cell" style="background-image:url('${src}');${cellStyle}"><p id="text">Limited flights to Doha</p></div></div>`;
    return { doc, cell: doc.getElementById('cell')!, text: doc.getElementById('text')! };
  };
  const style = (el: Element) => el.ownerDocument.defaultView!.getComputedStyle(el);

  afterEach(() => vi.restoreAllMocks());

  it('turns a tiled white picture into the surface, with readable text on it', async () => {
    const { doc, cell, text } = setup(flat([255, 255, 255]), '');
    await createEmailDarkModeEngine().apply(doc, { canvas: surface });
    expect(style(cell).backgroundImage).toBe('none');
    const behind = readSurfaceColor(cell, surface);
    expect(formatColor(behind)).toBe(formatColor(surface));
    expect(contrastRatio(c(style(text).color), behind)).toBeGreaterThan(7);
  });

  it('dims a tiled brand-colour picture like a fill of that colour', async () => {
    const lime = c('rgb(165, 211, 0)');
    const { doc, cell } = setup(flat([165, 211, 0]), '');
    await createEmailDarkModeEngine().apply(doc, { canvas: surface });
    expect(style(cell).backgroundImage).toBe('none');
    expect(style(cell).backgroundColor).toBe(formatColor(darkenBackground(lime, surface)));
  });

  it('converts a one-colour picture repeated inside another (Air Bank\'s lime header)', async () => {
    const lime = c('rgb(153, 204, 51)');
    const { doc, cell } = setup(flat([153, 204, 51]), '');
    cell.innerHTML = `<table id="inner" style="background-image:url('data:image/png;base64,BBBB');background-color:#99cc33"><tr><td>Air Bank</td></tr></table>`;
    await createEmailDarkModeEngine().apply(doc, { canvas: surface });
    const inner = doc.getElementById('inner')!;
    expect(style(inner).backgroundImage).toBe('none');
    expect(style(inner).backgroundColor).toBe(formatColor(darkenBackground(lime, surface)));
  });

  it('keeps the mail hidden until a slow picture is read, then shows it', async () => {
    const { doc, cell } = setup(flat([255, 255, 255]), '');
    const win = doc.defaultView as unknown as typeof globalThis;
    vi.spyOn(win.HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(false);
    const created = vi.spyOn(Document.prototype, 'createElement');
    const pass = createEmailDarkModeEngine().apply(doc, { canvas: surface });
    expect(doc.documentElement.classList.contains(DARK_PENDING_CLASS)).toBe(true);
    const loader = created.mock.results.find((r, i) => created.mock.calls[i][0] === 'img')!.value as HTMLImageElement;
    loader.dispatchEvent(new Event('load'));
    await pass;
    expect(doc.documentElement.classList.contains(DARK_PENDING_CLASS)).toBe(false);
    expect(style(cell).backgroundImage).toBe('none');
  });

  it('shows the mail after a moment when a picture never loads', () => {
    vi.useFakeTimers();
    try {
      const { doc } = setup(flat([255, 255, 255]), '');
      const win = doc.defaultView as unknown as typeof globalThis;
      vi.spyOn(win.HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(false);
      void createEmailDarkModeEngine().apply(doc, { canvas: surface });
      expect(doc.documentElement.classList.contains(DARK_PENDING_CLASS)).toBe(true);
      vi.advanceTimersByTime(400);
      expect(doc.documentElement.classList.contains(DARK_PENDING_CLASS)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('converts a nested picture while an image beside it is still loading', async () => {
    const { doc, cell } = setup(flat([255, 255, 255]), '');
    const win = doc.defaultView as unknown as typeof globalThis;
    vi.spyOn(win.HTMLImageElement.prototype, 'complete', 'get').mockImplementation(function (this: HTMLImageElement) {
      return !this.hasAttribute('data-slow');
    });
    cell.innerHTML = `<img data-slow src="data:image/png;base64,CCCC" alt=""><table id="inner" style="background-image:url('data:image/png;base64,BBBB')"><tr><td>Qatar</td></tr></table>`;
    void createEmailDarkModeEngine().apply(doc, { canvas: surface });
    await new Promise((r) => setTimeout(r, 20));
    expect(style(doc.getElementById('inner')!).backgroundImage).toBe('none');
  });

  it('keeps text on a kept fill readable when the colour it inherits was lightened', async () => {
    const { doc, cell } = setup(flat([255, 255, 255]), '');
    cell.style.color = '#000000';
    cell.innerHTML = '<div id="green" style="background-color:#009600"><span id="label">Paid</span></div>';
    await createEmailDarkModeEngine().apply(doc, { canvas: surface });
    const green = doc.getElementById('green')!;
    const label = doc.getElementById('label')!;
    expect(contrastRatio(c(style(label).color), c(style(green).backgroundColor))).toBeGreaterThanOrEqual(4.5);
  });

  it('flips a logo on a card inside a one-colour picture once', async () => {
    const { doc, cell } = setup(flat([255, 255, 255]), '');
    const win = doc.defaultView as unknown as typeof globalThis;
    const logo = new Uint8ClampedArray(40 * 20 * 4);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) {
      if (x > 5 && x < 35 && y > 5 && y < 15) logo.set([0, 0, 0, 255], (y * 40 + x) * 4);
    }
    vi.spyOn(win.HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => {
      let drawn: HTMLImageElement | null = null;
      return {
        drawImage(source: HTMLImageElement) { drawn = source; },
        getImageData() {
          return { data: drawn && drawn.id === 'logo' ? logo : flat([255, 255, 255]) };
        },
      };
    }) as never);
    cell.innerHTML = '<div style="background-color:#fff"><img id="logo" src="data:image/png;base64,LOGO" alt=""></div>';
    await createEmailDarkModeEngine().apply(doc, { canvas: surface });
    const filter = (doc.getElementById('logo') as HTMLImageElement).style.getPropertyValue('filter');
    expect(filter.match(/url\(/g)).toHaveLength(1);
  });

  it('keeps a real picture and the text on it as sent', async () => {
    const { doc, cell, text } = setup(photo, '');
    await createEmailDarkModeEngine().apply(doc, { canvas: surface });
    expect(style(cell).backgroundImage).toMatch(/^url\(/);
    expect(formatColor(c(style(text).color))).toBe('rgb(26, 26, 26)');
  });

  it('keeps a small picture that does not repeat (a bullet) as a picture', async () => {
    const { doc, cell } = setup(flat([255, 255, 255]), 'background-repeat:no-repeat;');
    await createEmailDarkModeEngine().apply(doc, { canvas: surface });
    expect(style(cell).backgroundImage).toMatch(/^url\(/);
  });

  it('keeps a picture with see-through pixels', async () => {
    const { doc, cell } = setup(flat([255, 255, 255], 120), '');
    await createEmailDarkModeEngine().apply(doc, { canvas: surface });
    expect(style(cell).backgroundImage).toMatch(/^url\(/);
  });

  it('makes no request for a remote picture while remote content is blocked', async () => {
    const { doc, cell } = setup(flat([255, 255, 255]), '', 'https://example.com/white.webp');
    const created = vi.spyOn(Document.prototype, 'createElement');
    await createEmailDarkModeEngine().apply(doc, { canvas: surface });
    expect(created.mock.calls.some(([tag]) => tag === 'img')).toBe(false);
    expect(style(cell).backgroundImage).toMatch(/^url\(/);
  });

  it('keeps the inherited colour of text on a picture it cannot read', async () => {
    const { doc, text } = setup(null, '');
    await createEmailDarkModeEngine().apply(doc, { canvas: surface });
    expect(formatColor(c(style(text).color))).toBe('rgb(26, 26, 26)');
  });
});
