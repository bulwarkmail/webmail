import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// isLoading is the message list's: while it is set, the list fades under
// "Loading emails…". A send set it too, so every send reloaded the list on
// screen until the message was out (compose-24).

describe('the message list during a send', () => {
  let client: IJMAPClient;
  let finishSend: (value: unknown) => void;

  beforeEach(() => {
    client = {
      getAccountId: () => 'acc-1',
      pruneEmailSubmissions: vi.fn().mockResolvedValue(0),
      sendEmail: vi.fn(() => new Promise((resolve) => { finishSend = resolve; })),
      getAllMailboxesWithState: vi.fn().mockResolvedValue({ mailboxes: [], states: {} }),
    } as unknown as IJMAPClient;
    useAuthStore.setState({ client: null });
    useEmailStore.setState({ isLoading: false, pendingUndoSend: null });
  });

  it('is not put in its loading state while the message goes out', async () => {
    const sending = useEmailStore.getState().sendEmail(client, ['bob@example.net'], 'Subject', 'body');

    expect(useEmailStore.getState().isLoading).toBe(false);

    finishSend({ scheduled: false, emailId: 'sent-1' });
    await sending;
    expect(useEmailStore.getState().isLoading).toBe(false);
  });

  it('keeps loading a folder that a send finished in the middle of', async () => {
    useEmailStore.setState({ isLoading: true });
    const sending = useEmailStore.getState().sendEmail(client, ['bob@example.net'], 'Subject', 'body');
    finishSend({ scheduled: false, emailId: 'sent-1' });
    await sending;

    expect(useEmailStore.getState().isLoading).toBe(true);
  });
});
