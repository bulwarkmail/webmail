import { describe, it, expect, beforeEach, vi } from 'vitest';

import { setupQuoteCollapse, collapsePlainTextQuotes, QUOTE_TOGGLE_ATTR, QUOTE_COLLAPSED_ATTR } from '@/lib/quote-collapse';
import { plainTextToSafeHtml, sanitizeEmailHtml, sanitizePlainTextRenderedHtml } from '@/lib/email-sanitization';

const labels = { show: 'Show quoted text', hide: 'Hide quoted text' };

const toggle = () => document.body.querySelector<HTMLLabelElement>(`[${QUOTE_TOGGLE_ATTR}]`);
/** The checkbox inside the toggle; it carries the state and the ARIA attributes. */
const checkbox = () => toggle()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
/** Computed display: the fold is a stylesheet rule, not an inline style. */
const display = (el: Element) => getComputedStyle(el).display;

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
    expect(display(quote)).toBe('none');
    const btn = toggle()!;
    expect(btn).toBeTruthy();
    expect(checkbox().getAttribute('aria-expanded')).toBe('false');
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
    expect(display(quote)).toBe('flex');
    expect(checkbox().getAttribute('aria-expanded')).toBe('true');
    expect(btn.title).toBe(labels.hide);

    btn.click();
    expect(display(quote)).toBe('none');
    expect(checkbox().getAttribute('aria-expanded')).toBe('false');
    expect(btn.title).toBe(labels.show);
  });

  it('folds by stylesheet alone, for frames where no listener runs (Safari)', () => {
    document.body.innerHTML = `
      <p>reply text</p>
      <div><div style="border:none;border-top:solid #E1E1E1 1.0pt"><p><b>From:</b> John</p></div></div>
      <p id="quoted" style="display:flex">quoted</p>`;
    const onToggle = vi.fn();
    setupQuoteCollapse(document, labels, onToggle);
    const quoted = document.getElementById('quoted')!;
    expect(quoted.hasAttribute(QUOTE_COLLAPSED_ATTR)).toBe(true);
    expect(quoted.getAttribute('style')).toBe('display:flex');
    expect(quoted).not.toBeVisible();

    // WebKit runs no parent-attached listener in a frame sandboxed without
    // allow-scripts; only the checkbox's native state changes on a click.
    checkbox().checked = true;
    expect(display(quoted)).toBe('flex');
    checkbox().checked = false;
    expect(quoted).not.toBeVisible();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('collapses an Apple Mail cite blockquote but keeps the attribution line visible', () => {
    document.body.innerHTML = `
      <div>See you then.</div>
      <div>On 20 Jul 2026, at 10:00, Jane wrote:</div>
      <blockquote type="cite">the original</blockquote>`;
    expect(setupQuoteCollapse(document, labels)).toBe(true);

    const quote = document.querySelector<HTMLElement>('blockquote')!;
    expect(display(quote)).toBe('none');
    expect(document.body.textContent).toContain('Jane wrote:');
  });

  it('collapses Bulwark\'s own data-quoted-html reply island', () => {
    document.body.innerHTML = `
      <p>my answer</p>
      <div>On Jul 20, John &lt;j@example.com&gt; wrote:</div>
      <div data-quoted-html style="border-left:2px solid #c5c5c5;padding-left:12px;">original</div>`;
    expect(setupQuoteCollapse(document, labels)).toBe(true);
    expect(display(document.querySelector<HTMLElement>('[data-quoted-html]')!)).toBe('none');
  });

  it('collapses everything after an Outlook divRplyFwdMsg separator', () => {
    document.body.innerHTML = `
      <div>Top-posted answer</div>
      <div id="divRplyFwdMsg"><b>From:</b> John<br><b>Sent:</b> Monday</div>
      <div>quoted paragraph one</div>
      <div>quoted paragraph two</div>`;
    expect(setupQuoteCollapse(document, labels)).toBe(true);

    const divs = [...document.querySelectorAll<HTMLElement>('body > div')];
    expect(divs[0]).toBeVisible();
    expect(display(divs[1])).toBe('none');
    expect(display(divs[2])).toBe('none');
    expect(display(divs[3])).toBe('none');
  });

  it('collapses from a Thunderbird moz-cite-prefix attribution onwards', () => {
    document.body.innerHTML = `
      <p>reply</p>
      <div class="moz-cite-prefix">On 20.07.2026, Jane wrote:</div>
      <blockquote type="cite">original</blockquote>`;
    expect(setupQuoteCollapse(document, labels)).toBe(true);
    expect(display(document.querySelector<HTMLElement>('.moz-cite-prefix')!)).toBe('none');
    expect(display(document.querySelector<HTMLElement>('blockquote')!)).toBe('none');
  });

  it('collapses an iPhone Mail reply, whose attribution sits in a quote of its own (#1476)', () => {
    document.body.innerHTML = `<div dir="ltr">Works for me.</div><div dir="ltr"><br><blockquote type="cite">On 30 Oct 2026, at 17:02, John &lt;john@example.com&gt; wrote:<br><br></blockquote></div><blockquote type="cite"><div dir="ltr">Shall we meet on Friday?</div></blockquote>`;
    expect(setupQuoteCollapse(document, labels)).toBe(true);
    const [attribution, original] = [...document.querySelectorAll<HTMLElement>('blockquote')];
    expect(display(attribution)).toBe('none');
    expect(display(original)).toBe('none');
    expect(document.querySelector<HTMLElement>('div[dir="ltr"]')!).toBeVisible();
  });

  it('collapses from the header block of an Outlook for Windows reply (#1476)', () => {
    document.body.innerHTML = `<div class="WordSection1"><p class="MsoNormal">Done, see attached.</p><div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm"><p class="MsoNormal"><b>From:</b> John<br><b>Sent:</b> Friday</p></div></div><p class="MsoNormal">Can you send the file?</p></div>`;
    expect(setupQuoteCollapse(document, labels)).toBe(true);
    const paragraphs = [...document.querySelectorAll<HTMLElement>('.WordSection1 > p')];
    expect(paragraphs[0]).toBeVisible();
    expect(display(paragraphs[1])).toBe('none');
  });

  it('collapses an Outlook mobile reference message (#1476)', () => {
    document.body.innerHTML = `<div>On my way</div><div id="mail-editor-reference-message-container"><div><b>From:</b> John</div><div>Where are you?</div></div>`;
    expect(setupQuoteCollapse(document, labels)).toBe(true);
    expect(display(document.getElementById('mail-editor-reference-message-container')!)).toBe('none');
  });

  it('does not collapse when the quote is the entire message', () => {
    document.body.innerHTML = `
      <div class="gmail_quote">forwarded content only</div>`;
    expect(setupQuoteCollapse(document, labels)).toBe(false);
    expect(toggle()).toBeNull();
    expect(document.querySelector<HTMLElement>('.gmail_quote')!).toBeVisible();
  });

  it('keeps an interleaved reply visible and offers a manual quote toggle', () => {
    document.body.innerHTML = `
      <p>first point</p>
      <blockquote type="cite">their question</blockquote>
      <p>my answer below the quote</p>`;
    expect(setupQuoteCollapse(document, labels)).toBe(true);
    expect(document.querySelector('blockquote')).toBeVisible();
    expect(document.body.lastElementChild).toBeVisible();
    expect(checkbox().getAttribute('aria-expanded')).toBe('true');
    expect(checkbox().getAttribute('aria-label')).toBe(labels.hide);
    expect(toggle()!.title).toBe(labels.hide);
  });

  it.each([
    ['Bulwark', '<div data-quoted-html>original</div>'],
    ['Gmail container', '<div class="gmail_quote_container">original</div>'],
    ['Gmail', '<div class="gmail_quote">original</div>'],
    ['Apple Mail', '<blockquote type="cite">original</blockquote>'],
    ['Yahoo', '<div class="yahoo_quoted">original</div>'],
    ['Proton blockquote', '<blockquote class="protonmail_quote">original</blockquote>'],
    ['Proton div', '<div class="protonmail_quote">original</div>'],
  ])('lets the user fold the %s container without hiding the reply after it', (_client, quotedHtml) => {
    document.body.innerHTML = `<p id="reply">my answer</p>${quotedHtml}<p id="after">another answer below</p><style>body{height:auto}</style>`;
    const quote = document.getElementById('reply')!.nextElementSibling as HTMLElement;
    const content = quote.innerHTML;

    expect(setupQuoteCollapse(document, labels)).toBe(true);
    const button = toggle()!;
    expect(quote).toBeVisible();
    expect(checkbox().getAttribute('aria-expanded')).toBe('true');
    expect(checkbox().getAttribute('aria-label')).toBe(labels.hide);

    button.click();
    expect(quote).not.toBeVisible();
    expect(document.getElementById('reply')).toBeVisible();
    expect(document.getElementById('after')).toBeVisible();
    expect(checkbox().getAttribute('aria-expanded')).toBe('false');
    expect(checkbox().getAttribute('aria-label')).toBe(labels.show);
    expect(button.title).toBe(labels.show);
    expect(quote.innerHTML).toBe(content);

    button.click();
    expect(quote).toBeVisible();
    expect(checkbox().getAttribute('aria-expanded')).toBe('true');
    expect(checkbox().getAttribute('aria-label')).toBe(labels.hide);
    expect(button.title).toBe(labels.hide);
    expect(quote.innerHTML).toBe(content);
  });

  it('preserves a sanitized native quote and its trailing signature across manual toggles', () => {
    document.body.innerHTML = sanitizeEmailHtml(`
      <div><p>My answer</p><p>On Monday, Bob wrote:</p>
        <div data-quoted-html style="display:flex;border-left:2px solid #ccc">
          <p>Original message</p><blockquote type="cite">Earlier history</blockquote>
          <img src="cid:original-image" alt="Original image">
        </div>
      </div><br><br>-- <br><div id="signature"><strong>Alice</strong><br>Example company</div>`);
    const quote = document.querySelector<HTMLElement>('[data-quoted-html]')!;
    const originalQuote = quote.innerHTML;
    const originalSignature = document.getElementById('signature')!.outerHTML;
    const originalText = document.body.textContent;

    expect(setupQuoteCollapse(document, labels)).toBe(true);
    expect(display(quote)).toBe('flex');
    expect(document.getElementById('signature')).toBeVisible();
    toggle()!.click();
    expect(display(quote)).toBe('none');
    expect(document.getElementById('signature')).toBeVisible();
    toggle()!.click();
    expect(display(quote)).toBe('flex');
    expect(quote.innerHTML).toBe(originalQuote);
    expect(document.getElementById('signature')!.outerHTML).toBe(originalSignature);
    expect(document.querySelector('img')!.getAttribute('src')).toBe('cid:original-image');
    toggle()!.remove();
    expect(document.body.textContent).toBe(originalText);
  });

  it.each([
    '<div data-quoted-html><p>Old question</p><p id="inline-answer">New inline answer</p></div>',
    '<div class="gmail_quote"><blockquote>Old question</blockquote><p id="inline-answer">New inline answer</p></div>',
  ])('keeps answers inside a quote visible until the user chooses to fold it', (quotedHtml) => {
    document.body.innerHTML = `<p>Answers below</p>${quotedHtml}<p id="after">Regards</p>`;
    expect(setupQuoteCollapse(document, labels)).toBe(true);
    expect(document.getElementById('inline-answer')).toBeVisible();
    toggle()!.click();
    expect(document.getElementById('inline-answer')).not.toBeVisible();
    expect(document.getElementById('after')).toBeVisible();
    toggle()!.click();
    expect(document.getElementById('inline-answer')).toBeVisible();
  });

  it('folds only the first recognized container when replies separate multiple quotes', () => {
    document.body.innerHTML = `
      <p>Answers below</p><blockquote type="cite" id="first">First question</blockquote>
      <p id="answer">First answer</p><blockquote type="cite" id="second">Second question</blockquote>
      <p id="after">Second answer</p>`;
    expect(setupQuoteCollapse(document, labels)).toBe(true);
    expect(document.getElementById('first')).toBeVisible();
    expect(document.getElementById('second')).toBeVisible();
    toggle()!.click();
    expect(document.getElementById('first')).not.toBeVisible();
    expect(document.getElementById('second')).toBeVisible();
    expect(document.getElementById('answer')).toBeVisible();
    expect(document.getElementById('after')).toBeVisible();
  });

  it('does not add a manual toggle to an ambiguous bare blockquote with a reply after it', () => {
    document.body.innerHTML = '<p>Earlier:</p><blockquote>Original</blockquote><p>My answer below</p>';
    expect(setupQuoteCollapse(document, labels)).toBe(false);
    expect(toggle()).toBeNull();
    expect(document.querySelector('blockquote')).toBeVisible();
  });

  it('does not add a manual toggle when a quote and signature have no preceding reply', () => {
    document.body.innerHTML = '<div data-quoted-html>Original</div><p>-- Signature</p>';
    expect(setupQuoteCollapse(document, labels)).toBe(false);
    expect(toggle()).toBeNull();
    expect(document.querySelector('[data-quoted-html]')).toBeVisible();
  });

  it('does not reset or duplicate a manual toggle when setup runs again', () => {
    document.body.innerHTML = '<p>Reply</p><div data-quoted-html>Original</div><p>Signature</p>';
    expect(setupQuoteCollapse(document, labels)).toBe(true);
    const button = toggle()!;
    expect(setupQuoteCollapse(document, labels)).toBe(false);
    expect(checkbox().getAttribute('aria-expanded')).toBe('true');
    button.click();
    expect(setupQuoteCollapse(document, labels)).toBe(false);
    expect(document.querySelectorAll(`[${QUOTE_TOGGLE_ATTR}]`)).toHaveLength(1);
    expect(checkbox().getAttribute('aria-expanded')).toBe('false');
    button.click();
    expect(checkbox().getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[data-quoted-html]')).toBeVisible();
  });

  it.each([true, false])('notifies the reader after toggling, initially expanded: %s', (manual) => {
    document.body.innerHTML = '<p>Reply</p><div data-quoted-html style="display:flex">Original</div>'
      + (manual ? '<p>Signature</p>' : '');
    const quote = document.querySelector<HTMLElement>('[data-quoted-html]')!;
    const states: Array<{ expanded: string | null; display: string }> = [];
    const onToggle = vi.fn(() => {
      states.push({ expanded: checkbox().getAttribute('aria-expanded'), display: display(quote) });
    });

    expect(setupQuoteCollapse(document, labels, onToggle)).toBe(true);
    expect(onToggle).not.toHaveBeenCalled();
    toggle()!.click();
    toggle()!.click();
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(states).toEqual(manual
      ? [{ expanded: 'false', display: 'none' }, { expanded: 'true', display: 'flex' }]
      : [{ expanded: 'true', display: 'flex' }, { expanded: 'false', display: 'none' }]);
  });

  it('ignores the reader stylesheet after a trailing quote when choosing its initial state', () => {
    document.body.innerHTML = '<p>Reply</p><div class="gmail_quote">Original</div>'
      + '<style>html,body{height:auto!important;min-height:0!important}body{overflow-y:hidden!important}</style>';
    expect(setupQuoteCollapse(document, labels)).toBe(true);
    expect(document.querySelector('.gmail_quote')).not.toBeVisible();
    expect(checkbox().getAttribute('aria-expanded')).toBe('false');
  });

  it('still folds the full run of adjacent cite quotes when a stylesheet follows it', () => {
    document.body.innerHTML = '<p>Reply</p><blockquote type="cite">Attribution</blockquote>'
      + '<blockquote type="cite">Original</blockquote><style>body{height:auto}</style>';
    expect(setupQuoteCollapse(document, labels)).toBe(true);
    const quotes = document.querySelectorAll('blockquote');
    expect(quotes[0]).not.toBeVisible();
    expect(quotes[1]).not.toBeVisible();
    expect(checkbox().getAttribute('aria-expanded')).toBe('false');
  });

  it('does not treat a stylesheet as a reply preceding a quote-only message', () => {
    document.body.innerHTML = '<style>body{height:auto}</style><div class="gmail_quote">Forwarded original</div>';
    expect(setupQuoteCollapse(document, labels)).toBe(false);
    expect(toggle()).toBeNull();
    expect(document.querySelector('.gmail_quote')).toBeVisible();
  });

  it('ignores a trailing stylesheet for an attributed bare blockquote', () => {
    document.body.innerHTML = '<p>Reply</p><p>On Monday, Bob wrote:</p><blockquote>Original</blockquote>'
      + '<style>body{height:auto}</style>';
    expect(setupQuoteCollapse(document, labels)).toBe(true);
    expect(document.querySelector('blockquote')).not.toBeVisible();
    expect(checkbox().getAttribute('aria-expanded')).toBe('false');
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
    expect(display(outer)).toBe('none');
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
    expect(display((document.body.lastElementChild as HTMLElement))).toBe('none');
  });

  it('collapses a nested wrapper case: separator inside a wrapper div hides content outside it too', () => {
    document.body.innerHTML = `
      <div>answer</div>
      <div><div id="appendonsend"></div><div>quoted intro</div></div>
      <div>quoted rest</div>`;
    expect(setupQuoteCollapse(document, labels)).toBe(true);
    const last = document.body.lastElementChild as HTMLElement;
    expect(last.textContent).toBe('quoted rest');
    expect(display(last)).toBe('none');
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
