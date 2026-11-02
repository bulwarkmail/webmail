import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_SEARCH_FILTERS } from '../lib/jmap/search-utils';
import { useSavedSearches, type SavedSearch } from './saved-searches';
import { SavedSearchSidebar } from './saved-search-sidebar';

const entry = (id:string, scope='account-a:'):SavedSearch => ({id, scope, name:`View ${id}`, query:id, mailboxId:'', filters:{...DEFAULT_SEARCH_FILTERS}});
const props = {scope:'account-a:',collapsed:false,query:'',filters:{...DEFAULT_SEARCH_FILTERS},mailboxId:'',mailboxes:[],onApply:vi.fn()};
beforeEach(()=>{useSavedSearches.setState({entries:[]});vi.clearAllMocks();});

it('keeps other accounts out of navigation and disables searches for missing folders',()=>{
  useSavedSearches.setState({entries:[entry('mine'),entry('private','account-b:'),{...entry('missing'),mailboxId:'deleted'}]});
  render(<SavedSearchSidebar {...props} />);
  expect(screen.queryByRole('button',{name:'View private'})).toBeNull();
  expect(screen.getByRole('button',{name:'View missing, folder unavailable'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'View missing, folder unavailable'}));
  expect(props.onApply).not.toHaveBeenCalled();
});

it('opens the exact saved criteria and identifies the active view',()=>{
  const saved={...entry('reports'),mailboxId:'inbox',filters:{...DEFAULT_SEARCH_FILTERS,hasAttachment:false}};
  useSavedSearches.setState({entries:[saved]});
  render(<SavedSearchSidebar {...props} query="reports" mailboxId="inbox" filters={saved.filters} mailboxes={[{id:'inbox',name:'Inbox'}]} />);
  const button=screen.getByRole('button',{name:'View reports'});
  expect(button).toHaveAttribute('aria-current','page');
  fireEvent.click(button);
  expect(props.onApply).toHaveBeenCalledWith(saved);
});

it('reveals additional views and lets the section collapse',()=>{
  useSavedSearches.setState({entries:Array.from({length:7},(_,i)=>entry(String(i)))});
  render(<SavedSearchSidebar {...props} />);
  expect(screen.queryByRole('button',{name:'View 6'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Show all 7 views'}));
  expect(screen.getByRole('button',{name:'View 6'})).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:'Saved views (7)'}));
  expect(screen.queryByRole('button',{name:'View 0'})).toBeNull();
});

it('keeps a collapsed sidebar free of unreachable saved-view controls',()=>{
  useSavedSearches.setState({entries:[entry('reports')]});
  const {container}=render(<SavedSearchSidebar {...props} collapsed />);
  expect(container).toBeEmptyDOMElement();
});
