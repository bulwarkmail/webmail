import { describe, expect, it, vi } from 'vitest';

import { htmlToPlainText } from '../html-to-text';

describe('htmlToPlainText', () => {
  it('preserves line breaks from <br> within a paragraph', () => {
    expect(htmlToPlainText('<p>Line 1.<br>Line 2.</p>')).toBe('Line 1.\nLine 2.');
  });

  it('separates block elements with newlines instead of running them together (#421)', () => {
    // The previous textContent-based implementation produced "Line 1.Line 2.Paragraph 2."
    expect(htmlToPlainText('<div>Line 1.</div><div>Line 2.</div><div>Paragraph 2.</div>')).toBe(
      'Line 1.\nLine 2.\nParagraph 2.'
    );
  });

  it('with paragraphSpacing, separates paragraphs with a blank line', () => {
    expect(
      htmlToPlainText('<p>Line 1.<br>Line 2.</p><p>Paragraph 2.</p>', { paragraphSpacing: true })
    ).toBe('Line 1.\nLine 2.\n\nParagraph 2.');
  });

  it('without paragraphSpacing, separates paragraphs with a single newline', () => {
    expect(htmlToPlainText('<p>A</p><p>B</p>')).toBe('A\nB');
  });

  it('renders links as text when the text equals the href', () => {
    expect(
      htmlToPlainText('<p><a href="mailto:alice@example.com">alice@example.com</a></p>')
    ).toBe('alice@example.com');
  });

  it('renders an @mention as just its text', () => {
    expect(
      htmlToPlainText('<p>Hi <a href="mailto:dana@example.com" class="mention">@Dana</a> see <a href="mailto:info@example.com">us</a></p>')
    ).toBe("Hi @Dana see us <mailto:info@example.com>");
  });

  it('renders links as "text <href>" when they differ', () => {
    expect(htmlToPlainText('<p>Visit <a href="https://example.com">our site</a></p>')).toBe(
      'Visit our site <https://example.com>'
    );
  });

  it('collapses excess whitespace and trims the result', () => {
    expect(htmlToPlainText('  <p>  Hello   world  </p>  ')).toBe('Hello world');
  });

  it('caps consecutive blank lines at one', () => {
    expect(htmlToPlainText('<p>A</p><br><br><br><p>B</p>', { paragraphSpacing: true })).toBe(
      'A\n\nB'
    );
  });

  it('returns an empty string for empty or whitespace-only HTML', () => {
    expect(htmlToPlainText('')).toBe('');
    expect(htmlToPlainText('   <p>  </p>  ')).toBe('');
  });

  it('handles nested lists as separate lines', () => {
    expect(htmlToPlainText('<ul><li>One</li><li>Two</li></ul>')).toBe('One\nTwo');
  });

  it('keeps the trailing space of a "-- " signature delimiter', () => {
    // Without it the text part's delimiter was "--", which clients do not
    // recognise as the start of a signature.
    expect(htmlToPlainText('<p>Hi</p><p>-- </p><p>User A</p>')).toBe('Hi\n-- \nUser A');
  });

  describe('mailMarkup', () => {
    // The text part of a reply showed the quoted original as ordinary text,
    // and list items without their bullets.
    const mail = { paragraphSpacing: true, mailMarkup: true };

    it('prefixes quoted text with "> "', () => {
      const html = '<p>Sure.</p><p>On Sun, B wrote:</p><div data-quoted-html=""><p>Hi A,</p><p>can you?</p></div>';
      expect(htmlToPlainText(html, mail)).toBe('Sure.\n\nOn Sun, B wrote:\n\n> Hi A,\n>\n> can you?');
    });

    it('nests quotes', () => {
      expect(htmlToPlainText('<blockquote><p>a</p><blockquote><p>b</p></blockquote></blockquote>', mail)).toBe('> a\n>\n> > b');
    });

    // Every quote level used to serialise its innerHTML and parse it again, so
    // Reply on a long thread of nested quotes did quadratic work.
    it('parses a deeply nested quote once', () => {
      const depth = 300;
      const html = '<blockquote>'.repeat(depth) + '<p>deep</p>' + '</blockquote>'.repeat(depth);
      const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
      try {
        expect(htmlToPlainText(html, mail)).toBe(`${'> '.repeat(depth)}deep`);
        expect(parse).toHaveBeenCalledTimes(1);
      } finally {
        parse.mockRestore();
      }
    });

    it('marks list items', () => {
      expect(htmlToPlainText('<ul><li>Revenue</li><li>Costs</li></ul><ol start="3"><li>x</li><li>y</li></ol>', mail))
        .toBe('- Revenue\n- Costs\n\n3. x\n4. y');
    });

    it('leaves the default conversion unchanged', () => {
      expect(htmlToPlainText('<blockquote>a</blockquote><ul><li>b</li></ul>')).toBe('a\nb');
    });
  });
});
