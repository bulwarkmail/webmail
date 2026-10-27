import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { StateChange } from '@/lib/jmap/types';
import { changesAnyType, type PushStateListener } from '@/lib/push-events';

export interface MailPushHandlers<Built> {
  /** Full handling for the login on screen (list, scheduled, filters...). */
  handleStateChange: (change: StateChange, client: IJMAPClient) => unknown;
  /** Drops the cached folder list of a login that reported a change. */
  invalidateUnifiedMailboxes: (client: IJMAPClient) => void;
  buildPopulatedUnifiedAccounts: () => Promise<Built>;
  refreshCrossCounts: (built: Built) => void;
  refreshUnifiedCounts: (built: Built) => void;
  /** True while the list shows a unified or cross-account view. */
  isUnifiedView: () => boolean;
  /** Re-reads the list on screen. */
  refreshList: () => unknown;
}

/**
 * The mail view's share of push. The active login gets the full handler;
 * background logins re-project the unified counters, and refresh the list
 * when it is a unified view, which includes their mail (#1350).
 *
 * Handlers are read at event time, so a subscription never holds a stale
 * closure.
 */
export function createMailPushListener<Built>(handlers: () => MailPushHandlers<Built>): PushStateListener {
  return (change, client, role) => {
    const h = handlers();
    // A login that reports a change has a folder list worth fetching again;
    // the others keep theirs, which is what spares the unified scope a full
    // round of Mailbox/get on every push.
    h.invalidateUnifiedMailboxes(client);
    if (role === 'active') {
      void h.handleStateChange(change, client);
      return;
    }
    if (h.isUnifiedView() && changesAnyType(change, ['Email'])) void h.refreshList();
    h.buildPopulatedUnifiedAccounts()
      .then((built) => {
        h.refreshCrossCounts(built);
        h.refreshUnifiedCounts(built);
      })
      .catch(() => { /* per-account fetch failures surface elsewhere */ });
  };
}
