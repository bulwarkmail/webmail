import { render, act, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useSharedSentRecipients } from '../use-shared-sent-recipients';
import { useContactStore } from '@/stores/contact-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Mailbox } from '@/lib/jmap/types';

// The shared accounts' Sent folders are read at sign-in only with the
// setting on, and once, however often the folder list is refreshed.

function Harness({ client, mailboxes }: { client: IJMAPClient | null; mailboxes: Mailbox[] }) {
  useSharedSentRecipients(client, mailboxes, 'own-sent');
  return null;
}

const client = {} as IJMAPClient;
const mailboxes = (count = 0) => [
  { id: 'own-sent', name: 'Sent', role: 'sent', accountId: 'me', isShared: false, totalEmails: count },
  { id: 'A:inbox', originalId: 'inbox', name: 'Inbox', role: 'inbox', accountId: 'A', isShared: true },
  { id: 'A:sent', originalId: 'sent-a', name: 'Sent', role: 'sent', accountId: 'A', isShared: true, totalEmails: count },
] as Mailbox[];

let loadRecentRecipients: ReturnType<typeof vi.fn>;
let loadSharedRecentRecipients: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestIdleCallback', undefined);
  loadRecentRecipients = vi.fn().mockResolvedValue(undefined);
  loadSharedRecentRecipients = vi.fn().mockResolvedValue(undefined);
  useContactStore.setState({ loadRecentRecipients, loadSharedRecentRecipients } as never);
  useSettingsStore.setState({ sharedSentRecipientSuggestions: false });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const idle = () => act(async () => { await vi.advanceTimersByTimeAsync(1500); });

describe('useSharedSentRecipients', () => {
  it('reads nothing while the setting is off', async () => {
    render(<Harness client={client} mailboxes={mailboxes()} />);
    await idle();
    expect(loadSharedRecentRecipients).not.toHaveBeenCalled();
  });

  it("reads the shared Sent folders after the own one once it is on, and not again for new counts", async () => {
    const { rerender } = render(<Harness client={client} mailboxes={mailboxes()} />);
    await idle();
    act(() => { useSettingsStore.setState({ sharedSentRecipientSuggestions: true }); });
    await idle();

    expect(loadRecentRecipients).toHaveBeenCalledWith(client, 'own-sent');
    expect(loadSharedRecentRecipients).toHaveBeenCalledTimes(1);
    expect(loadSharedRecentRecipients).toHaveBeenCalledWith(client, [{ accountId: 'A', mailboxId: 'sent-a' }]);
    expect(loadRecentRecipients.mock.invocationCallOrder[0]).toBeLessThan(loadSharedRecentRecipients.mock.invocationCallOrder[0]);

    rerender(<Harness client={client} mailboxes={mailboxes(5)} />);
    await idle();
    expect(loadSharedRecentRecipients).toHaveBeenCalledTimes(1);
  });

  it('waits for the client', async () => {
    useSettingsStore.setState({ sharedSentRecipientSuggestions: true });
    render(<Harness client={null} mailboxes={mailboxes()} />);
    await idle();
    expect(loadSharedRecentRecipients).not.toHaveBeenCalled();
  });
});
