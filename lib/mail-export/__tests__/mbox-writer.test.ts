import { describe, it, expect } from 'vitest';
import { mboxEntry, envelopeLine } from '@/lib/mail-export/mbox-writer';
import { MboxSplitter } from '@/lib/mail-import/mbox';
import { mboxState, withoutStateHeaders } from '@/lib/mail-import/mbox-status';
import { readHeaderBlock } from '@/lib/mail-import/mbox';

const enc = new TextEncoder();
const dec = new TextDecoder();
const join = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

function reread(mbox: Uint8Array) {
  const s = new MboxSplitter();
  return [...s.push(mbox), ...s.end()].map((m) => ({ text: dec.decode(join(m.parts)), state: mboxState(readHeaderBlock(m.parts)), fromLine: m.fromLine }));
}

describe('mboxEntry (mboxrd)', () => {
  const raw = 'Subject: hi\r\nX-Mozilla-Status: 0001\r\nStatus: RO\r\nX-Keywords:\r\n old\r\nFrom: a@example.org\r\n\r\nFrom the top\r\n>From quoted\r\nend\r\n';

  it('copes with a header line of hundreds of kilobytes, on export and on import', () => {
    const long = `X-${'a'.repeat(300_000)}: v\r\nStatus: RO\r\nSubject: s\r\n\r\nbody\r\n`;
    const out = dec.decode(join(mboxEntry(enc.encode(long), { $seen: true }, '2020-01-01T00:00:00Z')));
    expect(out).toContain('aaa: v\r\nSubject: s\r\n');
    const kept = dec.decode(join(withoutStateHeaders([enc.encode(`${'X'.repeat(300_000)}: v\r\nStatus: RO\r\n\r\nb\r\n`)])));
    expect(kept.endsWith(': v\r\n\r\nb\r\n')).toBe(true);
  });

  it('writes an envelope line in asctime UTC', () => {
    expect(envelopeLine('2020-05-05T10:11:12Z', '\n')).toBe('From bulwark-export Tue May  5 10:11:12 2020\n');
  });

  it('quotes From lines, replaces old state headers and keeps CRLF', () => {
    const out = dec.decode(join(mboxEntry(enc.encode(raw), { $flagged: true, work: true }, '2020-05-05T10:11:12Z')));
    expect(out).toBe(
      'From bulwark-export Tue May  5 10:11:12 2020\r\nStatus: O\r\nX-Status: F\r\nX-Keywords: work\r\n'
      + 'Subject: hi\r\nFrom: a@example.org\r\n\r\n>From the top\r\n>>From quoted\r\nend\r\n\r\n',
    );
  });

  it('round-trips through the importer: same bytes minus state headers, same keywords', () => {
    const msgs: { raw: string; keywords: Record<string, boolean> }[] = [
      { raw: 'Subject: one\n\n>>From x\nFrom y\n\nFrom MAILER-DAEMON Tue May  5 10:11:12 2020\n', keywords: { $seen: true, $answered: true } },
      { raw: 'Subject: two\r\n\r\nno newline at end', keywords: { $draft: true, $forwarded: true } },
    ];
    const mbox = join(msgs.flatMap((m) => mboxEntry(enc.encode(m.raw), m.keywords, '2021-01-02T03:04:05Z')));
    const back = reread(mbox);
    expect(back).toHaveLength(2);
    expect(back[0].state.keywords).toEqual({ $seen: true, $answered: true });
    expect(back[0].text.endsWith('Subject: one\n\n>>From x\nFrom y\n\nFrom MAILER-DAEMON Tue May  5 10:11:12 2020\n')).toBe(true);
    expect(back[1].state.keywords).toEqual({ $draft: true, $forwarded: true });
    expect(back[1].text.endsWith('Subject: two\r\n\r\nno newline at end\r\n')).toBe(true);
    expect(back[1].fromLine).toBe('From bulwark-export Sat Jan  2 03:04:05 2021');
  });
});
