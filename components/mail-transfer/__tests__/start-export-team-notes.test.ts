import { describe, expect, it, vi } from 'vitest';

// A whole-account export carries the team notes folder: it is part of the
// mailbox, even though Bulwark never lists it.

const runExport = vi.fn(async () => ({ phase: 'done', exported: 0, failed: 0, failures: [], total: 0, fraction: 1 }));
vi.mock('@/lib/mail-export/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mail-export/engine')>()),
  runExport: (...args: unknown[]) => runExport(...(args as [])),
}));
vi.mock('@/lib/download-guard', () => ({ downloadAllowed: () => true }));

describe('startExport', () => {
  it('asks for the folder list with the team notes included', async () => {
    const all = [
      { id: 'in', name: 'Inbox', role: 'inbox' },
      { id: 'notes', name: 'Team notes' },
    ];
    const getMailboxes = vi.fn(async (_id?: string, options?: { includeHidden?: boolean }) =>
      (options?.includeHidden ? all : all.filter((m) => m.name !== 'Team notes')));
    const { useAuthStore } = await import('@/stores/auth-store');
    useAuthStore.setState({ client: { getMailboxes } as never, activeAccountId: 'login' } as never);
    const { startExport } = await import('../start-export');

    startExport({ format: 'mbox', accountId: 'team', sink: { abort: vi.fn(async () => {}) } as never });

    await vi.waitFor(() => expect(runExport).toHaveBeenCalled());
    const folders = (runExport.mock.calls[0] as unknown as [{ folders: Array<{ mailboxId: string }> }])[0].folders;
    expect(folders.map((f) => f.mailboxId).sort()).toEqual(['in', 'notes']);
  });
});
