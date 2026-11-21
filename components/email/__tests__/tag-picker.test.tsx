import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { TagPicker } from '../tag-picker';
import { useSettingsStore, type KeywordDefinition } from '@/stores/settings-store';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { usePolicyStore } from '@/stores/policy-store';
import { resetSharedTags, useSharedTagsStore } from '@/stores/shared-tags-store';
import { DEFAULT_POLICY } from '@/lib/admin/types';

const TAGS: KeywordDefinition[] = [
  { id: 'work', label: 'Work', color: 'blue' },
  { id: 'work/clients', label: 'Clients', color: 'green' },
  { id: 'work/clients/acme', label: 'Acme', color: 'red' },
  { id: 'personal', label: 'Personal', color: 'purple' },
];

/** Ten tags is the point at which the filter box appears. */
const MANY_TAGS: KeywordDefinition[] = Array.from({ length: 12 }, (_, i) => ({
  id: `tag-${i}`,
  label: i === 0 ? 'Invoices' : `Tag ${i}`,
  color: 'blue',
}));

describe('TagPicker', () => {
  beforeEach(() => {
    useSettingsStore.setState({ emailKeywords: TAGS, nestedTags: true });
  });

  it('names a nested tag by its own label, not the whole path', () => {
    render(<TagPicker selectedIds={[]} onToggle={() => {}} />);

    // The tree conveys the hierarchy, so a child needs only its own name.
    expect(screen.getByText('Clients')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.queryByText('Work/Clients')).not.toBeInTheDocument();
  });

  it('indents each level below its parent', () => {
    const { container } = render(<TagPicker selectedIds={[]} onToggle={() => {}} />);
    const acme = screen.getByText('Acme');

    // Two levels down: two nested indent wrappers between it and the list.
    const indents = acme.closest('.ps-4')?.parentElement?.closest('.ps-4');
    expect(indents).not.toBeNull();
    expect(container.querySelectorAll('.ps-4').length).toBe(2);
  });

  it('marks the applied tags and reports toggles by id', () => {
    const onToggle = vi.fn();
    render(<TagPicker selectedIds={['work/clients']} onToggle={onToggle} />);

    const row = screen.getByText('Clients').closest('button')!;
    expect(row).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Work').closest('button')).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(row);
    expect(onToggle).toHaveBeenCalledWith('work/clients');
  });

  it('draws a tag only part of a selection carries as mixed', () => {
    render(<TagPicker selectedIds={['work']} partialIds={['personal', 'from-elsewhere']} onToggle={() => {}} />);

    expect(screen.getByText('Work').closest('button')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Personal').closest('button')).toHaveAttribute('aria-checked', 'mixed');
    // An undefined tag on part of the selection is still listed, so it can come off.
    expect(screen.getByText('from-elsewhere').closest('button')).toHaveAttribute('aria-checked', 'mixed');
  });

  it('lists a tag it has no definition for, so it can be taken off', () => {
    const onToggle = vi.fn();
    const { rerender } = render(<TagPicker selectedIds={['from-elsewhere']} onToggle={onToggle} />);

    const row = screen.getByText('from-elsewhere').closest('button')!;
    expect(row).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(row);
    expect(onToggle).toHaveBeenCalledWith('from-elsewhere');

    // Nothing but the message says it exists, so deselecting is the last of it.
    rerender(<TagPicker selectedIds={[]} onToggle={onToggle} />);
    expect(screen.queryByText('from-elsewhere')).not.toBeInTheDocument();
  });

  it('counts undefined tags towards the filter box, and matches them', () => {
    const strays = Array.from({ length: 8 }, (_, i) => `stray-${i}`);
    const { container } = render(<TagPicker selectedIds={strays} onToggle={() => {}} />);

    fireEvent.change(screen.getByLabelText('tag_filter_placeholder'), { target: { value: 'stray-3' } });
    expect(within(container).getByText('stray-3')).toBeInTheDocument();
    expect(within(container).queryByText('Work')).not.toBeInTheDocument();
  });

  it('hides the filter box until the list is long enough to need one', () => {
    render(<TagPicker selectedIds={[]} onToggle={() => {}} />);
    expect(screen.queryByLabelText('tag_filter_placeholder')).not.toBeInTheDocument();

    useSettingsStore.setState({ emailKeywords: MANY_TAGS });
    render(<TagPicker selectedIds={[]} onToggle={() => {}} />);
    expect(screen.getAllByLabelText('tag_filter_placeholder').length).toBeGreaterThan(0);
  });

  it('flattens to matches while filtering, and says so when there are none', () => {
    useSettingsStore.setState({ emailKeywords: MANY_TAGS });
    const { container } = render(<TagPicker selectedIds={[]} onToggle={() => {}} />);

    fireEvent.change(screen.getByLabelText('tag_filter_placeholder'), { target: { value: 'invo' } });
    expect(within(container).getByText('Invoices')).toBeInTheDocument();
    expect(within(container).queryByText('Tag 5')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('tag_filter_placeholder'), { target: { value: 'zzz' } });
    expect(within(container).getByText('tag_no_matches')).toBeInTheDocument();
  });

  it('matches the full path, so a child is reachable by its parent name', () => {
    useSettingsStore.setState({ emailKeywords: [...TAGS, ...MANY_TAGS] });
    const { container } = render(<TagPicker selectedIds={[]} onToggle={() => {}} />);

    fireEvent.change(screen.getByLabelText('tag_filter_placeholder'), { target: { value: 'work/cli' } });
    // Filtered rows are flat, so they carry the whole path.
    expect(within(container).getByText('Work/Clients')).toBeInTheDocument();
  });

  it('lists tags flat when nesting is off', () => {
    useSettingsStore.setState({ nestedTags: false });
    const { container } = render(<TagPicker selectedIds={[]} onToggle={() => {}} />);

    expect(container.querySelectorAll('.ps-4').length).toBe(0);
    expect(screen.getByText('Clients')).toBeInTheDocument();
  });
});

describe('TagPicker new tag', () => {
  it('creates a tag from the picker and puts it on the message', async () => {
    const { fireEvent, render, screen } = await import('@testing-library/react');
    const { useSettingsStore } = await import('@/stores/settings-store');
    const { TagPicker } = await import('../tag-picker');
    useSettingsStore.setState({ emailKeywords: [] } as never);
    const onToggle = vi.fn();
    render(<TagPicker selectedIds={[]} onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId('tag-picker-new'));
    const field = screen.getByRole('textbox', { name: 'new_tag_placeholder' });
    fireEvent.change(field, { target: { value: 'Receipts' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    const created = useSettingsStore.getState().emailKeywords;
    expect(created).toHaveLength(1);
    expect(created[0].label).toBe('Receipts');
    expect(onToggle).toHaveBeenCalledWith(created[0].id);
  });

  // #1613: refused as "Choose a shorter name" before.
  it('creates a tag named in Cyrillic, and refuses the same name twice', async () => {
    const { fireEvent, render, screen } = await import('@testing-library/react');
    const { useSettingsStore } = await import('@/stores/settings-store');
    const { TagPicker } = await import('../tag-picker');
    useSettingsStore.setState({ emailKeywords: [{ id: '1', label: 'Банк 1', color: 'blue' }] } as never);
    const onToggle = vi.fn();
    const { unmount } = render(<TagPicker selectedIds={[]} onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId('tag-picker-new'));
    const field = screen.getByRole('textbox', { name: 'new_tag_placeholder' });

    fireEvent.change(field, { target: { value: 'Счета 1' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.keyDown(field, { key: 'Enter' });
    const created = useSettingsStore.getState().emailKeywords;
    expect(created).toHaveLength(2);
    expect(created[1].label).toBe('Счета 1');
    expect(created[1].id).toMatch(/^tag-[0-9a-z]+$/);
    expect(onToggle).toHaveBeenCalledWith(created[1].id);
    unmount();

    render(<TagPicker selectedIds={[]} onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId('tag-picker-new'));
    fireEvent.change(screen.getByRole('textbox', { name: 'new_tag_placeholder' }), { target: { value: 'счета 1' } });
    expect(screen.getByRole('alert')).toHaveTextContent('tag_exists');
  });
});

// #1613: in a group account the picker offers the group's shared tags, but
// "New tag" made a personal tag, which the group showed by its raw id.
describe('TagPicker new tag in a group account', () => {
  const SCOPE = { loginId: 'login-1', accountId: 'team' };
  let stored: Record<string, unknown>;
  const client = {
    getAccountId: () => 'me',
    getPrincipalTypes: async () => ({ team: 'group' }),
    advertisesBulwarkMetadata: () => true,
    supportsBulwarkMetadata: () => true,
    getBulwarkMetadata: vi.fn(async () => ({ tags: stored })),
    patchBulwarkMetadata: vi.fn(async (_id: string | undefined, _key: string, patches: Array<{ path: string[]; value: unknown }>) => {
      const tags = { ...((stored.tags ?? {}) as Record<string, unknown>) };
      for (const { path, value } of patches) tags[path[1]] = value;
      stored = { tags };
      return { newState: 'sX' };
    }),
    discoverKeywords: async () => ({ keywords: {}, scanned: 0, total: 0, complete: true }),
    getMailboxes: vi.fn(async () => []),
  };

  const setInbox = (rights: Record<string, boolean>) =>
    useEmailStore.setState({ mailboxes: [{ id: 'team:a', name: 'Inbox', role: 'inbox', accountId: 'team', isShared: true, myRights: rights } as never] });

  beforeEach(() => {
    resetSharedTags();
    stored = { tags: { urgent: { label: 'Urgent', color: 'red' } } };
    client.patchBulwarkMetadata.mockClear();
    useSettingsStore.setState({ emailKeywords: [{ id: 'work', label: 'Work', color: 'blue' }], nestedTags: false });
    useAuthStore.setState({
      client: client as never,
      activeAccountId: 'login-1',
      getClientForAccount: ((id: string) => (id === 'login-1' ? client : undefined)) as never,
    });
    usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, restrictions: {} } });
    setInbox({ mayRename: true, maySetMetadata: true });
  });

  afterEach(() => {
    resetSharedTags();
    useEmailStore.setState({ mailboxes: [] });
    useAuthStore.setState({ client: null, activeAccountId: null });
    usePolicyStore.setState({ policy: DEFAULT_POLICY });
  });

  it('adds the new tag to the group\'s shared tags, not to the personal ones', async () => {
    const onToggle = vi.fn();
    render(<TagPicker selectedIds={[]} onToggle={onToggle} scope={SCOPE} />);
    expect(await screen.findByText('Urgent')).toBeInTheDocument();
    expect(screen.queryByText('Work')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('tag-picker-new'));
    const field = screen.getByRole('textbox', { name: 'new_tag_placeholder' });
    fireEvent.change(field, { target: { value: 'urgent' } });
    expect(screen.getByRole('alert')).toHaveTextContent('tag_exists');

    fireEvent.change(field, { target: { value: 'Work' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(onToggle).toHaveBeenCalledWith('work'));
    expect(client.patchBulwarkMetadata).toHaveBeenCalledWith('team', 'tags', [
      { path: ['tags', 'work'], value: { label: 'Work', color: expect.any(String) } },
    ]);
    expect(useSettingsStore.getState().emailKeywords).toEqual([{ id: 'work', label: 'Work', color: 'blue' }]);
    expect(await screen.findByText('Work')).toBeInTheDocument();
  });

  it('offers no new tag to a member who may not change the group\'s tags', async () => {
    setInbox({ mayRename: false, maySetMetadata: false });
    render(<TagPicker selectedIds={[]} onToggle={() => {}} scope={SCOPE} />);
    expect(await screen.findByText('Urgent')).toBeInTheDocument();
    expect(screen.queryByTestId('tag-picker-new')).not.toBeInTheDocument();
  });

  it('offers no new tag when the organisation locked the shared tags', async () => {
    usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, restrictions: { sharedTags: { locked: true } } } });
    render(<TagPicker selectedIds={[]} onToggle={() => {}} scope={SCOPE} />);
    expect(await screen.findByText('Urgent')).toBeInTheDocument();
    expect(screen.queryByTestId('tag-picker-new')).not.toBeInTheDocument();
  });

  it('still makes a personal tag where the group has no shared tags to offer', async () => {
    client.advertisesBulwarkMetadata = () => false;
    try {
      const onToggle = vi.fn();
      render(<TagPicker selectedIds={[]} onToggle={onToggle} scope={SCOPE} />);
      await waitFor(() => expect(useSharedTagsStore.getState().entries['login-1|team']?.status).toBe('unsupported'));
      expect(screen.getByText('Work')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('tag-picker-new'));
      const field = screen.getByRole('textbox', { name: 'new_tag_placeholder' });
      fireEvent.change(field, { target: { value: 'Receipts' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(useSettingsStore.getState().emailKeywords.map((k) => k.id)).toEqual(['work', 'receipts']);
      expect(onToggle).toHaveBeenCalledWith('receipts');
      expect(client.patchBulwarkMetadata).not.toHaveBeenCalled();
    } finally {
      client.advertisesBulwarkMetadata = () => true;
    }
  });
});
