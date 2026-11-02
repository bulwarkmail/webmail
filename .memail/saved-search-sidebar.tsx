'use client';

import { useId, useState } from 'react';
import { Bookmark, ChevronDown, ChevronRight, Search } from '../components/icons';
import type { SearchFilters } from '../lib/jmap/search-utils';
import { matchesSavedSearch, savedSearchDescription, useSavedSearches, type SavedSearch } from './saved-searches';

export function SavedSearchSidebar({scope, collapsed, query, filters, mailboxId, mailboxes, onApply}: {
  scope: string; collapsed: boolean; query: string; filters: SearchFilters; mailboxId: string;
  mailboxes: {id: string; name: string}[]; onApply: (entry: SavedSearch) => void;
}) {
  const entries = useSavedSearches(s=>s.entries).filter(entry=>entry.scope===scope);
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const id = useId();
  if (collapsed || !entries.length) return null;
  return <section className="memail-saved-views" aria-label="Saved views">
    <button type="button" className="memail-sidebar-section-toggle" aria-label={`Saved views (${entries.length})`} aria-expanded={expanded} aria-controls={expanded ? id : undefined} onClick={()=>setExpanded(value=>!value)}>
      <Bookmark className="size-4" aria-hidden="true" /><span className="flex-1 text-start">Saved views</span><span className="text-xs tabular-nums">{entries.length}</span>
      {expanded ? <ChevronDown className="size-3.5" aria-hidden="true" /> : <ChevronRight className="size-3.5" aria-hidden="true" />}
    </button>
    {expanded && <div id={id} className="flex flex-col gap-1">
      {(showAll ? entries : entries.slice(0,5)).map(entry=>{
        const folder = entry.mailboxId ? mailboxes.find(mailbox=>mailbox.id===entry.mailboxId) : undefined;
        const missing = !!entry.mailboxId && !folder;
        const active = !missing && matchesSavedSearch(entry,query,filters,mailboxId);
        return <button key={entry.id} type="button" disabled={missing} aria-label={missing ? `${entry.name}, folder unavailable` : entry.name} aria-current={active ? 'page' : undefined}
          title={`${entry.name} — ${savedSearchDescription(entry)} · ${missing ? 'Folder unavailable' : folder?.name ?? 'All folders'}`}
          onClick={()=>onApply(entry)} className="memail-saved-view-row">
          <Search className="size-4 shrink-0" aria-hidden="true" /><span className="min-w-0 truncate">{entry.name}</span>
          {missing && <span aria-hidden="true" className="ms-auto text-xs text-muted-foreground">Unavailable</span>}
        </button>;
      })}
      {entries.length > 5 && <button type="button" className="min-h-9 rounded-md px-3 text-start text-xs font-medium text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" aria-expanded={showAll} onClick={()=>setShowAll(value=>!value)}>{showAll ? 'Show fewer views' : `Show all ${entries.length} views`}</button>}
    </div>}
  </section>;
}
