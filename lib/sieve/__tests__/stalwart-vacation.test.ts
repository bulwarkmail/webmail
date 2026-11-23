import { describe, expect, it } from 'vitest';
import { generateScript } from '@/lib/sieve/generator';
import { stalwartVacationScript } from '@/lib/filters/__tests__/sieve-mock';
import { parseStalwartVacationScript } from '../stalwart-vacation';

const ALTERNATIVE = [
  'Content-Type: multipart/alternative; ',
  '\tboundary="b1"',
  '',
  '',
  '--b1',
  'Content-Type: text/plain; charset="utf-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Ich bin bis zum 28. November nicht im B=C3=BCro. Ablage: "C:\\Abwesend".',
  '--b1',
  'Content-Type: text/html; charset="utf-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<p>Ich bin bis zum 28. November nicht im B=C3=BCro.</p>',
  '--b1--',
  '',
].join('\r\n');

const plain = (text: string) => `Content-Type: text/plain; charset="utf-8"\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${text}\r\n`;

describe('parseStalwartVacationScript', () => {
  it('reads the period, the subject and both bodies back', async () => {
    const script = stalwartVacationScript({
      fromDate: '2026-11-20T07:00:00Z',
      toDate: '2026-11-28T17:00:00Z',
      subject: 'Abwesend: "Urlaub"',
      mimeBody: ALTERNATIVE,
    });
    expect(await parseStalwartVacationScript(script)).toEqual({
      fromDate: '2026-11-20T07:00:00Z',
      toDate: '2026-11-28T17:00:00Z',
      subject: 'Abwesend: "Urlaub"',
      textBody: 'Ich bin bis zum 28. November nicht im Büro. Ablage: "C:\\Abwesend".',
      htmlBody: expect.stringContaining('<p>Ich bin bis zum 28. November nicht im Büro.</p>'),
    });
  });

  it('reads a reply without period or subject', async () => {
    expect(await parseStalwartVacationScript(stalwartVacationScript({ mimeBody: plain('Bin nicht da.') }))).toEqual({
      fromDate: null,
      toDate: null,
      subject: '',
      textBody: 'Bin nicht da.',
      htmlBody: null,
    });
  });

  it('finds no reply in Stalwart\'s own default text', async () => {
    expect(await parseStalwartVacationScript(stalwartVacationScript({ mimeBody: plain('I am away.') }))).toBeNull();
  });

  it('leaves every other script alone', async () => {
    const own = stalwartVacationScript({ subject: 'x', mimeBody: plain('y') });
    expect(await parseStalwartVacationScript(generateScript([], undefined, { includeVacation: true }))).toBeNull();
    expect(await parseStalwartVacationScript(own.replace('vacation :mime', 'vacation :days 3 :mime'))).toBeNull();
    expect(await parseStalwartVacationScript(`${own}keep;\r\n`)).toBeNull();
    expect(await parseStalwartVacationScript(own.replace(';\r\n\r\n', ';\r\n\r\nif true {\r\n'))).toBeNull();
  });
});
