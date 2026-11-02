/**
 * The "Search in" setting (#1485): whether a new search looks in all folders
 * or only in the folder that is open. Its own module so the settings store
 * can check values without importing the folder helpers (they import the
 * store back through lib/utils).
 */
export type SearchDefaultScope = 'all' | 'folder';

export function isSearchDefaultScope(value: unknown): value is SearchDefaultScope {
  return value === 'all' || value === 'folder';
}
