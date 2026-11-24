import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelegatesSettings } from '../delegates-settings';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import type { ShareChange, ShareChangeResult, ShareTarget } from '@/lib/jmap/share-batch';
import { CALENDAR_PRESETS, FILE_PRESETS, MAILBOX_PRESETS } from '@/lib/jmap/share-rights';
import type { Principal, PrincipalListing } from '@/lib/jmap/types';

const ALICE: Principal = { id: 'ci', type: 'individual', name: 'org-alice@example.org', email: 'org-alice@example.org' };
const TEAM: Principal = { id: 'ch', type: 'group', name: 'org-team@example.org', email: 'org-team@example.org' };
const CAROL: Principal = { id: 'ck', type: 'individual', name: 'org-carol@example.org', email: 'org-carol@example.org' };

// Stalwart 1.0 with directory queries off: only the principals alice knows.
const DIRECTORY_OFF: PrincipalListing = { principals: [ALICE, TEAM, CAROL], status: 'restricted', directoryQueriesOff: true };

function targets(withCarol = false): ShareTarget[] {
  const carol = (rights: object) => (withCarol ? { ck: rights } : {});
  return [
    { kind: 'mailbox', accountId: 'ci', id: 'a', name: 'Inbox', role: 'inbox', shareWith: carol({ ...MAILBOX_PRESETS.read, maySetKeywords: true }) as never },
    { kind: 'mailbox', accountId: 'ci', id: 'b', name: 'Sent Items', role: 'sent', shareWith: {} },
    { kind: 'calendar', accountId: 'ci', id: 'c', name: 'Calendar', isDefault: true, shareWith: carol(CALENDAR_PRESETS.read) as never },
    { kind: 'addressBook', accountId: 'ci', id: 'd', name: 'Contacts', isDefault: true, shareWith: {} },
    ...(withCarol ? [{ kind: 'file' as const, accountId: 'ci', id: 'n', name: 'plan.pdf', shareWith: { ck: FILE_PRESETS.read } }] : []),
  ];
}

const ok = (changes: ShareChange[]): ShareChangeResult[] => changes.map((change) => ({ change, ok: true }));

function makeClient(options: {
  withCarol?: boolean;
  directory?: PrincipalListing;
  apply?: (c: ShareChange[]) => ShareChangeResult[];
  sharedAccounts?: Array<{ id: string; name: string }>;
  targets?: ShareTarget[];
  failed?: string[];
  seenSetsKeywords?: boolean;
} = {}) {
  return {
    getAccountId: () => 'ci',
    getUsername: () => 'org-alice@example.org',
    getSharedAccounts: () => options.sharedAccounts ?? [],
    supportsPrincipals: () => true,
    sharesSeenWithKeywords: () => options.seenSetsKeywords ?? false,
    getPrincipals: vi.fn(async () => (options.directory ?? DIRECTORY_OFF).principals),
    listPrincipals: vi.fn(async () => options.directory ?? DIRECTORY_OFF),
    getShareTargets: vi.fn(async (_include?: object) => ({ targets: options.targets ?? targets(options.withCarol), failed: (options.failed ?? []) as never[] })),
    applyShareChanges: vi.fn(async (changes: ShareChange[]) => (options.apply ?? ok)(changes)),
    findPrincipalByEmail: vi.fn(async () => ({ principal: null, status: 'forbidden' as const, directoryQueriesOff: true })),
  };
}

const initialPolicy = usePolicyStore.getState();
const initialAuth = useAuthStore.getState();

function restrict(restrictions: Record<string, object>) {
  usePolicyStore.setState((state) => ({ policy: { ...state.policy, restrictions: { ...state.policy.restrictions, ...restrictions } } }));
}

function renderWith(client: ReturnType<typeof makeClient>) {
  useAuthStore.setState({ client: client as never, activeAccountId: 'acc-alice' });
  return render(<DelegatesSettings />);
}

beforeEach(() => {
  try { localStorage.clear(); } catch { /* ignore */ }
});

afterEach(() => {
  cleanup();
  usePolicyStore.setState(initialPolicy, true);
  useAuthStore.setState(initialAuth, true);
});

describe('DelegatesSettings', () => {
  it('shows nothing and reads nothing when the admin hides delegation', async () => {
    restrict({ delegation: { hidden: true } });
    const client = makeClient();
    const { container } = renderWith(client);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(client.getShareTargets).not.toHaveBeenCalled();
  });

  it('appears once a late policy stops hiding it', async () => {
    restrict({ delegation: { hidden: true } });
    const client = makeClient();
    renderWith(client);
    await act(async () => {});
    act(() => usePolicyStore.setState((state) => ({ policy: { ...state.policy, restrictions: {} } })));
    expect(await screen.findByText('give_access')).toBeInTheDocument();
    expect(client.getShareTargets).toHaveBeenCalled();
  });

  it('lists everyone with access, grouped by person, with what they have', async () => {
    renderWith(makeClient({ withCarol: true }));
    const row = await screen.findByTestId('delegate-row');
    expect(within(row).getByText('org-carol@example.org')).toBeInTheDocument();
    expect(within(row).getByText('summary.mail_inbox · summary.calendars · summary.files · level.read')).toBeInTheDocument();
    expect(screen.getAllByTestId('delegate-row')).toHaveLength(1);
  });

  it('names someone the directory does not list from the accounts they share with the user', async () => {
    renderWith(makeClient({
      withCarol: true,
      directory: { principals: [ALICE], status: 'restricted', directoryQueriesOff: true },
      sharedAccounts: [{ id: 'ck', name: 'org-carol@example.org' }],
    }));
    const row = await screen.findByTestId('delegate-row');
    expect(within(row).getByText('org-carol@example.org')).toBeInTheDocument();
    expect(within(row).queryByText('unknown_person')).toBeNull();
  });

  it('marks a group named only by the session as a group', async () => {
    const list = targets();
    list[0].shareWith.ch = MAILBOX_PRESETS.read;
    renderWith(makeClient({
      targets: list,
      directory: { principals: [], status: 'error' },
      sharedAccounts: [{ id: 'ch', name: 'org-team@example.org' }],
    }));
    // The auth store sets the policy subject once the session is in; it knows the user's groups.
    act(() => usePolicyStore.setState({ subject: { email: ALICE.email!, groups: ['org-team@example.org'] } }));
    const row = await screen.findByTestId('delegate-row');
    expect(within(row).getByText('org-team@example.org')).toBeInTheDocument();
    expect(await within(row).findByText('group')).toBeInTheDocument();
  });

  it('asks only for the types the admin left on', async () => {
    usePolicyStore.setState((state) => ({ policy: { ...state.policy, features: { ...state.policy.features, calendarEnabled: false, filesEnabled: false } } }));
    const client = makeClient();
    renderWith(client);
    await screen.findByText('nobody');
    expect(client.getShareTargets).toHaveBeenLastCalledWith({ calendars: false, contacts: true, files: false });
  });

  it('holds Change and Remove while a type is unread, and reads again on Try again', async () => {
    const client = makeClient({ withCarol: true, failed: ['calendar'] });
    renderWith(client);
    const row = await screen.findByTestId('delegate-row');
    expect(within(row).getByRole('button', { name: 'change' })).toBeDisabled();
    expect(within(row).getByRole('button', { name: 'remove' })).toBeDisabled();
    const notice = screen.getByTestId('delegates-read-failed');
    expect(notice).toHaveTextContent('read_failed');
    client.getShareTargets.mockResolvedValue({ targets: targets(true), failed: [] });
    fireEvent.click(within(notice).getByRole('button', { name: 'retry' }));
    await waitFor(() => expect(within(screen.getByTestId('delegate-row')).getByRole('button', { name: 'remove' })).toBeEnabled());
    expect(client.getShareTargets).toHaveBeenCalledTimes(2);
  });

  it('shows the answer of the current account, not a slow one of the account before', async () => {
    let releaseFirst: (v: { targets: ShareTarget[]; failed: never[] }) => void = () => {};
    const first = makeClient({ withCarol: true });
    first.getShareTargets.mockImplementation(() => new Promise((resolve) => { releaseFirst = resolve; }));
    renderWith(first);
    await act(async () => {});
    const second = makeClient();
    act(() => useAuthStore.setState({ client: second as never, activeAccountId: 'acc-other' }));
    expect(await screen.findByText('nobody')).toBeInTheDocument();
    await act(async () => { releaseFirst({ targets: targets(true), failed: [] }); });
    expect(screen.queryByTestId('delegate-row')).toBeNull();
    expect(screen.getByText('nobody')).toBeInTheDocument();
  });

  it('remembers the names of people with access, never the rest of the directory', async () => {
    renderWith(makeClient({ withCarol: true }));
    await screen.findByTestId('delegate-row');
    await waitFor(() => expect(localStorage.getItem('bulwark-delegate-names')).toContain('ck'));
    const stored = JSON.parse(localStorage.getItem('bulwark-delegate-names')!);
    expect(Object.keys(stored['acc-alice'])).toEqual(['ck']);
  });

  it('removes a person from every item, files included', async () => {
    const client = makeClient({ withCarol: true });
    renderWith(client);
    const row = await screen.findByTestId('delegate-row');
    fireEvent.click(within(row).getByRole('button', { name: 'remove' }));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'remove' }));
    await waitFor(() => expect(client.applyShareChanges).toHaveBeenCalledTimes(1));
    const changes = client.applyShareChanges.mock.calls[0][0];
    expect(changes.map((c) => [c.kind, c.id, c.principalId, c.rights])).toEqual([
      ['mailbox', 'a', 'ck', null],
      ['calendar', 'c', 'ck', null],
      ['file', 'n', 'ck', null],
    ]);
    // The overview is read again afterwards.
    await waitFor(() => expect(client.getShareTargets).toHaveBeenCalledTimes(2));
  });

  // #1171: every shared item in one list, with who has it.
  it('lists each shared item with who has it, sub-folders by their path', async () => {
    const list = targets(true);
    list.push({ kind: 'mailbox', accountId: 'ci', id: 'p', name: 'Projects', parentId: 'a', shareWith: { ch: MAILBOX_PRESETS.readWrite, ck: MAILBOX_PRESETS.read } });
    renderWith(makeClient({ targets: list }));
    const rows = await screen.findAllByTestId('shared-item-row');
    const read = (row: HTMLElement) => [
      row.querySelector('span[title]')!.textContent,
      within(row).getAllByTestId('shared-item-grant').map((g) => g.textContent),
    ];
    expect(rows.map(read)).toEqual([
      // The Inbox reads as in the sidebar (the key here, with keys for text).
      ['mailboxes.inbox', ['org-carol@example.org· level.read']],
      ['mailboxes.inbox / Projects', ['org-team@example.org· level.write', 'org-carol@example.org· level.read']],
      ['Calendar', ['org-carol@example.org· level.read']],
      ['plan.pdf', ['org-carol@example.org· level.read']],
    ]);
  });

  it('stops sharing one item with one person and keeps the rest', async () => {
    const client = makeClient({ withCarol: true });
    renderWith(client);
    const [inbox] = await screen.findAllByTestId('shared-item-row');
    fireEvent.click(within(inbox).getByRole('button', { name: 'stop_sharing' }));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'stop_sharing_confirm' }));
    await waitFor(() => expect(client.applyShareChanges).toHaveBeenCalledTimes(1));
    expect(client.applyShareChanges.mock.calls[0][0].map((c) => [c.kind, c.id, c.principalId, c.rights])).toEqual([
      ['mailbox', 'a', 'ck', null],
    ]);
    await waitFor(() => expect(client.getShareTargets).toHaveBeenCalledTimes(2));
  });

  it('lists nothing when nothing is shared', async () => {
    renderWith(makeClient());
    await screen.findByText('nobody');
    expect(screen.queryByTestId('shared-items-list')).toBeNull();
  });
});

function candidate(dialog: HTMLElement, text: string): HTMLElement {
  return within(within(dialog).getByTestId('delegate-candidates')).getAllByRole('button').find((b) => b.textContent?.includes(text))!;
}

describe('DelegateDialog', () => {
  async function openDialog(client: ReturnType<typeof makeClient>) {
    renderWith(client);
    fireEvent.click(await screen.findByText('give_access'));
    return screen.findByRole('dialog');
  }

  it('starts in the search field', async () => {
    const dialog = await openDialog(makeClient());
    await waitFor(() => expect(within(dialog).getByRole('textbox')).toHaveFocus());
  });

  it("says \"That's you\" for the user's own address", async () => {
    const client = makeClient({ directory: { principals: [ALICE], status: 'ok' } });
    const dialog = await openDialog(client);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'ORG-alice@example.org' } });
    fireEvent.click(within(dialog).getByText('use_address'));
    expect(await within(dialog).findByText('is_you')).toBeInTheDocument();
    expect(client.findPrincipalByEmail).not.toHaveBeenCalled();
  });

  it('remembers the person just picked', async () => {
    const client = makeClient({ directory: { principals: [ALICE, CAROL, TEAM], status: 'ok' } });
    const dialog = await openDialog(client);
    fireEvent.click(candidate(dialog, 'org-carol'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'apply_add' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const stored = JSON.parse(localStorage.getItem('bulwark-delegate-names')!);
    expect(Object.keys(stored['acc-alice'])).toEqual(['ck']);
  });

  it('says read delegates can flag mail where the server ties the two rights', async () => {
    const dialog = await openDialog(makeClient({ seenSetsKeywords: true }));
    expect(within(dialog).getByText('rights_read_hint_flags')).toBeInTheDocument();
    expect(within(dialog).queryByText('rights_read_hint')).toBeNull();
  });

  it('starts Change of manager rights at "Keep as it is" and has nothing to save', async () => {
    const list = targets();
    for (const t of list) if (t.kind === 'mailbox') t.shareWith.ck = MAILBOX_PRESETS.manager;
    const client = makeClient({ targets: list });
    renderWith(client);
    const row = await screen.findByTestId('delegate-row');
    fireEvent.click(within(row).getByRole('button', { name: 'change' }));
    const dialog = await screen.findByRole('dialog');
    const checked = within(dialog).getAllByRole('radio').filter((r) => (r as HTMLInputElement).checked).map((r) => (r as HTMLInputElement).value);
    expect(checked).toEqual(['keep', 'none', 'none', 'keep']);
    expect(within(dialog).getByRole('button', { name: 'apply_change' })).toBeDisabled();
    expect(within(dialog).getByText('nothing_to_change')).toBeInTheDocument();
  });

  it('says why only known people are listed when directory queries are off', async () => {
    const dialog = await openDialog(makeClient());
    expect(within(dialog).getByTestId('delegate-directory-off')).toHaveTextContent('directory_off_note');
    // The user's own principal isn't offered; their group and carol are.
    const options = within(within(dialog).getByTestId('delegate-candidates')).getAllByRole('button').map((o) => o.textContent);
    expect(options.some((o) => o?.includes('org-alice'))).toBe(false);
    expect(options.some((o) => o?.includes('org-carol'))).toBe(true);
  });

  it('shows the note for a typed address the server cannot look up', async () => {
    // A listing refused for another reason: the note comes from the lookup.
    const client = makeClient({ directory: { principals: [ALICE], status: 'restricted' } });
    const dialog = await openDialog(client);
    expect(within(dialog).queryByTestId('delegate-directory-off')).toBeNull();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'org-carol@example.org' } });
    fireEvent.click(within(dialog).getByText('use_address'));
    await waitFor(() => expect(client.findPrincipalByEmail).toHaveBeenCalledWith('org-carol@example.org'));
    expect(within(dialog).getByTestId('delegate-directory-off')).toHaveTextContent('directory_off_note');
  });

  it('takes a typed address the server resolves', async () => {
    const client = makeClient({ directory: { principals: [ALICE], status: 'ok' } });
    client.findPrincipalByEmail.mockResolvedValue({ principal: CAROL, status: 'ok' } as never);
    const dialog = await openDialog(client);
    const input = within(dialog).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'org-carol@example.org' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await within(dialog).findByText('org-carol@example.org')).toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox')).toBeNull();
  });

  it('gives read access to all folders and the default calendar and address book in one batch', async () => {
    const client = makeClient();
    const dialog = await openDialog(client);
    fireEvent.click(candidate(dialog, 'org-carol'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'apply_add' }));
    await waitFor(() => expect(client.applyShareChanges).toHaveBeenCalledTimes(1));
    const changes = client.applyShareChanges.mock.calls[0][0];
    expect(changes.map((c) => [c.kind, c.id, c.principalId])).toEqual([
      ['mailbox', 'a', 'ck'], ['mailbox', 'b', 'ck'], ['calendar', 'c', 'ck'], ['addressBook', 'd', 'ck'],
    ]);
    expect(changes[0].rights).toEqual(MAILBOX_PRESETS.read);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('reports the items that failed and tries only those again', async () => {
    let calls = 0;
    const client = makeClient({
      apply: (changes) => {
        calls += 1;
        return changes.map((change) => ({ change, ok: calls > 1 || change.kind !== 'calendar', error: calls > 1 ? undefined : 'You may not share this calendar' }));
      },
    });
    const dialog = await openDialog(client);
    fireEvent.click(candidate(dialog, 'org-carol'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'apply_add' }));
    const report = await within(dialog).findByRole('alert');
    expect(report).toHaveTextContent('partial_title');
    expect(report).toHaveTextContent('Calendar');
    expect(report).toHaveTextContent('You may not share this calendar');
    expect(report).not.toHaveTextContent('Inbox');

    fireEvent.click(within(dialog).getByRole('button', { name: 'retry' }));
    await waitFor(() => expect(client.applyShareChanges).toHaveBeenCalledTimes(2));
    expect(client.applyShareChanges.mock.calls[1][0].map((c) => c.id)).toEqual(['c']);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('offers only read when the admin allows only read', async () => {
    restrict({ sharingRights: { allowedValues: ['read'] } });
    const dialog = await openDialog(makeClient());
    const rights = within(dialog).getByTestId('delegate-rights');
    expect(within(rights).getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['read']);
    expect(within(rights).getByText('org_locked')).toBeInTheDocument();
  });

  it('offers both without a restriction, and no lock note', async () => {
    const dialog = await openDialog(makeClient());
    const rights = within(dialog).getByTestId('delegate-rights');
    expect(within(rights).getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['read', 'write']);
    expect(within(rights).queryByText('org_locked')).toBeNull();
  });

  it('keeps keys from the shortcuts behind it and closes on Escape', async () => {
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    try {
      const dialog = await openDialog(makeClient());
      fireEvent.keyDown(within(dialog).getByRole('textbox'), { key: 'e' });
      expect(onWindowKey).not.toHaveBeenCalled();
      fireEvent.keyDown(within(dialog).getByRole('textbox'), { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(onWindowKey).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', onWindowKey);
    }
  });

  it('starts "Change" from what the person has, and replaces it', async () => {
    const client = makeClient({ withCarol: true });
    renderWith(client);
    const row = await screen.findByTestId('delegate-row');
    fireEvent.click(within(row).getByRole('button', { name: 'change' }));
    const dialog = await screen.findByRole('dialog');
    const checked = within(dialog).getAllByRole('radio').filter((r) => (r as HTMLInputElement).checked).map((r) => (r as HTMLInputElement).value);
    expect(checked).toEqual(['inbox', 'default', 'none', 'read']);
    fireEvent.click(within(dialog).getAllByRole('radio').find((r) => (r as HTMLInputElement).value === 'write')!);
    fireEvent.click(within(dialog).getByRole('button', { name: 'apply_change' }));
    await waitFor(() => expect(client.applyShareChanges).toHaveBeenCalledTimes(1));
    const changes = client.applyShareChanges.mock.calls[0][0];
    expect(changes.map((c) => [c.id, (c.rights as Record<string, boolean> | null)?.mayAddItems ?? (c.rights as Record<string, boolean> | null)?.mayWriteAll])).toEqual([
      ['a', true], ['c', true],
    ]);
  });
});
