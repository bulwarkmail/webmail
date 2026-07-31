import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TagBadge } from '../tag-badge';
import { useSettingsStore, type KeywordDefinition } from '@/stores/settings-store';

const TAGS: KeywordDefinition[] = [
  { id: 'work', label: 'Work', color: 'blue' },
  { id: 'work/clients', label: 'Clients', color: 'green' },
];

describe('TagBadge', () => {
  beforeEach(() => {
    useSettingsStore.setState({ emailKeywords: TAGS, nestedTags: true });
  });

  it('names the tag by its full path', () => {
    render(<TagBadge tagId="work/clients" variant="badge" />);
    expect(screen.getByText('Work/Clients')).toBeInTheDocument();
  });

  it('names a tag it has no definition for by its id', () => {
    render(<TagBadge tagId="from-elsewhere" variant="badge" />);
    expect(screen.getByText('from-elsewhere')).toBeInTheDocument();
  });

  it('offers removal only when asked to', () => {
    const onRemove = vi.fn();
    const { rerender } = render(<TagBadge tagId="work" variant="badge" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    rerender(<TagBadge tagId="work" variant="badge" onRemove={onRemove} />);
    fireEvent.click(screen.getByRole('button', { name: 'remove_tag' }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('leaves the dot alone, having nowhere to put the control', () => {
    render(<TagBadge tagId="work" variant="dot" onRemove={() => {}} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Work')).toBeInTheDocument();
  });
});
