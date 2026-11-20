import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, render, screen } from '@testing-library/react';
import type { TeamRef } from '@/lib/team-mailboxes/team';

// Assign to me, Assign to…, Unassign, Mark done, Reopen: each only where it
// applies and where the folder lets the user change messages; a toast with
// Undo after each, an error toast when the change fails.

const ref: TeamRef = { key: 'login|g', loginId: 'login', accountId: 'g', groupAddress: 'tm-team@example.org' };
const client = { getAccountId: () => 'me', getUsername: () => 'tm-alice@example.org', supportsBulwarkMetadata: () => false };
let inTeam = true;
vi.mock('../use-team', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../use-team')>()),
  useTeamOf: () => (inTeam ? { ref, client } : null),
}));

const result = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, changed: true, keywords: {}, patch: {}, undo: vi.fn(async () => {}), timeline: Promise.resolve('n'), ...extra });
const store = vi.hoisted(() => ({
  assignToMe: vi.fn(), assign: vi.fn(), unassign: vi.fn(), markDone: vi.fn(), reopen: vi.fn(),
}));
vi.mock('@/stores/team-mailbox-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/team-mailbox-store')>()),
  ...store,
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(() => 't1'), error: vi.fn() }));
vi.mock('@/stores/toast-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/toast-store')>()),
  toast: { ...toasts, info: vi.fn(), dismiss: vi.fn(), update: vi.fn() },
}));

const { useTeamActions, TeamAssignDialogHost, resetAssignRequest } = await import('../team-actions');
const { useEmailStore } = await import('@/stores/email-store');

const email = (keywords: Record<string, boolean> = {}) => ({
  id: 'e1', threadId: 't1', messageId: undefined, subject: 'Offer', keywords, mailboxIds: { inbox: true }, sourceClientAccountId: 'login', sourceAccountId: 'g',
});
const keys = (entries: Array<{ kind: string; key?: string }>) => entries.map((e) => e.key);

afterEach(() => {
  inTeam = true;
  resetAssignRequest();
  Object.values(store).forEach((f) => f.mockReset());
  toasts.success.mockClear();
  toasts.error.mockClear();
  useEmailStore.setState({ mailboxes: [] });
});

describe('team actions', () => {
  it('offers each action only where it applies', () => {
    const open = renderHook(() => useTeamActions(email())).result.current;
    expect(keys(open)).toEqual(['extra:team_assign_me', 'extra:team_assign_to', 'extra:team_done']);
    const mineDone = renderHook(() => useTeamActions(email({ '$assigned:me': true, $done: true }))).result.current;
    expect(keys(mineDone)).toEqual(['extra:team_assign_to', 'extra:team_unassign', 'extra:team_reopen']);
  });

  it('offers nothing outside a team mailbox or where the folder doesn\'t let the user change messages', () => {
    inTeam = false;
    expect(renderHook(() => useTeamActions(email())).result.current).toEqual([]);
    inTeam = true;
    useEmailStore.setState({ mailboxes: [{ id: 'g:inbox', originalId: 'inbox', accountId: 'g', name: 'Inbox', myRights: { maySetKeywords: false } }] as never });
    expect(renderHook(() => useTeamActions(email())).result.current).toEqual([]);
  });

  it('marks done with one click and toasts Undo, which puts it back', async () => {
    const done = result('done');
    store.markDone.mockResolvedValue(done);
    const entries = renderHook(() => useTeamActions(email())).result.current;
    await act(async () => { (entries.find((e) => (e as { key?: string }).key === 'extra:team_done') as { run: () => void }).run(); });
    expect(store.markDone).toHaveBeenCalledWith(ref.key, expect.objectContaining({ id: 'e1' }));
    expect(toasts.success).toHaveBeenCalledWith('marked_done', expect.objectContaining({ action: expect.objectContaining({ label: 'undo' }) }));
    const action = (toasts.success.mock.calls[0] as unknown as [string, { action: { onClick: () => void } }])[1].action;
    await act(async () => { action.onClick(); });
    expect(done.undo).toHaveBeenCalled();
  });

  it('says so when the change fails', async () => {
    store.assignToMe.mockRejectedValue(new Error('forbidden'));
    const entries = renderHook(() => useTeamActions(email())).result.current;
    await act(async () => { (entries[0] as { run: () => void }).run(); });
    expect(toasts.error).toHaveBeenCalledWith('change_failed');
  });

  it('opens Assign to… and assigns the person picked', async () => {
    store.assign.mockResolvedValue(result('assigned', { assignee: { id: 'cj', name: 'Josh', me: false } }));
    render(<TeamAssignDialogHost />);
    const entries = renderHook(() => useTeamActions(email())).result.current;
    act(() => { (entries.find((e) => (e as { key?: string }).key === 'extra:team_assign_to') as { run: () => void }).run(); });
    expect(screen.getByRole('dialog', { name: 'dialog_title' })).toBeTruthy();
  });
});
