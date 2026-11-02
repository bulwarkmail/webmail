import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SEARCH_FILTERS } from '../lib/jmap/search-utils';
import { normalizeSavedSearch, useSavedSearches } from './saved-searches';
import { SavedSearchMenu } from './saved-search-menu';
const entry = {id:'one',scope:'account-a',name:'Invoices',query:'invoice',mailboxId:'inbox',filters:{...DEFAULT_SEARCH_FILTERS,hasAttachment:true}};
beforeEach(() => useSavedSearches.setState({entries:[]}));
describe('saved searches', () => {
  it('copies filters and preserves explicit false values', () => {
    const saved = normalizeSavedSearch({...entry,filters:{...entry.filters,isUnread:false}})!;
    expect(saved.filters.isUnread).toBe(false);
    expect(saved.filters).not.toBe(entry.filters);
  });
  it('rejects empty, malformed and plugin searches', () => {
    expect(normalizeSavedSearch({...entry,query:'',filters:DEFAULT_SEARCH_FILTERS})).toBeNull();
    expect(normalizeSavedSearch({...entry,filters:{}})).toBeNull();
    expect(normalizeSavedSearch({...entry,filters:{...entry.filters,pluginFilter:{pluginId:'x',label:'X',filter:{text:'x'}}}})).toBeNull();
  });
  it('caps entries per account and isolates deletion', () => {
    for (let n=0;n<20;n++) expect(useSavedSearches.getState().save({...entry,id:String(n)})).toBe(true);
    expect(useSavedSearches.getState().save({...entry,id:'overflow'})).toBe(false);
    expect(useSavedSearches.getState().save({...entry,scope:'account-b',id:'0'})).toBe(true);
    useSavedSearches.getState().remove('account-a','0');
    expect(useSavedSearches.getState().entries.filter(e=>e.scope==='account-b')).toHaveLength(1);
  });
  it('shows only this account and restores the stored query, filters and scope', () => {
    useSavedSearches.setState({entries:[entry,{...entry,id:'other',scope:'account-b',name:'Other account'}]});
    const onApply = vi.fn();
    render(<SavedSearchMenu scope="account-a" query="new query" filters={DEFAULT_SEARCH_FILTERS} mailboxId="" mailboxes={[{id:'inbox',name:'Inbox'}]} onApply={onApply} />);
    fireEvent.click(screen.getByLabelText('Saved searches',{selector:'summary'}));
    expect(screen.queryByText('Other account')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Open saved search Invoices'}));
    expect(onApply).toHaveBeenCalledWith(entry);
  });
  it('does not silently broaden a search whose folder is gone', () => {
    useSavedSearches.setState({entries:[entry]});
    render(<SavedSearchMenu scope="account-a" query="" filters={DEFAULT_SEARCH_FILTERS} mailboxId="" mailboxes={[]} onApply={()=>{}} />);
    fireEvent.click(screen.getByLabelText('Saved searches',{selector:'summary'}));
    expect(screen.getByRole('button',{name:'Open saved search Invoices'})).toBeDisabled();
  });
});
