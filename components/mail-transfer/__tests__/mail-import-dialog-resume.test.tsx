import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MailTransferHost } from '@/components/mail-transfer/mail-transfer-host';
import { openMailImport } from '@/stores/mail-transfer-store';
import { useEmailStore } from '@/stores/email-store';
import { useAuthStore } from '@/stores/auth-store';
import type { Mailbox } from '@/lib/jmap/types';

// The lookup of an earlier run never answers here.
vi.mock('@/lib/mail-import/checkpoints', () => ({
  checkpointKey: () => 'k',
  readCheckpoint: () => new Promise(() => {}),
  clearCheckpointsFor: async () => {},
}));

describe('MailImportDialog and an earlier run', () => {
  it('keeps Import off until it knows whether the file can be continued', async () => {
    useEmailStore.setState({ mailboxes: [{ id: 'inbox', name: 'Inbox', role: 'inbox', myRights: { mayAddItems: true } } as Mailbox] } as never);
    useAuthStore.setState({ client: { getAccountId: () => 'acc1' } as never, activeAccountId: 'b1' } as never);
    render(<MailTransferHost />);
    act(() => openMailImport());
    const input = screen.getByTestId('mail-import-file') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['From a Tue May  5 10:11:12 2020\n\nb\n'], 'a.mbox')], configurable: true });
    fireEvent.change(input);
    await screen.findByText('a.mbox');
    const start = screen.getByTestId('mail-import-start') as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(true));
    await new Promise((r) => setTimeout(r, 100));
    expect(start.disabled).toBe(true);
  });
});
