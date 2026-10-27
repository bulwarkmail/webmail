import { deliverDeepLink, setPendingDeepLink } from '@/lib/deep-link-handoff';
import {
  appPath,
  buildCalendarPath,
  buildContactsPath,
  buildFilesPath,
  buildMailPath,
  sharedFilesSearch,
} from '@/lib/deep-links';
import type { GlobalSearchHit } from '@/lib/global-search/types';
import { useAuthStore } from '@/stores/auth-store';
import { useFileStore } from '@/stores/file-store';
import { useProTabStore, type ProPaneId } from '@/stores/pro-tab-store';

export interface OpenHitOptions {
  /** True inside the Pro shell: hits open as tabs + handoff. False: router navigation. */
  proShell: boolean;
  /** Pro shell: pane the tab should land in. */
  pane?: ProPaneId;
  /** Standard layout: navigate to an app path (the palette passes `router.push`). */
  navigate?: (path: string) => void;
}

function fileLinkFor(hit: Extract<GlobalSearchHit, { kind: 'files' }>): { segments: string[]; search: string } {
  // A node of a drive shared with the user has no path under the login's own
  // root: the link names it by the id the Files store lists it under, and the
  // Files app opens the shared folder (or shared-files page) it is listed in.
  if (hit.node.isShared) {
    return { segments: [], search: sharedFilesSearch(hit.node.id, hit.isFolder ? null : hit.node.name) };
  }
  const folderSegments = hit.folderPath.split('/').filter(Boolean);
  // An own folder's link has no query, and says so: a Files page that takes
  // a link without one reads the address bar instead, which may still name
  // the shared folder or file on screen (`?shared=`, `?preview=`).
  if (hit.isFolder) return { segments: [...folderSegments, hit.node.name], search: '' };
  return { segments: folderSegments, search: `?preview=${encodeURIComponent(hit.node.name)}` };
}

/**
 * Opens a search hit on its surface, in the right account. Every hit carries
 * login + owner + raw id (#847), so nothing here re-resolves by bare id.
 */
export async function openHit(hit: GlobalSearchHit, options: OpenHitOptions): Promise<void> {
  const { proShell, pane, navigate } = options;
  const auth = useAuthStore.getState();
  const isActiveLogin = hit.localAccountId === auth.activeAccountId;

  if (proShell) {
    const tabs = useProTabStore.getState();
    switch (hit.kind) {
      case 'mail':
        tabs.openEmailTab({
          accountId: hit.jmapAccountId,
          // The active login's hits too: without it the tab reads the id
          // through the mail list, which may be browsing another login, or
          // hold another account's message with the same id.
          clientAccountId: hit.localAccountId,
          emailId: hit.id,
          mailboxId: null,
          title: hit.title,
        }, { pane, reuseReader: true });
        return;
      case 'contacts':
        tabs.openTab('contacts');
        // Pro aggregates every login's contacts under namespaced store ids.
        setPendingDeepLink('contacts', [hit.storeId]);
        return;
      case 'calendar':
        tabs.openTab('calendar');
        setPendingDeepLink(
          'calendar',
          ['event', hit.id],
          `?account=${encodeURIComponent(hit.jmapAccountId)}${isActiveLogin ? '' : `&login=${encodeURIComponent(hit.localAccountId)}`}`,
        );
        return;
      case 'files': {
        // The Files surface browses one login at a time - switch its client
        // to the owning login before handing over the path.
        const fileStore = useFileStore.getState();
        if (fileStore.currentAccountId !== hit.localAccountId) {
          const client = auth.getClientForAccount(hit.localAccountId);
          if (client) {
            fileStore.initClient(client, hit.localAccountId);
            useFileStore.setState({ supportsFiles: null });
          }
        }
        tabs.openTab('files');
        const link = fileLinkFor(hit);
        setPendingDeepLink('files', link.segments, link.search);
        return;
      }
    }
  }

  // Standard layout: switch the active login when needed, then navigate.
  if (!isActiveLogin) await auth.switchAccount(hit.localAccountId);
  switch (hit.kind) {
    case 'mail': {
      // A group or shared account's hit names its account: ids repeat (#1351).
      const own = auth.getClientForAccount(hit.localAccountId)?.getAccountId();
      const ownerAccountId = hit.jmapAccountId && hit.jmapAccountId !== own ? hit.jmapAccountId : null;
      navigate?.(appPath(buildMailPath({ mailboxId: null, emailId: hit.id, threadId: null, ownerAccountId })));
      return;
    }
    case 'contacts':
      // Outside the Pro shell the store holds the active login's contacts raw.
      navigate?.(appPath(buildContactsPath({ contactId: hit.id })));
      return;
    case 'calendar':
      navigate?.(appPath(buildCalendarPath({ view: 'month', date: null, eventId: hit.id, accountId: hit.jmapAccountId })));
      return;
    case 'files': {
      const link = fileLinkFor(hit);
      // A Files page that is already open reads the route only when it
      // mounts, and Next keeps it mounted when a link changes only the query
      // (a node of a shared drive): it takes the link directly instead.
      if (isActiveLogin && deliverDeepLink('files', link.segments, link.search)) return;
      const path = buildFilesPath(`/${link.segments.join('/')}`);
      navigate?.(appPath(`${path}${link.search}`));
      return;
    }
  }
}
