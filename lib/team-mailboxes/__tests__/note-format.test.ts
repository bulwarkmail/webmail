import { describe, expect, it } from 'vitest';
import {
  MAX_NOTE_CHARS,
  buildNoteEmail,
  isOwnNote,
  noteKeyFor,
  noteLength,
  noteSubject,
  parseMentions,
  parseNote,
} from '../note-format';

const author = { name: 'Alice Archer', email: 'tm-alice@example.org' };

/** What Stalwart answers for a created note: the header properties echoed back. */
function serverCopy(email: Record<string, unknown>, id = 'n1'): Record<string, unknown> {
  return {
    id,
    receivedAt: '2026-11-20T14:02:11Z',
    from: email.from,
    keywords: email.keywords,
    mailboxIds: email.mailboxIds,
    messageId: (email.messageId as string[]).map((m) => m),
    'header:X-Bulwark-Note-For:asText': email['header:X-Bulwark-Note-For:asText'],
    'header:X-Bulwark-Note-Thread:asText': email['header:X-Bulwark-Note-Thread:asText'] ?? null,
    'header:X-Bulwark-Note-Kind:asText': email['header:X-Bulwark-Note-Kind:asText'],
    'header:X-Bulwark-Note-Mentions:asText': email['header:X-Bulwark-Note-Mentions:asText'] ?? null,
    textBody: [{ partId: '1' }],
    bodyValues: { '1': { value: (email.bodyValues as Record<string, { value: string }>)['1'].value } },
  };
}

describe('note message format', () => {
  it('round-trips a note through the server copy', () => {
    const { email, messageId } = buildNoteEmail({
      mailboxId: 'notes', author, groupAddress: 'tm-team@example.org', subject: 'Re: Offer for the Mulberry project',
      key: 'CAF1x@mail.client.example', threadId: 't9', kind: 'note', mentions: ['HV', 'hw', 'hv'], text: '  waiting for feedback from Mabel \n',
    });
    expect(email).toMatchObject({
      mailboxIds: { notes: true },
      keywords: { $seen: true, '$bulwark-note': true, '$bulwark-mention-hv': true, '$bulwark-mention-hw': true },
      to: [{ email: 'tm-team@example.org' }],
      subject: 'Note: Re: Offer for the Mulberry project',
      'header:X-Bulwark-Note-For:asText': '<CAF1x@mail.client.example>',
      'header:X-Bulwark-Note-Kind:asText': 'note',
      'header:X-Bulwark-Note-Mentions:asText': 'hv, hw',
    });
    // Never threaded into the customer's conversation.
    expect(email).not.toHaveProperty('inReplyTo');
    expect(email).not.toHaveProperty('references');
    expect(messageId).toMatch(/@notes\.bulwark\.invalid$/);

    const note = parseNote(serverCopy(email));
    expect(note).toEqual({
      id: 'n1', messageId, key: 'CAF1x@mail.client.example', threadId: 't9', kind: 'note',
      author: { name: 'Alice Archer', email: 'tm-alice@example.org' },
      at: Date.parse('2026-11-20T14:02:11Z'), mentions: ['hv', 'hw'],
      text: 'waiting for feedback from Mabel', truncated: false,
    });
  });

  it('keys a message without a Message-ID by account and id', () => {
    expect(noteKeyFor({ id: 'e1', messageId: ['<abc@x>'] }, 'g')).toBe('abc@x');
    expect(noteKeyFor({ id: 'e1', messageId: null }, 'g')).toBe('jmap:g/e1');
    expect(noteKeyFor({ id: 'e1', messageId: [] }, 'g')).toBe('jmap:g/e1');
    const { email } = buildNoteEmail({ mailboxId: 'n', author, groupAddress: 'g@x', subject: '', key: 'jmap:g/e1', kind: 'note', text: 'x' });
    expect(parseNote(serverCopy(email))?.key).toBe('jmap:g/e1');
  });

  it('writes timeline entries without text and without mention keywords', () => {
    const { email } = buildNoteEmail({
      mailboxId: 'n', author, groupAddress: 'g@x', subject: 's', key: 'k', kind: 'assigned', mentions: ['hv'], text: 'ignored',
    });
    expect(email.keywords).toEqual({ $seen: true, '$bulwark-note': true });
    expect(email['header:X-Bulwark-Note-Mentions:asText']).toBe('hv');
    const entry = parseNote(serverCopy(email));
    expect(entry).toMatchObject({ kind: 'assigned', mentions: ['hv'], text: '' });
  });

  it('refuses a text over the limit and counts what is left', () => {
    expect(() => buildNoteEmail({ mailboxId: 'n', author, groupAddress: 'g', subject: 's', key: 'k', kind: 'note', text: 'a'.repeat(MAX_NOTE_CHARS + 1) })).toThrow();
    expect(noteLength('a'.repeat(MAX_NOTE_CHARS))).toEqual({ left: 0, over: 0 });
    expect(noteLength('a'.repeat(MAX_NOTE_CHARS + 12))).toEqual({ left: 0, over: 12 });
    // Characters, not UTF-16 units.
    expect(noteLength('😀').left).toBe(MAX_NOTE_CHARS - 1);
  });

  it('shows a longer note from another client cut, not dropped', () => {
    const { email } = buildNoteEmail({ mailboxId: 'n', author, groupAddress: 'g', subject: 's', key: 'k', kind: 'note', text: 'x' });
    const raw = serverCopy(email);
    raw.bodyValues = { '1': { value: 'b'.repeat(MAX_NOTE_CHARS + 5) } };
    const note = parseNote(raw)!;
    expect(note.truncated).toBe(true);
    expect([...note.text!]).toHaveLength(MAX_NOTE_CHARS + 1);
  });

  it('ignores messages that are not usable notes', () => {
    const { email } = buildNoteEmail({ mailboxId: 'n', author, groupAddress: 'g', subject: 's', key: 'k', kind: 'note', text: 'x' });
    const good = serverCopy(email);
    expect(parseNote({ ...good, 'header:X-Bulwark-Note-For:asText': null })).toBeNull();
    expect(parseNote({ ...good, 'header:X-Bulwark-Note-For:asText': '<>' })).toBeNull();
    expect(parseNote({ ...good, 'header:X-Bulwark-Note-Kind:asText': 'chat' })).toBeNull();
    expect(parseNote({ ...good, from: [] })).toBeNull();
    // Header values from other clients: folded spaces, upper case kind, bare For.
    expect(parseNote({ ...good, 'header:X-Bulwark-Note-For:asText': '  abc@x ', 'header:X-Bulwark-Note-Kind:asText': ' Done ' }))
      .toMatchObject({ key: 'abc@x', kind: 'done', text: '' });
  });

  it('reads mentions leniently and keeps only ids', () => {
    expect(parseMentions(' cj,Mabel ,  x y ')).toEqual(['cj', 'mabel', 'x', 'y']);
    expect(parseMentions('a@b.c, <hv>')).toEqual([]);
    expect(parseMentions(null)).toEqual([]);
  });

  it('builds a one-line subject and recognises the author', () => {
    expect(noteSubject('Re:\n  Offer\t now')).toBe('Note: Re: Offer now');
    expect(noteSubject(undefined)).toBe('Note:');
    expect(noteSubject('x'.repeat(300))).toHaveLength(200);
    expect(isOwnNote({ author: { name: '', email: 'tm-alice@example.org' } }, 'TM-Alice@example.org')).toBe(true);
    expect(isOwnNote({ author: { name: '', email: 'tm-alice@example.org' } }, 'tm-bob@example.org')).toBe(false);
    expect(isOwnNote({ author: { name: '', email: 'tm-alice@example.org' } }, null)).toBe(false);
  });
});
