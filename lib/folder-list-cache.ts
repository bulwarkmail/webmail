import type { Email } from '@/lib/jmap/types';

/**
 * The last list seen in each folder, so opening a folder paints the rows it
 * had a moment ago while the fresh page loads behind them - and keeps them if
 * that load fails. On a slow server or a large folder the difference is an
 * instant folder against seconds of the previous folder's mail under a
 * spinner.
 *
 * In memory only: mail does not outlive the tab here, unlike the one-list boot
 * snapshot in the email store, and the live fetch always runs.
 */
export interface FolderList {
  emails: Email[];
  totalEmails: number;
  hasMoreEmails: boolean;
}

/** Folders remembered per tab; the oldest visited is dropped first. */
const MAX_FOLDERS = 30;

const lists = new Map<string, FolderList>();

/**
 * What a remembered list belongs to. Folder ids repeat across accounts and
 * servers, and a category tab or another sort
 * order is another list of the same folder.
 */
export function folderListKey(parts: {
  login: string | null;
  viewingAccountId: string | null;
  accountId: string;
  mailboxId: string;
  filter: unknown;
  order: unknown;
}): string {
  return JSON.stringify([
    parts.login ?? '',
    parts.viewingAccountId ?? '',
    parts.accountId,
    parts.mailboxId,
    parts.filter ?? null,
    parts.order ?? null,
  ]);
}

export function rememberedFolderList(key: string): FolderList | undefined {
  return lists.get(key);
}

export function rememberFolderList(key: string, list: FolderList, pageSize: number): void {
  lists.delete(key);
  lists.set(key, {
    // One page is what a folder opens on; load-more fetches the rest again.
    emails: list.emails.slice(0, pageSize),
    totalEmails: list.totalEmails,
    hasMoreEmails: list.hasMoreEmails || list.emails.length > pageSize,
  });
  while (lists.size > MAX_FOLDERS) {
    const oldest = lists.keys().next().value;
    if (oldest === undefined) break;
    lists.delete(oldest);
  }
}

export function forgetFolderLists(): void {
  lists.clear();
}
