import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { ScheduledEmail } from '@/lib/jmap/types';

// compose-p3-9: a send in its Undo time counted in Scheduled. In the browser
// the count went up as the toast said "Sent" and down again a few seconds
// later; in the desktop app a pop-out's send stayed in the count for minutes,
// until Scheduled was opened.

const T0 = Date.parse('2026-11-04T10:00:00Z');

const scheduled = (submissionId: string, sendAt: number): ScheduledEmail => ({
  id: `email-${submissionId}`, emailSubmissionId: submissionId, scheduledSendAt: new Date(sendAt).toISOString(),
  scheduledIdentityId: 'identity-1', scheduledUndoStatus: 'pending', isScheduled: true, isSmimeScheduled: false,
  threadId: 't', mailboxIds: {}, keywords: {}, receivedAt: new Date(T0).toISOString(), size: 1, hasAttachment: false,
} as unknown as ScheduledEmail);

describe('sends in their Undo time and the Scheduled count', () => {
  let onServer: ScheduledEmail[];
  let client: IJMAPClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    onServer = [scheduled('tomorrow', T0 + 86_400_000)];
    client = {
      getAccountId: () => 'acc',
      pruneEmailSubmissions: vi.fn(async () => 0),
      getScheduledEmails: vi.fn(async () => ({ emails: [...onServer], hasMore: false, total: onServer.length, totalByAccount: { acc: onServer.length }, nextPosition: onServer.length })),
    } as unknown as IJMAPClient;
    useEmailStore.setState({ undoHolds: new Map(), lastScheduledSubmissionIds: new Set(), scheduledTotal: 0, scheduledTotalByAccount: {}, pendingUndoSend: null });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const count = () => useEmailStore.getState().scheduledTotal;

  it('leaves it out while it waits, and counts what is left once the server let it go', async () => {
    onServer.push(scheduled('undo-1', T0 + 6_000));
    useEmailStore.getState().noteUndoHold(client, 'undo-1', new Date(T0 + 6_000).toISOString());
    await vi.advanceTimersByTimeAsync(0);
    expect(count()).toBe(1);
    expect(useEmailStore.getState().scheduledTotalByAccount).toEqual({ acc: 1 });

    // Another refresh in the Undo time (a push) doesn't count it either.
    await useEmailStore.getState().refreshScheduledMetadata(client);
    expect(count()).toBe(1);

    // Released, but the server still lists it for a while: asked again later.
    await vi.advanceTimersByTimeAsync(6_000 + 3_000);
    expect(count()).toBe(1);
    onServer = onServer.filter((e) => e.emailSubmissionId !== 'undo-1');
    const calls = vi.mocked(client.getScheduledEmails).mock.calls.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(vi.mocked(client.getScheduledEmails).mock.calls.length).toBeGreaterThan(calls);
    expect(count()).toBe(1);
    expect(useEmailStore.getState().undoHolds.size).toBe(0);
  });

  it('counts a send that was really scheduled', async () => {
    await useEmailStore.getState().refreshScheduledMetadata(client);
    expect(count()).toBe(1);
  });
});
