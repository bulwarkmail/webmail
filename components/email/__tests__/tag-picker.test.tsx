import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TagPicker } from '../tag-picker';
import { useSettingsStore, type KeywordDefinition } from '@/stores/settings-store';

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
