import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { WorkspaceToolbar } from './workspace-toolbar';
import { useSettingsStore } from '../stores/settings-store';
import { useUIStore } from '../stores/ui-store';
vi.mock('./workspace-views',()=>({acquireWorkspaceViews:()=>()=>{}}));

it('applies reading and triage presets through native layout and width settings',()=>{
  render(<WorkspaceToolbar title="Inbox" onShortcuts={()=>{}} />);
  fireEvent.click(screen.getByRole('button',{name:'Read and reply layout'}));
  expect(useSettingsStore.getState().mailLayout).toBe('split');
  expect(useSettingsStore.getState().density).toBe('compact');
  expect(useUIStore.getState().emailListWidth).toBe(400);
  expect(useUIStore.getState().sidebarWidth).toBe(220);
  fireEvent.click(screen.getByRole('button',{name:'Triage layout'}));
  expect(useSettingsStore.getState().mailLayout).toBe('focus');
  expect(useSettingsStore.getState().readingWidth).toBe('comfortable');
});

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
