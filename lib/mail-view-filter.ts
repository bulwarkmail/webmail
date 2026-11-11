/** Shared JMAP predicates; system views remain built-in, never settings records. */
export function systemViewFilter(view: 'unread' | 'starred'): Record<string, unknown> {
  return view === 'unread' ? { notKeyword: '$seen' } : { hasKeyword: '$flagged' };
}

export function combineMailFilters(...filters: (Record<string, unknown> | null | undefined)[]): Record<string, unknown> {
  const present = filters.filter((f): f is Record<string, unknown> => !!f && Object.keys(f).length > 0);
  return present.length === 1 ? present[0] : { operator: 'AND', conditions: present };
}
