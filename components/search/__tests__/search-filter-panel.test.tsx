import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_SEARCH_FILTERS, type SearchFilters } from '@/lib/jmap/search-utils';
import { SearchFilterPanel, daysAgo } from '../search-filter-panel';

function renderPanel(filters: Partial<SearchFilters> = {}) {
  const onChange = vi.fn();
  const onClearAll = vi.fn();
  const onDone = vi.fn();
  render(
    <SearchFilterPanel
      filters={{ ...DEFAULT_SEARCH_FILTERS, ...filters }}
      onChange={onChange}
      onClearAll={onClearAll}
      onDone={onDone}
    />,
  );
  return { onChange, onClearAll, onDone };
}

describe('SearchFilterPanel', () => {
  it('turns Unread and Read on and off, without a hidden third state', () => {
    const { onChange } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'unread' }));
    expect(onChange).toHaveBeenLastCalledWith({ isUnread: true }, 'now');
    fireEvent.click(screen.getByRole('button', { name: 'read' }));
    expect(onChange).toHaveBeenLastCalledWith({ isUnread: false }, 'now');
  });

  it('marks an active chip as pressed and turns it off on the next click', () => {
    const { onChange } = renderPanel({ isStarred: true });
    const starred = screen.getByRole('button', { name: 'starred' });
    expect(starred.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(starred);
    expect(onChange).toHaveBeenLastCalledWith({ isStarred: null }, 'now');
  });

  it('shows every field at once, and debounces the text ones', () => {
    const { onChange } = renderPanel();
    fireEvent.change(screen.getByLabelText('from'), { target: { value: 'alice' } });
    expect(onChange).toHaveBeenLastCalledWith({ from: 'alice' }, 'debounced');
    expect(screen.getByLabelText('has_words')).toBeTruthy();
    expect(screen.getByLabelText('date_within')).toBeTruthy();
  });

  it('turns a date range pick into an after date', () => {
    const { onChange } = renderPanel();
    fireEvent.change(screen.getByLabelText('date_within'), { target: { value: 'past_week' } });
    expect(onChange).toHaveBeenLastCalledWith({ dateAfter: daysAgo(7), dateBefore: '' }, 'now');
  });

  it('recognises its own range and offers the two dates for anything else', () => {
    renderPanel({ dateAfter: daysAgo(30) });
    expect((screen.getByLabelText('date_within') as HTMLSelectElement).value).toBe('past_month');
    expect(screen.queryByLabelText('date_after')).toBeNull();
  });

  it('opens the custom range with both dates', () => {
    renderPanel({ dateAfter: '2026-01-01', dateBefore: '2026-02-01' });
    expect((screen.getByLabelText('date_within') as HTMLSelectElement).value).toBe('custom');
    expect((screen.getByLabelText('date_after') as HTMLInputElement).value).toBe('2026-01-01');
  });

  it('shows the custom fields as soon as Custom is picked, before any date is set', () => {
    const { onChange } = renderPanel();
    fireEvent.change(screen.getByLabelText('date_within'), { target: { value: 'custom' } });
    expect(screen.getByLabelText('date_after')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('turns a size pick into a lower bound in KB', () => {
    const { onChange } = renderPanel();
    fireEvent.change(screen.getByLabelText('size'), { target: { value: 'mb5' } });
    expect(onChange).toHaveBeenLastCalledWith({ minSizeKb: '5120', maxSizeKb: '' }, 'now');
  });

  it('offers Clear all only when a filter is set', () => {
    renderPanel();
    expect(screen.queryByRole('button', { name: /clear_all/ })).toBeNull();
  });

  it('clears everything and closes on Search or Enter', () => {
    const { onClearAll, onDone } = renderPanel({ subject: 'invoice' });
    fireEvent.click(screen.getByRole('button', { name: /clear_all/ }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
    fireEvent.submit(screen.getByLabelText('subject').closest('form')!);
    fireEvent.click(screen.getByRole('button', { name: 'search' }));
    expect(onDone).toHaveBeenCalledTimes(2);
  });
});
