/**
 * What a composer comes back as when the app starts again: a pop-out on its draft.
 * Each open composer says which draft it holds, as soon as it has one. The shell
 * keeps the list per window. Closing a window drops its list, so a draft the user
 * put away stays in Drafts and doesn't come back on screen. Quitting keeps it.
 */

import { appPath } from '@/lib/deep-links';
import { getDesktopBridge } from './bridge';

export interface OpenDraft {
  draftId: string;
  /** The login it was saved through. */
  localAccountId?: string | null;
  /** The JMAP account holding it, when not that login's own. */
  ownerAccountId?: string | null;
}

const open = new Map<string, OpenDraft>();

export function restoreUrlFor(draft: OpenDraft): string {
  const search = new URLSearchParams({ draft: draft.draftId });
  if (draft.localAccountId) search.set('account', draft.localAccountId);
  if (draft.ownerAccountId) search.set('owner', draft.ownerAccountId);
  return `${appPath('/popout/compose')}?${search.toString()}`;
}

/** With null, this composer holds no draft any more: sent, discarded or closed. */
export function noteOpenDraft(key: string, draft: OpenDraft | null): void {
  const windows = getDesktopBridge()?.windows;
  if (!windows?.setRestore) return;
  if (draft) open.set(key, draft);
  else if (!open.delete(key)) return;
  windows.setRestore([...open.values()].map(restoreUrlFor));
}

/** Test helper. */
export function resetOpenDrafts(): void {
  open.clear();
}
