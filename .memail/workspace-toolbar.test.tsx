import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { WorkspaceToolbar } from './workspace-toolbar';
vi.mock('./workspace-views',()=>({acquireWorkspaceViews:()=>()=>{}}));

it('identifies search scope and exposes a clear action without changing layout',()=>{
  const clear = vi.fn();
  render(<WorkspaceToolbar title="Search results" context="All folders" onClearSearch={clear} onShortcuts={()=>{}} />);
  expect(screen.getByRole('heading',{name:'Search results'})).toBeInTheDocument();
  expect(screen.getByText('All folders')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Clear search and filters'}));
  expect(clear).toHaveBeenCalledOnce();
});

it('keeps ordinary folder headings and omits the clear action outside search',()=>{
  render(<WorkspaceToolbar title="Inbox" onShortcuts={()=>{}} />);
  expect(screen.getByRole('heading',{name:'Inbox'})).toBeInTheDocument();
  expect(screen.getByText('Your workspace')).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Clear search and filters'})).toBeNull();
});
