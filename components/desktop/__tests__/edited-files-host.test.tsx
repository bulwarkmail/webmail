import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const policy = vi.hoisted(() => ({ decided: true, allowed: true }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const openMailLink = vi.hoisted(() => vi.fn());
const handOffDraft = vi.hoisted(() => vi.fn());
const openDraftWindow = vi.hoisted(() => vi.fn());
const saveBlobAs = vi.hoisted(() => vi.fn(() => true));
const signOutGates = vi.hoisted(() => [] as ((account: string) => Promise<boolean>)[]);
const accounts = vi.hoisted(() => ({ list: [{ id: 'acct', cookieSlot: 2 }] as { id: string; cookieSlot: number }[], active: 'acct' as string | null }));

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/stores/toast-store', () => ({ toast }));
vi.mock('@/lib/device-policy', () => ({ canDownload: () => policy.allowed, canExport: () => true }));
vi.mock('@/lib/offline/offline-mode', () => ({ scopeDecided: () => policy.decided }));
vi.mock('@/lib/desktop/mail-links', () => ({ openMailLink }));
vi.mock('@/lib/launch-handoff', () => ({ handOffDraft }));
vi.mock('@/lib/popout/open', () => ({ openDraftWindow }));
vi.mock('@/lib/download-guard', () => ({ saveBlobAs }));
vi.mock('@/lib/org/account-subjects', () => ({ useAccountSubjects: { subscribe: () => () => {} } }));
vi.mock('@/stores/policy-store', () => ({ usePolicyStore: { subscribe: () => () => {} } }));
vi.mock('@/lib/sign-out-cleanup', () => ({
  addSignOutGate: (gate: (account: string) => Promise<boolean>) => {
    signOutGates.push(gate);
    return () => {};
  },
  onBeforeSignOut: () => () => {},
  onFullSignOut: () => {},
}));
vi.mock('@/stores/account-store', () => {
  const useAccountStore = (select: (s: { accounts: typeof accounts.list }) => unknown) => select({ accounts: accounts.list });
  useAccountStore.getState = () => ({ accounts: accounts.list });
  return { useAccountStore };
});
vi.mock('@/stores/auth-store', () => {
  const useAuthStore = (select: (s: { activeAccountId: string | null }) => unknown) => select({ activeAccountId: accounts.active });
  return { useAuthStore };
});

import { EditedFilesHost } from '../edited-files-host';
import { resetEditSessions, takeFilesForReply, useEditSessions } from '@/lib/desktop/edit-attachments';

const session = (over: Record<string, unknown> = {}) => ({
  id: 's1', name: 'a.docx', type: 'x/y', account: 'acct', source: '{"kind":"mail","emailId":"e1","ownerAccountId":"owner"}', changed: true, version: 1, claimed: false, ...over,
});

let bridge: { edit: Record<string, ReturnType<typeof vi.fn>>; dialogs: { confirm: ReturnType<typeof vi.fn> }; os: { notify: ReturnType<typeof vi.fn> } };

function show(...sessions: ReturnType<typeof session>[]) {
  bridge.edit.list.mockResolvedValue(sessions);
  useEditSessions.setState({ sessions });
  return render(<EditedFilesHost />);
}

beforeEach(() => {
  policy.decided = true;
  policy.allowed = true;
  accounts.list = [{ id: 'acct', cookieSlot: 2 }];
  accounts.active = 'acct';
  signOutGates.length = 0;
  vi.clearAllMocks();
  saveBlobAs.mockReturnValue(true);
  bridge = {
    edit: {
      canEdit: vi.fn(() => true),
      begin: vi.fn(),
      open: vi.fn(),
      reopen: vi.fn(),
      list: vi.fn(async () => []),
      read: vi.fn(async () => ({ ok: true, name: 'a.docx', type: 'x/y', data: new Uint8Array([1]), hash: 'h' })),
      taken: vi.fn(async () => {}),
      discard: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      setSource: vi.fn(),
      claim: vi.fn(),
      onChange: vi.fn(() => () => {}),
    },
    dialogs: { confirm: vi.fn(async () => 0) },
    os: { notify: vi.fn(async () => ({ shown: true, playSound: false })) },
  };
  (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1, ...bridge };
  resetEditSessions();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
});

describe('which offers show', () => {
  it('a saved file nobody holds', () => {
    show(session());
    expect(screen.getByTestId('edited-file')).toBeTruthy();
  });

  it('nothing for an unchanged file or one a composer holds', () => {
    show(session({ changed: false }), session({ id: 's2', claimed: true }));
    expect(screen.queryByTestId('edited-file')).toBeNull();
  });

  it('nothing for an account that is not signed in here', () => {
    show(session({ account: 'someone-else' }));
    expect(screen.queryByTestId('edited-file')).toBeNull();
    expect(bridge.os.notify).not.toHaveBeenCalled();
  });

  it('nothing in a browser', () => {
    delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
    useEditSessions.setState({ sessions: [session()] });
    render(<EditedFilesHost />);
    expect(screen.queryByTestId('edited-file')).toBeNull();
  });

  it('says it once per file on the OS, whatever the number of saves', async () => {
    const { rerender } = show(session());
    await waitFor(() => expect(bridge.os.notify).toHaveBeenCalledTimes(1));
    act(() => useEditSessions.setState({ sessions: [session({ version: 2 })] }));
    rerender(<EditedFilesHost />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bridge.os.notify).toHaveBeenCalledTimes(1);
  });
});

describe('a message\'s attachment', () => {
  it('attaches to a reply on that message, with that login', async () => {
    show(session());
    fireEvent.click(screen.getByText('reply'));
    await waitFor(() => expect(openMailLink).toHaveBeenCalled());
    const [link, options] = openMailLink.mock.calls[0];
    expect(link).toEqual({ kind: 'message', id: 'e1', slot: 2, ownerAccountId: 'owner', reply: true });
    expect(options).toEqual({ replyText: '' });
    const parked = takeFilesForReply('e1');
    expect(parked.map((f) => f.name)).toEqual(['a.docx']);
    // Only the composer's having it makes it taken.
    expect(bridge.edit.taken).not.toHaveBeenCalled();
  });

  it('saves a copy through the guard, and only a saved copy counts as taken', async () => {
    show(session());
    fireEvent.click(screen.getByText('save_copy'));
    await waitFor(() => expect(saveBlobAs).toHaveBeenCalled());
    expect(saveBlobAs.mock.calls[0]).toEqual([expect.any(File), 'a.docx', { kind: 'attachment', subject: 'acct' }]);
    expect(bridge.edit.taken).toHaveBeenCalledWith('s1', 'h');
  });

  it('a save the guard refuses stays an offer', async () => {
    saveBlobAs.mockReturnValue(false);
    show(session());
    fireEvent.click(screen.getByText('save_copy'));
    await waitFor(() => expect(saveBlobAs).toHaveBeenCalled());
    expect(bridge.edit.taken).not.toHaveBeenCalled();
  });
});

describe('other sources', () => {
  it('a closed draft opens in its window, where its chip offers the update', () => {
    show(session({ source: '{"kind":"draft","draftId":"d1","ownerAccountId":"owner"}' }));
    expect(screen.queryByText('reply')).toBeNull();
    fireEvent.click(screen.getByText('open_draft'));
    expect(openDraftWindow).toHaveBeenCalledWith({ draftId: 'd1', localAccountId: 'acct', ownerAccountId: 'owner' });
  });

  it('a file whose message went can start a new one', async () => {
    show(session({ source: '{"kind":"file"}' }));
    expect(screen.queryByText('reply')).toBeNull();
    expect(screen.queryByText('open_draft')).toBeNull();
    fireEvent.click(screen.getByText('new_message'));
    await waitFor(() => expect(handOffDraft).toHaveBeenCalled());
    expect(handOffDraft.mock.calls[0][0].files[0].name).toBe('a.docx');
  });
});

describe('discarding', () => {
  it('asks first, with keeping as the default', async () => {
    bridge.dialogs.confirm.mockResolvedValueOnce(1);
    show(session());
    fireEvent.click(screen.getByRole('button', { name: 'discard a.docx' }));
    await waitFor(() => expect(bridge.dialogs.confirm).toHaveBeenCalled());
    expect(bridge.dialogs.confirm.mock.calls[0][0]).toMatchObject({ defaultId: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bridge.edit.discard).not.toHaveBeenCalled();

    bridge.dialogs.confirm.mockResolvedValueOnce(0);
    fireEvent.click(screen.getByRole('button', { name: 'discard a.docx' }));
    await waitFor(() => expect(bridge.edit.discard).toHaveBeenCalledWith('s1'));
  });
});

describe('the organisation', () => {
  it('saying no ends a session and its copy, and says so', async () => {
    policy.allowed = false;
    show(session());
    await waitFor(() => expect(bridge.edit.discard).toHaveBeenCalledWith('s1'));
    expect(toast.error).toHaveBeenCalledWith('removed_policy');
  });

  it('not having said yet deletes nothing, and reads nothing either', async () => {
    policy.decided = false;
    show(session());
    fireEvent.click(screen.getByText('save_copy'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('blocked_policy'));
    expect(bridge.edit.discard).not.toHaveBeenCalled();
    expect(bridge.edit.read).not.toHaveBeenCalled();
  });
});

describe('signing out', () => {
  it('asks only with edits nobody took, in the account going', async () => {
    show(session({ account: 'acct' }), session({ id: 's2', account: 'other', changed: false }));
    expect(signOutGates).toHaveLength(1);
    bridge.dialogs.confirm.mockResolvedValueOnce(1);
    await expect(signOutGates[0]('acct')).resolves.toBe(false);
    bridge.dialogs.confirm.mockResolvedValueOnce(0);
    await expect(signOutGates[0]('acct')).resolves.toBe(true);
    bridge.dialogs.confirm.mockClear();
    await expect(signOutGates[0]('other')).resolves.toBe(true);
    expect(bridge.dialogs.confirm).not.toHaveBeenCalled();
  });
});
