import { describe, expect, it } from 'vitest';
import { computeFitScale } from '@/lib/email-fit-width';
import { applyMailTextSize, mailFitOptions, mailFrameCss, mailOverrideActive, mailOverrideCss, mailTextFactor, plainBodyFontSize, readingCardWidth, resolveSystemToggle, scaledTextSize } from '@/lib/mail-reading';

describe('mailTextFactor', () => {
  it('follows the app text size when the mail size is 0', () => {
    expect(mailTextFactor(0, 'medium')).toBe(1);
    expect(mailTextFactor(0, 'xx-large')).toBe(1.5);
  });
  it('uses the mail size when one is set', () => {
    expect(mailTextFactor(1.25, 'huge')).toBe(1.25);
  });
});

describe('plainBodyFontSize', () => {
  it('stays at the old size by default', () => {
    expect(plainBodyFontSize(14, 0, 'medium', 0)).toBe('0.875rem');
  });
  it('relies on rem for the app size and multiplies only what the mail size adds', () => {
    // rem already carries 1.25, so 1.5 needs another 1.2.
    expect(plainBodyFontSize(14, 1.5, 'x-large', 0)).toBe('calc(0.875rem * 1.2)');
    expect(plainBodyFontSize(14, 0, 'x-large', 0)).toBe('0.875rem');
  });
  it('puts a floor under it', () => {
    expect(plainBodyFontSize(13, 0, 'medium', 16)).toBe('max(0.8125rem, 16px)');
  });
});

describe('readingCardWidth', () => {
  it('holds the 80-character column and its gutters at the mail text size', () => {
    expect(readingCardWidth(0, 'medium', 0)).toBe('calc(0.875rem * 44 + 2.5rem)');
  });
  it('grows with the mail text size, as the column does', () => {
    expect(readingCardWidth(1.5, 'x-large', 0)).toBe('calc(calc(0.875rem * 1.2) * 44 + 2.5rem)');
    expect(readingCardWidth(0, 'medium', 16)).toBe('calc(max(0.875rem, 16px) * 44 + 2.5rem)');
  });
});

describe('scaledTextSize', () => {
  it('scales font and px line height together', () => {
    expect(scaledTextSize(10, 15, { factor: 1.5, minPx: 0 })).toEqual({ font: 15, lineHeight: 22.5 });
  });
  it('raises text below the minimum, with its line height', () => {
    expect(scaledTextSize(9, 12, { factor: 1, minPx: 18 })).toEqual({ font: 18, lineHeight: 24 });
    expect(scaledTextSize(20, null, { factor: 1, minPx: 18 })).toEqual({ font: 20, lineHeight: null });
  });
  it('applies the minimum after scaling', () => {
    expect(scaledTextSize(10, null, { factor: 2, minPx: 16 }).font).toBe(20);
    expect(scaledTextSize(6, null, { factor: 2, minPx: 16 }).font).toBe(16);
  });
});

function mailDoc(html: string): Document {
  // A frame's document, so it has a window for getComputedStyle.
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.body.innerHTML = html;
  return doc;
}

describe('applyMailTextSize', () => {
  it('leaves a mail alone at 100 % with no minimum', () => {
    const doc = mailDoc('<p style="font-size: 10px">tiny</p>');
    expect(applyMailTextSize(doc, { factor: 1, minPx: 0 })).toBe(false);
    expect(doc.querySelector('p')!.style.fontSize).toBe('10px');
  });

  it('enlarges small text to the minimum and pins the rest', () => {
    const doc = mailDoc('<div style="font-size: 20px"><span style="font-size: 9px">fine print</span></div>');
    doc.body.style.fontSize = '14px';
    expect(applyMailTextSize(doc, { factor: 1, minPx: 12 })).toBe(true);
    expect(doc.querySelector('span')!.style.getPropertyValue('font-size')).toBe('12px');
    expect(doc.querySelector('span')!.style.getPropertyPriority('font-size')).toBe('important');
    expect(doc.querySelector('div')!.style.getPropertyValue('font-size')).toBe('20px');
  });

  it('scales every text size and runs once per document', () => {
    const doc = mailDoc('<p style="font-size: 16px; line-height: 20px">a</p>');
    doc.body.style.fontSize = '14px';
    applyMailTextSize(doc, { factor: 1.5, minPx: 0 });
    const p = doc.querySelector('p')!;
    expect(p.style.getPropertyValue('font-size')).toBe('24px');
    expect(p.style.getPropertyValue('line-height')).toBe('30px');
    expect(doc.body.style.getPropertyValue('font-size')).toBe('21px');
    expect(applyMailTextSize(doc, { factor: 1.5, minPx: 0 })).toBe(false);
    expect(p.style.getPropertyValue('font-size')).toBe('24px');
  });
});

describe('resolveSystemToggle', () => {
  it('follows the OS only for system', () => {
    expect(resolveSystemToggle('system', true)).toBe(true);
    expect(resolveSystemToggle('system', false)).toBe(false);
    expect(resolveSystemToggle('on', false)).toBe(true);
    expect(resolveSystemToggle('off', true)).toBe(false);
  });
});

describe('mailFrameCss', () => {
  it('is empty when nothing is asked for', () => {
    expect(mailFrameCss({ reduceMotion: false })).toBe('');
  });
  it('stops animations and transitions for reduce motion', () => {
    expect(mailFrameCss({ reduceMotion: true })).toMatch(/animation-duration:0\.01ms!important.*transition-duration:0\.01ms!important/);
  });
});

describe('mailOverrideActive', () => {
  it('always, never, or only with more contrast', () => {
    expect(mailOverrideActive('always', 'normal', false)).toBe(true);
    expect(mailOverrideActive('never', 'more', true)).toBe(false);
    expect(mailOverrideActive('high-contrast', 'more', false)).toBe(true);
    expect(mailOverrideActive('high-contrast', 'system', true)).toBe(true);
    expect(mailOverrideActive('high-contrast', 'system', false)).toBe(false);
    expect(mailOverrideActive('high-contrast', 'normal', true)).toBe(false);
  });
});

describe('mailOverrideCss', () => {
  const base = {
    fontFamily: '"Lexend", sans-serif', foreground: '#111111', background: '#fafafa', link: '#1d4ed8',
    lineSpacing: 'normal', letterSpacing: 'normal', wordSpacing: 'normal', paragraphSpacing: 'normal',
    textFactor: 1.25, minPx: 0,
  } as const;

  it('puts the app font, size and colours on the mail', () => {
    const css = mailOverrideCss(base);
    expect(css).toContain('html{background:#fafafa!important}body{background:transparent!important}html,body{color:#111111!important}');
    expect(css).toContain('font-family:"Lexend", sans-serif!important;font-size:calc(0.875rem * 1.25)!important');
    expect(css).toMatch(/body \*:not\([^)]*\)\{font-family:inherit!important;font-size:1em!important[^}]*color:#111111!important;background-color:transparent!important;background-image:none!important/);
    expect(css).toContain('a[href],a[href] *{color:#1d4ed8!important}');
    expect(css).toContain('a[href]{text-decoration-line:underline!important}');
    expect(css).not.toContain('letter-spacing');
  });

  it('carries the spacing settings and the minimum size', () => {
    const css = mailOverrideCss({ ...base, lineSpacing: 'loose', letterSpacing: 'wider', wordSpacing: 'wide', paragraphSpacing: 'wide', minPx: 18 });
    expect(css).toContain('line-height:1.9!important');
    expect(css).toContain('letter-spacing:0.12em!important');
    expect(css).toContain('word-spacing:0.16em!important');
    expect(css).toContain('body p{margin-block-end:1.5em!important}');
    expect(css).toContain('font-size:max(calc(0.875rem * 1.25), 18px)!important');
  });

  it('cannot be broken out of by a hostile value', () => {
    const css = mailOverrideCss({ ...base, fontFamily: 'x}</style><img src=x>{' });
    expect(css).not.toContain('</style>');
    expect(css).not.toMatch(/font-family:x\}/);
  });
});

describe('mailFrameCss underline', () => {
  it('underlines links when asked', () => {
    expect(mailFrameCss({ reduceMotion: false, underlineLinks: true })).toBe('a[href]{text-decoration-line:underline!important}');
  });
});

describe('applyMailTextSize with the override stylesheet', () => {
  it('leaves sizes to the stylesheet and only takes out justified text', () => {
    const doc = mailDoc('<p style="font-size: 9px; text-align: justify">x</p>');
    applyMailTextSize(doc, { factor: 2, minPx: 16, unjustify: true, sizesFromCss: true });
    const p = doc.querySelector('p')!;
    expect(p.style.getPropertyValue('font-size')).toBe('9px');
    expect(p.style.getPropertyValue('text-align')).toBe('start');
  });
});

describe('mailFitOptions', () => {
  it('fits only on phones by default', () => {
    expect(computeFitScale(1200, 800, mailFitOptions(false, false))).toBe(1);
    expect(mailFitOptions(false, false).enabled).toBe(false);
    expect(mailFitOptions(true, false).enabled).toBe(true);
  });
  it('fits a wide mail into a desktop pane with "Fit wide mail" on', () => {
    const options = mailFitOptions(false, true);
    expect(options.enabled).toBe(true);
    expect(computeFitScale(1200, 800, options)).toBeCloseTo(2 / 3);
  });
});
