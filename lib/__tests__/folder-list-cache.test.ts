import { beforeEach, describe, expect, it } from 'vitest';
import { forgetFolderLists, rememberFolderList, rememberedFolderList } from '../folder-list-cache';
import type { Email } from '../jmap/types';

describe('folder list cache', () => {
  beforeEach(() => forgetFolderLists());

  it('keeps the drafts by conversation, so a revisit needs no extra request for them (#1798)', () => {
    const draftThreads = new Map([['t-1', 'd-1']]);
    rememberFolderList('acc:inbox', {
      emails: [{ id: 'm-1', threadId: 't-1' } as unknown as Email],
      totalEmails: 1,
      hasMoreEmails: false,
      sync: null,
      threadEmailCounts: new Map([['t-1', 2]]),
      draftThreads,
    }, 50);
    expect(rememberedFolderList('acc:inbox')?.draftThreads).toBe(draftThreads);
  });
});
