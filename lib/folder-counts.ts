/**
 * Per-folder counter override (#982). Without one a folder follows the global
 * "show total count" setting.
 *  - unread: only the unread count
 *  - all:    unread and total, even with the global total count off
 *  - none:   no counter at all
 */
export type FolderCountMode = 'unread' | 'all' | 'none';

export const FOLDER_COUNT_MODES: readonly FolderCountMode[] = ['unread', 'all', 'none'];

export function isFolderCountMode(value: unknown): value is FolderCountMode {
  return typeof value === 'string' && (FOLDER_COUNT_MODES as readonly string[]).includes(value);
}

/**
 * The counter of a row that adds up several folders, such as the unified
 * "All Trash": the setting all of them have, or none (the default) when
 * they differ or one has no setting (#1691).
 */
export function commonFolderCountMode(
  modes: Readonly<Record<string, FolderCountMode | string>> | undefined,
  mailboxIds: readonly string[],
): FolderCountMode | undefined {
  const first = mailboxIds.length > 0 ? modes?.[mailboxIds[0]] : undefined;
  if (!isFolderCountMode(first)) return undefined;
  return mailboxIds.every((id) => modes?.[id] === first) ? first : undefined;
}

/**
 * Which counts a sidebar row shows. A zero means that count is not shown.
 * Mountain View shows one number per row, so there at most one of the two is
 * non-zero: the unread count, or the total for Drafts (a draft is never
 * unread) and for folders set to "all".
 */
export function resolveFolderCounts({
  unread,
  total,
  role,
  mode: rawMode,
  showTotalGlobally,
  mountainView,
}: {
  unread?: number;
  total?: number;
  role?: string | null;
  mode?: FolderCountMode | string;
  showTotalGlobally: boolean;
  mountainView: boolean;
}): { unread: number; total: number } {
  // Synced settings can carry values from other versions; treat those as unset.
  const mode = isFolderCountMode(rawMode) ? rawMode : undefined;
  const u = unread ?? 0;
  const t = total ?? 0;
  if (mode === 'none') return { unread: 0, total: 0 };
  if (mountainView) {
    const showTotal = mode === 'all' || (mode === undefined && role === 'drafts');
    return showTotal ? { unread: 0, total: t } : { unread: u, total: 0 };
  }
  if (mode === 'unread') return { unread: u, total: 0 };
  if (mode === 'all') return { unread: u, total: t };
  return { unread: u, total: showTotalGlobally ? t : 0 };
}
