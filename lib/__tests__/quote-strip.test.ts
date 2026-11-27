import { describe, expect, it } from 'vitest';
import { stripPlainTextQuotes, stripQuotedHtml } from '../quote-collapse';

// A message saved as a template loses the quoted original of a reply or a
// forward, with the line that introduces it: what the reader folds.

describe('stripQuotedHtml', () => {
  it("removes Bulwark's own reply quote and its attribution", () => {
    const html = '<p>Thanks, see you Monday.</p><p>Dev</p><br><p>On 22 Nov 2026, Sophie &lt;s@x.example&gt; wrote:<br></p>'
      + '<div data-quoted-html="true"><p>Shall we meet?</p></div>';
    expect(stripQuotedHtml(html)).toBe('<p>Thanks, see you Monday.</p><p>Dev</p>');
  });

  it("removes Bulwark's forward header with the forwarded message, in any language", () => {
    const html = '<p>Voir ci-dessous.</p><br><div>---------- Message transféré ----------<br>De : Sophie<br>Date : 22 nov.<br>Objet : Test<br>À : Bob<br></div>'
      + '<div data-quoted-html="true"><p>Original</p></div>';
    expect(stripQuotedHtml(html)).toBe('<p>Voir ci-dessous.</p>');
  });

  it('removes a Gmail quote, attribution included', () => {
    const html = '<div dir="ltr">Sounds good.</div><br><div class="gmail_quote gmail_quote_container"><div class="gmail_attr">On Mon, Bob wrote:<br></div>'
      + '<blockquote class="gmail_quote">Lunch?</blockquote></div>';
    expect(stripQuotedHtml(html)).toBe('<div dir="ltr">Sounds good.</div>');
  });

  it('removes a Thunderbird quote from its attribution line on', () => {
    const html = '<p>Yes.</p><div class="moz-cite-prefix">On 1/2/26 Bob wrote:<br></div><blockquote type="cite">Lunch?</blockquote>';
    expect(stripQuotedHtml(html)).toBe('<p>Yes.</p>');
  });

  it('removes an Outlook quote from its header block on, with the rule above it', () => {
    const html = '<div>Agreed.</div><hr><div id="divRplyFwdMsg"><b>From:</b> Bob<br><b>Sent:</b> Monday</div><div>Lunch?</div>';
    expect(stripQuotedHtml(html)).toBe('<div>Agreed.</div>');
  });

  it('removes an Apple Mail quote and the attribution before it', () => {
    const html = '<div>Fine by me.</div><div><br><blockquote type="cite"><div>On 2 Nov, Bob wrote:</div></blockquote></div>'
      + '<blockquote type="cite"><div>Lunch?</div></blockquote>';
    expect(stripQuotedHtml(html)).toBe('<div>Fine by me.</div>');
  });

  it('keeps a signature below an explicit quote container', () => {
    const html = '<p>Yes.</p><p>On Mon, Bob wrote:</p><div data-quoted-html="true"><p>Lunch?</p></div><p>-- <br>Dev</p>';
    expect(stripQuotedHtml(html)).toBe('<p>Yes.</p><p>-- <br>Dev</p>');
  });

  it('keeps a message that is only a quote, a reply written between quotes, and a message without quote', () => {
    const forwardOnly = '<div>---------- Forwarded message ----------<br>From: Bob</div><div data-quoted-html="true"><p>Original</p></div>';
    expect(stripQuotedHtml(forwardOnly)).toBe(forwardOnly);
    const interleaved = '<p>On Mon, Bob wrote:</p><blockquote>Point one?</blockquote><p>Yes.</p><blockquote>Point two?</blockquote><p>No.</p>';
    expect(stripQuotedHtml(interleaved)).toBe(interleaved);
    expect(stripQuotedHtml('<p>Hello</p>')).toBe('<p>Hello</p>');
  });

  it('keeps the line before the quote when it introduces nothing', () => {
    const html = '<p>Here is my answer.</p><div data-quoted-html="true"><p>Question</p></div>';
    expect(stripQuotedHtml(html)).toBe('<p>Here is my answer.</p>');
  });
});

describe('stripPlainTextQuotes', () => {
  it('removes the trailing ">" quote and its attribution line', () => {
    expect(stripPlainTextQuotes('Sure, 12:30.\n\nOn Mon, Bob wrote:\n> Lunch?\n>\n> Bob\n')).toBe('Sure, 12:30.');
  });

  it('keeps a "-- " signature after the quote', () => {
    expect(stripPlainTextQuotes('Sure.\n\nOn Mon, Bob wrote:\n> Lunch?\n\n-- \nDev')).toBe('Sure.\n\n-- \nDev');
  });

  it('removes a forwarded message from its separator line on', () => {
    expect(stripPlainTextQuotes('FYI\n\n---------- Forwarded message ----------\nFrom: Bob\n\nOriginal')).toBe('FYI');
  });

  it('keeps an interleaved reply, a message that is only a quote, and a rule of dashes', () => {
    const interleaved = 'On Mon, Bob wrote:\n> One?\nYes.\n> Two?\nNo.';
    expect(stripPlainTextQuotes(interleaved)).toBe(interleaved);
    const onlyQuote = 'On Mon, Bob wrote:\n> Lunch?';
    expect(stripPlainTextQuotes(onlyQuote)).toBe(onlyQuote);
    const rule = 'Agenda\n----------\nItem one';
    expect(stripPlainTextQuotes(rule)).toBe(rule);
  });
});
