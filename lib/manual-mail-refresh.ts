import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { SCHEDULED_MAILBOX_ID } from '@/lib/deep-links';
import { useEmailStore } from '@/stores/email-store';

/**
 * What the Refresh button, its shortcut and the browser refresh gestures do:
 * fetch the folders' counts and bring the shown list up to date in place, as
 * a push does. The list keeps its rows, loaded pages, open conversations and
 * an active search while the request is out, rather than dimming under the
 * loading overlay the way opening a folder does (#1716).
 */
export async function refreshMailView(client: IJMAPClient): Promise<void> {
  const state = useEmailStore.getState();
  if (state.isScheduledView || state.selectedMailbox === SCHEDULED_MAILBOX_ID) {
    await Promise.all([
      state.fetchMailboxes(client),
      state.fetchScheduledEmails(client),
    ]);
    return;
  }
  await state.fetchMailboxes(client);
  await state.refreshScheduledMetadata(client);
  await useEmailStore.getState().refreshCurrentMailbox(client);
}
