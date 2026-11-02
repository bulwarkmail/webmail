'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Bookmark, Plus, Trash2, Search, Pencil, Check, X } from '../components/icons';
import { DEFAULT_SEARCH_FILTERS, isFilterEmpty, type SearchFilters } from '../lib/jmap/search-utils';
import { MAX_SAVED_SEARCHES, useSavedSearches, type SavedSearch, savedSearchDescription, matchesSavedSearch } from './saved-searches';

export function SavedSearchMenu({scope,query,filters,mailboxId,mailboxes,onApply}: {
  scope:string; query:string; filters:SearchFilters; mailboxId:string;
  mailboxes: {id:string;name:string}[]; onApply:(entry:SavedSearch) => void;
}) {
  const entries = useSavedSearches(s => s.entries).filter(e => e.scope === scope);
  const [name,setName] = useState('');
  const [find,setFind] = useState('');
  const finder = useRef<HTMLInputElement>(null);
  const visibleEntries = entries.filter(entry=>[entry.name,savedSearchDescription(entry),entry.mailboxId ? mailboxes.find(mailbox=>mailbox.id===entry.mailboxId)?.name ?? '' : 'All folders'].join(' ').toLocaleLowerCase().includes(find.trim().toLocaleLowerCase()));
  const [status,setStatus] = useState('');
  const [editing,setEditing] = useState<string | null>(null);
  const [editName,setEditName] = useState('');
  const [replaceCriteria,setReplaceCriteria] = useState(false);
  const [removed,setRemoved] = useState<SavedSearch | null>(null);
  const undo = useRef<HTMLButtonElement>(null);
  useEffect(()=>{ if (removed?.scope===scope) undo.current?.focus(); },[removed,scope]);
  const menu = useRef<HTMLDetailsElement>(null);
  const lastEditing = useRef<string | null>(null);
  useEffect(()=>{
    if(!editing && lastEditing.current && menu.current?.open) {
      Array.from(menu.current.querySelectorAll<HTMLButtonElement>('[data-search-edit]')).find(button=>button.dataset.searchEdit===lastEditing.current)?.focus();
    }
    lastEditing.current = editing;
  },[editing]);
  const inputId = useId();
  const hasSearch = !filters.pluginFilter && (!!query.trim() || !isFilterEmpty(filters));
  const canSave = hasSearch && entries.length < MAX_SAVED_SEARCHES;
  useEffect(() => {
    const dismiss = (event:PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) menu.current?.removeAttribute('open');
    };
    document.addEventListener('pointerdown',dismiss);
    return () => document.removeEventListener('pointerdown',dismiss);
  },[]);
  return <details ref={menu} data-keyboard-layer onBlur={event=>{
    if(event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) menu.current?.removeAttribute('open');
  }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if(editing) {setEditing(null);menu.current?.querySelector('summary')?.focus();} else { menu.current?.removeAttribute('open'); menu.current?.querySelector('summary')?.focus(); } }
  }}>
    <summary aria-label="Saved searches" title="Saved searches" className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md px-3 text-sm text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
      <Bookmark className="size-4" aria-hidden="true" /><span className="hidden xl:inline">Saved</span>
    </summary>
    <section aria-label="Saved searches" className="absolute end-3 top-full z-50 mt-2 w-96 max-h-[min(36rem,75dvh)] overflow-y-auto max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg max-sm:fixed max-sm:inset-x-3 max-sm:bottom-[calc(4.5rem+env(safe-area-inset-bottom))] max-sm:top-auto max-sm:mt-0 max-sm:w-auto max-sm:max-w-none max-sm:max-h-[calc(100dvh-6rem)]">
      <div className="flex items-center justify-between"><h3 className="font-semibold">Saved searches</h3><div className="flex items-center gap-2"><span className="text-xs tabular-nums text-muted-foreground">{entries.length} / {MAX_SAVED_SEARCHES}</span><button type="button" aria-label="Close saved searches" className="grid min-h-11 min-w-11 place-items-center rounded-md text-muted-foreground hover:bg-accent" onClick={()=>{menu.current?.removeAttribute('open');menu.current?.querySelector('summary')?.focus();}}><X className="size-4" aria-hidden="true" /></button></div></div>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">Saved on this device for this account. Each search keeps its filters and folder scope.</p>
      <div className="mt-3 border-b border-border pb-3">
        <p className="mb-2 text-xs text-muted-foreground">Quick searches · {mailboxId ? mailboxes.find(m=>m.id===mailboxId)?.name ?? 'Selected folder' : 'All folders'}</p>
        <div role="group" aria-label="Quick searches" className="flex flex-wrap gap-2">
          {([{name:'Unread',key:'isUnread'},{name:'Starred',key:'isStarred'},{name:'Attachments',key:'hasAttachment'}] as const).map(preset=><button key={preset.key} type="button" className="min-h-10 rounded-md border border-border px-3 text-xs hover:bg-accent" onClick={()=>{
            onApply({id:`quick-${preset.key}`,scope,name:preset.name,query:'',mailboxId,filters:{...DEFAULT_SEARCH_FILTERS,[preset.key]:true}});
            menu.current?.removeAttribute('open'); menu.current?.querySelector('summary')?.focus();
          }}>{preset.name}</button>)}
        </div>
      </div>
      {!!entries.length && <div className="relative mt-3">
        <Search className="pointer-events-none absolute start-3 top-3.5 size-4 text-muted-foreground" aria-hidden="true" />
        <input ref={finder} type="search" aria-label="Find saved searches" placeholder="Find by name, filters or folder" value={find}
          onChange={event=>setFind(event.target.value)} className="min-h-11 w-full rounded-md border border-input bg-background ps-9 pe-3 text-sm" />
      </div>}
      <ul className="my-3 space-y-2">
        {visibleEntries.map(entry => {
          const missingFolder = !!entry.mailboxId && !mailboxes.some(m => m.id === entry.mailboxId);
          const folder = entry.mailboxId ? mailboxes.find(m => m.id === entry.mailboxId)?.name : 'All folders';
          const current = matchesSavedSearch(entry,query,filters,mailboxId);
          const description = savedSearchDescription(entry);
          return <li key={entry.id} className={`rounded-lg border ${current ? 'border-primary/30 bg-accent/40' : 'border-border'}`}>
            {editing === entry.id ? <form className="space-y-3 p-3" onSubmit={event=>{
              event.preventDefault();
              if(!editName.trim() || (replaceCriteria && !hasSearch)) return;
              const changes = {name:editName,...(replaceCriteria ? {query,filters,mailboxId} : {})};
              if(useSavedSearches.getState().update(scope,entry.id,changes)) {setEditing(null);setStatus('Saved search updated.');}
              else setStatus('This search could not be updated.');
            }}>
              <label className="block text-xs font-medium" htmlFor={`${inputId}-edit`}>Search name</label>
              <input id={`${inputId}-edit`} value={editName} maxLength={80} onChange={event=>setEditName(event.target.value)} className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm" autoFocus />
              <label className="flex items-start gap-2 text-xs leading-5"><input type="checkbox" checked={replaceCriteria} disabled={!hasSearch} onChange={event=>setReplaceCriteria(event.target.checked)} className="mt-1 accent-primary" />Use the current query, filters and folder</label>
              {replaceCriteria && <p className="break-words text-xs text-muted-foreground">{savedSearchDescription({query,filters})}</p>}
              <div className="flex justify-end gap-2"><button type="button" onClick={()=>setEditing(null)} className="min-h-10 rounded-md px-3 text-sm hover:bg-accent">Cancel</button><button type="submit" disabled={!editName.trim() || (replaceCriteria && !hasSearch)} className="min-h-10 rounded-md bg-primary px-3 text-sm text-primary-foreground disabled:opacity-40">Save changes</button></div>
            </form> : <>
              <div className="flex items-start gap-1 p-1">
                <button type="button" aria-label={`Open saved search ${entry.name}`} aria-current={current ? 'true' : undefined} disabled={missingFolder} onClick={() => { onApply(entry); menu.current?.removeAttribute('open'); menu.current?.querySelector('summary')?.focus(); }} className="flex min-h-12 min-w-0 flex-1 items-start gap-3 rounded-lg px-2 py-2 text-start hover:bg-accent disabled:opacity-50">
                  {current ? <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" /> : <Search className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                  <span className="min-w-0"><span className="block truncate text-sm font-medium">{entry.name}</span><span className="block truncate text-xs text-muted-foreground">{missingFolder ? 'Folder no longer available' : folder}{current ? ' · Current search' : ''}</span></span>
                </button>
                <button type="button" data-search-edit={entry.id} aria-label={`Edit saved search ${entry.name}`} title="Edit saved search" onClick={()=>{setEditing(entry.id);setEditName(entry.name);setReplaceCriteria(false);}} className="grid min-h-11 min-w-9 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><Pencil className="size-4" aria-hidden="true" /></button>
                <button type="button" aria-label={`Remove saved search ${entry.name}`} title="Remove saved search" onClick={() => {useSavedSearches.getState().remove(scope,entry.id);setRemoved(entry);setStatus('Saved search removed.');}} className="grid min-h-11 min-w-9 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive"><Trash2 className="size-4" aria-hidden="true" /></button>
              </div>
              <p title={description} className="line-clamp-2 break-words px-3 pb-3 text-xs leading-5 text-muted-foreground">{description}</p>
            </>}
          </li>;
        })}
        {!!entries.length && !visibleEntries.length && <li className="py-3 text-sm text-muted-foreground">No saved searches match your search.<button type="button" onClick={()=>{setFind('');finder.current?.focus();}} className="mt-2 block min-h-11 rounded-md px-2 text-primary hover:bg-accent">Show all saved searches</button></li>}
        {!entries.length && <li className="py-4 text-sm text-muted-foreground">Your reusable searches will appear here.</li>}
      </ul>
      <form className="border-t border-border pt-3" onSubmit={event => {
        event.preventDefault();
        if (!canSave || !name.trim()) return;
        if (useSavedSearches.getState().save({id:crypto.randomUUID(),scope,name,query,filters,mailboxId})) { setName('');setStatus('Search saved.'); }
      }}>
        <label htmlFor={inputId} className="text-xs font-medium">Save current search</label>
        <div className="mt-2 flex gap-2"><input id={inputId} value={name} maxLength={80} disabled={!canSave} onChange={event => setName(event.target.value)} placeholder="Give this search a name" className="min-h-11 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50" /><button type="submit" disabled={!canSave || !name.trim()} aria-label="Save current search" className="grid min-h-11 min-w-11 place-items-center rounded-md bg-primary text-primary-foreground disabled:opacity-40"><Plus className="size-4" /></button></div>
        {!canSave && <p className="mt-2 text-xs text-muted-foreground">{filters.pluginFilter ? 'Plugin searches cannot be saved here.' : entries.length >= MAX_SAVED_SEARCHES ? 'Remove a search to make room (20 per account).' : 'Run a search or add filters first.'}</p>}
      </form>
      <div className="mt-2 flex items-center justify-between gap-2"><p role="status" className="text-xs text-muted-foreground">{status}</p>
        {removed?.scope===scope && <button ref={undo} type="button" className="min-h-10 rounded-md px-3 text-sm font-medium text-primary hover:bg-accent" onClick={()=>{
          if(useSavedSearches.getState().save(removed)) {setRemoved(null);setStatus('Saved search restored.');}
          else setStatus('Could not restore: the search already exists or this account has reached its limit.');
        }}>Undo removal</button>}
      </div>
    </section>
  </details>;
}
