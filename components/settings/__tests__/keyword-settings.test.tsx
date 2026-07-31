import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KeywordSettings } from '../keyword-settings';
import { useSettingsStore, DEFAULT_KEYWORDS } from '@/stores/settings-store';

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

  it('shows keyword JMAP id', () => {
    render(<KeywordSettings />);
    expect(screen.getByText('$label:red')).toBeInTheDocument();
    expect(screen.getByText('$label:blue')).toBeInTheDocument();
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

  it('prevents adding keyword with duplicate id', () => {
    render(<KeywordSettings />);
    fireEvent.click(screen.getByText('add_keyword'));

    const input = screen.getByPlaceholderText('label_placeholder');
    fireEvent.change(input, { target: { value: 'Red' } });

    // Should show duplicate warning
    expect(screen.getByText('id_exists')).toBeInTheDocument();
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
    expect(screen.getByText('$label:work/clients')).toBeInTheDocument();
  });

  it('rejects a path that would exceed the keyword length limit', () => {
    const deepId = 'a'.repeat(240);
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
