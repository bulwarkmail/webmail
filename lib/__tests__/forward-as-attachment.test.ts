import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildForwardAsAttachmentPayload, buildBatchForwardAsAttachmentPayload } from '@/lib/forward-as-attachment';
import type { Email } from '@/lib/jmap/types';

// Pin TZ so the local-time date rendering in the filename test is deterministic,
// restoring it after so this doesn't leak into other test files in the same worker.
let originalTZ: string | undefined;
beforeAll(() => {
  originalTZ = process.env.TZ;
  process.env.TZ = 'UTC';
});
afterAll(() => {
  // process.env coerces to strings, so `= undefined` would leave the literal
  // string "undefined" behind when TZ was originally unset - delete instead.
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: 'e1',
    threadId: 't1',
    mailboxIds: { inbox: true },
    keywords: {},
    size: 12345,
    receivedAt: '2026-07-26T22:25:22Z',
    subject: 'Your waste service day is changing',
    hasAttachment: false,
    blobId: 'blob123',
    ...overrides,
  };
}

describe('buildForwardAsAttachmentPayload', () => {
  it('returns null when the email has no blobId', () => {
    const email = makeEmail({ blobId: undefined });
    expect(buildForwardAsAttachmentPayload(email, 'Fwd:')).toBeNull();
  });

  it('prefixes the subject using the given forward prefix', () => {
    const email = makeEmail({ subject: 'Missed spam example' });
    const payload = buildForwardAsAttachmentPayload(email, 'Fwd:');
    expect(payload?.subject).toBe('Fwd: Missed spam example');
  });

  it('builds a message/rfc822 attachment referencing the email\'s own blobId, not a new upload', () => {
    const email = makeEmail({ blobId: 'the-real-blob-id', size: 26489 });
    const payload = buildForwardAsAttachmentPayload(email, 'Fwd:');
    expect(payload?.attachment).toEqual({
      blobId: 'the-real-blob-id',
      name: expect.stringMatching(/\.eml$/),
      type: 'message/rfc822',
      size: 26489,
    });
  });

  it('is idempotent - repeated forwarding does not stack prefixes', () => {
    const email = makeEmail({ subject: 'Fwd: already forwarded once' });
    const payload = buildForwardAsAttachmentPayload(email, 'Fwd:');
    expect(payload?.subject).toBe('Fwd: already forwarded once');
  });

  it('leaves the subject blank (not just the bare prefix) for a subject-less message, matching normal Forward', () => {
    const email = makeEmail({ subject: undefined });
    const payload = buildForwardAsAttachmentPayload(email, 'Fwd:');
    expect(payload?.subject).toBe('');
  });

  it('applies user space/case transforms but ignores a custom filename template, unlike "Export as .eml"', () => {
    const email = makeEmail({ subject: 'Missed spam example' });
    const payload = buildForwardAsAttachmentPayload(email, 'Fwd:', {
      template: 'custom-{subject}',
      lowercase: true,
      spaceReplacement: 'dash',
    });
    expect(payload?.attachment.name).toBe('2026-07-26-22.25.22-missed-spam-example.eml');
  });

  it('uses a dash between date and subject by default', () => {
    const email = makeEmail({ subject: 'Missed spam example' });
    const payload = buildForwardAsAttachmentPayload(email, 'Fwd:');
    expect(payload?.attachment.name).toBe('2026-07-26 22.25.22-Missed spam example.eml');
  });

  it('never includes from/to in the filename, even with the default template, to avoid leaking names to the recipient', () => {
    const email = makeEmail({
      subject: 'Missed spam example',
      from: [{ name: 'Alice Sender', email: 'alice@example.com' }],
      to: [{ name: "'Bobby'", email: 'bob@example.com' }],
    });
    const payload = buildForwardAsAttachmentPayload(email, 'Fwd:');
    expect(payload?.attachment.name).not.toContain('Alice');
    expect(payload?.attachment.name).not.toContain('Bobby');
  });
});

describe('buildBatchForwardAsAttachmentPayload', () => {
  const countLabel = (n: number) => `${n} email${n === 1 ? '' : 's'}`;

  it('returns null when no email has a blobId', () => {
    const emails = [makeEmail({ id: 'e1', blobId: undefined }), makeEmail({ id: 'e2', blobId: undefined })];
    expect(buildBatchForwardAsAttachmentPayload(emails, 'Fwd:', countLabel)).toBeNull();
  });

  it('skips emails without a blobId and attaches the rest', () => {
    const emails = [
      makeEmail({ id: 'e1', blobId: 'blob-1' }),
      makeEmail({ id: 'e2', blobId: undefined }),
      makeEmail({ id: 'e3', blobId: 'blob-3' }),
    ];
    const payload = buildBatchForwardAsAttachmentPayload(emails, 'Fwd:', countLabel);
    expect(payload?.attachments.map((a) => a.blobId)).toEqual(['blob-1', 'blob-3']);
  });

  it('builds the subject from the attachable count, not the input length', () => {
    const emails = [
      makeEmail({ id: 'e1', blobId: 'blob-1' }),
      makeEmail({ id: 'e2', blobId: 'blob-2' }),
      makeEmail({ id: 'e3', blobId: undefined }),
    ];
    const payload = buildBatchForwardAsAttachmentPayload(emails, 'Fwd:', countLabel);
    expect(payload?.subject).toBe('Fwd: 2 emails');
  });

  it('prefixes the count phrase using the given forward prefix', () => {
    const emails = [makeEmail({ id: 'e1', blobId: 'b1' }), makeEmail({ id: 'e2', blobId: 'b2' })];
    const payload = buildBatchForwardAsAttachmentPayload(emails, 'WG:', countLabel);
    expect(payload?.subject).toBe('WG: 2 emails');
  });

  it('preserves the input list order of the attachments', () => {
    const emails = [
      makeEmail({ id: 'e1', blobId: 'b1', subject: 'First' }),
      makeEmail({ id: 'e2', blobId: 'b2', subject: 'Second' }),
      makeEmail({ id: 'e3', blobId: 'b3', subject: 'Third' }),
    ];
    const payload = buildBatchForwardAsAttachmentPayload(emails, 'Fwd:', countLabel);
    expect(payload?.attachments.map((a) => a.name)).toEqual([
      expect.stringMatching(/first/i),
      expect.stringMatching(/second/i),
      expect.stringMatching(/third/i),
    ]);
  });

  it('references each email\'s own blobId and size as message/rfc822 .eml entries', () => {
    const emails = [
      makeEmail({ id: 'e1', blobId: 'b1', size: 100 }),
      makeEmail({ id: 'e2', blobId: 'b2', size: 200 }),
    ];
    const payload = buildBatchForwardAsAttachmentPayload(emails, 'Fwd:', countLabel);
    expect(payload?.attachments).toEqual([
      { blobId: 'b1', name: expect.stringMatching(/\.eml$/), type: 'message/rfc822', size: 100 },
      { blobId: 'b2', name: expect.stringMatching(/\.eml$/), type: 'message/rfc822', size: 200 },
    ]);
  });

  it('applies user space/case transforms but ignores a custom filename template, unlike "Export as .eml"', () => {
    const emails = [makeEmail({ id: 'e1', blobId: 'b1', subject: 'Missed spam example' })];
    const payload = buildBatchForwardAsAttachmentPayload(emails, 'Fwd:', countLabel, {
      template: 'custom-{subject}',
      lowercase: true,
      spaceReplacement: 'dash',
    });
    expect(payload?.attachments[0].name).toBe('2026-07-26-22.25.22-missed-spam-example.eml');
  });

  it('supports a single email, producing a "one" count label', () => {
    const emails = [makeEmail({ id: 'e1', blobId: 'b1' })];
    const payload = buildBatchForwardAsAttachmentPayload(emails, 'Fwd:', countLabel);
    expect(payload?.subject).toBe('Fwd: 1 email');
    expect(payload?.attachments).toHaveLength(1);
  });
});
