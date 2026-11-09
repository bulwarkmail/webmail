import { describe, it, expect } from 'vitest';
import { MboxSplitter, envelopeDate, readHeaderBlock, type MboxMessage } from '@/lib/mail-import/mbox';

const enc = new TextEncoder();
const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join('');

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** Splits `data` fed in chunks of `chunk` bytes (every size hits a different edge). */
function split(data: Uint8Array | string, chunk = data.length, options = {}): MboxMessage[] {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  const s = new MboxSplitter(options);
  const out: MboxMessage[] = [];
  for (let i = 0; i < bytes.length; i += Math.max(1, chunk)) out.push(...s.push(bytes.subarray(i, i + Math.max(1, chunk))));
  out.push(...s.end());
  return out;
}
const texts = (msgs: MboxMessage[]) => msgs.map((m) => latin1(join(m.parts)));

const TWO = [
  'From alice@example.org Tue May  5 10:11:12 2020',
  'Subject: one',
  '',
  'Body one',
  '',
  'From bob@example.org Wed May  6 11:00:00 2020',
  'Subject: two',
  '',
  'Body two',
  '',
].join('\n');

describe('MboxSplitter', () => {
  it('splits on From lines after an empty line and drops the envelope line and the separator', () => {
    const msgs = split(TWO);
    expect(texts(msgs)).toEqual(['Subject: one\n\nBody one\n', 'Subject: two\n\nBody two\n']);
    expect(msgs[0].fromLine).toBe('From alice@example.org Tue May  5 10:11:12 2020');
    expect(msgs[1].offset).toBe(TWO.indexOf('From bob'));
  });

  it('gives the same messages whatever the chunk size', () => {
    const whole = texts(split(TWO));
    for (const size of [1, 2, 3, 5, 7, 13, 64]) expect(texts(split(TWO, size))).toEqual(whole);
  });

  it('keeps a From line that follows a non-empty line in the body', () => {
    const mbox = 'From a Tue May  5 10:11:12 2020\nSubject: x\n\nline\nFrom here on\n';
    expect(texts(split(mbox))).toEqual(['Subject: x\n\nline\nFrom here on\n']);
  });

  it('does not split on a body line "From now on" after an empty line that has no date', () => {
    const mbox = 'From a Tue May  5 10:11:12 2020\nSubject: x\n\nhello\n\nFrom now on we meet\n';
    expect(texts(split(mbox))).toHaveLength(1);
  });

  it('does not split on a body line with a time but no date after it', () => {
    const mbox = 'From a Tue May  5 10:11:12 2020\nSubject: x\n\nhello\n\nFrom now on we meet at 10:30 in room 2020b\n';
    expect(texts(split(mbox))).toHaveLength(1);
  });

  it('splits on envelope lines with a zone or "remote from"', () => {
    const mbox = 'From a Sat Apr 18 08:29:01 +0000 2020\nSubject: 1\n\nb\n\nFrom b Sat Apr 18 08:29:01 2020 remote from host\nSubject: 2\n\nb\n';
    expect(texts(split(mbox))).toHaveLength(2);
  });

  it('unquotes mboxrd ">From " lines by one ">"', () => {
    const mbox = 'From a Tue May  5 10:11:12 2020\nSubject: q\n\n>From the start\n>>From deeper\n> not a from\n>Fromage\n';
    expect(texts(split(mbox, 4))).toEqual(['Subject: q\n\nFrom the start\n>From deeper\n> not a from\n>Fromage\n']);
  });

  it('handles CRLF files and keeps CRLF in the message', () => {
    const msgs = split(TWO.replace(/\n/g, '\r\n'), 3);
    expect(texts(msgs)).toEqual(['Subject: one\r\n\r\nBody one\r\n', 'Subject: two\r\n\r\nBody two\r\n']);
  });

  it('passes 8-bit bytes through untouched', () => {
    const head = enc.encode('From a Tue May  5 10:11:12 2020\nSubject: x\nContent-Type: text/plain; charset=iso-8859-1\n\n');
    const body = new Uint8Array([0x47, 0x72, 0xfc, 0xdf, 0x65, 0x0a, 0xff, 0xfe, 0x80, 0x0a]);
    const msgs = split(join([head, body]), 5);
    const out = join(msgs[0].parts);
    expect(Array.from(out.subarray(out.length - body.length))).toEqual(Array.from(body));
  });

  it('keeps an empty line the message ends with when the separator adds another', () => {
    const mbox = 'From a Tue May  5 10:11:12 2020\nSubject: x\n\nbody\n\n\nFrom b Tue May  5 10:11:12 2020\nSubject: y\n\nz\n';
    expect(texts(split(mbox))).toEqual(['Subject: x\n\nbody\n\n', 'Subject: y\n\nz\n']);
  });

  it('ignores bytes before the first envelope line', () => {
    expect(texts(split('\n\nFrom a Tue May  5 10:11:12 2020\nSubject: x\n\nb\n'))).toEqual(['Subject: x\n\nb\n']);
  });

  describe('Content-Length (mboxcl2)', () => {
    const body = 'first\n\nFrom inside Tue May  5 10:11:12 2020\nstill body\n';
    const mboxcl2 = `From a Tue May  5 10:11:12 2020\nSubject: one\nContent-Length: ${body.length}\n\n${body}\nFrom b Wed May  6 11:00:00 2020\nSubject: two\n\nz\n`;

    it('keeps an unquoted From line inside a body whose Content-Length lands on the next message', () => {
      for (const size of [1, 4, 9, mboxcl2.length]) {
        const out = texts(split(mboxcl2, size));
        expect(out).toHaveLength(2);
        expect(out[0]).toBe(`Subject: one\nContent-Length: ${body.length}\n\n${body}`);
        expect(out[1]).toBe('Subject: two\n\nz\n');
      }
    });

    it('trusts a length that lands right on the next From line too', () => {
      const withBlank = `${body}\n`;
      const mbox = `From a Tue May  5 10:11:12 2020\nContent-Length: ${withBlank.length}\n\n${withBlank}From b Wed May  6 11:00:00 2020\n\nz\n`;
      expect(texts(split(mbox, 3))).toHaveLength(2);
    });

    it('splits at the From lines after all when the length is wrong', () => {
      const wrong = mboxcl2.replace(`Content-Length: ${body.length}`, 'Content-Length: 5');
      const out = texts(split(wrong, 7));
      expect(out).toHaveLength(3);
      expect(out[0]).toBe('Subject: one\nContent-Length: 5\n\nfirst\n');
      expect(out[1]).toBe('still body\n');
      expect(out[2]).toBe('Subject: two\n\nz\n');
    });

    it('splits when the length runs past the end of the file', () => {
      const past = mboxcl2.replace(`Content-Length: ${body.length}`, 'Content-Length: 99999');
      expect(texts(split(past))).toHaveLength(3);
    });

    it('trusts a length that ends the file', () => {
      const last = `From a Tue May  5 10:11:12 2020\nContent-Length: ${body.length}\n\n${body}`;
      expect(texts(split(last, 2))).toEqual([`Content-Length: ${body.length}\n\n${body}`]);
    });
  });

  it('reports a message over the size limit without keeping its bytes', () => {
    const big = `From a Tue May  5 10:11:12 2020\nSubject: big\n\n${'x'.repeat(500)}\n\nFrom b Wed May  6 11:00:00 2020\nSubject: small\n\nok\n`;
    const msgs = split(big, 50, { maxMessageBytes: 100 });
    expect(msgs[0].tooLarge).toBe(true);
    expect(msgs[0].parts).toEqual([]);
    expect(msgs[0].size).toBeGreaterThan(100);
    expect(msgs[1].tooLarge).toBe(false);
    expect(latin1(join(msgs[1].parts))).toBe('Subject: small\n\nok\n');
  });
});

describe('envelopeDate', () => {
  it('reads the asctime date of an envelope line as UTC', () => {
    expect(envelopeDate('From alice@example.org Tue May  5 10:11:12 2020')).toBe('2020-05-05T10:11:12Z');
    expect(envelopeDate('From - Fri Jan 31 23:59:00 2014')).toBe('2014-01-31T23:59:00Z');
  });
  it('applies a zone written before the year (Gmail Takeout)', () => {
    expect(envelopeDate('From 1234@xxx Sat Apr 18 08:29:01 +0200 2020')).toBe('2020-04-18T06:29:01Z');
  });
  it('returns undefined without a date', () => {
    expect(envelopeDate('From someone')).toBeUndefined();
  });
});

describe('readHeaderBlock', () => {
  it('stops at the first empty line', () => {
    expect(readHeaderBlock([enc.encode('A: 1\r\nB: 2\r\n\r\nbody')])).toBe('A: 1\r\nB: 2');
  });
});
