import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const policy = vi.hoisted(() => ({ decided: true, allowed: true }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const openMailLink = vi.hoisted(() => vi.fn());
const handOffDraft = vi.hoisted(() => vi.fn());
const openDraftWindow = vi.hoisted(() => vi.fn());
const saveBlobAs = vi.hoisted(() => vi.fn(() => true));
const signOutGates = vi.hoisted(() => [] as ((account: string) => Promise<boolean>)[]);
const accounts = vi.hoisted(() => ({ list: [{ id: 'acct', cookieSlot: 2 }] as { id: string; cookieSlot: number; label?: string }[], active: 'acct' as string | null }));
const contentHidden = vi.hoisted(() => ({ value: false }));
const switchAccount = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/stores/toast-store', () => ({ toast }));
vi.mock('@/lib/device-policy', () => ({ canDownload: () => policy.allowed, canExport: () => true }));
vi.mock('@/lib/offline/availability', () => ({ scopeDecided: () => policy.decided }));
vi.mock('@/lib/desktop/mail-links', () => ({ openMailLink }));
vi.mock('@/lib/desktop/mail-notifications', () => ({ contentHiddenFor: () => contentHidden.value }));
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
  useAuthStore.getState = () => ({ activeAccountId: accounts.active, switchAccount });
  return { useAuthStore };
});

import { EditedFilesHost } from '../edited-files-host';
import { resetEditSessions, takeFilesForReply, useEditSessions } from '@/lib/desktop/edit-attachments';

const session = (over: Record<string, unknown> = {}) => ({
  id: 's1', name: 'a.docx', type: 'x/y', account: 'acct', source: '{"kind":"mail","emailId":"e1","ownerAccountId":"owner"}', changed: true, version: 1, hash: 'h', claimed: false, held: false, savedAs: false, lastChance: false, ...over,
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
  contentHidden.value = false;
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
      settle: vi.fn(async () => []),
      read: vi.fn(async () => ({ ok: true, name: 'a.docx', type: 'x/y', data: new Uint8Array([1]), hash: 'h' })),
      taken: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
      discard: vi.fn(async () => ({ held: [] })),
      forceDiscard: vi.fn(async () => ({ held: [] })),
      askClear: vi.fn(async () => true),
      clear: vi.fn(async () => ({ held: [] })),
      wipe: vi.fn(async () => ({ held: [] })),
      shown: vi.fn(),
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
  // pim-p3-6: the app's own question (the Bulwark window in the desktop app), not the OS's message box.
  it('asks with the app\'s own question, then main deletes without asking again', async () => {
    show(session());
    fireEvent.click(screen.getByRole('button', { name: 'discard a.docx' }));
    expect(await screen.findByText('discard_title')).toBeTruthy();
    expect(screen.getByText('discard_detail outside_note')).toBeTruthy();
    expect(bridge.edit.forceDiscard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'discard_confirm' }));
    await waitFor(() => expect(bridge.edit.forceDiscard).toHaveBeenCalledWith('s1'));
    expect(bridge.edit.discard).not.toHaveBeenCalled();
    expect(bridge.dialogs.confirm).not.toHaveBeenCalled();
  });

  it('keeps the file when the question is cancelled', async () => {
    show(session());
    fireEvent.click(screen.getByRole('button', { name: 'discard a.docx' }));
    fireEvent.click(await screen.findByRole('button', { name: 'cancel' }));
    await waitFor(() => expect(screen.queryByText('discard_title')).toBeNull());
    expect(bridge.edit.forceDiscard).not.toHaveBeenCalled();
    expect(bridge.edit.discard).not.toHaveBeenCalled();
  });

  it('the X only hides the card until the next save', () => {
    const view = show(session());
    fireEvent.click(screen.getByRole('button', { name: 'hide a.docx' }));
    expect(screen.queryByTestId('edited-file')).toBeNull();
    expect(bridge.edit.discard).not.toHaveBeenCalled();
    act(() => useEditSessions.setState({ sessions: [session({ version: 2 })] }));
    view.rerender(<EditedFilesHost />);
    expect(screen.getByTestId('edited-file')).toBeTruthy();
  });
});

describe('the organisation', () => {
  it('saying no ends a session with no question, says so on the OS, and stays until read', async () => {
    policy.allowed = false;
    show(session());
    await waitFor(() => expect(bridge.edit.forceDiscard).toHaveBeenCalledWith('s1'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('removed_policy', { duration: 0 }));
    expect(bridge.edit.discard).not.toHaveBeenCalled();
    await waitFor(() => expect(bridge.os.notify).toHaveBeenCalledWith(expect.objectContaining({ id: 'edit-policy-s1', title: 'removed_policy', body: 'outside_note' })));
  });

  it('says when a program still has the file', async () => {
    policy.allowed = false;
    bridge.edit.forceDiscard.mockResolvedValue({ held: ['a.docx'] });
    show(session());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('removed_policy_held', { duration: 0 }));
  });

  it('names no file on the OS where that account hides content', async () => {
    policy.allowed = false;
    contentHidden.value = true;
    show(session());
    await waitFor(() => expect(bridge.os.notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'removed_policy_hidden' })));
  });

  it('does not end a session twice while a program holds it', async () => {
    policy.allowed = false;
    show(session({ held: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bridge.edit.forceDiscard).not.toHaveBeenCalled();
  });

  it('not having said yet deletes nothing, and reads nothing either', async () => {
    policy.decided = false;
    show(session());
    fireEvent.click(screen.getByText('save_copy'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('blocked_policy'));
    expect(bridge.edit.forceDiscard).not.toHaveBeenCalled();
    expect(bridge.edit.read).not.toHaveBeenCalled();
  });
});

describe('signing out', () => {
  it('leaves the question to main, whose yes covers the deleting', async () => {
    show(session());
    expect(signOutGates).toHaveLength(1);
    bridge.edit.askClear.mockResolvedValueOnce(false);
    await expect(signOutGates[0]('acct')).resolves.toBe(false);
    expect(bridge.edit.askClear).toHaveBeenCalledWith('acct');
  });
});

describe('what a program still holds', () => {
  it('names the file, for an account signed in here, and what the app can\'t reach', () => {
    show(session({ held: true, changed: false }));
    expect(screen.getByTestId('edited-file-held').textContent).toContain('held_named');
    expect(screen.getByTestId('edited-file-held').textContent).toContain('outside_note');
    expect(screen.queryByTestId('edited-file')).toBeNull();
  });

  it('names nothing for anyone else, and still says it', () => {
    show(session({ held: true, changed: false, account: 'someone-else' }));
    const notice = screen.getByTestId('edited-file-held').textContent ?? '';
    expect(notice).toContain('held_unnamed');
    expect(notice).not.toContain('held_named');
  });

  it('a held file with edits nobody wanted is not offered', () => {
    show(session({ held: true, changed: true }));
    expect(screen.queryByTestId('edited-file')).toBeNull();
  });
});

describe('the name on the OS', () => {
  it('stays off where that account hides content', async () => {
    contentHidden.value = true;
    show(session());
    await waitFor(() => expect(bridge.os.notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'changed_title_hidden' })));
  });

  it('shows where it does not', async () => {
    show(session());
    await waitFor(() => expect(bridge.os.notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'changed_title' })));
  });
});

describe('more than one account', () => {
  it('says which one a file belongs to', () => {
    accounts.list = [{ id: 'acct', cookieSlot: 2, label: 'work@example.org' }, { id: 'home', cookieSlot: 3, label: 'home@example.org' }];
    show(session());
    expect(screen.getByTestId('edited-file-account').textContent).toBe('work@example.org');
  });

  it('with one, there is nothing to say', () => {
    show(session());
    expect(screen.queryByTestId('edited-file-account')).toBeNull();
  });

  it('a new message starts from the file\'s own account', async () => {
    accounts.list = [{ id: 'acct', cookieSlot: 2 }, { id: 'home', cookieSlot: 3 }];
    accounts.active = 'home';
    const order: string[] = [];
    switchAccount.mockImplementationOnce(async () => { order.push('switch'); });
    handOffDraft.mockImplementationOnce(() => { order.push('handoff'); });
    show(session({ source: '{"kind":"file"}' }));
    fireEvent.click(screen.getByText('new_message'));
    await waitFor(() => expect(handOffDraft).toHaveBeenCalled());
    expect(switchAccount).toHaveBeenCalledWith('acct');
    expect(order).toEqual(['switch', 'handoff']);
  });

  it('already on it, nothing switches', async () => {
    show(session({ source: '{"kind":"file"}' }));
    fireEvent.click(screen.getByText('new_message'));
    await waitFor(() => expect(handOffDraft).toHaveBeenCalled());
    expect(switchAccount).not.toHaveBeenCalled();
  });
});

describe('the last offer', () => {
  it('says so, and tells main it was seen', async () => {
    show(session({ lastChance: true }));
    expect(screen.getByTestId('edited-file-last-chance')).toBeTruthy();
    await waitFor(() => expect(bridge.edit.shown).toHaveBeenCalledWith('s1'));
  });

  it('an ordinary offer says nothing of it', async () => {
    show(session());
    expect(screen.queryByTestId('edited-file-last-chance')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bridge.edit.shown).not.toHaveBeenCalled();
  });
});

describe('a file saved under a new name from a draft', () => {
  it('has no draft to open: its own message is what it can go on', () => {
    show(session({ source: '{"kind":"draft","draftId":"d1"}', savedAs: true }));
    expect(screen.queryByText('open_draft')).toBeNull();
    expect(screen.getByText('new_message')).toBeTruthy();
  });
});
