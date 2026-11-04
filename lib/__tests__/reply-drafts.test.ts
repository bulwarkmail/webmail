import { describe, expect, it, vi } from 'vitest';
import { answersMessage, findReplyDraft, threadDrafts } from '@/lib/reply-drafts';
import type { Email } from '@/lib/jmap/types';

const message = { id: 'm1', messageId: ['abc@example.org'] as unknown as string };
const draft = (id: string, extra: Partial<Email> = {}) => ({
  id, threadId: 't1', keywords: { $draft: true }, receivedAt: '2026-11-02T10:00:00Z', ...extra,
}) as Email;

describe('answersMessage', () => {
  it('matches a draft whose In-Reply-To names the message, brackets or not', () => {
    expect(answersMessage(draft('d1', { inReplyTo: ['<abc@example.org>'] }), message)).toBe(true);
    expect(answersMessage(draft('d1', { inReplyTo: ['abc@example.org'] }), { messageId: 'abc@example.org' })).toBe(true);
  });

  it('leaves out a reply to another message, and a sent message', () => {
    expect(answersMessage(draft('d1', { inReplyTo: ['other@example.org'] }), message)).toBe(false);
    expect(answersMessage({ inReplyTo: ['abc@example.org'], keywords: {} }, message)).toBe(false);
  });
});

describe('findReplyDraft', () => {
  it('reads list rows without In-Reply-To in full and picks the newest that answers', async () => {
    const full: Record<string, Email> = {
      d1: draft('d1', { inReplyTo: ['abc@example.org'], receivedAt: '2026-11-01T10:00:00Z' }),
      d2: draft('d2', { inReplyTo: ['abc@example.org'], receivedAt: '2026-11-03T10:00:00Z' }),
      d3: draft('d3', { inReplyTo: ['other@example.org'], receivedAt: '2026-11-04T10:00:00Z' }),
    };
    const getEmail = vi.fn(async (id: string) => full[id] ?? null);
    const rows = Object.values(full).map(({ inReplyTo: _drop, ...row }) => row as Email);
    const found = await findReplyDraft(rows, message, getEmail);
    expect(found?.id).toBe('d2');
    expect(getEmail).toHaveBeenCalledWith('d3');
    expect(getEmail).not.toHaveBeenCalledWith('d1');
  });

  it('finds nothing for a message without a Message-ID', async () => {
    const getEmail = vi.fn();
    expect(await findReplyDraft([draft('d1')], { id: 'm1' }, getEmail)).toBeNull();
    expect(getEmail).not.toHaveBeenCalled();
  });
});

describe('threadDrafts', () => {
  it('returns the drafts of a conversation, and asks nothing more of a single message', async () => {
    const client = {
      getThread: vi.fn(async (id: string) => (id === 't1' ? { emailIds: ['m1', 'd1'] } : { emailIds: ['x'] })),
      getSomeEmails: vi.fn(async () => [{ id: 'm1', keywords: {} }, draft('d1')] as Email[]),
    };
    expect((await threadDrafts(client, 't1', 'acc')).map((e) => e.id)).toEqual(['d1']);
    expect(await threadDrafts(client, 't2', 'acc')).toEqual([]);
    expect(client.getSomeEmails).toHaveBeenCalledTimes(1);
  });
});
