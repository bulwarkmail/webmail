import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { WorkspaceToolbar } from './workspace-toolbar';
import { useSettingsStore } from '../stores/settings-store';
vi.mock('./workspace-views',()=>({acquireWorkspaceViews:()=>()=>{}}));

it('offers every reading layout in Customize and updates native preferences',()=>{
  render(<WorkspaceToolbar title="Inbox" onShortcuts={()=>{}} />);
  const trigger=screen.getByLabelText('Inbox view rules',{selector:'summary'});
  fireEvent.click(trigger);
  // jsdom does not implement the summary's default disclosure action.
  trigger.closest('details')!.setAttribute('open','');
  fireEvent.click(screen.getByRole('button',{name:'Below reading layout'}));
  expect(useSettingsStore.getState().mailLayout).toBe('horizontal');
  fireEvent.click(screen.getByRole('button',{name:'Side reading layout'}));
  expect(useSettingsStore.getState().mailLayout).toBe('split');
  fireEvent.click(screen.getByRole('button',{name:'Focus reading layout'}));
  expect(useSettingsStore.getState().mailLayout).toBe('focus');
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

it('offers all native spacing levels and a separate preview preference',()=>{
  useSettingsStore.setState({density:'regular', showPreview:true});
  render(<WorkspaceToolbar title="Inbox" onShortcuts={()=>{}} />);
  screen.getByLabelText('Inbox view rules',{selector:'summary'}).closest('details')!.setAttribute('open','');
  for (const [label,value] of [['Dense','extra-compact'],['Compact','compact'],['Relaxed','comfortable'],['Regular','regular']] as const) {
    const button=screen.getByRole('button',{name:`${label} message spacing`});
    fireEvent.click(button);
    expect(useSettingsStore.getState().density).toBe(value);
    expect(button).toHaveAttribute('aria-pressed','true');
    expect(useSettingsStore.getState().showPreview).toBe(true);
  }
  fireEvent.click(screen.getByRole('checkbox',{name:'Message previews'}));
  expect(useSettingsStore.getState().showPreview).toBe(false);
  expect(useSettingsStore.getState().density).toBe('regular');
});
