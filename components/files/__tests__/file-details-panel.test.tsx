import {useState} from 'react';
import {render,screen,fireEvent,within} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import {FileDetailsPanel} from '../file-details-panel';
import {PreviewShell} from '../preview-shell';
import type {FileResource} from '@/stores/file-store';
const file:FileResource={id:'notes',name:'launch-notes.txt',serverName:'launch-notes.txt',isDirectory:false,contentType:'text/plain',contentLength:120,lastModified:'2026-11-01T10:00:00Z',blobId:'blob',parentId:null};
function props(){return {resource:file,selection:[file],folderName:'Documents',folderItems:[file],path:'/Documents/launch-notes.txt',isStarred:false,canShare:true,canPreview:true,canEdit:false,iconOptions:{showIcons:true,coloredIcons:false,showThumbnails:false},getImageUrl:vi.fn(async()=>''),onClose:vi.fn(),onOpen:vi.fn(),onEdit:vi.fn(),onDownload:vi.fn(),onShare:vi.fn(),onToggleStar:vi.fn()};}

it('contains overlay focus and returns to its opener after Escape',()=>{
  const callbacks=props();
  function Host(){const[open,setOpen]=useState(false);return <><button onClick={()=>setOpen(true)}>Open details</button>{open&&<FileDetailsPanel {...callbacks} overlay onClose={()=>{callbacks.onClose();setOpen(false);}}/>}</>;}
  render(<Host/>);
  const opener=screen.getByRole('button',{name:'Open details'});opener.focus();fireEvent.click(opener);
  const panel=screen.getByRole('dialog',{name:'details'});
  expect(panel).toHaveAttribute('aria-modal','true');
  expect(within(panel).getByRole('region',{name:'details'})).toHaveAttribute('tabindex','0');
  const close=within(panel).getByRole('button',{name:'close_details'});
  expect(close).toHaveFocus();
  fireEvent.keyDown(close,{key:'Tab',shiftKey:true});
  const share=within(panel).getByRole('button',{name:'share'});expect(share).toHaveFocus();
  fireEvent.keyDown(share,{key:'Tab'});expect(close).toHaveFocus();
  fireEvent.keyDown(close,{key:'Escape'});
  expect(screen.queryByRole('dialog')).toBeNull();expect(opener).toHaveFocus();
  expect(callbacks.onClose).toHaveBeenCalledOnce();expect(callbacks.onDownload).not.toHaveBeenCalled();
});

it('leaves desktop focus alone until the panel is used, then restores it on close',()=>{
  const callbacks=props();
  function Host(){const[open,setOpen]=useState(false);return <><button onClick={()=>setOpen(true)}>Open details</button>{open&&<FileDetailsPanel {...callbacks} onClose={()=>setOpen(false)}/>}</>;}
  render(<Host/>);
  const opener=screen.getByRole('button',{name:'Open details'});opener.focus();fireEvent.click(opener);expect(opener).toHaveFocus();
  const panel=screen.getByRole('complementary',{name:'details'});expect(panel).not.toHaveAttribute('aria-modal');
  const close=within(panel).getByRole('button',{name:'close_details'});close.focus();
  fireEvent.keyDown(close,{key:'Escape'});expect(opener).toHaveFocus();
});

it('keeps native action callbacks in the named footer',()=>{
  const callbacks=props();render(<FileDetailsPanel {...callbacks}/>);
  const actions=within(screen.getByRole('group',{name:'toolbar'}));
  fireEvent.click(actions.getByRole('button',{name:'preview'}));expect(callbacks.onOpen).toHaveBeenCalledOnce();
  fireEvent.click(actions.getByRole('button',{name:'download'}));expect(callbacks.onDownload).toHaveBeenCalledOnce();
  fireEvent.click(actions.getByRole('button',{name:'share'}));expect(callbacks.onShare).toHaveBeenCalledOnce();
  expect(callbacks.onEdit).not.toHaveBeenCalled();
});

it('respects device and symlink download restrictions',()=>{
  const callbacks=props();const{rerender}=render(<FileDetailsPanel {...callbacks} onDownload={undefined}/>);
  expect(screen.queryByRole('button',{name:'download'})).toBeNull();
  rerender(<FileDetailsPanel {...callbacks} resource={{...file,isSymlink:true}} canPreview={false} canEdit={false}/>);
  expect(screen.queryByRole('button',{name:'download'})).toBeNull();expect(screen.queryByRole('button',{name:'preview'})).toBeNull();
});

it('keeps edit precedence and directory favorite state',()=>{
  const callbacks=props();const{rerender}=render(<FileDetailsPanel {...callbacks} canEdit/>);
  fireEvent.click(screen.getByRole('button',{name:'office_edit'}));expect(callbacks.onEdit).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button',{name:'preview'})).toBeNull();
  rerender(<FileDetailsPanel {...callbacks} resource={{...file,isDirectory:true}} isStarred/>);
  const star=screen.getByRole('button',{name:'unstar'});expect(star).toHaveAttribute('aria-pressed','true');
  fireEvent.click(star);expect(callbacks.onToggleStar).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button',{name:'download'})).toBeNull();
});


it('closes a nested preview before its details overlay and restores the action focus',()=>{
  const callbacks=props();
  function Host(){const[preview,setPreview]=useState(false);return <><FileDetailsPanel {...callbacks} overlay onOpen={()=>setPreview(true)}/>{preview&&<PreviewShell name="notes.txt" onClose={()=>setPreview(false)}><p>Preview fixture</p></PreviewShell>}</>;}
  render(<Host/>);
  const previewButton=screen.getByRole('button',{name:'preview'});previewButton.focus();fireEvent.click(previewButton);
  expect(screen.getByRole('dialog',{name:'notes.txt'})).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole('button',{name:'close_preview'}),{key:'Escape'});
  expect(screen.queryByRole('dialog',{name:'notes.txt'})).toBeNull();
  expect(screen.getByRole('dialog',{name:'details'})).toBeInTheDocument();
  expect(previewButton).toHaveFocus();expect(callbacks.onClose).not.toHaveBeenCalled();
});
