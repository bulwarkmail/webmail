import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { SearchChips } from '../search-chips';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';

vi.mock('next-intl',()=>({useTranslations:()=> (key:string,params?:Record<string,unknown>)=>params ? `${key} ${JSON.stringify(params)}` : key}));

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

    const chip = screen.getByText('From Alice').parentElement!;
    fireEvent.click(chip.querySelector('button')!);
    expect(onRemoveFilter).toHaveBeenCalledWith('pluginFilter');
  });
});

it('names negative filters and exposes the full truncated search value', () => {
  render(<SearchChips filters={{...DEFAULT_SEARCH_FILTERS,from:'a-very-long-address@example.com',hasAttachment:false,isUnread:false,isStarred:false}} onRemoveFilter={()=>{}} onClearAll={()=>{}}/>);
  expect(screen.getByTitle('a-very-long-address@example.com')).toBeInTheDocument();
  const buttons=screen.getAllByRole('button').filter(button=>button.hasAttribute('data-filter-remove'));
  expect(buttons).toHaveLength(4);
  for (const button of buttons) expect(button.getAttribute('aria-label')).toContain('remove_filter');
  expect(buttons.find(button=>button.getAttribute('aria-label')?.includes('has_attachment'))).toHaveAttribute('aria-label',expect.stringContaining('no'));
});

it('keeps focus on a remaining criterion, then returns to the list when the last is removed', () => {
  const fallback=vi.fn();
  function Host(){
    const [filters,setFilters]=React.useState({...DEFAULT_SEARCH_FILTERS,from:'alice@example.com',subject:'Budget'});
    return <SearchChips filters={filters} onRemoveFilter={key=>setFilters(previous=>({...previous,[key]:DEFAULT_SEARCH_FILTERS[key]}))} onClearAll={()=>setFilters(DEFAULT_SEARCH_FILTERS)} onEmptyFocus={fallback}/>;
  }
  render(<Host/>);
  fireEvent.click(document.querySelector('[data-filter-remove]')!);
  const remaining=document.querySelector('[data-filter-remove]')!;
  expect(remaining).toHaveFocus();
  fireEvent.click(remaining);
  expect(fallback).toHaveBeenCalledOnce();
});
