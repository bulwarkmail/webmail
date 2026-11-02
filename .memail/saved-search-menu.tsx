'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Bookmark, Plus, Trash2, Search } from '../components/icons';
import { isFilterEmpty, type SearchFilters } from '../lib/jmap/search-utils';
import { MAX_SAVED_SEARCHES, useSavedSearches, type SavedSearch } from './saved-searches';

export function SavedSearchMenu({scope,query,filters,mailboxId,mailboxes,onApply}: {
  scope:string; query:string; filters:SearchFilters; mailboxId:string;
  mailboxes: {id:string;name:string}[]; onApply:(entry:SavedSearch) => void;
}) {
  const entries = useSavedSearches(s => s.entries).filter(e => e.scope === scope);
  const [name,setName] = useState('');
  const [status,setStatus] = useState('');
  const menu = useRef<HTMLDetailsElement>(null);
  const inputId = useId();
  const canSave = !filters.pluginFilter && (!!query.trim() || !isFilterEmpty(filters)) && entries.length < MAX_SAVED_SEARCHES;
  useEffect(() => {
    const dismiss = (event:PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) menu.current?.removeAttribute('open');
    };
    document.addEventListener('pointerdown',dismiss);
    return () => document.removeEventListener('pointerdown',dismiss);
  },[]);
  return <details ref={menu} onKeyDown={event => {
    if (event.key === 'Escape') { menu.current?.removeAttribute('open'); menu.current?.querySelector('summary')?.focus(); }
  }}>
    <summary aria-label="Saved searches" title="Saved searches" className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md px-3 text-sm text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
      <Bookmark className="size-4" aria-hidden="true" /><span className="hidden xl:inline">Saved</span>
    </summary>
    <section aria-label="Saved searches" className="absolute end-3 top-full z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg">
      <h3 className="font-semibold">Saved searches</h3>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">Saved on this device for this account. Each search keeps its filters and folder scope.</p>
      <ul className="my-3 max-h-60 overflow-auto">
        {entries.map(entry => {
          const missingFolder = !!entry.mailboxId && !mailboxes.some(m => m.id === entry.mailboxId);
          const folder = entry.mailboxId ? mailboxes.find(m => m.id === entry.mailboxId)?.name : 'All folders';
          return <li key={entry.id} className="flex items-center gap-1 rounded-lg hover:bg-accent">
            <button type="button" aria-label={`Open saved search ${entry.name}`} disabled={missingFolder} onClick={() => { onApply(entry); menu.current?.removeAttribute('open'); }} className="flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 text-start disabled:opacity-50">
              <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0"><span className="block truncate text-sm font-medium">{entry.name}</span><span className="block truncate text-xs text-muted-foreground">{missingFolder ? 'Folder no longer available' : folder}</span></span>
            </button>
            <button type="button" aria-label={`Remove saved search ${entry.name}`} onClick={() => {useSavedSearches.getState().remove(scope,entry.id);setStatus('Saved search removed.');}} className="grid min-h-11 min-w-11 place-items-center rounded-md text-muted-foreground hover:text-destructive"><Trash2 className="size-4" aria-hidden="true" /></button>
          </li>;
        })}
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
      <p role="status" className="mt-2 text-xs text-muted-foreground">{status}</p>
    </section>
  </details>;
}
