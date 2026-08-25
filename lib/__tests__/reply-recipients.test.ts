import { describe, it, expect } from 'vitest';
import { buildReplyRecipients, isSelfSent } from '@/lib/reply-recipients';

const OWN = ['me@example.com', 'info@example.com'];

const emails = (list: { email?: string }[]) => list.map((r) => r.email);

describe('buildReplyRecipients', () => {
  describe('received message', () => {
    const received = {
      from: [{ email: 'bob@other.com', name: 'Bob' }],
      to: [{ email: 'me@example.com' }, { email: 'carol@other.com' }],
      cc: [{ email: 'dave@other.com' }],
    };

    it('replies to the sender', () => {
      const { to, cc } = buildReplyRecipients(received, 'reply', OWN);
      expect(emails(to)).toEqual(['bob@other.com']);
      expect(cc).toEqual([]);
    });

    it('prefers the Reply-To header over From', () => {
      const { to } = buildReplyRecipients(
        { ...received, replyToAddresses: [{ email: 'list@other.com' }] },
        'reply',
        OWN,
      );
      expect(emails(to)).toEqual(['list@other.com']);
    });

    it('reply-all keeps the other recipients and drops our own address', () => {
      const { to, cc } = buildReplyRecipients(received, 'replyAll', OWN);
      expect(emails(to)).toEqual(['bob@other.com', 'carol@other.com']);
      expect(emails(cc)).toEqual(['dave@other.com']);
    });

    it('reply-all drops our own address even with +tag sub-addressing', () => {
      const { to } = buildReplyRecipients(
        { ...received, to: [{ email: 'me+newsletter@example.com' }, { email: 'carol@other.com' }] },
        'replyAll',
        OWN,
      );
      expect(emails(to)).toEqual(['bob@other.com', 'carol@other.com']);
    });
  });

  describe('self-sent message (#703)', () => {
    const sent = {
      from: [{ email: 'me@example.com', name: 'Me' }],
      to: [{ email: 'bob@other.com', name: 'Bob' }],
      cc: [{ email: 'carol@other.com' }],
    };

    it('replies to the original recipient, not to ourselves', () => {
      const { to, cc } = buildReplyRecipients(sent, 'reply', OWN);
      expect(emails(to)).toEqual(['bob@other.com']);
      expect(cc).toEqual([]);
    });

    it('reply-all restores the original To and Cc', () => {
      const { to, cc } = buildReplyRecipients(sent, 'replyAll', OWN);
      expect(emails(to)).toEqual(['bob@other.com']);
      expect(emails(cc)).toEqual(['carol@other.com']);
    });

    it('recognises the sending identity through +tag sub-addressing', () => {
      const { to } = buildReplyRecipients(
        { ...sent, from: [{ email: 'me+project@example.com' }] },
        'reply',
        OWN,
      );
      expect(emails(to)).toEqual(['bob@other.com']);
    });

    it('ignores our own Reply-To header so the reply leaves our mailbox', () => {
      const { to } = buildReplyRecipients(
        { ...sent, replyToAddresses: [{ email: 'info@example.com' }] },
        'reply',
        OWN,
      );
      expect(emails(to)).toEqual(['bob@other.com']);
    });

    it('honours an EXTERNAL Reply-To even on a self-sent message (#776)', () => {
      // Contact-form / helpdesk pattern: the mail arrives From our own address
      // (so it looks self-sent) but Reply-To carries the real correspondent.
      // The reply must reach them, not loop back to our own To.
      const { to } = buildReplyRecipients(
        { ...sent, to: [{ email: 'me@example.com' }], replyToAddresses: [{ email: 'customer@external.com' }] },
        'reply',
        OWN,
      );
      expect(emails(to)).toEqual(['customer@external.com']);
    });

    it('reply-all with an external Reply-To routes To to the Reply-To (#776)', () => {
      const { to } = buildReplyRecipients(
        { ...sent, replyToAddresses: [{ email: 'customer@external.com' }] },
        'replyAll',
        OWN,
      );
      // Reply-To leads; the other original recipients (bob) are still included,
      // our own address dropped.
      expect(emails(to)).toEqual(['customer@external.com', 'bob@other.com']);
    });

    it('keeps a self-addressed recipient we chose ourselves', () => {
      const { to } = buildReplyRecipients(
        { ...sent, to: [{ email: 'info@example.com' }] },
        'reply',
        OWN,
      );
      expect(emails(to)).toEqual(['info@example.com']);
    });

    it('falls back to the sender when there is no visible recipient (Bcc-only)', () => {
      const { to } = buildReplyRecipients({ ...sent, to: [], cc: [] }, 'reply', OWN);
      expect(emails(to)).toEqual(['me@example.com']);
    });

    it('keeps the display names of the original recipients', () => {
      const { to } = buildReplyRecipients(sent, 'reply', OWN);
      expect(to[0]).toEqual({ email: 'bob@other.com', name: 'Bob' });
    });
  });

  it('returns nothing without a source message', () => {
    expect(buildReplyRecipients(undefined, 'replyAll', OWN)).toEqual({ to: [], cc: [] });
  });

  it('treats a message as foreign when no identity matches', () => {
    expect(isSelfSent({ from: [{ email: 'bob@other.com' }] }, OWN)).toBe(false);
    expect(isSelfSent({ from: [{ email: 'ME@Example.com ' }] }, OWN)).toBe(true);
    expect(isSelfSent({ from: [] }, OWN)).toBe(false);
    expect(isSelfSent(undefined, OWN)).toBe(false);
  });
});
