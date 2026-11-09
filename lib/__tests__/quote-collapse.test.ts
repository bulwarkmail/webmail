import { describe, it, expect, beforeEach, vi } from 'vitest';

import { setupQuoteCollapse, collapsePlainTextQuotes, QUOTE_TOGGLE_ATTR, QUOTE_COLLAPSED_ATTR } from '@/lib/quote-collapse';
import { plainTextToSafeHtml, sanitizeEmailHtml, sanitizePlainTextRenderedHtml } from '@/lib/email-sanitization';

const labels = { show: 'Show quoted text', hide: 'Hide quoted text' };

const toggle = () => document.body.querySelector<HTMLButtonElement>(`[${QUOTE_TOGGLE_ATTR}]`);

describe('setupQuoteCollapse', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('collapses a Gmail-style trailing quote behind a toggle', () => {
    document.body.innerHTML = `
      <div dir="ltr">Thanks, sounds good!</div>
      <div class="gmail_quote">
        <div class="gmail_attr">On Mon, Jul 20, 2026 John wrote:</div>
        <blockquote>Original message body</blockquote>
      </div>`;
    expect(setupQuoteCollapse(document, labels)).toBe(true);

    const quote = document.querySelector<HTMLElement>('.gmail_quote')!;
    expect(quote.style.display).toBe('none');
    const btn = toggle()!;
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.title).toBe(labels.show);
    // Button sits directly before the quote it controls.
    expect(btn.nextElementSibling).toBe(quote);
  });

  it('toggle expands and re-collapses, restoring the original inline display', () => {
    document.body.innerHTML = `
      <p>reply text</p>
      <div class="gmail_quote" style="display:flex">quoted</div>`;
    setupQuoteCollapse(document, labels);

    const quote = document.querySelector<HTMLElement>('.gmail_quote')!;
    const btn = toggle()!;
    btn.click();
    expect(quote.style.display).toBe('flex');
    expect(quote.hasAttribute(QUOTE_COLLAPSED_ATTR)).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(btn.title).toBe(labels.hide);

    btn.click();
    expect(quote.style.display).toBe('none');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.title).toBe(labels.show);
  });

  it('collapses an Apple Mail cite blockquote but keeps the attribution line visible', () => {
    document.body.innerHTML = `
      <div>See you then.</div>
      <div>On 20 Jul 2026, at 10:00, Jane wrote:</div>
      <blockquote type="cite">the original</blockquote>`;
    expect(setupQuoteCollapse(document, labels)).toBe(true);

    const quote = document.querySelector<HTMLElement>('blockquote')!;
    expect(quote.style.display).toBe('none');
    expect(document.body.textContent).toContain('Jane wrote:');
  });

  it('collapses Bulwark\'s own data-quoted-html reply island', () => {
    document.body.innerHTML = `
      <p>my answer</p>
      <div>On Jul 20, John &lt;j@example.com&gt; wrote:</div>
      <div data-quoted-html style="border-left:2px solid #c5c5c5;padding-left:12px;">original</div>`;
    expect(setupQuoteCollapse(document, labels)).toBe(true);
    expect(document.querySelector<HTMLElement>('[data-quoted-html]')!.style.display).toBe('none');
  });

  it('collapses everything after an Outlook divRplyFwdMsg separator', () => {
    document.body.innerHTML = `
      <div>Top-posted answer</div>
      <div id="divRplyFwdMsg"><b>From:</b> John<br><b>Sent:</b> Monday</div>
      <div>quoted paragraph one</div>
      <div>quoted paragraph two</div>`;
    expect(setupQuoteCollapse(document, labels)).toBe(true);

    const divs = [...document.querySelectorAll<HTMLElement>('body > div')];
    expect(divs[0].style.display).toBe('');
    expect(divs[1].style.display).toBe('none');
    expect(divs[2].style.display).toBe('none');
    expect(divs[3].style.display).toBe('none');
  });

  it('collapses from a Thunderbird moz-cite-prefix attribution onwards', () => {
    document.body.innerHTML = `
      <p>reply</p>
      <div class="moz-cite-prefix">On 20.07.2026, Jane wrote:</div>
      <blockquote type="cite">original</blockquote>`;
    expect(setupQuoteCollapse(document, labels)).toBe(true);
    expect(document.querySelector<HTMLElement>('.moz-cite-prefix')!.style.display).toBe('none');
    expect(document.querySelector<HTMLElement>('blockquote')!.style.display).toBe('none');
  });

  it('collapses an iPhone Mail reply, whose attribution sits in a quote of its own (#1476)', () => {
    document.body.innerHTML = `<div dir="ltr">Works for me.</div><div dir="ltr"><br><blockquote type="cite">On 30 Oct 2026, at 17:02, John &lt;john@example.com&gt; wrote:<br><br></blockquote></div><blockquote type="cite"><div dir="ltr">Shall we meet on Friday?</div></blockquote>`;
    expect(setupQuoteCollapse(document, labels)).toBe(true);
    const [attribution, original] = [...document.querySelectorAll<HTMLElement>('blockquote')];
    expect(attribution.style.display).toBe('none');
    expect(original.style.display).toBe('none');
    expect(document.querySelector<HTMLElement>('div[dir="ltr"]')!.style.display).toBe('');
  });

  it('collapses from the header block of an Outlook for Windows reply (#1476)', () => {
    document.body.innerHTML = `<div class="WordSection1"><p class="MsoNormal">Done, see attached.</p><div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm"><p class="MsoNormal"><b>From:</b> John<br><b>Sent:</b> Friday</p></div></div><p class="MsoNormal">Can you send the file?</p></div>`;
    expect(setupQuoteCollapse(document, labels)).toBe(true);
    const paragraphs = [...document.querySelectorAll<HTMLElement>('.WordSection1 > p')];
    expect(paragraphs[0].style.display).toBe('');
    expect(paragraphs[1].style.display).toBe('none');
  });

  it('collapses an Outlook mobile reference message (#1476)', () => {
    document.body.innerHTML = `<div>On my way</div><div id="mail-editor-reference-message-container"><div><b>From:</b> John</div><div>Where are you?</div></div>`;
    expect(setupQuoteCollapse(document, labels)).toBe(true);
    expect(document.getElementById('mail-editor-reference-message-container')!.style.display).toBe('none');
  });

  it('does not collapse when the quote is the entire message', () => {
    document.body.innerHTML = `
      <div class="gmail_quote">forwarded content only</div>`;
    expect(setupQuoteCollapse(document, labels)).toBe(false);
    expect(toggle()).toBeNull();
    expect(document.querySelector<HTMLElement>('.gmail_quote')!.style.display).toBe('');
  });

  it('does not collapse an interleaved reply (content after the quote container)', () => {
    document.body.innerHTML = `
      <p>first point</p>
      <blockquote type="cite">their question</blockquote>
      <p>my answer below the quote</p>`;
    expect(setupQuoteCollapse(document, labels)).toBe(false);
    expect(toggle()).toBeNull();
  });

  it('ignores whitespace-only trailing content after the quote container', () => {
    document.body.innerHTML = `
      <p>reply</p>
      <div class="gmail_quote">quoted</div>
      <div><br></div>
      ${String.fromCharCode(160)}`;
    expect(setupQuoteCollapse(document, labels)).toBe(true);
  });

  it('is idempotent per document', () => {
    document.body.innerHTML = `
      <p>reply</p>
      <div class="gmail_quote">quoted</div>`;
    expect(setupQuoteCollapse(document, labels)).toBe(true);
    expect(setupQuoteCollapse(document, labels)).toBe(false);
    expect(document.querySelectorAll(`[${QUOTE_TOGGLE_ATTR}]`)).toHaveLength(1);
  });

  it('does nothing when no quote marker exists', () => {
    document.body.innerHTML = `<p>plain email with content</p><p>and more content</p>`;
    expect(setupQuoteCollapse(document, labels)).toBe(false);
    expect(toggle()).toBeNull();
  });

  it('collapses a bare blockquote preceded by an attribution line ending in a colon', () => {
    // Shape of a Bulwark reply to a plain-text original (issue #480 follow-up):
    // no type/class on the blockquote, attribution in the preceding <p>.
    document.body.innerHTML = `
      <div>
        <p>Hi Tracey,<br>thanks for reaching out.</p>
        <p>On Mo., 18. Mai 2026, 20:27, Tracey Tiefisher wrote:<br></p>
        <blockquote><p>Hi Linus,</p><blockquote><p>older nested quote</p></blockquote></blockquote>
        <p></p>
      </div>`;
    expect(setupQuoteCollapse(document, labels)).toBe(true);
    const outer = document.querySelector<HTMLElement>('blockquote')!;
    expect(outer.style.display).toBe('none');
    expect(document.body.textContent).toContain('Tracey Tiefisher wrote:');
  });

  it('leaves a bare blockquote alone when the preceding text is not an attribution', () => {
    document.body.innerHTML = `
      <p>Our newsletter quote of the day</p>
      <blockquote>Stay hungry, stay foolish.</blockquote>`;
    expect(setupQuoteCollapse(document, labels)).toBe(false);
    expect(toggle()).toBeNull();
  });

  it('looks for an attribution in one pass over many bare blockquotes', () => {
    // Every outermost blockquote used to walk all text before it again, so a
    // body of a few ten thousand blockquotes froze the reader for minutes.
    const n = 2000;
    document.body.innerHTML = '<p>Intro</p>' + '<blockquote>x</blockquote>'.repeat(n) + '<p>Earlier:</p><blockquote>late quote</blockquote>';
    const nodes = document.body.querySelectorAll('*').length + n + 3;
    const walkerSpy = vi.spyOn(Node.prototype, 'compareDocumentPosition');
    try {
      expect(setupQuoteCollapse(document, labels)).toBe(true);
      expect(walkerSpy.mock.calls.length).toBeLessThan(nodes * 6);
    } finally {
      walkerSpy.mockRestore();
    }
    expect(document.body.lastElementChild!.textContent).toBe('late quote');
    expect((document.body.lastElementChild as HTMLElement).style.display).toBe('none');
  });

  it('collapses a nested wrapper case: separator inside a wrapper div hides content outside it too', () => {
    document.body.innerHTML = `
      <div>answer</div>
      <div><div id="appendonsend"></div><div>quoted intro</div></div>
      <div>quoted rest</div>`;
    expect(setupQuoteCollapse(document, labels)).toBe(true);
    const last = document.body.lastElementChild as HTMLElement;
    expect(last.textContent).toBe('quoted rest');
    expect(last.style.display).toBe('none');
  });
});

describe('sanitizer keeps the quote marker attribute', () => {
  it('preserves data-quoted-html through sanitizeEmailHtml', () => {
    const out = sanitizeEmailHtml('<p>hi</p><div data-quoted-html style="padding-left:12px">orig</div>');
    expect(out).toContain('data-quoted-html');
  });
});

describe('collapsePlainTextQuotes', () => {
  const raw = [
    'Hallo Linus,',
    '',
    'ich sehe eben, dass du das gefixt hast, thx!',
    '',
    'On Dienstag, 31. Maerz 2026 13:56 Richard Weinberger wrote:',
    '> On Dienstag, 31. Maerz 2026 00:28 Richard Weinberger wrote:',
    '> > Hi!',
    '> ',
    '> Here are some more issues:',
    '> ',
    '> - getClientIP() vulnerable to IP spoofing.',
    '',
    '',
    '-- ',
    'sigma star gmbh | Eduard-Bodem-Gasse 6, 6020 Innsbruck, AUT',
  ].join('\n');

  it('wraps the trailing quote run in <details>, keeping reply, attribution and signature visible', () => {
    const out = collapsePlainTextQuotes(plainTextToSafeHtml(raw), labels);
    expect(out).toContain('<details>');
    expect(out).toContain('•••');
    expect(out).toContain(`title="${labels.show}"`);
    // Quote run is inside the details, attribution and signature outside.
    const details = out.slice(out.indexOf('<details>'), out.indexOf('</details>'));
    expect(details).toContain('getClientIP()');
    // The nested quoted attribution (00:28) collapses, the outer one (13:56) stays.
    expect(details).toContain('00:28');
    expect(details).not.toContain('13:56');
    const outside = out.replace(details, '');
    expect(outside).toContain('Hallo Linus,');
    expect(outside).toContain('13:56 Richard Weinberger wrote:');
    expect(outside).toContain('sigma star gmbh');
  });

  it('round-trips through sanitizePlainTextRenderedHtml', () => {
    const out = sanitizePlainTextRenderedHtml(collapsePlainTextQuotes(plainTextToSafeHtml(raw), labels));
    expect(out).toContain('<details>');
    expect(out).toContain('<summary');
    expect(out).toContain(`title="${labels.show}"`);
  });

  it('does not collapse a bottom-posted reply (content after the quote run)', () => {
    const text = 'Tom wrote:\n> what do you think?\n\nSounds good to me!';
    const safe = plainTextToSafeHtml(text);
    expect(collapsePlainTextQuotes(safe, labels)).toBe(safe);
  });

  it('does not collapse when the quote is the whole message', () => {
    const text = '> forwarded line one\n> forwarded line two';
    const safe = plainTextToSafeHtml(text);
    expect(collapsePlainTextQuotes(safe, labels)).toBe(safe);
  });

  it('leaves mail without quote lines untouched', () => {
    const safe = plainTextToSafeHtml('just a normal message\nwith two lines');
    expect(collapsePlainTextQuotes(safe, labels)).toBe(safe);
  });

  it('never treats a ">" mid-line as a quote', () => {
    const safe = plainTextToSafeHtml('a -> b\nx > y comparison');
    expect(collapsePlainTextQuotes(safe, labels)).toBe(safe);
  });
});
