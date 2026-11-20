import { describe, expect, it, vi } from 'vitest';
import { fileReplyWithOriginal, fileWithOriginalTargets } from '@/lib/outgoing/file-with-original';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Mailbox } from '@/lib/jmap/types';

const rights = { mayAddItems: true } as Mailbox['myRights'];
const box = (id: string, extra: Partial<Mailbox> = {}): Mailbox => ({
  id, name: id, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
  myRights: rights, isSubscribed: true, ...extra,
});

const folders = [
  box('inbox', { role: 'inbox' }),
  box('sent', { role: 'sent' }),
  box('drafts', { role: 'drafts' }),
  box('trash', { role: 'trash' }),
  box('projects'),
  box('readonly', { myRights: { mayAddItems: false } as Mailbox['myRights'] }),
  box('g:inbox', { role: 'inbox', isShared: true, accountId: 'g', originalId: 'inbox' }),
  box('g:acme', { isShared: true, accountId: 'g', originalId: 'acme' }),
  box('g:sent', { role: 'sent', isShared: true, accountId: 'g', originalId: 'sent' }),
];

describe('fileWithOriginalTargets', () => {
  it("offers the own account's folders that take mail, without Sent, Drafts or Trash", () => {
    expect(fileWithOriginalTargets(folders, undefined, 'me').map((m) => m.id)).toEqual(['inbox', 'projects']);
    expect(fileWithOriginalTargets(folders, 'me', 'me').map((m) => m.id)).toEqual(['inbox', 'projects']);
  });

  it("offers only the group's folders for a message in a group account", () => {
    expect(fileWithOriginalTargets(folders, 'g', 'me').map((m) => m.id)).toEqual(['g:inbox', 'g:acme']);
  });
});

function client(accountId: string): IJMAPClient {
  return {
    getAccountId: () => accountId,
    addEmailToMailbox: vi.fn().mockResolvedValue(undefined),
  } as unknown as IJMAPClient;
}

describe('fileReplyWithOriginal', () => {
  it('files the reply in the folder by its server id and moves the original', async () => {
    const c = client('me');
    const moveOriginal = vi.fn().mockResolvedValue(true);
    const result = await fileReplyWithOriginal({
      folder: folders[7], client: c, accountId: 'g',
      reply: { id: 'reply-1', accountId: 'g', sameLogin: true },
      moveOriginal,
    });
    expect(c.addEmailToMailbox).toHaveBeenCalledWith('reply-1', 'acme', 'g');
    expect(moveOriginal).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ originalMoved: true, replyFiled: true, replyElsewhere: false });
  });

  it('leaves a reply from another account in Sent and still moves the original', async () => {
    const c = client('me');
    const result = await fileReplyWithOriginal({
      folder: folders[7], client: c, accountId: 'g',
      reply: { id: 'reply-1', accountId: 'me', sameLogin: true },
      moveOriginal: vi.fn().mockResolvedValue(true),
    });
    expect(c.addEmailToMailbox).not.toHaveBeenCalled();
    expect(result).toEqual({ originalMoved: true, replyFiled: false, replyElsewhere: true });
  });

  it('leaves a reply sent through another login in Sent', async () => {
    const c = client('me');
    const result = await fileReplyWithOriginal({
      folder: folders[4], client: c,
      reply: { id: 'reply-1', accountId: 'me', sameLogin: false },
      moveOriginal: vi.fn().mockResolvedValue(true),
    });
    expect(c.addEmailToMailbox).not.toHaveBeenCalled();
    expect(result.replyElsewhere).toBe(true);
  });

  it('counts the own account the same whether named or not', async () => {
    const c = client('me');
    const result = await fileReplyWithOriginal({
      folder: folders[4], client: c,
      reply: { id: 'reply-1', accountId: 'me', sameLogin: true },
      moveOriginal: vi.fn().mockResolvedValue(true),
    });
    expect(c.addEmailToMailbox).toHaveBeenCalledWith('reply-1', 'projects', undefined);
    expect(result.replyFiled).toBe(true);
  });

  it('still files the reply when the move of the original fails', async () => {
    const c = client('me');
    const result = await fileReplyWithOriginal({
      folder: folders[4], client: c,
      reply: { id: 'reply-1', sameLogin: true },
      moveOriginal: vi.fn().mockRejectedValue(new Error('forbidden')),
    });
    expect(result).toEqual({ originalMoved: false, replyFiled: true, replyElsewhere: false });
  });
});
