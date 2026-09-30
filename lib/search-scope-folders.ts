import type { Mailbox } from '@/lib/jmap/types';
import { buildMailboxTree, flattenMailboxTree, type MailboxNode } from '@/lib/utils';

/**
 * `searchMailboxId` of the "All folders" search scope: every folder of every
 * account, Trash and Junk included. The default scope, "" ("All folders
 * except Spam and Trash"), leaves those two out. JMAP ids never contain "*",
 * so this cannot collide with a folder id.
 */
export const SEARCH_SCOPE_ALL_FOLDERS = '*';

/**
 * Whether `searchMailboxId` searches across folders (the default scope or
 * "All folders") rather than inside the one folder picked in the dropdown.
 */
export function isAllFoldersSearchScope(searchMailboxId: string): boolean {
  return searchMailboxId === '' || searchMailboxId === SEARCH_SCOPE_ALL_FOLDERS;
}

/**
 * The search scope a folder starts with: Spam and Trash search themselves,
 * since that is what a search from inside them looks for; every other folder
 * searches all folders except Spam and Trash ("").
 */
export function defaultSearchScopeFor(mailboxes: Mailbox[], openMailboxId: string | null | undefined): string {
  const open = openMailboxId ? mailboxes.find((mb) => mb.id === openMailboxId) : undefined;
  return open && (open.role === 'trash' || open.role === 'junk') ? open.id : '';
}

export interface SearchScopeFolderGroup {
  /** Owner JMAP account id; the React key. */
  ownerId: string;
  /** Owner account label (`accountName`, else the owner id). */
  label: string;
  /** The owner's folders in sidebar order, `depth` counted from its top level. */
  mailboxes: MailboxNode[];
}

/**
 * Splits the sidebar's folder list into the login's own folders and the
 * group/shared folders grouped by their owner account, for the search
 * panel's Folder dropdown. Both come in sidebar order, each subfolder right
 * after its parent with its nesting `depth`, so the dropdown can indent it.
 *
 * Shared folders carry their owner's name in the sidebar, but the flat
 * dropdown listed them by bare name, so a group's "Inbox" was
 * indistinguishable from the user's own (#1082).
 */
export function groupSearchScopeFolders(
  mailboxes: Mailbox[],
): { own: MailboxNode[]; shared: SearchScopeFolderGroup[] } {
  const ownRoots: MailboxNode[] = [];
  const shared: SearchScopeFolderGroup[] = [];
  for (const node of buildMailboxTree(mailboxes)) {
    // buildMailboxTree wraps each shared account's folders in a virtual
    // `shared-account-<id>` node, the dropdown's optgroup.
    if (node.id.startsWith('shared-account-')) {
      shared.push({
        ownerId: node.accountId ?? '',
        label: node.name,
        mailboxes: flattenMailboxTree(node.children),
      });
    } else {
      ownRoots.push(node);
    }
  }
  return { own: flattenMailboxTree(ownRoots), shared };
}
