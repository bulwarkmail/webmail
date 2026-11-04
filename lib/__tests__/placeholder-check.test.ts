import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { findUnfilledPlaceholders, stripEmbeddedSignatureHtml, type PlaceholderWords } from '../placeholder-check';

const localesDir = path.resolve(__dirname, '../../locales');
const locales = fs.readdirSync(localesDir).filter((l) => fs.existsSync(path.join(localesDir, l, 'common.json')));

function wordsOf(locale: string): PlaceholderWords {
  const messages = JSON.parse(fs.readFileSync(path.join(localesDir, locale, 'common.json'), 'utf-8'));
  return messages.email_composer.placeholder_words;
}

// What the composer passes: English and the UI language.
const withUi = (locale: string) => [wordsOf('en'), wordsOf(locale)];
const EN = withUi('en');
const ALL = locales.map(wordsOf);

describe('findUnfilledPlaceholders', () => {
  it('finds template placeholders in the subject and the body', () => {
    expect(findUnfilledPlaceholders('Follow-up: {{subject}}', 'Hi {{ recipient_name }},')).toEqual([
      '{{subject}}',
      '{{ recipient_name }}',
    ]);
  });

  it('finds upper-case fill-ins in brackets', () => {
    expect(findUnfilledPlaceholders('', 'See you at [TIME]. It costs [PRICE] per [UNIT_NAME].'))
      .toEqual(['[TIME]', '[PRICE]', '[UNIT_NAME]']);
    expect(findUnfilledPlaceholders('', 'Best regards, [YOUR NAME]')).toEqual(['[YOUR NAME]']);
    expect(findUnfilledPlaceholders('', 'Treffpunkt: [ÜBERGABEORT]')).toEqual(['[ÜBERGABEORT]']);
  });

  // A template's "Hi [Name]" went out unchanged: only capitals and
  // "your/insert" prompts counted.
  it('finds capitalised words in brackets that a template left to fill in', () => {
    expect(findUnfilledPlaceholders('', ['Hi [Name],', '[Step] is done. Regards, [First Name] at [Company]. [Date]'].join('\n'), EN)).toEqual([
      '[Name]',
      '[Step]',
      '[First Name]',
      '[Company]',
      '[Date]',
    ]);
  });

  it('leaves longer bracketed phrases and links alone', () => {
    expect(findUnfilledPlaceholders('', 'See [Chapter Four Part Two] and [Name](https://example.com).', EN)).toEqual([]);
  });

  it('finds fill-ins that ask the sender to write something', () => {
    expect(findUnfilledPlaceholders('', 'Best regards,\n[Your Name]\n[Insert date]', EN)).toEqual([
      '[Your Name]',
      '[Insert date]',
    ]);
    expect(findUnfilledPlaceholders('', 'Viele Grüße\n[Ihr Name], [Datum einfügen]', withUi('de'))).toEqual([
      '[Ihr Name]',
      '[Datum einfügen]',
    ]);
  });

  it.each([
    ['ar', '[أدخل الاسم]'],
    ['ca', '[El teu nom]'],
    ['cs', '[Vaše jméno]'],
    ['da', '[Dit navn]'],
    ['de', '[Unterschrift eintragen]'],
    ['es', '[Tu nombre]'],
    ['es', '[Inserte la fecha]'],
    ['et', '[Teie nimi]'],
    ['fa', '[نام شما]'],
    ['fr', '[Votre nom]'],
    ['fr', '[Insérer la date]'],
    ['he', '[השם שלך]'],
    ['hu', '[Az Ön neve]'],
    ['it', '[Il tuo nome]'],
    ['it', '[Inserisci la data]'],
    ['ja', '[あなたの名前]'],
    ['ja', '［会社名を入力］'],
    ['ko', '[귀하의 이름]'],
    ['ko', '[날짜 입력]'],
    ['lv', '[Jūsu vārds]'],
    ['mn', '[Таны нэр]'],
    ['nb', '[Ditt navn]'],
    ['nl', '[Uw naam]'],
    ['nl', '[Datum invullen]'],
    ['pl', '[Twoje imię]'],
    ['pt', '[Seu nome]'],
    ['ro', '[Numele tău]'],
    ['ru', '[Ваше имя]'],
    ['ru', '[Укажите дату]'],
    ['sk', '[Vaše meno]'],
    ['tr', '[Adınız]'],
    ['tr', '[Tarih ekleyin]'],
    ['uk', '[Ваше ім’я]'],
    ['zh', '[您的姓名]'],
    ['zh', '【插入日期】'],
    ['zh-TW', '[填寫公司名稱]'],
  ])('finds a %s fill-in with that UI language: %s', (locale, fillIn) => {
    expect(findUnfilledPlaceholders('', `Text ${fillIn} text`, withUi(locale))).toEqual([fillIn]);
  });

  it('checks only the languages it is given', () => {
    expect(findUnfilledPlaceholders('', 'Cordialement, [Votre nom]', withUi('de'))).toEqual([]);
    expect(findUnfilledPlaceholders('', 'Cordialement, [Votre nom]', withUi('fr'))).toEqual(['[Votre nom]']);
  });

  it('finds English fill-ins whatever the UI language', () => {
    expect(findUnfilledPlaceholders('', 'Thanks, [Your Name]. TODO', withUi('ja'))).toEqual(['[Your Name]', 'TODO']);
  });

  it('skips word lists that are not lists of strings', () => {
    const broken = [{ before: 'your' }, { before: [1, '', '-', null] }, null, { after: {} }] as unknown as PlaceholderWords[];
    expect(findUnfilledPlaceholders('', '[Your name] [TIME]', broken)).toEqual(['[TIME]']);
  });

  it('finds the circles that stand in for a name in Japanese and Korean', () => {
    expect(findUnfilledPlaceholders('', '〇〇様\nお世話になっております。○○○ 님')).toEqual(['〇〇', '○○○']);
  });

  it('leaves bracketed words and headings in other languages alone', () => {
    const text = [
      '【重要】お知らせ 【通知】',
      '[votre] [ваше] [您的]',
      'Le [ton] juste. Vote [tu].',
      'Siehe [Anlage 2] und [Kapitel 3].',
      'Termin: ○ und ◯.',
    ].join('\n');
    expect(findUnfilledPlaceholders('', text, ALL)).toEqual([]);
  });

  it('finds unfinished-text markers', () => {
    expect(findUnfilledPlaceholders('', 'The venue is TBD. TODO: add the agenda. Room XXX', EN)).toEqual([
      'TBD',
      'TODO',
      'XXX',
    ]);
  });

  it('reports a marker in brackets once', () => {
    expect(findUnfilledPlaceholders('', 'Agenda: [TODO]', EN)).toEqual(['[TODO]']);
  });

  it('lists each placeholder once', () => {
    expect(findUnfilledPlaceholders('{{name}}', 'Hi {{name}}, at [TIME] or [TIME]?')).toEqual([
      '{{name}}',
      '[TIME]',
    ]);
  });

  it('leaves ordinary text alone', () => {
    const text = [
      'See footnote [1] and tick [x].',
      'Option [A] is fine, so is [3D] and [2026].',
      'I still have a todo list and the date is tba.',
      'Read [the docs](https://example.com) and [Your account](https://example.com/me).',
      'The mastodon handle is TODOS and the size is XXXL.',
      'Signed, [Yours truly].',
      'A {single} brace and {{}} are not placeholders.',
    ].join('\n');
    expect(findUnfilledPlaceholders('', text, ALL)).toEqual([]);
  });

  it('ignores bracket tags and markers in the subject', () => {
    expect(findUnfilledPlaceholders('Re: [EXTERNAL] Venue TBD', 'Thanks!', ALL)).toEqual([]);
  });
});

describe('placeholder words in the locale files', () => {
  it.each(locales)('%s has lists of strings', (locale) => {
    const words = wordsOf(locale) as Record<string, unknown>;
    for (const key of ['before', 'after', 'unfinished']) {
      expect(Array.isArray(words[key]), `${locale}: ${key} is not a list`).toBe(true);
      for (const word of words[key] as unknown[]) {
        expect(typeof word === 'string' && word.replace(/-/g, '').trim() !== '', `${locale}: ${JSON.stringify(word)}`).toBe(true);
      }
    }
  });
});

describe('stripEmbeddedSignatureHtml', () => {
  it('drops the bracketed signature range and keeps the rest', () => {
    const html = '<p>Hello</p><p data-signature-block="start"></p><p>[COMPANY] TODO</p><p data-signature-block="end"></p><p>After</p>';
    const stripped = stripEmbeddedSignatureHtml(html);
    expect(stripped).toContain('Hello');
    expect(stripped).toContain('After');
    expect(stripped).not.toContain('[COMPANY]');
  });

  it('drops a signature atom without range markers', () => {
    const html = '<p>Hello [TIME]</p><div data-signature-block-node="">[COMPANY]</div>';
    expect(stripEmbeddedSignatureHtml(html)).toBe('<p>Hello [TIME]</p>');
  });

  it('returns a body without a signature unchanged', () => {
    expect(stripEmbeddedSignatureHtml('<p>Hello</p>')).toBe('<p>Hello</p>');
  });
});
