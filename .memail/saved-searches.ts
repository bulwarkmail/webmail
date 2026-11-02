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
  remove: (scope: string, id: string) => void;
}
export const useSavedSearches = create<SavedSearchState>()(persist((set,get) => ({
  entries: [],
  save: input => {
    const entry = normalizeSavedSearch(input);
    if (!entry || get().entries.filter(e => e.scope === entry.scope).length >= MAX_SAVED_SEARCHES) return false;
    set(s => ({entries:[...s.entries,entry]}));
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
