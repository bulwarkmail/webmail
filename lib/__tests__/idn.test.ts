import { describe, it, expect } from 'vitest';
import {
  toAsciiDomain,
  toAsciiEmail,
  toUnicodeDomain,
  toUnicodeEmail,
  toUnicodeEmailOnOwnDomains,
} from '../idn';

// Pairs as Stalwart (idna crate, UTS #46) and browsers produce them.
const PAIRS: Array<[string, string]> = [
  ['bücher.de', 'xn--bcher-kva.de'],
  ['münchen.de', 'xn--mnchen-3ya.de'],
  ['ノード.com', 'xn--gdkj2l.com'],
  ['ドメイン名例.jp', 'xn--eckwd4c7cu47r2wf.jp'],
  ['пример.рф', 'xn--e1afmkfd.xn--p1ai'],
  ['straße.de', 'xn--strae-oqa.de'],
  ['𠀋.jp', 'xn--u50i.jp'],
];

describe('toAsciiDomain', () => {
  it.each(PAIRS)('converts %s to %s', (unicode, ascii) => {
    expect(toAsciiDomain(unicode)).toBe(ascii);
  });

  it('lowercases and maps like a browser does', () => {
    expect(toAsciiDomain('Bücher.DE')).toBe('xn--bcher-kva.de');
    expect(toAsciiDomain('ΑΒΓ.gr')).toBe('xn--mxacd.gr');
    expect(toAsciiDomain(' example.com ')).toBe('example.com');
  });

  it('rejects input that is not a bare host name', () => {
    expect(toAsciiDomain('')).toBeNull();
    expect(toAsciiDomain('a b.de')).toBeNull();
    expect(toAsciiDomain('evil.com/path')).toBeNull();
    expect(toAsciiDomain('evil.com:25')).toBeNull();
    expect(toAsciiDomain('user@evil.com')).toBeNull();
    expect(toAsciiDomain('%65vil.com')).toBeNull();
    expect(toAsciiDomain('xn--zz.de')).toBeNull();
  });
});

describe('toAsciiEmail', () => {
  it('converts only the domain of an IDN address', () => {
    expect(toAsciiEmail('alice@ノード.com')).toBe('alice@xn--gdkj2l.com');
    expect(toAsciiEmail('Jörg@Bücher.de')).toBe('Jörg@xn--bcher-kva.de');
  });

  it('leaves ASCII addresses and bare login names exactly as typed', () => {
    expect(toAsciiEmail('Alice@Example.COM')).toBe('Alice@Example.COM');
    expect(toAsciiEmail('alice@xn--bcher-kva.de')).toBe('alice@xn--bcher-kva.de');
    expect(toAsciiEmail('alice')).toBe('alice');
    expect(toAsciiEmail('jörg')).toBe('jörg');
    expect(toAsciiEmail('')).toBe('');
  });

  it('splits at the last @ and keeps unconvertible input unchanged', () => {
    expect(toAsciiEmail('"a@b"@bücher.de')).toBe('"a@b"@xn--bcher-kva.de');
    expect(toAsciiEmail('alice@bü cher.de')).toBe('alice@bü cher.de');
  });
});

describe('toUnicodeDomain', () => {
  it.each(PAIRS)('shows %s for %s', (unicode, ascii) => {
    expect(toUnicodeDomain(ascii)).toBe(unicode);
  });

  it('decodes uppercase ACE labels to a lowercase domain', () => {
    expect(toUnicodeDomain('XN--BCHER-KVA.DE')).toBe('bücher.de');
    expect(toUnicodeDomain('mail.xn--Bcher-kva.de')).toBe('mail.bücher.de');
  });

  it('leaves plain ASCII domains alone, case included', () => {
    expect(toUnicodeDomain('Example.COM')).toBe('Example.COM');
    expect(toUnicodeDomain('')).toBe('');
  });

  it('keeps labels that are not valid, canonical punycode', () => {
    expect(toUnicodeDomain('xn--zz.de')).toBe('xn--zz.de');
    expect(toUnicodeDomain('xn--.de')).toBe('xn--.de');
    // Decodes to plain "abc", whose ASCII form is not "xn--abc-".
    expect(toUnicodeDomain('xn--abc-.de')).toBe('xn--abc-.de');
    // Decode to "À" and fullwidth "ａｂｃü", which UTS #46 maps to other
    // labels; a registrable domain can never contain them.
    expect(toUnicodeDomain('xn--3ba.de')).toBe('xn--3ba.de');
    expect(toUnicodeDomain('xn--tda9921kdae.de')).toBe('xn--tda9921kdae.de');
    expect(toUnicodeDomain('xn--0ca.de')).toBe('à.de');
  });
});

describe('toUnicodeEmail', () => {
  it('converts only the domain', () => {
    expect(toUnicodeEmail('alice@xn--gdkj2l.com')).toBe('alice@ノード.com');
    expect(toUnicodeEmail('Alice+Tag@xn--bcher-kva.de')).toBe('Alice+Tag@bücher.de');
  });

  it('returns other input unchanged', () => {
    expect(toUnicodeEmail('alice@example.com')).toBe('alice@example.com');
    expect(toUnicodeEmail('Alice Example')).toBe('Alice Example');
    expect(toUnicodeEmail('alice')).toBe('alice');
  });
});

describe('toUnicodeEmailOnOwnDomains', () => {
  const own = ['alice@xn--gdkj2l.com', null, undefined, ''];

  it('shows addresses on the user\'s own IDN domains in Unicode', () => {
    expect(toUnicodeEmailOnOwnDomains('alice@xn--gdkj2l.com', own)).toBe('alice@ノード.com');
    expect(toUnicodeEmailOnOwnDomains('bob@XN--GDKJ2L.COM', own)).toBe('bob@ノード.com');
  });

  it('recognizes the domain when the user\'s own address is in Unicode', () => {
    expect(toUnicodeEmailOnOwnDomains('bob@xn--bcher-kva.de', ['alice@bücher.de'])).toBe('bob@bücher.de');
  });

  it('keeps everyone else\'s IDN domain in ASCII form', () => {
    expect(toUnicodeEmailOnOwnDomains('eve@xn--bcher-kva.de', own)).toBe('eve@xn--bcher-kva.de');
    expect(toUnicodeEmailOnOwnDomains('eve@sub.xn--gdkj2l.com', own)).toBe('eve@sub.xn--gdkj2l.com');
    expect(toUnicodeEmailOnOwnDomains('eve@xn--bcher-kva.de', [])).toBe('eve@xn--bcher-kva.de');
  });

  it('leaves ASCII addresses untouched', () => {
    expect(toUnicodeEmailOnOwnDomains('Bob@Example.com', ['alice@example.com'])).toBe('Bob@Example.com');
  });
});
