/**
 * The file list's columns: select, name, then modified (from md) and size
 * (from sm), then the row actions. A plain module, so the page skeleton
 * (components/boot-skeleton/files-skeleton.tsx) lays its rows out on the
 * same grid as FileListView without importing a client component.
 */
export const FILE_LIST_COLUMNS =
  "grid grid-cols-[auto_minmax(0,1fr)_auto] sm:grid-cols-[auto_minmax(0,1fr)_5.5rem_auto] md:grid-cols-[auto_minmax(0,1fr)_9rem_5.5rem_auto] items-center gap-x-3";
