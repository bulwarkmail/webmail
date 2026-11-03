import { describe, it, expect } from 'vitest';
import {
  buildEmbeddedSignatureHtml,
  htmlComposeBodyToPlainText,
  plainComposeBodyToHtml,
  replaceEmbeddedSignature,
  replacePlainTextSignature,
  replacePlainTextSignatureAboveQuote,
  stripEmbeddedSignature,
} from '../compose-format';
import { SIGNATURE_BLOCK_MARKER, SIGNATURE_RANGE_MARKER, containsEmbeddedSignature } from '../signature-block';
import { plainTextBodyHasSignature } from '@/lib/signature-utils';
import { extractUserAuthoredText } from '@/lib/email-composer-utils';
import { buildQuotedHtmlBlock } from '../quoted-html';

const identity = { htmlSignature: '<b>Alice</b><br>Acme', textSignature: 'Alice\nAcme' };
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('compose-format (#1022): HTML <-> plain text switch', () => {
  describe('stripEmbeddedSignature', () => {
    it('removes the marker-bracketed range and reports it', () => {
      const html = `<p>Hi</p>${buildEmbeddedSignatureHtml(identity, { embed: true, separator: true })}`;
      const out = stripEmbeddedSignature(html);
      expect(out.hadSignature).toBe(true);
      expect(out.html).toBe('<p>Hi</p>');
    });

    it('stops before the quote when the end marker is missing', () => {
      const html = `<p>Hi</p><p ${SIGNATURE_RANGE_MARKER}="separator">-- </p><p>Alice</p><blockquote>original</blockquote>`;
      const out = stripEmbeddedSignature(html);
      expect(out.hadSignature).toBe(true);
      expect(out.html).toBe('<p>Hi</p><blockquote>original</blockquote>');
    });

    it('leaves a body without markers untouched', () => {
      expect(stripEmbeddedSignature('<p>Hi</p>')).toEqual({ html: '<p>Hi</p>', hadSignature: false });
    });
  });

  describe('htmlComposeBodyToPlainText', () => {
    it('flattens formatting and carries the signature over as plain text', () => {
      const html = `<p>Hello <b>there</b></p><p>Second</p>${buildEmbeddedSignatureHtml(identity, { embed: true, separator: true })}`;
      const text = htmlComposeBodyToPlainText(html, identity, { separator: true });
      expect(text).toBe('Hello there\n\nSecond\n\n-- \nAlice\nAcme');
      expect(plainTextBodyHasSignature(text, identity)).toBe(true);
      expect(count(text, 'Alice')).toBe(1);
    });

    it('does not invent a signature for a body that had none (below-quote reply)', () => {
      const text = htmlComposeBodyToPlainText('<p>Thanks</p><blockquote>original</blockquote>', identity, { separator: true });
      expect(text).toBe('Thanks\n\n> original');
      expect(plainTextBodyHasSignature(text, identity)).toBe(false);
    });

    it('keeps the quoted original of a rich reply marked with "> "', () => {
      const html = `<p>Thanks</p><p>On Monday Bob wrote:</p>${buildQuotedHtmlBlock('<p>Line one<br>Line two</p><p>Para two</p>')}`;
      const text = htmlComposeBodyToPlainText(html, identity, { separator: true });
      expect(text).toBe('Thanks\n\nOn Monday Bob wrote:\n\n> Line one\n> Line two\n>\n> Para two');
      // The attachment reminder and plugin edits only see the user's text.
      expect(extractUserAuthoredText(text, { plainTextMode: true })).not.toContain('Line one');
    });

    it('keeps list markers and image alt text', () => {
      const html = '<ul><li>apples</li><li>pears</li></ul><ol><li>first</li><li>second</li></ol><p><img src="x.png" alt="a bike"></p>';
      const text = htmlComposeBodyToPlainText(html, identity, { separator: true, imageAlt: (alt) => `[Image: ${alt}]` });
      expect(text).toBe('- apples\n- pears\n\n1. first\n2. second\n\n[Image: a bike]');
    });

    it('honours the separator setting', () => {
      const html = `<p>Hi</p>${buildEmbeddedSignatureHtml(identity, { embed: true, separator: false })}`;
      expect(htmlComposeBodyToPlainText(html, identity, { separator: false })).toBe('Hi\n\nAlice\nAcme');
    });
  });

  describe('plainComposeBodyToHtml', () => {
    it('wraps paragraphs and re-embeds the signature with markers', () => {
      const html = plainComposeBodyToHtml('Hello\nthere\n\nSecond\n\n-- \nAlice\nAcme', identity, { separator: true });
      expect(html.startsWith('<p>Hello<br>there</p><p>Second</p>')).toBe(true);
      expect(containsEmbeddedSignature(html)).toBe(true);
      expect(count(html, SIGNATURE_BLOCK_MARKER)).toBe(1);
      expect(html).toContain('<b>Alice</b>');
      // The plain-text copy is gone - only the embedded HTML one remains.
      expect(count(html, 'Alice')).toBe(1);
    });

    it('keeps a body without signature signature-free', () => {
      const html = plainComposeBodyToHtml('Thanks\n\n> original', identity, { separator: true });
      expect(html).toBe('<p>Thanks</p><blockquote><p>original</p></blockquote>');
      expect(containsEmbeddedSignature(html)).toBe(false);
    });

    it('turns "> " lines back into a quote, one level per marker', () => {
      const text = 'Thanks\n\nOn Monday Bob wrote:\n> Line one\n> Line two\n>\n> > older\nnot quoted';
      expect(plainComposeBodyToHtml(text, identity, { separator: true })).toBe(
        '<p>Thanks</p><p>On Monday Bob wrote:</p>'
        + '<blockquote><p>Line one<br>Line two</p><blockquote><p>older</p></blockquote></blockquote>'
        + '<p>not quoted</p>',
      );
    });

    it('round-trips a quoted reply through plain text and back', () => {
      const start = `<p>Thanks</p><p>On Monday Bob wrote:</p>${buildQuotedHtmlBlock('<p>Line one</p><blockquote><p>older</p></blockquote>')}`;
      const text = htmlComposeBodyToPlainText(start, identity, { separator: true });
      const back = plainComposeBodyToHtml(text, identity, { separator: true });
      expect(back).toBe('<p>Thanks</p><p>On Monday Bob wrote:</p><blockquote><p>Line one</p><blockquote><p>older</p></blockquote></blockquote>');
      expect(htmlComposeBodyToPlainText(back, identity, { separator: true })).toBe(text);
    });

    it('gives an untouched signature-only body an empty paragraph to type into', () => {
      const html = plainComposeBodyToHtml('\n\n-- \nAlice\nAcme', identity, { separator: true });
      expect(html.startsWith('<p></p>')).toBe(true);
      expect(containsEmbeddedSignature(html)).toBe(true);
    });
  });

  it('round-trips a compose body without duplicating or losing the signature', () => {
    const start = `<p>Draft text</p>${buildEmbeddedSignatureHtml(identity, { embed: true, separator: true })}`;
    const text = htmlComposeBodyToPlainText(start, identity, { separator: true });
    const back = plainComposeBodyToHtml(text, identity, { separator: true });
    expect(back).toBe(start);
  });

  it('adds no separator paragraph in front of a signature that has its own delimiter', () => {
    const html = buildEmbeddedSignatureHtml({ textSignature: '-- \nUser A' }, { embed: true, separator: true });
    expect(html).not.toContain(`${SIGNATURE_RANGE_MARKER}="separator"`);
    expect(count(html, '-- ')).toBe(1);
  });
});

describe('switching identity swaps the signature', () => {
  const other = { htmlSignature: '<i>Team</i>', textSignature: 'Team' };
  const none = { htmlSignature: '', textSignature: '' };
  const embed = (sig: typeof identity) => buildEmbeddedSignatureHtml(sig, { embed: true, separator: true });
  // The DOM writes valueless attributes as =""; compare in its spelling.
  const dom = (html: string) => new DOMParser().parseFromString(html, 'text/html').body.innerHTML;

  describe('replaceEmbeddedSignature', () => {
    it('puts the new signature where the old one was', () => {
      const html = `<p>Hi</p>${embed(identity)}<blockquote>original</blockquote>`;
      expect(replaceEmbeddedSignature(html, embed(other)))
        .toBe(dom(`<p>Hi</p>${embed(other)}<blockquote>original</blockquote>`));
    });

    it('removes the signature for an identity without one', () => {
      const html = `<p>Hi</p>${embed(identity)}<blockquote>original</blockquote>`;
      expect(replaceEmbeddedSignature(html, embed(none))).toBe('<p>Hi</p><blockquote>original</blockquote>');
    });

    it('adds a signature above the quote when the body had none', () => {
      expect(replaceEmbeddedSignature('<p>Hi</p><blockquote>original</blockquote>', embed(other)))
        .toBe(dom(`<p>Hi</p>${embed(other)}<blockquote>original</blockquote>`));
    });

    it('keeps text typed on the line under the signature', () => {
      const typedBelow = embed(identity).replace(
        `<p ${SIGNATURE_RANGE_MARKER}="end"></p>`,
        `<p ${SIGNATURE_RANGE_MARKER}="end">P.S. see you</p>`,
      );
      expect(replaceEmbeddedSignature(`<p>Hi</p>${typedBelow}`, embed(none)))
        .toBe('<p>Hi</p><p>P.S. see you</p>');
      expect(replaceEmbeddedSignature(`<p>Hi</p>${typedBelow}`, embed(other)))
        .toBe(dom(`<p>Hi</p>${embed(other)}<p>P.S. see you</p>`));
    });

    it('adds a signature at the end when there is no quote', () => {
      expect(replaceEmbeddedSignature('<p>Hi</p>', embed(other))).toBe(dom(`<p>Hi</p>${embed(other)}`));
    });

    it('adds a signature above the quote header when the body had none (#842)', () => {
      const html = '<p>Hi</p><p>On Mon, Bob wrote:</p><blockquote>original</blockquote>';
      expect(replaceEmbeddedSignature(html, embed(other), { quoteHeader: 'On Mon, Bob wrote:' }))
        .toBe(dom(`<p>Hi</p>${embed(other)}<p>On Mon, Bob wrote:</p><blockquote>original</blockquote>`));
    });

    it('adds a signature above a forward header that has no quote element', () => {
      const html = '<p>Hi</p><p>---------- Forwarded message ----------<br>From: Bob</p><p>original</p>';
      expect(replaceEmbeddedSignature(html, embed(other), { quoteHeader: '---------- Forwarded message ----------' }))
        .toBe(dom(`<p>Hi</p>${embed(other)}<p>---------- Forwarded message ----------<br>From: Bob</p><p>original</p>`));
    });
  });

  describe('replacePlainTextSignatureAboveQuote (#842)', () => {
    const header = 'On Mon, Bob wrote:';
    const quote = `${header}\n> original`;

    it('adds the signature between the reply and the quote header', () => {
      expect(replacePlainTextSignatureAboveQuote(`\n\n${quote}`, header, none, identity, { separator: true }))
        .toBe(`\n\n-- \nAlice\nAcme\n\n${quote}`);
      expect(replacePlainTextSignatureAboveQuote(`Hi\n\n${quote}`, header, none, identity, { separator: true }))
        .toBe(`Hi\n\n-- \nAlice\nAcme\n\n${quote}`);
    });

    it('swaps or removes the signature above the quote', () => {
      const signed = `Hi\n\n-- \nAlice\nAcme\n\n${quote}`;
      expect(replacePlainTextSignatureAboveQuote(signed, header, identity, other, { separator: true }))
        .toBe(`Hi\n\n-- \nTeam\n\n${quote}`);
      expect(replacePlainTextSignatureAboveQuote(signed, header, identity, none, { separator: true }))
        .toBe(`Hi\n\n${quote}`);
    });

    it('leaves a body alone whose quote header is gone', () => {
      expect(replacePlainTextSignatureAboveQuote('Hi\n\n> original', header, none, identity, { separator: true }))
        .toBe('Hi\n\n> original');
    });
  });

  describe('replacePlainTextSignature', () => {
    const signed = 'Hi\n\n-- \nAlice\nAcme';

    it('swaps a trailing signature', () => {
      expect(replacePlainTextSignature(signed, identity, other, { separator: true })).toBe('Hi\n\n-- \nTeam');
    });

    it('removes it for an identity without one and adds it back', () => {
      const bare = replacePlainTextSignature(signed, identity, none, { separator: true });
      expect(bare).toBe('Hi');
      expect(replacePlainTextSignature(bare, none, identity, { separator: true })).toBe(signed);
    });

    it('leaves a body alone whose signature the user edited', () => {
      const edited = 'Hi\n\n-- \nAlice (edited)';
      expect(replacePlainTextSignature(edited, identity, other, { separator: true })).toBe(edited);
    });
  });
});
