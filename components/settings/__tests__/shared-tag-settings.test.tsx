import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Names with their tag in them: the global mock returns the bare key.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: { name?: string }) => (params?.name ? `${key}:${params.name}` : key),
  useLocale: () => 'en',
}));

import { SharedTagSettings } from '../shared-tag-settings';
import { maySetSharedTags } from '@/hooks/use-account-tags';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';
import { resetSharedTags, sharedTagsKey, useSharedTagsStore } from '@/stores/shared-tags-store';

// Settings > Folders & tags > Shared tags: the editor of each group
// mailbox's tags, read-only when the admin locked them, and a note instead of
// an editor where the server keeps no metadata or couldn't be read.

const URGENT = { label: 'Urgent', color: 'red' };
const RIGHTS = { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true };

let stored: Record<string, unknown> | null;
let keywords: Record<string, number>;
let advertised: boolean;
let principalType: string;
const client = {
  getAccountId: () => 'me',
  getAccountInfo: (id: string) => ({ isPersonal: id === 'me' }),
  getSharedAccounts: () => [
    { id: 'me', name: 'org-alice@example.org', isPrimary: true, capabilities: { mail: true } },
    { id: 'team', name: 'org-team@example.org', isPrimary: false, capabilities: { mail: true } },
  ],
  getPrincipalTypes: async () => ({ team: principalType }),
  advertisesBulwarkMetadata: () => advertised,
  supportsBulwarkMetadata: () => advertised,
  getBulwarkMetadata: vi.fn(async () => (stored ? { tags: stored } : null)),
  patchBulwarkMetadata: vi.fn(async (_id: string | undefined, _key: string, patches: Array<{ path: string[]; value: unknown }>) => {
    const tags = { ...((stored?.tags ?? {}) as Record<string, unknown>) };
    for (const { path, value } of patches) {
      if (value === null) delete tags[path[1]];
      else tags[path[1]] = value;
    }
    stored = { tags };
    return { newState: 'sX' };
  }),
  discoverKeywords: async () => ({ keywords, scanned: 0, total: 0, complete: true }),
  getMailboxes: vi.fn(async () => []),
};

function setRights(rights: Record<string, boolean>) {
  useEmailStore.setState({ mailboxes: [{ id: 'team:a', name: 'Inbox', role: 'inbox', accountId: 'team', isShared: true, myRights: rights } as never] });
}

function setLocked(locked: boolean) {
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, restrictions: locked ? { sharedTags: { locked: true } } : {} } });
}

beforeEach(() => {
  resetSharedTags();
  stored = { tags: { urgent: { ...URGENT } } };
  keywords = {};
  advertised = true;
  principalType = 'group';
  client.getBulwarkMetadata.mockClear();
  client.patchBulwarkMetadata.mockClear();
  client.getMailboxes.mockClear();
  useSettingsStore.setState({ emailKeywords: [], nestedTags: false });
  useAuthStore.setState({
    client: client as never,
    activeAccountId: 'login-1',
    getClientForAccount: ((id: string) => (id === 'login-1' ? client : undefined)) as never,
  });
  setLocked(false);
  setRights({ ...RIGHTS, maySetMetadata: true });
});
afterEach(() => resetSharedTags());

describe('SharedTagSettings', () => {
  it('lets a member who may change the Inbox add a shared tag, as one patch', async () => {
    render(<SharedTagSettings />);
    expect(await screen.findByText('Urgent')).toBeInTheDocument();
    fireEvent.click(screen.getByText('add'));
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Waiting' } });
    fireEvent.click(screen.getByText('save'));
    await waitFor(() => expect(client.patchBulwarkMetadata).toHaveBeenCalledWith('team', 'tags', [
      { path: ['tags', 'waiting'], value: { label: 'Waiting', color: 'blue' } },
    ]));
    expect(await screen.findByText('Waiting')).toBeInTheDocument();
  });

  // #1613: a name with no Latin letters or digits had no id, so Save stayed off.
  it('adds a shared tag named in Cyrillic under a valid keyword id', async () => {
    render(<SharedTagSettings />);
    expect(await screen.findByText('Urgent')).toBeInTheDocument();
    fireEvent.click(screen.getByText('add'));
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Работа' } });
    fireEvent.click(screen.getByText('save'));
    await waitFor(() => expect(client.patchBulwarkMetadata).toHaveBeenCalled());
    const [[, , patches]] = client.patchBulwarkMetadata.mock.calls;
    expect(patches).toHaveLength(1);
    expect(patches[0].path[1]).toMatch(/^tag-[0-9a-z]+$/);
    expect(patches[0].value).toEqual({ label: 'Работа', color: 'blue' });
  });

  it('refuses a second shared tag with the same name', async () => {
    render(<SharedTagSettings />);
    expect(await screen.findByText('Urgent')).toBeInTheDocument();
    fireEvent.click(screen.getByText('add'));
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'urgent' } });
    expect(screen.getByText('exists')).toBeInTheDocument();
    expect(screen.getByText('save').closest('button')).toBeDisabled();
  });

  it('names the buttons after their tag and puts focus back on the edit button after saving', async () => {
    render(<SharedTagSettings />);
    fireEvent.click(await screen.findByLabelText('edit_tag:Urgent'));
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Very urgent' } });
    fireEvent.click(screen.getByText('save'));
    // The color wasn't picked, so it isn't sent: whatever is stored stays.
    await waitFor(() => expect(client.patchBulwarkMetadata).toHaveBeenCalledWith('team', 'tags', [
      { path: ['tags', 'urgent'], value: { label: 'Very urgent', color: 'red' } },
    ]));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('edit_tag:Very urgent')));
  });

  it('warns that deleting is for everyone, in words, before it deletes', async () => {
    render(<SharedTagSettings />);
    fireEvent.click(await screen.findByLabelText('delete_tag:Urgent'));
    const confirm = screen.getByTestId('shared-tag-delete-confirm');
    const warning = screen.getByText('delete_confirm');
    expect(confirm).toContainElement(warning);
    // Shown at every width, not only from the sm breakpoint up.
    expect(warning.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    fireEvent.click(screen.getByText('delete'));
    await waitFor(() => expect(client.patchBulwarkMetadata).toHaveBeenCalledWith('team', 'tags', [{ path: ['tags', 'urgent'], value: null }]));
  });

  it('shows the tags read-only with "Set by your organisation" when the admin locked them', async () => {
    setLocked(true);
    keywords = { '$label:found': 1 };
    const { container } = render(<SharedTagSettings />);
    expect(await screen.findByText('Urgent')).toBeInTheDocument();
    await screen.findByText('found_on_messages');
    expect(container.querySelector('[data-org-locked]')).not.toBeNull();
    expect(screen.queryByText('add')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^edit_tag/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^delete_tag/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^name_it/)).not.toBeInTheDocument();
  });

  it('is read-only with a note for a member without the right to change the Inbox', async () => {
    setRights({ ...RIGHTS, maySetMetadata: false });
    render(<SharedTagSettings />);
    expect(await screen.findByTestId('shared-tags-no-rights')).toHaveTextContent('no_rights');
    expect(screen.queryByText('add')).not.toBeInTheDocument();
  });

  it('asks for no rights of a mailbox a person shared', async () => {
    principalType = 'individual';
    useEmailStore.setState({ mailboxes: [] });
    render(<SharedTagSettings />);
    await waitFor(() => expect(useSharedTagsStore.getState().entries[sharedTagsKey('login-1', 'team')]?.status).toBe('personal'));
    expect(client.getMailboxes).not.toHaveBeenCalled();
    expect(screen.queryByTestId('shared-tags-account')).not.toBeInTheDocument();
  });

  it('says in one line that the server keeps no shared tags, with no editor', async () => {
    advertised = false;
    render(<SharedTagSettings />);
    expect(await screen.findByTestId('shared-tags-unsupported')).toHaveTextContent('unsupported');
    expect(screen.queryByText('add')).not.toBeInTheDocument();
    expect(client.getBulwarkMetadata).not.toHaveBeenCalled();
  });

  it('says so in one line when the shared tags couldn\'t be read', async () => {
    stored = null;
    render(<SharedTagSettings />);
    expect(await screen.findByTestId('shared-tags-unavailable')).toHaveTextContent('unavailable');
    expect(screen.queryByText('add')).not.toBeInTheDocument();
  });

  it('keeps a change the server didn\'t take and says it will try again', async () => {
    render(<SharedTagSettings />);
    await screen.findByText('Urgent');
    client.patchBulwarkMetadata.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fireEvent.click(screen.getByText('add'));
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Waiting' } });
    await act(async () => { fireEvent.click(screen.getByText('save')); });
    expect(await screen.findByTestId('shared-tags-pending')).toHaveTextContent('save_pending');
    expect(screen.getByText('Waiting')).toBeInTheDocument();
  });

  it('offers to name a tag found on the messages, keeping its id', async () => {
    keywords = { '$label:waiting-for-customer': 2 };
    render(<SharedTagSettings />);
    fireEvent.click(await screen.findByLabelText('name_it:waiting-for-customer'));
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Customer' } });
    fireEvent.click(screen.getByText('save'));
    await waitFor(() => expect(client.patchBulwarkMetadata).toHaveBeenCalledWith('team', 'tags', [
      { path: ['tags', 'waiting-for-customer'], value: { label: 'Customer', color: expect.any(String) } },
    ]));
  });
});

describe('maySetSharedTags', () => {
  it('follows maySetMetadata, and renaming where the server has no such right', () => {
    expect(maySetSharedTags({ maySetMetadata: true, mayRename: false })).toBe(true);
    expect(maySetSharedTags({ maySetMetadata: false, mayRename: true })).toBe(false);
    expect(maySetSharedTags({ mayRename: true })).toBe(true);
    expect(maySetSharedTags(null)).toBe(false);
  });
});
