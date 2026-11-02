import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SEARCH_FILTERS } from '../lib/jmap/search-utils';
import { normalizeSavedSearch, useSavedSearches, savedSearchDescription, matchesSavedSearch } from './saved-searches';
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


it('renames only the intended account entry and preserves its search criteria',()=>{
  useSavedSearches.setState({entries:[entry,{...entry,scope:'account-b'}]});
  expect(useSavedSearches.getState().update('account-a','one',{name:'Receipts'})).toBe(true);
  expect(useSavedSearches.getState().entries[0]).toEqual({...entry,name:'Receipts'});
  expect(useSavedSearches.getState().entries[1]).toEqual({...entry,scope:'account-b'});
  expect(useSavedSearches.getState().update('missing','one',{name:'Wrong'})).toBe(false);
  expect(useSavedSearches.getState().update('account-a','one',{name:' '})).toBe(false);
  expect(useSavedSearches.getState().save(entry)).toBe(false);
});

it('describes negative filters and requires exact scope and filters for the current indicator',()=>{
  const negative = {...entry,filters:{...entry.filters,isUnread:false,isStarred:false,hasAttachment:false}};
  expect(savedSearchDescription(negative)).toContain('Read · Not starred');
  expect(savedSearchDescription(negative)).toContain('No attachments');
  expect(matchesSavedSearch(negative,' invoice ',negative.filters,'inbox')).toBe(true);
  expect(matchesSavedSearch(negative,'invoice',negative.filters,'')).toBe(false);
  expect(matchesSavedSearch(negative,'invoice',{...negative.filters,isUnread:null},'inbox')).toBe(false);
});

it('edits a name without replacing filters unless explicitly selected, and can undo removal',()=>{
  useSavedSearches.setState({entries:[entry]});
  render(<SavedSearchMenu scope="account-a" query="new query" filters={DEFAULT_SEARCH_FILTERS} mailboxId="" mailboxes={[{id:'inbox',name:'Inbox'}]} onApply={()=>{}} />);
  fireEvent.click(screen.getByLabelText('Saved searches',{selector:'summary'}));
  fireEvent.click(screen.getByRole('button',{name:'Edit saved search Invoices'}));
  fireEvent.change(screen.getByLabelText('Search name'),{target:{value:'Receipts'}});
  fireEvent.click(screen.getByRole('button',{name:'Save changes'}));
  expect(useSavedSearches.getState().entries[0]).toEqual({...entry,name:'Receipts'});
  expect(document.activeElement).toBe(screen.getByRole('button',{name:'Edit saved search Receipts'}));
  fireEvent.click(screen.getByRole('button',{name:'Remove saved search Receipts'}));
  expect(useSavedSearches.getState().entries).toHaveLength(0);
  fireEvent.click(screen.getByRole('button',{name:'Undo removal'}));
  expect(useSavedSearches.getState().entries[0]).toEqual({...entry,name:'Receipts'});
});

it('replaces saved criteria only when requested and quick searches use the current folder scope',()=>{
  const onApply = vi.fn();
  useSavedSearches.setState({entries:[entry]});
  render(<SavedSearchMenu scope="account-a" query="review" filters={{...DEFAULT_SEARCH_FILTERS,isUnread:true}} mailboxId="inbox" mailboxes={[{id:'inbox',name:'Inbox'}]} onApply={onApply} />);
  fireEvent.click(screen.getByLabelText('Saved searches',{selector:'summary'}));
  fireEvent.click(screen.getByRole('button',{name:'Edit saved search Invoices'}));
  fireEvent.click(screen.getByLabelText('Use the current query, filters and folder'));
  fireEvent.click(screen.getByRole('button',{name:'Save changes'}));
  expect(useSavedSearches.getState().entries[0].query).toBe('review');
  expect(useSavedSearches.getState().entries[0].filters.hasAttachment).toBeNull();
  expect(screen.getByRole('button',{name:'Open saved search Invoices'})).toHaveAttribute('aria-current','true');
  fireEvent.click(screen.getByRole('button',{name:'Attachments'}));
  expect(onApply.mock.calls[0][0]).toMatchObject({query:'',mailboxId:'inbox',filters:{hasAttachment:true,isUnread:null}});
});


it('finds saved searches by criteria and folder without altering stored entries',()=>{
  useSavedSearches.setState({entries:[entry,{...entry,id:'two',name:'Team notes',query:'planning',mailboxId:'archive',filters:{...DEFAULT_SEARCH_FILTERS}}]});
  render(<SavedSearchMenu scope="account-a" query="" filters={DEFAULT_SEARCH_FILTERS} mailboxId="" mailboxes={[{id:'inbox',name:'Inbox'},{id:'archive',name:'Archive'}]} onApply={()=>{}} />);
  fireEvent.click(screen.getByLabelText('Saved searches',{selector:'summary'}));
  fireEvent.change(screen.getByRole('searchbox',{name:'Find saved searches'}),{target:{value:'attachments'}});
  expect(screen.getByRole('button',{name:'Open saved search Invoices'})).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Open saved search Team notes'})).toBeNull();
  fireEvent.change(screen.getByRole('searchbox',{name:'Find saved searches'}),{target:{value:'ARCHIVE'}});
  expect(screen.getByRole('button',{name:'Open saved search Team notes'})).toBeInTheDocument();
  fireEvent.change(screen.getByRole('searchbox',{name:'Find saved searches'}),{target:{value:'no match'}});
  fireEvent.click(screen.getByRole('button',{name:'Show all saved searches'}));
  expect(screen.getByRole('button',{name:'Open saved search Invoices'})).toBeInTheDocument();
  expect(useSavedSearches.getState().entries).toHaveLength(2);
  expect(document.activeElement).toBe(screen.getByRole('searchbox',{name:'Find saved searches'}));
});
