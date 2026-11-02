import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// batchArchive and batchSetTag act on the list selection; a plugin's batch
// (email.batch) names its messages instead. With a target they must act on
// exactly those messages, in the target's account, whatever is selected or
// open, and archive by the user's archiveMode.

const box = (id: string, role: string | null, extra: Partial<Mailbox> = {}) => ({ id, name: id, role, isShared: false, ...extra }) as unknown as Mailbox;
const email = (id: string, keywords: Record<string, boolean> = {}) => ({
  id, threadId: `t-${id}`, receivedAt: '2025-03-04T10:00:00Z', mailboxIds: { inbox: true }, keywords,
}) as unknown as Email;

describe('batch functions with an explicit target', () => {
  let client: IJMAPClient;
  let other: IJMAPClient;

  beforeEach(() => {
    client = {
      getMailboxes: vi.fn().mockResolvedValue([box('inbox', 'inbox'), box('arch', 'archive'), box('acc2:x', null, { isShared: true, accountId: 'acc2' } as never)]),
      batchArchiveEmails: vi.fn().mockResolvedValue(undefined),
      batchUpdateKeywords: vi.fn().mockResolvedValue(undefined),
      getAccountId: () => 'acc1',
    } as unknown as IJMAPClient;
    other = { batchUpdateKeywords: vi.fn(), batchArchiveEmails: vi.fn() } as unknown as IJMAPClient;
    useSettingsStore.setState({ archiveMode: 'year' } as never);
    useEmailStore.setState({
      emails: [email('m1'), email('keep')],
      // The selection names another message: a targeted call must leave it alone.
      selectedEmailKeys: new Set(['keep']),
      isUnifiedView: true,
      fetchTagCounts: vi.fn(),
    } as never);
  });

  it('archives the named messages into the account\'s Archive, by archiveMode', async () => {
    const ok = await useEmailStore.getState().batchArchive(other, { emailIds: ['m1'], client, emails: [email('m1')] });
    expect(ok).toBe(true);
    expect(client.batchArchiveEmails).toHaveBeenCalledWith(
      [{ id: 'm1', receivedAt: '2025-03-04T10:00:00Z' }], 'arch', 'year',
      expect.not.arrayContaining([expect.objectContaining({ isShared: true })]), undefined,
    );
    expect(other.batchArchiveEmails).not.toHaveBeenCalled();
    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['keep']);
    expect([...useEmailStore.getState().selectedEmailKeys]).toEqual(['keep']);
  });

  it('tags the named messages through the target\'s client and skips those already tagged', async () => {
    const ok = await useEmailStore.getState().batchSetTag(other, 'work', true, {
      emailIds: ['m1', 'm2'], client, emails: [email('m1'), email('m2', { '$label:work': true })],
    });
    expect(ok).toBe(true);
    expect(client.batchUpdateKeywords).toHaveBeenCalledWith(['m1'], { 'keywords/$label:work': true }, undefined);
    expect(other.batchUpdateKeywords).not.toHaveBeenCalled();
  });
});
