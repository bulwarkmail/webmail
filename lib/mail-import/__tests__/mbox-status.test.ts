import { describe, it, expect } from 'vitest';
import { mboxState, withoutStateHeaders } from '@/lib/mail-import/mbox-status';

describe('mboxState', () => {
  it('imports a message without any state header as read, as before', () => {
    expect(mboxState('Subject: x\nDate: Tue, 5 May 2020 10:00:00 +0000')).toEqual({ keywords: { $seen: true }, expunged: false });
  });

  it('reads Status R as read and Status O alone as unread', () => {
    expect(mboxState('Status: RO').keywords).toEqual({ $seen: true });
    expect(mboxState('Status: O').keywords).toEqual({});
  });

  it('reads X-Status answered, flagged and draft', () => {
    expect(mboxState('Status: O\nX-Status: AFT').keywords).toEqual({ $answered: true, $flagged: true, $draft: true });
  });

  it('reads Thunderbird X-Mozilla-Status bits', () => {
    expect(mboxState('X-Mozilla-Status: 0001').keywords).toEqual({ $seen: true });
    expect(mboxState('X-Mozilla-Status: 0000').keywords).toEqual({});
    expect(mboxState('X-Mozilla-Status: 1006').keywords).toEqual({ $answered: true, $flagged: true, $forwarded: true });
  });

  it('marks a Thunderbird-expunged message (0x8) to be skipped', () => {
    expect(mboxState('X-Mozilla-Status: 0009').expunged).toBe(true);
    expect(mboxState('X-Mozilla-Status: 0001').expunged).toBe(false);
  });

  it('adds X-Keywords and X-Mozilla-Keys, skipping invalid and server-set ones', () => {
    const { keywords } = mboxState('Status: R\nX-Keywords: Work, $label1 bad(word) $HasAttachment\nX-Mozilla-Keys: todo');
    expect(keywords).toEqual({ $seen: true, work: true, $label1: true, todo: true });
  });

  it('reads Google Takeout labels', () => {
    expect(mboxState('X-Gmail-Labels: Inbox,Unread').keywords).toEqual({});
    expect(mboxState('X-Gmail-Labels: Inbox,Starred').keywords).toEqual({ $seen: true, $flagged: true });
  });

  it('reads folded and differently cased headers', () => {
    expect(mboxState('subject: a\r\nx-status:\r\n F\r\nSTATUS: O').keywords).toEqual({ $flagged: true });
  });
});

describe('withoutStateHeaders', () => {
  const enc = new TextEncoder();
  const text = (parts: Uint8Array[]) => parts.map((p) => new TextDecoder().decode(p)).join('');
  it('drops the state headers, folded lines too, and keeps the rest byte for byte', () => {
    const raw = 'Status: RO\r\nSubject: hi\r\nX-Keywords: a\r\n b\r\nX-Mozilla-Status: 0001\r\nFrom: x@example.org\r\n\r\nStatus: in the body\r\n';
    // Split in odd places, as the mbox splitter hands them over.
    const parts = [enc.encode(raw.slice(0, 7)), enc.encode(raw.slice(7, 40)), enc.encode(raw.slice(40))];
    expect(text(withoutStateHeaders(parts))).toBe('Subject: hi\r\nFrom: x@example.org\r\n\r\nStatus: in the body\r\n');
  });
  it('leaves a message without them as it was', () => {
    const parts = [enc.encode('Subject: hi\n\nbody\n')];
    expect(withoutStateHeaders(parts)).toBe(parts);
  });
});

