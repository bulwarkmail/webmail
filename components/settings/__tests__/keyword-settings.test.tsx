import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KeywordSettings } from '../keyword-settings';
import { useSettingsStore, DEFAULT_KEYWORDS } from '@/stores/settings-store';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useFilterStore } from '@/stores/filter-store';

// Mock SettingsSection to just render children, keeping the real controls
vi.mock('../settings-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-section')>()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe('KeywordSettings', () => {
  beforeEach(() => {
    useSettingsStore.setState({ emailKeywords: [...DEFAULT_KEYWORDS], nestedTags: false });
  });

  it('renders all default keywords', () => {
    render(<KeywordSettings />);
    DEFAULT_KEYWORDS.forEach((kw) => {
      expect(screen.getByText(kw.label)).toBeInTheDocument();
    });
  });

  // settings-28: the stored keyword is no line of its own; with the advanced
  // settings on it is the tag's tooltip.
  it('does not show the stored keyword under each tag', () => {
    render(<KeywordSettings />);
    expect(screen.queryByText('$label:red')).toBeNull();
    expect(screen.queryByTitle('$label:red')).toBeNull();
  });

  it('shows the stored keyword as a tooltip with the advanced settings on', () => {
    useSettingsStore.setState({ showAdvancedSettings: true });
    render(<KeywordSettings />);
    expect(screen.queryByText('$label:red')).toBeNull();
    expect(screen.getByTitle('$label:red')).toBeInTheDocument();
    expect(screen.getByTitle('$label:blue')).toBeInTheDocument();
    useSettingsStore.setState({ showAdvancedSettings: false });
  });

  // MO-06: the tag order was drag-only.
  it('moves a tag down with its Move down button', () => {
    render(<KeywordSettings />);
    const [first, second] = useSettingsStore.getState().emailKeywords.map((k) => k.id);
    fireEvent.click(screen.getAllByTestId('move-down')[0]);
    const ids = useSettingsStore.getState().emailKeywords.map((k) => k.id);
    expect(ids.slice(0, 2)).toEqual([second, first]);
  });

  // #1612: new accounts start with no tags.
  it('says there are no tags yet and still lets the user make one', () => {
    useSettingsStore.setState({ emailKeywords: [] });
    render(<KeywordSettings />);
    expect(screen.getByText('empty')).toBeInTheDocument();
    fireEvent.click(screen.getByText('add_keyword'));
    expect(screen.queryByText('empty')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('label_placeholder'), { target: { value: 'Work' } });
    fireEvent.click(screen.getByText('add'));
    expect(useSettingsStore.getState().emailKeywords).toEqual([{ id: 'work', label: 'Work', color: 'blue' }]);
    expect(screen.queryByText('empty')).toBeNull();
  });

  it('renders add keyword button', () => {
    render(<KeywordSettings />);
    expect(screen.getByText('add_keyword')).toBeInTheDocument();
  });

  it('shows add form when add button clicked', () => {
    render(<KeywordSettings />);
    fireEvent.click(screen.getByText('add_keyword'));
    expect(screen.getByPlaceholderText('label_placeholder')).toBeInTheDocument();
    // Cancel and save buttons should appear
    expect(screen.getByText('cancel')).toBeInTheDocument();
    expect(screen.getByText('add')).toBeInTheDocument();
  });

  it('adds a new keyword through the form', () => {
    render(<KeywordSettings />);
    fireEvent.click(screen.getByText('add_keyword'));

    const input = screen.getByPlaceholderText('label_placeholder');
    fireEvent.change(input, { target: { value: 'Important' } });
    fireEvent.click(screen.getByText('add'));

    const keywords = useSettingsStore.getState().emailKeywords;
    expect(keywords).toHaveLength(DEFAULT_KEYWORDS.length + 1);
    expect(keywords[keywords.length - 1].label).toBe('Important');
    expect(keywords[keywords.length - 1].id).toBe('important');
  });

  it('prevents adding a tag with a name that is already used', () => {
    render(<KeywordSettings />);
    fireEvent.click(screen.getByText('add_keyword'));

    const input = screen.getByPlaceholderText('label_placeholder');
    fireEvent.change(input, { target: { value: 'red' } });

    // Should show duplicate warning
    expect(screen.getByText('name_exists')).toBeInTheDocument();
    expect(screen.getByText('add')).toBeDisabled();
  });

  it('cancels add form when cancel clicked', () => {
    render(<KeywordSettings />);
    fireEvent.click(screen.getByText('add_keyword'));
    expect(screen.getByPlaceholderText('label_placeholder')).toBeInTheDocument();

    fireEvent.click(screen.getByText('cancel'));
    expect(screen.queryByPlaceholderText('label_placeholder')).not.toBeInTheDocument();
  });

  it('deletes keyword when delete button clicked', () => {
    render(<KeywordSettings />);
    // Find delete buttons (title="delete")
    const deleteButtons = screen.getAllByTitle('delete');
    expect(deleteButtons.length).toBe(DEFAULT_KEYWORDS.length);

    // Delete the first keyword
    fireEvent.click(deleteButtons[0]);
    expect(useSettingsStore.getState().emailKeywords).toHaveLength(DEFAULT_KEYWORDS.length - 1);
    expect(useSettingsStore.getState().emailKeywords.find((k) => k.id === 'red')).toBeUndefined();
  });

  // A list of "Edit" / "Delete" with nothing else said which tag a screen
  // reader user was on; each button is named after its tag now, as a full
  // size icon button (32px, 44px hit area on touch).
  it('names each tag row button after its tag', () => {
    render(<KeywordSettings />);
    expect(screen.getAllByRole('button', { name: 'edit_tag' })).toHaveLength(DEFAULT_KEYWORDS.length);
    const deletes = screen.getAllByRole('button', { name: 'delete_tag' });
    expect(deletes).toHaveLength(DEFAULT_KEYWORDS.length);
    expect(deletes[0].className).toContain('h-8 w-8');
  });

  it('shows edit form when edit button clicked', () => {
    render(<KeywordSettings />);
    const editButtons = screen.getAllByTitle('edit');
    fireEvent.click(editButtons[0]); // edit first keyword (Red)

    const input = screen.getByDisplayValue('Red');
    expect(input).toBeInTheDocument();
    expect(screen.getByText('save')).toBeInTheDocument();
  });

  it('updates keyword label through edit form', () => {
    render(<KeywordSettings />);
    const editButtons = screen.getAllByTitle('edit');
    fireEvent.click(editButtons[0]); // edit "Red"

    const input = screen.getByDisplayValue('Red');
    fireEvent.change(input, { target: { value: 'Crimson' } });
    fireEvent.click(screen.getByText('save'));

    const kw = useSettingsStore.getState().emailKeywords.find((k) => k.id === 'red');
    expect(kw?.label).toBe('Crimson');
  });

  it('normalizes label to id correctly', () => {
    render(<KeywordSettings />);
    fireEvent.click(screen.getByText('add_keyword'));

    const input = screen.getByPlaceholderText('label_placeholder');
    fireEvent.change(input, { target: { value: 'My Custom Tag!' } });
    fireEvent.click(screen.getByText('add'));

    const keywords = useSettingsStore.getState().emailKeywords;
    const added = keywords[keywords.length - 1];
    expect(added.id).toBe('my-custom-tag');
    expect(added.label).toBe('My Custom Tag!');
  });

  it('offers no parent picker while nesting is off', () => {
    render(<KeywordSettings />);
    fireEvent.click(screen.getByText('add_keyword'));

    expect(screen.queryByLabelText('parent_field')).not.toBeInTheDocument();
  });

  it('nests a new tag under the selected parent', () => {
    useSettingsStore.setState({
      emailKeywords: [{ id: 'work', label: 'Work', color: 'blue' }],
      nestedTags: true,
    });
    render(<KeywordSettings />);
    fireEvent.click(screen.getByText('add_keyword'));

    fireEvent.change(screen.getByLabelText('parent_field'), { target: { value: 'work' } });
    fireEvent.change(screen.getByPlaceholderText('label_placeholder'), { target: { value: 'Clients' } });
    fireEvent.click(screen.getByText('add'));

    const keywords = useSettingsStore.getState().emailKeywords;
    expect(keywords[keywords.length - 1]).toMatchObject({ id: 'work/clients', label: 'Clients' });
  });

  it('shows nested tags by their full path', () => {
    useSettingsStore.setState({
      emailKeywords: [
        { id: 'work', label: 'Work', color: 'blue' },
        { id: 'work/clients', label: 'Clients', color: 'green' },
      ],
      nestedTags: true,
    });
    render(<KeywordSettings />);

    expect(screen.getByText('Work/Clients')).toBeInTheDocument();
    expect(screen.queryByText('$label:work/clients')).toBeNull();
  });

  it('rejects a path that would exceed the 128-byte keyword limit of Stalwart', () => {
    // `$label:` + 110 + `/overflowing-name` is 134 bytes: fine by the RFC's
    // 255, refused by Stalwart 1.0 and cut short by 0.16.
    const deepId = 'a'.repeat(110);
    useSettingsStore.setState({
      emailKeywords: [{ id: deepId, label: 'Deep', color: 'blue' }],
      nestedTags: true,
    });
    render(<KeywordSettings />);
    fireEvent.click(screen.getByText('add_keyword'));

    fireEvent.change(screen.getByLabelText('parent_field'), { target: { value: deepId } });
    fireEvent.change(screen.getByPlaceholderText('label_placeholder'), { target: { value: 'Overflowing name' } });

    expect(screen.getByText('too_long')).toBeInTheDocument();
    expect(screen.getByText('add').closest('button')).toBeDisabled();
  });

  it('still saves a new colour for a tag whose id predates the limit', () => {
    // 128 characters, 135 bytes as a keyword: created when the limit was the
    // RFC's 255.
    const parentId = 'a'.repeat(120);
    const oldId = `${parentId}/old-tag`;
    useSettingsStore.setState({
      emailKeywords: [
        { id: parentId, label: 'Deep', color: 'blue' },
        { id: oldId, label: 'Old tag', color: 'blue' },
      ],
      nestedTags: true,
    });
    render(<KeywordSettings />);

    fireEvent.click(screen.getAllByTitle('edit')[1]);
    fireEvent.click(screen.getByLabelText('green'));

    expect(screen.queryByText('too_long')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('save'));
    expect(useSettingsStore.getState().emailKeywords.find((k) => k.id === oldId)?.color).toBe('green');

    // Renaming it would make a new id, which has to fit.
    fireEvent.click(screen.getAllByTitle('edit')[1]);
    fireEvent.change(screen.getByDisplayValue('Old tag'), { target: { value: 'Renamed tag' } });
    expect(screen.getByText('too_long')).toBeInTheDocument();
  });

  it('locks the name and the delete action of a tag that has nested tags', () => {
    useSettingsStore.setState({
      emailKeywords: [
        { id: 'work', label: 'Work', color: 'blue' },
        { id: 'work/clients', label: 'Clients', color: 'green' },
      ],
      nestedTags: true,
    });
    render(<KeywordSettings />);

    expect(screen.getByTitle('has_children_delete')).toBeDisabled();

    fireEvent.click(screen.getAllByTitle('edit')[0]);
    expect(screen.getByDisplayValue('Work')).toBeDisabled();
    expect(screen.getByText('has_children_locked')).toBeInTheDocument();
  });

  it('defaults every tag to always visible in the sidebar', () => {
    render(<KeywordSettings />);

    const pickers = screen.getAllByLabelText('visibility_field');
    expect(pickers).toHaveLength(DEFAULT_KEYWORDS.length);
    pickers.forEach((picker) => expect(picker).toHaveValue('show'));
  });

  it('stores the visibility chosen for a tag', () => {
    render(<KeywordSettings />);

    fireEvent.change(screen.getAllByLabelText('visibility_field')[0], { target: { value: 'unread' } });

    expect(useSettingsStore.getState().emailKeywords.find((k) => k.id === 'red')?.visibility).toBe('unread');
  });
});

// Tag names and colours live only in these settings, so losing them hides tags
// whose keywords are still intact on every message. Scanning finds those
// keywords and offers them back under a name the user never had to remember.
describe('KeywordSettings unrecognized tags', () => {
  const discoverKeywords = vi.fn();

  beforeEach(() => {
    useSettingsStore.setState({ emailKeywords: [...DEFAULT_KEYWORDS], nestedTags: false });
    discoverKeywords.mockReset();
    discoverKeywords.mockResolvedValue({ keywords: {}, scanned: 0, total: 0, complete: true });
    useAuthStore.setState({ client: { discoverKeywords, getTagCounts: vi.fn().mockResolvedValue({}) } as never });
    useEmailStore.setState({ tagCounts: {} });
  });

  const scan = async () => {
    fireEvent.click(screen.getByText('unrecognized.scan'));
    await waitFor(() => expect(discoverKeywords).toHaveBeenCalled());
  };

  it('offers no scan when there is no connected account', async () => {
    useAuthStore.setState({ client: null });
    render(<KeywordSettings />);

    expect(screen.getByText('unrecognized.scan').closest('button')).toBeDisabled();
  });

  it('says so when every keyword on the server is already defined', async () => {
    discoverKeywords.mockResolvedValue({
      keywords: { $seen: 9, '$label:red': 4 },
      scanned: 9,
      total: 9,
      complete: true,
    });
    render(<KeywordSettings />);
    await scan();

    expect(await screen.findByText('unrecognized.none')).toBeInTheDocument();
  });

  it('surfaces an unrecognized keyword with a proposed name and its raw id', async () => {
    discoverKeywords.mockResolvedValue({
      keywords: { '$label:q3-invoices': 7 },
      scanned: 9,
      total: 9,
      complete: true,
    });
    render(<KeywordSettings />);
    await scan();

    expect(await screen.findByDisplayValue('Q3 Invoices')).toBeInTheDocument();
    expect(screen.getByText('$label:q3-invoices')).toBeInTheDocument();
  });

  it('adds the tag under the keyword the messages already carry', async () => {
    discoverKeywords.mockResolvedValue({
      keywords: { '$label:q3-invoices': 7 },
      scanned: 9,
      total: 9,
      complete: true,
    });
    render(<KeywordSettings />);
    await scan();
    await screen.findByDisplayValue('Q3 Invoices');

    fireEvent.click(screen.getAllByText('add').slice(-1)[0]);

    expect(useSettingsStore.getState().emailKeywords).toContainEqual(
      expect.objectContaining({ id: 'q3-invoices', label: 'Q3 Invoices' }),
    );
  });

  it('keeps the id when the proposed name is edited first', async () => {
    discoverKeywords.mockResolvedValue({
      keywords: { '$label:q3-invoices': 7 },
      scanned: 9,
      total: 9,
      complete: true,
    });
    render(<KeywordSettings />);
    await scan();

    fireEvent.change(await screen.findByDisplayValue('Q3 Invoices'), { target: { value: 'Invoices' } });
    fireEvent.click(screen.getAllByText('add').slice(-1)[0]);

    expect(useSettingsStore.getState().emailKeywords).toContainEqual(
      expect.objectContaining({ id: 'q3-invoices', label: 'Invoices' }),
    );
  });

  it('drops a row from the list once its tag is defined', async () => {
    discoverKeywords.mockResolvedValue({
      keywords: { '$label:q3-invoices': 7 },
      scanned: 9,
      total: 9,
      complete: true,
    });
    render(<KeywordSettings />);
    await scan();
    await screen.findByDisplayValue('Q3 Invoices');

    fireEvent.click(screen.getAllByText('add').slice(-1)[0]);

    // The name field belongs to the unrecognized row alone - the tag itself is
    // now in the list above, where it is named by a badge rather than an input.
    expect(screen.queryByDisplayValue('Q3 Invoices')).not.toBeInTheDocument();
    expect(screen.getByText('unrecognized.none')).toBeInTheDocument();
  });

  it('adds every found tag at once', async () => {
    discoverKeywords.mockResolvedValue({
      keywords: { '$label:q3-invoices': 7, '$label:receipts': 3 },
      scanned: 9,
      total: 9,
      complete: true,
    });
    render(<KeywordSettings />);
    await scan();

    fireEvent.click(await screen.findByText('unrecognized.add_all'));

    const ids = useSettingsStore.getState().emailKeywords.map((k) => k.id);
    expect(ids).toContain('q3-invoices');
    expect(ids).toContain('receipts');
  });

  it('warns that a capped scan may have missed tags on older mail', async () => {
    discoverKeywords.mockResolvedValue({
      keywords: { '$label:q3-invoices': 7 },
      scanned: 25000,
      total: 90000,
      complete: false,
    });
    render(<KeywordSettings />);
    await scan();

    expect(await screen.findByText('unrecognized.partial')).toBeInTheDocument();
  });

  it('reports a failed scan instead of claiming nothing was found', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    discoverKeywords.mockRejectedValue(new Error('network down'));
    render(<KeywordSettings />);
    await scan();

    expect(await screen.findByText('unrecognized.error')).toBeInTheDocument();
    expect(screen.queryByText('unrecognized.none')).not.toBeInTheDocument();
  });
});

// SET-20: Escape cancels editing a tag, as it does for folders, calendars
// and address books.
describe('KeywordSettings editing', () => {
  it('cancels the edit form on Escape without saving', () => {
    useSettingsStore.setState({ emailKeywords: [...DEFAULT_KEYWORDS], nestedTags: false });
    render(<KeywordSettings />);
    fireEvent.click(screen.getAllByTitle('edit')[0]);
    const input = screen.getByDisplayValue(DEFAULT_KEYWORDS[0].label);
    fireEvent.change(input, { target: { value: 'Changed' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByDisplayValue('Changed')).toBeNull();
    expect(useSettingsStore.getState().emailKeywords[0].label).toBe(DEFAULT_KEYWORDS[0].label);
  });
});

// #1613: the id is a slug of the name, and a name with no Latin letters or
// digits has none, so Save stayed disabled without a word.
describe('KeywordSettings names in other scripts', () => {
  const migrateKeyword = vi.fn();
  const renameKeywordInFilters = vi.fn();

  beforeEach(() => {
    useSettingsStore.setState({ emailKeywords: [...DEFAULT_KEYWORDS], nestedTags: false });
    migrateKeyword.mockReset();
    renameKeywordInFilters.mockReset().mockResolvedValue({ changed: 0, unhandled: 0 });
    useFilterStore.setState({ renameKeywordInFilters } as never);
    useAuthStore.setState({ client: { migrateKeyword, getTagCounts: vi.fn().mockResolvedValue({}) } as never });
  });

  const addTag = (name: string) => {
    fireEvent.click(screen.getByText('add_keyword'));
    fireEvent.change(screen.getByPlaceholderText('label_placeholder'), { target: { value: name } });
    fireEvent.click(screen.getByText('add'));
  };

  it('adds a tag named in Cyrillic under a valid keyword id', () => {
    render(<KeywordSettings />);
    addTag('Работа');

    const added = useSettingsStore.getState().emailKeywords.at(-1);
    expect(added?.label).toBe('Работа');
    expect(added?.id).toMatch(/^tag-[0-9a-z]+$/);
  });

  it('adds two names whose slugs are the same as two tags', () => {
    render(<KeywordSettings />);
    addTag('Банк 1');
    addTag('Счета 1');

    const keywords = useSettingsStore.getState().emailKeywords;
    expect(keywords).toHaveLength(DEFAULT_KEYWORDS.length + 2);
    const [bank, bills] = keywords.slice(-2);
    expect(bank).toMatchObject({ label: 'Банк 1', id: '1' });
    expect(bills.label).toBe('Счета 1');
    expect(bills.id).not.toBe('1');
  });

  it('renames a tag to a Cyrillic name without changing its id', async () => {
    render(<KeywordSettings />);
    fireEvent.click(screen.getAllByTitle('edit')[0]);
    fireEvent.change(screen.getByDisplayValue('Red'), { target: { value: 'Красный' } });
    fireEvent.click(screen.getByText('save'));

    await waitFor(() =>
      expect(useSettingsStore.getState().emailKeywords.find((k) => k.id === 'red')?.label).toBe('Красный'),
    );
    expect(migrateKeyword).not.toHaveBeenCalled();
  });

  // "Счета 1" got a generated id because "Банк 1" had `1`. With "Банк 1"
  // gone, a colour change must not move it to `1`: that rewrites all its
  // mail and filters, and the mail "Банк 1" left behind would join it.
  it('keeps the id of a tag when only its colour changes', async () => {
    render(<KeywordSettings />);
    addTag('Банк 1');
    addTag('Счета 1');
    const billsId = useSettingsStore.getState().emailKeywords.at(-1)!.id;
    expect(billsId).not.toBe('1');
    useSettingsStore.setState({ emailKeywords: useSettingsStore.getState().emailKeywords.filter((k) => k.id !== '1') });

    fireEvent.click(screen.getAllByTitle('edit').at(-1)!);
    fireEvent.click(screen.getByLabelText('green'));
    fireEvent.click(screen.getByText('save'));

    await waitFor(() =>
      expect(useSettingsStore.getState().emailKeywords.find((k) => k.label === 'Счета 1')?.color).toBe('green'),
    );
    expect(useSettingsStore.getState().emailKeywords.find((k) => k.label === 'Счета 1')?.id).toBe(billsId);
    expect(migrateKeyword).not.toHaveBeenCalled();
    expect(renameKeywordInFilters).not.toHaveBeenCalled();
  });

  it('keeps the id of a plugin tag when its name changes only in case', async () => {
    useSettingsStore.setState({ emailKeywords: [{ id: 'from-plugin', label: 'invoices', color: 'blue' }] });
    render(<KeywordSettings />);
    fireEvent.click(screen.getByTitle('edit'));
    fireEvent.change(screen.getByDisplayValue('invoices'), { target: { value: 'Invoices' } });
    fireEvent.click(screen.getByText('save'));

    await waitFor(() => expect(useSettingsStore.getState().emailKeywords[0].label).toBe('Invoices'));
    expect(useSettingsStore.getState().emailKeywords[0].id).toBe('from-plugin');
    expect(migrateKeyword).not.toHaveBeenCalled();
  });

  it('still moves the mail when a tag is renamed to another slug', async () => {
    migrateKeyword.mockResolvedValue({ refused: 0 });
    useSettingsStore.setState({ emailKeywords: [{ id: 'from-plugin', label: 'invoices', color: 'blue' }] });
    render(<KeywordSettings />);
    fireEvent.click(screen.getByTitle('edit'));
    fireEvent.change(screen.getByDisplayValue('invoices'), { target: { value: 'Bills' } });
    fireEvent.click(screen.getByText('save'));

    await waitFor(() => expect(migrateKeyword).toHaveBeenCalledWith('$label:from-plugin', '$label:bills'));
  });

  it('nests a tag with a Cyrillic name under its parent', () => {
    useSettingsStore.setState({ emailKeywords: [{ id: 'work', label: 'Work', color: 'blue' }], nestedTags: true });
    render(<KeywordSettings />);
    fireEvent.click(screen.getByText('add_keyword'));
    fireEvent.change(screen.getByLabelText('parent_field'), { target: { value: 'work' } });
    fireEvent.change(screen.getByPlaceholderText('label_placeholder'), { target: { value: 'Клиенты' } });
    fireEvent.click(screen.getByText('add'));

    expect(useSettingsStore.getState().emailKeywords.at(-1)?.id).toMatch(/^work\/tag-[0-9a-z]+$/);
  });
});
