// How a booking card decides whether a text from the mail may be shown (namesOtherDomain, the one
// check every card text goes through). The card is for a message that passed the sender check for
// shop.example; no text on it may read as another domain:
//
// 1. Only expected characters: letters, marks and numbers of any script, the space, currency signs
//    and a fixed set of punctuation. A text with any other code point is left out whole.
// 2. A dot is whatever stands where a dot would stand: any single character between two labels that
//    is not one of the joiners honest text uses (dashes, slash, apostrophes, &, +, :, comma, brackets,
//    arrow, underscore), and a single letter of another script than the letters on both sides of it.
// 3. A run of labels names a domain when its last label is a real top-level domain, or a reserved
//    one, compared in ASCII form; and, whatever it ends in, when it mixes scripts.
import { act, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key),
  useLocale: () => 'en',
}));

import { loadTopLevelDomains, namesOtherDomain } from '../card-parts';

const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const SENDER = 'shop.example';
const named = (text: string) => namesOtherDomain(text, SENDER);

beforeAll(() => loadTopLevelDomains());

describe('step 1: only expected characters', () => {
  it('control: honest text in several scripts, with typographic punctuation, is shown', () => {
    for (const text of [
      'Hotel Am Markt', 'St.-Pauli-Fischmarkt 14', 'Hamburg Hbf → Berlin Hbf', '„Jazz Night“ – 20:00', 'Grand Hôtel ★★★★',
      'Café № 5', '½ Pension', '129,90 €', 'Zürich HB', 'תל אביב', 'القاهرة', 'ホテル・ニューオータニ', '東京駅（丸の内）', 'Москва, ул. Тверская 7',
      'Αθήνα', 'Ελ. Βενιζέλος', 'São Paulo', 'Kraków Główny', 'भारत', 'Seat 12A × 2', 'Gate B 1–3',
    ]) {
      expect(named(text), text).toBe(false);
    }
  });

  it.each<[string, string]>([
    ['a right-to-left override', cp(0x202e)],
    ['a left-to-right isolate', cp(0x2066)],
    ['a right-to-left mark', cp(0x200f)],
    ['a zero width space', cp(0x200b)],
    ['a zero width joiner', cp(0x200d)],
    ['a soft hyphen', cp(0xad)],
    ['a tag character', cp(0xe0041)],
    ['an unassigned code point', cp(0x0378)],
    ['a private use code point', cp(0xe000)],
    ['a lone surrogate', '\ud800'],
    ['a control character', cp(0x07)],
    ['a C1 control character', cp(0x85)],
    ['the Hangul filler', cp(0x3164)],
    ['a Khmer inherent vowel', cp(0x17b4)],
    ['a variation selector', cp(0xfe0f)],
    ['a Mongolian free variation selector', cp(0x180b)],
    ['a line separator', cp(0x2028)],
    ['a paragraph separator', cp(0x2029)],
    ['an emoji', cp(0x1f389)],
  ])('leaves out a text with %s in it, whole', (_name, ch) => {
    expect(named(`Hotel Am${ch} Markt`)).toBe(true);
    expect(named('Hotel Am Markt')).toBe(false);
  });

  it('leaves out every format and default-ignorable code point, and unassigned ones, next to the dot of a domain', () => {
    const FORMAT = /\p{Cf}/u;
    const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
    const UNASSIGNED = /\p{Cn}/u;
    const missed: string[] = [];
    let checked = 0;
    let unassigned = 0;
    for (let code = 0; code <= 0x10ffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const ch = cp(code);
      const sampled = UNASSIGNED.test(ch) && (unassigned++ % 211 === 0);
      if (!FORMAT.test(ch) && !IGNORABLE.test(ch) && !sampled) continue;
      checked += 1;
      if (!named(`bigbank${ch}.example`) || !named(`bigbank.${ch}example`)) missed.push(code.toString(16));
    }
    expect(missed).toEqual([]);
    // Cf, the default-ignorables (plane 14 alone holds 4,096) and a sample of the unassigned ones.
    expect(checked).toBeGreaterThan(8000);
  });
});

describe('step 2: a dot is whatever stands where a dot would stand', () => {
  it.each<[string, string]>([
    ['a full stop', '.'],
    ['a one dot leader', cp(0x2024)],
    ['a fullwidth full stop', cp(0xff0e)],
    ['an ideographic full stop', cp(0x3002)],
    ['an Arabic full stop', cp(0x06d4)],
    ['a middle dot', cp(0xb7)],
    ['a katakana middle dot', cp(0x30fb)],
    ['a bullet', cp(0x2022)],
    ['a hyphenation point', cp(0x2027)],
    ['an at sign', '@'],
  ])('reads %s between two labels as a dot', (_name, dot) => {
    expect(named(`bigbank${dot}example`)).toBe(true);
  });

  it('keeps references joined with underscores: no host name has one, and it draws as no dot', () => {
    for (const text of ['INV_DE_123', 'Order_No_DE5', 'BK_FLIGHT_DE', 'bigbank_example']) {
      expect(named(text), text).toBe(false);
    }
  });

  it.each<[string, number]>([
    ['Lisu (LISU LETTER TONE MYA TI)', 0xa4f8],
    ['Canadian syllabics (CANADIAN SYLLABICS FINAL MIDDLE DOT)', 0x1427],
    ['Hangul (HANGUL LETTER ARAEA)', 0x318d],
    ['Han (CJK radical dot)', 0x4e36],
    ['Arabic (ARABIC-INDIC DIGIT ZERO)', 0x0660],
  ])('reads a single letter or digit of %s between two Latin labels as a dot', (_name, code) => {
    expect(named(`bigbank${cp(code)}example`)).toBe(true);
    expect(named(`shop1${cp(code)}com`)).toBe(true);
  });

  it('reads an uncased letter between two cased ones of the same script as a dot (LATIN LETTER SINOLOGICAL DOT)', () => {
    expect(named(`bigbank${cp(0xa78f)}example`)).toBe(true);
  });

  it('reads a letter of another script between two labels of any script as a dot, not only Latin', () => {
    expect(named(`банк${cp(0xa4f8)}рф`)).toBe(true);
  });

  it('keeps the joiners honest text puts between words, and letters that belong together', () => {
    for (const text of ['Hamburg–Berlin', 'Hamburg—Berlin', 'Wien/Graz', "O'Reilly", 'McDonald’s', 'C&A', 'A+B', 'Köln:Bonn', 'Hamburg,Berlin',
      '(Berlin)', 'Hamburg→Berlin', 'Hamburg-Berlin', 'スーパーマーケット', '東の京', 'Tシャツ']) {
      expect(named(text), text).toBe(false);
    }
  });
});

describe('step 3: a top-level domain is a real one', () => {
  it.each(['de', 'com', 'co.uk', 'shop', 'berlin', 'security', 'app', 'xn--p1ai', 'am', 'museum'])('reads a name on .%s as a domain', (tld) => {
    expect(named(`bigbank.${tld}`)).toBe(true);
    expect(named(`Tickets by BigBank.${tld.toUpperCase()}`)).toBe(true);
  });

  it.each([['банк.рф', 'xn--p1ai'], ['银行.中国', 'xn--fiqs8s']])('reads %s, an internationalised top-level domain in Unicode, as its %s entry', (text) => {
    expect(named(text)).toBe(true);
  });

  it.each(['example', 'test', 'invalid', 'localhost', 'internal', 'local', 'lan', 'home', 'corp'])('reads a name on the reserved .%s as a domain', (tld) => {
    expect(named(`bigbank.${tld}`)).toBe(true);
  });

  it.each(['St.Pölten Hbf', 'Dr.Oetker', 'E.Mustermann', '17.Juni', 'T-Shirt Gr.XL', 'Vitamin B.Complex', 'HDMI v2.1', '10.30 Uhr', '9.99 EUR', 'z.B.', 'e.g.', 'bigbank.xyzzy'])(
    'does not read %s as a domain: it ends in no top-level domain',
    (text) => {
      expect(named(text)).toBe(false);
    },
  );

  it('reads a domain inside a longer word, after a hyphen, and in an address', () => {
    for (const text of ['bigbank.example-secure', 'bigbank.com-login', 'service@bigbank.example', 'https://bigbank.example/login', 'www.bigbank.example']) {
      expect(named(text), text).toBe(true);
    }
  });

  it('keeps the sender\'s own domain and the ones below it, also in an address', () => {
    for (const text of ['shop.example', 'Shop.Example', 'pay.shop.example', 'orders@shop.example', 'https://www.shop.example/orders']) {
      expect(named(text), text).toBe(false);
    }
    expect(named('shop.example.bigbank.example')).toBe(true);
  });

  it('reads a run that mixes scripts as a look-alike of a domain, whatever it ends in', () => {
    // A Cyrillic letter at the start of the last label, a whole label in Cyrillic capitals, a Cyrillic letter for one of two dots.
    for (const text of [`bigbank.${cp(0x0441)}om`, `BIGBANK.${cp(0x0421, 0x041e, 0x041c)}`, `bigbank.c${cp(0x043e)}m`, `bigbank${cp(0xa4f8)}c${cp(0x043e)}m`]) {
      expect(named(text), text).toBe(true);
    }
    // Japanese, Chinese and Korean are written next to Latin.
    expect(named('ANAクラウンプラザホテル・大阪')).toBe(false);
  });
});

describe('the list of top-level domains loads with the cards', () => {
  it('reads every dotted name as a domain until the list has loaded, and draws the card again once it has', async () => {
    vi.resetModules();
    type ListModule = typeof import('@/lib/top-level-domains');
    let release!: (mod: ListModule) => void;
    vi.doMock('@/lib/top-level-domains', () => new Promise<ListModule>((resolve) => { release = resolve; }));
    const parts = await import('../card-parts');
    const { StructuredMailCards } = await import('../structured-mail-cards');

    expect(parts.namesOtherDomain('St.Gallen', SENDER)).toBe(true);
    expect(parts.namesOtherDomain('Erika Mustermann', SENDER)).toBe(false);
    expect(parts.namesOtherDomain('pay.shop.example', SENDER)).toBe(false);

    const hotel = {
      kind: 'lodging' as const, key: 'h1', name: 'Hotel St.Georg', passengers: [], links: {}, source: 'json-ld' as const,
      checkin: { date: '2026-12-04', time: '15:00:00' }, checkout: { date: '2026-12-06', time: '11:00:00' },
    };
    render(<StructuredMailCards cards={[hotel]} email={{ id: 'm1', from: [{ email: 'orders@shop.example' }] }} allowRemoteImages={false} />);
    expect(screen.getByRole('heading').textContent).toBe('kind_lodging');

    const list = await vi.importActual<ListModule>('@/lib/top-level-domains');
    await act(async () => {
      release(list);
      await parts.loadTopLevelDomains();
    });
    expect(parts.namesOtherDomain('St.Gallen', SENDER)).toBe(false);
    expect(await screen.findByText('Hotel St.Georg')).toBeInTheDocument();
    vi.doUnmock('@/lib/top-level-domains');
  });
});
