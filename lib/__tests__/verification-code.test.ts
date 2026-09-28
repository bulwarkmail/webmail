import { describe, it, expect } from 'vitest';
import {
  findVerificationCode,
  listVerificationCode,
  verificationCodeBodyText,
  VERIFICATION_CODE_MAX_AGE_MS,
} from '@/lib/verification-code';
// Real sign-in and confirmation mails as Stalwart 0.16.23 serves them: the
// list's subject and preview, and the body text the reader derives from the
// HTML part. Names, addresses and link tokens are replaced.
import mails from './fixtures/verification-code-mails.json';

// Mail whose code is neither in the subject nor in the 256-character
// preview: its body opens with CSS, raw HTML or padding, or the preview
// ends before (or in the middle of) the code.
const NOT_IN_PREVIEW = new Set([
  'Lieferando', 'Planauskunft', 'Tuya', 'Telekom Geschäftskunden', 'Telekom Login', 'Steam', 'Autodesk',
  'Amazon Visa',
]);

describe('findVerificationCode on real mail', () => {
  it.each(mails.map((m) => [m.sender, m] as const))('finds the code of %s in the reader', (_, mail) => {
    expect(findVerificationCode(mail.subject, mail.body)).toBe(mail.code);
  });

  it.each(mails.map((m) => [m.sender, m] as const))('finds the code of %s in the list, or nothing', (sender, mail) => {
    expect(findVerificationCode(mail.subject, mail.preview)).toBe(NOT_IN_PREVIEW.has(sender) ? null : mail.code);
  });
});

describe('findVerificationCode', () => {
  it('copies grouped digits without the gaps', () => {
    expect(findVerificationCode('557 260 is your Instagram recovery code', '')).toBe('557260');
    expect(findVerificationCode('', 'Bitte gebe folgenden Bestätigungs-Code ein: 3 0 4 6 2 7 Gebe diesen')).toBe('304627');
    expect(findVerificationCode('', 'Your code: 123-456')).toBe('123456');
  });

  it('keeps the hyphen of a lettered code', () => {
    expect(findVerificationCode('Slack confirmation code: 6ZA-BRE', '')).toBe('6ZA-BRE');
  });

  it('does not offer a code the preview cut in half', () => {
    expect(findVerificationCode('', 'Bitte verwenden Sie den folgenden Steam-Guard-Code:\n\nAnmeldecode\nY9DG...')).toBeNull();
    expect(findVerificationCode('', 'Your code is 1234...')).toBeNull();
  });

  it('finds digits run into the words around them', () => {
    expect(findVerificationCode('', 'Gib diesen Code ein:86771674Teile diesen Code mit niemandem.')).toBe('86771674');
    expect(findVerificationCode('', 'Sign in to Claude.ai177945Copy and paste the temporary verification code')).toBe('177945');
  });

  it('prefers the code in the subject', () => {
    expect(findVerificationCode('Your code is 482913', 'Your verification code for account 5512345 is below')).toBe('482913');
  });

  it('takes the code the keyword introduces over other numbers near it', () => {
    expect(findVerificationCode('', 'Your verification code for account 12345678 is 482913.')).toBe('482913');
    expect(findVerificationCode('', 'Dein Passcode\n551471\nKI Palooza 2026 Sep 29 2026 - Sep 30 2026')).toBe('551471');
  });

  it('accepts a year-shaped code only when it is presented as the code', () => {
    expect(findVerificationCode('', 'Your Login Passcode for KI Palooza 2026')).toBeNull();
    expect(findVerificationCode('', 'Your code is 2013')).toBe('2013');
  });

  it('reads keywords in other languages', () => {
    expect(findVerificationCode('', 'Tu código de verificación es 482913')).toBe('482913');
    expect(findVerificationCode('', 'Twój kod weryfikacyjny: 482913')).toBe('482913');
    expect(findVerificationCode('', 'Ваш код подтверждения: 482913')).toBe('482913');
    expect(findVerificationCode('', '您的验证码是 482913')).toBe('482913');
    expect(findVerificationCode('', 'Din engangskode er 482913')).toBe('482913');
  });

  it.each([
    ['an order confirmation', 'Deine Bestellung Nr. 302-4829175-1937264',
      'Vielen Dank für deine Bestellung vom 26.09.2026. Bestellnummer: 302-4829175-1937264 Summe: 49,99 € Deine Kundennummer: 5512345.'],
    ['a shipping notice with a tracking code', 'Ihr Paket ist unterwegs',
      'Sendungsnummer 00340434161234567890. Mit dem Tracking-Code JJD0003900012 können Sie Ihre Sendung verfolgen. Zustellung am 28.09.2026 zwischen 10:00 und 14:00 Uhr.'],
    ['a promotion', 'Nur heute: 25 % auf alles',
      'Mit dem Gutscheincode HERBST25 sparst du 25 %. Or use code THANKS10 for 10% off. Use promo code FALL2026 at checkout. © 2026 Shop GmbH, 10115 Berlin'],
    ['a code review notification', 'Re: [bulwarkmail/webmail] Show verification codes (PR #1043)',
      'The code at line 1042 should use the shared helper, see commit 5f3e2a1 and issue #1039. Claude Code 2.1.14 fixed it.'],
    ['an invoice', 'Ihre Rechnung RE-2026-10432',
      'Rechnungsbetrag 119,00 EUR. Bitte überweisen Sie bis 10.10.2026 auf IBAN DE89 3704 0044 0532 0130 00, BIC COBADEFFXXX.'],
    ['a sign-in alert without a code', 'Neue Anmeldung bei deinem Konto',
      'Neue Anmeldung von Windows 11 um 14:32 Uhr in Berlin. Du musst keinen Code eingeben. Rufen Sie uns an unter +49 800 3301000 oder 0800 330 1000.'],
    ['a code of conduct update', 'Updates to our Code of Conduct',
      'We updated our Code of Conduct effective 1 October 2026. Contact us at 1 Market St, San Francisco, CA 94105.'],
    ['a card notice', 'Ihre Kreditkarte',
      'Geben Sie niemals Ihren Sicherheitscode oder Ihre PIN weiter. Ihre Karte endet auf 4821. Meeting-ID: 845 1234 5678'],
    ['a QR code', 'Deine Mitgliedskarte', 'Scanne den QR-Code in der App. Deine Mitgliedsnummer 20394857.'],
  ])('finds nothing in %s', (_, subject, text) => {
    expect(findVerificationCode(subject, text)).toBeNull();
  });
});

describe('listVerificationCode', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  const row = (receivedAt: string) => ({ subject: 'Your code is 482913', preview: '', receivedAt });

  it('shows the code of a fresh mail', () => {
    expect(listVerificationCode(row('2026-09-27T11:58:00Z'), now)).toBe('482913');
  });

  it('skips mail older than a day', () => {
    expect(listVerificationCode(row(new Date(now - VERIFICATION_CODE_MAX_AGE_MS - 1000).toISOString()), now)).toBeNull();
  });

  it('allows for a server clock a little ahead', () => {
    expect(listVerificationCode(row('2026-09-27T12:02:00Z'), now)).toBe('482913');
    expect(listVerificationCode(row('2026-09-28T12:00:00Z'), now)).toBeNull();
  });
});

describe('verificationCodeBodyText', () => {
  const part = (partId: string, type: string) => ({ partId, blobId: `blob-${partId}`, size: 1, type });
  const value = (v: string) => ({ value: v, isEncodingProblem: false, isTruncated: false });

  it('reads the HTML part as the reader shows it, without its stylesheet', () => {
    const text = verificationCodeBodyText({
      htmlBody: [part('2', 'text/html')],
      textBody: [part('1', 'text/plain')],
      bodyValues: {
        1: value('This email is only available as HTML.'),
        2: value('<html><body><style>.x{width:600px;color:#123456}</style><table><tr><td>Verification code:</td></tr><tr><td><b>261765</b></td></tr></table></body></html>'),
      },
    });
    expect(text).not.toContain('600px');
    expect(findVerificationCode('Verification Code', text)).toBe('261765');
  });

  it('reads plain-text mail', () => {
    const text = verificationCodeBodyText({
      htmlBody: [part('1', 'text/plain')],
      textBody: [part('1', 'text/plain')],
      bodyValues: { 1: value('Your HA Remote verification code is 811083.') },
    });
    expect(findVerificationCode('', text)).toBe('811083');
  });
});
