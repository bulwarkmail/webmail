import React, {createRef, useState} from 'react';
import {fireEvent, render, screen, within} from '@testing-library/react';
import {expect, it, vi} from 'vitest';
import {FilesHeader, type Crumb, type ViewMode} from '../files-header';

const crumbs: Crumb[] = ['My files','Projects','Clients','Design','Launch assets'].map((name,index)=>({id:index ? String(index) : null,name,path:index ? `/folder-${index}/` : '/'}));
function props() {
  return {crumbs,onNavigateCrumb:vi.fn(),onDropOnCrumb:vi.fn(),searchQuery:'',onSearchChange:vi.fn(),searchInputRef:createRef<HTMLInputElement>(),sortKey:'name' as const,sortDir:'asc' as const,onSortChange:vi.fn(),viewMode:'list' as ViewMode,onViewModeChange:vi.fn(),showDetails:false,onToggleDetails:vi.fn(),clipboardCount:0,onPaste:vi.fn(),onRefresh:vi.fn(),isLoading:false,compact:true,selection:null};
}

it('keeps the current folder visible and exposes every hidden parent in a named path menu', () => {
  const callbacks=props();
  render(<FilesHeader {...callbacks}/>);
  expect(screen.getByRole('button',{name:'Launch assets'})).toHaveAttribute('aria-current','page');
  expect(screen.queryByRole('button',{name:'Projects'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'show_path'}));
  const menu=screen.getByRole('menu',{name:'show_path'});
  expect(within(menu).getAllByRole('menuitem')).toHaveLength(3);
  fireEvent.click(within(menu).getByRole('menuitem',{name:'Clients'}));
  expect(callbacks.onNavigateCrumb).toHaveBeenCalledWith(crumbs[2]);
  expect(callbacks.onDropOnCrumb).not.toHaveBeenCalled();
});

it('keeps account context available once on a compact header', () => {
  const accountRoot=vi.fn();
  render(<FilesHeader {...props()} accountLabel="Operations account" onNavigateAccountRoot={accountRoot}/>);
  expect(screen.getAllByRole('button',{name:'Operations account'})).toHaveLength(1);
  fireEvent.click(screen.getByRole('button',{name:'Operations account'}));
  expect(accountRoot).toHaveBeenCalledOnce();
});

it('uses a single radio Tab stop with LTR and RTL arrow navigation', () => {
  const callbacks=props();
  function Host(){const[mode,setMode]=useState<ViewMode>('list');return <FilesHeader {...callbacks} viewMode={mode} onViewModeChange={value=>{callbacks.onViewModeChange(value);setMode(value);}}/>;}
  render(<Host/>);
  const list=screen.getByRole('radio',{name:'list_view'});
  const grid=screen.getByRole('radio',{name:'grid_view'});
  expect(list).toHaveAttribute('tabindex','0');
  expect(grid).toHaveAttribute('tabindex','-1');
  fireEvent.keyDown(list,{key:'ArrowRight'});
  expect(grid).toHaveFocus();expect(grid).toHaveAttribute('aria-checked','true');
  fireEvent.keyDown(grid,{key:'Home'});
  expect(list).toHaveFocus();
  screen.getByRole('radiogroup').style.direction='rtl';
  fireEvent.keyDown(list,{key:'ArrowLeft'});
  expect(grid).toHaveFocus();
  expect(callbacks.onNavigateCrumb).not.toHaveBeenCalled();
});

it('returns focus to compact search after Escape or clear', () => {
  const callbacks=props();
  function Host(){const[query,setQuery]=useState('');return <FilesHeader {...callbacks} searchQuery={query} onSearchChange={setQuery}/>;}
  render(<Host/>);
  fireEvent.click(screen.getByRole('button',{name:'search_placeholder'}));
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'Atlas'}});
  fireEvent.keyDown(screen.getByRole('searchbox'),{key:'Escape'});
  expect(screen.getByRole('button',{name:'search_placeholder'})).toHaveFocus();
  fireEvent.click(screen.getByRole('button',{name:'search_placeholder'}));
  fireEvent.click(screen.getByRole('button',{name:'clear_search'}));
  expect(screen.getByRole('button',{name:'search_placeholder'})).toHaveFocus();
});

it('clears desktop search without dropping focus or navigating away', () => {
  render(<FilesHeader {...props()} compact={false}/>);
  fireEvent.keyDown(screen.getByRole('searchbox'),{key:'Escape'});
  expect(screen.getByRole('searchbox')).toHaveFocus();
});
