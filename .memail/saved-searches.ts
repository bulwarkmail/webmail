import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_SEARCH_FILTERS, isFilterEmpty, type SearchFilters } from '../lib/jmap/search-utils';

export interface SavedSearch {
  id: string; scope: string; name: string; query: string; mailboxId: string; filters: SearchFilters;
}
export const MAX_SAVED_SEARCHES = 20;
export function normalizeSavedSearch(value: unknown): SavedSearch | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<SavedSearch>;
  if (![entry.id,entry.scope,entry.name,entry.query,entry.mailboxId].every(v => typeof v === 'string')) return null;
  if (!entry.id || !entry.scope || !entry.name?.trim() || !entry.filters || entry.filters.pluginFilter) return null;
  const filters = {...DEFAULT_SEARCH_FILTERS};
  for (const key of ['from','to','subject','body','dateAfter','dateBefore','minSizeKb','maxSizeKb'] as const) {
    if (typeof entry.filters[key] !== 'string') return null;
    filters[key] = entry.filters[key].slice(0,2000);
  }
  for (const key of ['hasAttachment','isUnread','isStarred'] as const) {
    if (entry.filters[key] !== null && typeof entry.filters[key] !== 'boolean') return null;
    filters[key] = entry.filters[key];
  }
  const query = entry.query!.trim().slice(0,2000);
  if (!query && isFilterEmpty(filters)) return null;
  return {id:entry.id,scope:entry.scope,name:entry.name.trim().slice(0,80),query,mailboxId:entry.mailboxId!,filters};
}
interface SavedSearchState {
  entries: SavedSearch[];
  save: (entry: SavedSearch) => boolean;
  update: (scope:string, id:string, changes:Partial<Pick<SavedSearch,'name'|'query'|'filters'|'mailboxId'>>) => boolean;
  remove: (scope: string, id: string) => void;
}
export const useSavedSearches = create<SavedSearchState>()(persist((set,get) => ({
  entries: [],
  save: input => {
    const entry = normalizeSavedSearch(input);
    if (!entry || get().entries.some(e=>e.id===entry.id && e.scope===entry.scope) || get().entries.filter(e => e.scope === entry.scope).length >= MAX_SAVED_SEARCHES) return false;
    set(s => ({entries:[...s.entries,entry]}));
    return true;
  },
  update: (scope,id,changes) => {
    const existing = get().entries.find(e=>e.scope===scope && e.id===id);
    if (!existing) return false;
    const updated = normalizeSavedSearch({...existing,...changes,id,scope});
    if (!updated) return false;
    set(s=>({entries:s.entries.map(e=>e.scope===scope && e.id===id ? updated : e)}));
    return true;
  },
  remove: (scope,id) => set(s => ({entries:s.entries.filter(e => e.scope !== scope || e.id !== id)})),
}), {
  name:'memail-saved-searches', version:1,
  partialize: ({entries}) => ({entries}),
  merge: (saved,current) => {
    const raw = (saved as {entries?:unknown} | null)?.entries;
    const entries: SavedSearch[] = [];
    if (Array.isArray(raw)) for (const value of raw) {
      const entry = normalizeSavedSearch(value);
      if (entry && entries.filter(e => e.scope === entry.scope).length < MAX_SAVED_SEARCHES && !entries.some(e => e.id === entry.id && e.scope === entry.scope)) entries.push(entry);
    }
    return {...current,entries};
  },
}));


/** Human-readable criteria, including negative filters (read, unstarred, no attachments). */
export function savedSearchDescription(entry: Pick<SavedSearch,'query'|'filters'>): string {
  const parts:string[] = [];
  if (entry.query) parts.push(`“${entry.query}”`);
  const filters = entry.filters;
  for (const [key,label] of [['from','From'],['to','To'],['subject','Subject'],['body','Body'],['dateAfter','After'],['dateBefore','Before']] as const) {
    if (filters[key]) parts.push(`${label}: ${filters[key]}`);
  }
  if (filters.hasAttachment !== null) parts.push(filters.hasAttachment ? 'Has attachments' : 'No attachments');
  if (filters.isUnread !== null) parts.push(filters.isUnread ? 'Unread' : 'Read');
  if (filters.isStarred !== null) parts.push(filters.isStarred ? 'Starred' : 'Not starred');
  if (filters.minSizeKb) parts.push(`At least ${filters.minSizeKb} KB`);
  if (filters.maxSizeKb) parts.push(`At most ${filters.maxSizeKb} KB`);
  return parts.join(' · ');
}

export function matchesSavedSearch(entry:SavedSearch, query:string, filters:SearchFilters, mailboxId:string): boolean {
  return entry.query === query.trim() && entry.mailboxId === mailboxId && !filters.pluginFilter &&
    Object.keys(DEFAULT_SEARCH_FILTERS).filter(key=>key!=='pluginFilter').every(key=>entry.filters[key as keyof SearchFilters]===filters[key as keyof SearchFilters]);
}
