import { describe, expect, it } from 'vitest';
import { takeoverHeaderFields, takeoverSubmission, withTakeoverHeaders } from '../takeover-headers';

// What the composer's own send writes into the header and a crypto plugin's
// send lacked: Reply-To, the read receipt request and the priority. The host
// adds them to the top-level header block of the plugin's raw message.

const enc = (text: string) => Uint8Array.from(text, (ch) => ch.charCodeAt(0) & 0xff);
const dec = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join('');

const SIGNED = [
  'From: Ann <ann@example.com>',
  'To: bob@example.org',
  'Subject: Hi',
  'MIME-Version: 1.0',
  'Content-Type: multipart/signed; protocol="application/pkcs7-signature"; boundary="b"',
  '',
  '--b',
  'Content-Type: text/plain',
  '',
  'Reply-To: not a header, this is the signed text',
  '--b--',
  '',
].join('\r\n');
const headOf = (raw: string) => raw.slice(0, raw.indexOf('\r\n\r\n')).split('\r\n');
const bodyOf = (raw: string) => raw.slice(raw.indexOf('\r\n\r\n'));

describe('the fields', () => {
  it('writes nothing without options', () => {
    expect(takeoverHeaderFields(null)).toEqual([]);
    expect(takeoverHeaderFields({})).toEqual([]);
    expect(takeoverHeaderFields({ replyTo: [], priority: 'normal' })).toEqual([]);
  });

  it('writes Reply-To with names and addresses', () => {
    expect(takeoverHeaderFields({ replyTo: [{ name: 'Team', email: 'team@example.org' }, { email: 'desk@example.org' }] }))
      .toEqual([['Reply-To', 'Team <team@example.org>, desk@example.org']]);
  });

  it('encodes a name outside ASCII and quotes one with specials', () => {
    expect(takeoverHeaderFields({ replyTo: [{ name: 'Team Müller', email: 'team@example.org' }] }))
      .toEqual([['Reply-To', '=?UTF-8?B?VGVhbSBNw7xsbGVy?= <team@example.org>']]);
    expect(takeoverHeaderFields({ replyTo: [{ name: 'Doe, "Jo"', email: 'jo@example.org' }] }))
      .toEqual([['Reply-To', '"Doe, \\"Jo\\"" <jo@example.org>']]);
  });

  it('writes the read receipt request and the priority as the composer\'s own send does', () => {
    expect(takeoverHeaderFields({ readReceiptTo: 'ann@example.com', priority: 'high' })).toEqual([
      ['Disposition-Notification-To', 'ann@example.com'],
      ['X-Priority', '1 (Highest)'],
      ['Importance', 'high'],
    ]);
    expect(takeoverHeaderFields({ priority: 'low' })).toEqual([['X-Priority', '5 (Lowest)'], ['Importance', 'low']]);
  });

  it.each([
    ['a line break', 'team@example.org\r\nBcc: eve@example.net'],
    ['a blank', 'team @example.org'],
    ['angle brackets', '<team@example.org>'],
    ['a comma', 'team@example.org,eve@example.net'],
    ['two at signs', 'team@example.org@example.net'],
    ['no domain', 'team@'],
    ['a character outside ASCII', 'tëam@example.org'],
  ])('leaves out an address with %s', (_label, email) => {
    expect(takeoverHeaderFields({ replyTo: [{ email }], readReceiptTo: email })).toEqual([]);
  });

  it('keeps a line break in a name out of the header', () => {
    const [[, value]] = takeoverHeaderFields({ replyTo: [{ name: 'Team\r\nBcc: eve@example.net', email: 'team@example.org' }] });
    expect(value).not.toMatch(/[\r\n]/);
    expect(value.endsWith(' <team@example.org>')).toBe(true);
  });
});

describe('the raw message', () => {
  const options = { replyTo: [{ name: 'Team', email: 'team@example.org' }], readReceiptTo: 'ann@example.com', priority: 'high' as const };

  it('gets the fields at the end of its header block', () => {
    const out = dec(withTakeoverHeaders(enc(SIGNED), options));
    expect(headOf(out)).toEqual([
      ...headOf(SIGNED),
      'Reply-To: Team <team@example.org>',
      'Disposition-Notification-To: ann@example.com',
      'X-Priority: 1 (Highest)',
      'Importance: high',
    ]);
  });

  it('keeps everything after the header block byte for byte, so a signature still fits', () => {
    const out = dec(withTakeoverHeaders(enc(SIGNED), options));
    expect(bodyOf(out)).toBe(bodyOf(SIGNED));
  });

  it('returns the same bytes when there is nothing to add', () => {
    const bytes = enc(SIGNED);
    expect(withTakeoverHeaders(bytes, null)).toBe(bytes);
    expect(withTakeoverHeaders(bytes, {})).toBe(bytes);
  });

  it('leaves a field the plugin wrote itself as it is, whatever its spelling', () => {
    const own = SIGNED.replace('Subject: Hi', 'Subject: Hi\r\nreply-to: own@example.org\r\nIMPORTANCE: low');
    const head = headOf(dec(withTakeoverHeaders(enc(own), options)));
    expect(head.filter((line) => /^reply-to:/i.test(line))).toEqual(['reply-to: own@example.org']);
    expect(head.filter((line) => /^importance:/i.test(line))).toEqual(['IMPORTANCE: low']);
    expect(head).toContain('Disposition-Notification-To: ann@example.com');
    expect(head).toContain('X-Priority: 1 (Highest)');
  });

  it('does not take a field name inside a folded line for a field', () => {
    const folded = SIGNED.replace('Subject: Hi', 'Subject: Hi\r\n Reply-To: part of the subject');
    expect(headOf(dec(withTakeoverHeaders(enc(folded), options)))).toContain('Reply-To: Team <team@example.org>');
  });

  it('uses the line break of the message', () => {
    const lf = SIGNED.replace(/\r\n/g, '\n');
    const out = dec(withTakeoverHeaders(enc(lf), options));
    expect(out).not.toContain('\r');
    expect(out.slice(0, out.indexOf('\n\n')).split('\n')).toContain('Importance: high');
  });

  it('keeps 8-bit bytes in the header as they are', () => {
    const utf8 = new TextEncoder().encode(SIGNED.replace('Subject: Hi', 'Subject: Grüße'));
    const out = withTakeoverHeaders(utf8, options);
    expect(new TextDecoder().decode(out)).toContain('Subject: Grüße\r\n');
  });

  it('returns a message without a header block as it is', () => {
    const bytes = enc('no blank line anywhere');
    expect(withTakeoverHeaders(bytes, options)).toBe(bytes);
  });

  it('folds a long Reply-To between addresses', () => {
    const replyTo = Array.from({ length: 6 }, (_, i) => ({ name: `Team number ${i}`, email: `team-${i}@example.org` }));
    const head = headOf(dec(withTakeoverHeaders(enc(SIGNED), { replyTo })));
    const lines = head.slice(head.findIndex((line) => line.startsWith('Reply-To:')));
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(78);
    expect(lines.join('').replace(/, /g, ',').replace(/,/g, ', ')).toBe(`Reply-To: ${replyTo.map((r) => `Team number ${r.email.slice(5, 6)} <${r.email}>`).join(', ')}`);
  });
});

describe('what the send asks of the mail server', () => {
  it('is nothing without delivery notifications or required TLS', () => {
    expect(takeoverSubmission(null)).toBeUndefined();
    expect(takeoverSubmission({ priority: 'high' })).toBeUndefined();
    expect(takeoverSubmission({ requestDsn: false, requireTls: false })).toBeUndefined();
  });

  it('carries each of the two that is set', () => {
    expect(takeoverSubmission({ requestDsn: true })).toEqual({ requestDsn: true });
    expect(takeoverSubmission({ requireTls: true })).toEqual({ requireTls: true });
    expect(takeoverSubmission({ requestDsn: true, requireTls: true, priority: 'low' })).toEqual({ requestDsn: true, requireTls: true });
  });

  it('writes neither into the header', () => {
    expect(takeoverHeaderFields({ requestDsn: true, requireTls: true })).toEqual([]);
  });
});
