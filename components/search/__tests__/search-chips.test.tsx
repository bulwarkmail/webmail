import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { SearchChips } from '../search-chips';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';

describe('SearchChips', () => {
  it('shows a plugin search as a removable chip (#1024)', () => {
    const onRemoveFilter = vi.fn();
    render(
      <SearchChips
        filters={{
          ...DEFAULT_SEARCH_FILTERS,
          pluginFilter: { pluginId: 'related', label: 'From Alice', filter: { from: 'alice@example.com' } },
        }}
        onRemoveFilter={onRemoveFilter}
        onClearAll={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /remove_filter/ }));
    expect(onRemoveFilter).toHaveBeenCalledWith('pluginFilter');
  });
});
