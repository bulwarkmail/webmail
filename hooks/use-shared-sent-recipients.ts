"use client";

import { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Mailbox } from '@/lib/jmap/types';
import { useContactStore } from '@/stores/contact-store';
import { useSettingsStore } from '@/stores/settings-store';
import { parseSharedSentFoldersKey, sharedSentFoldersKey } from '@/lib/shared-sent-folders';

/**
 * With sharedSentRecipientSuggestions on, reads the Sent folders of the
 * shared accounts in `mailboxes` for compose autocomplete, after the own one
 * (`sentMailboxId`): sending from a shared mailbox's address then suggests
 * the people it wrote to. Keyed on the set of those folders, not the folder
 * list, which changes with every count; started when the browser is idle.
 * The store reads each folder once per session.
 */
export function useSharedSentRecipients(client: IJMAPClient | null, mailboxes: Mailbox[], sentMailboxId: string | null): void {
  const enabled = useSettingsStore((state) => state.sharedSentRecipientSuggestions);
  const { loadRecentRecipients, loadSharedRecentRecipients } = useContactStore(useShallow((state) => ({
    loadRecentRecipients: state.loadRecentRecipients,
    loadSharedRecentRecipients: state.loadSharedRecentRecipients,
  })));
  const foldersKey = useMemo(() => sharedSentFoldersKey(mailboxes), [mailboxes]);

  useEffect(() => {
    if (!client || !enabled || !foldersKey) return;
    const run = () => {
      void (async () => {
        if (sentMailboxId) await loadRecentRecipients(client, sentMailboxId);
        await loadSharedRecentRecipients(client, parseSharedSentFoldersKey(foldersKey));
      })();
    };
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(run, { timeout: 5000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(run, 1000);
    return () => window.clearTimeout(timer);
  }, [client, enabled, foldersKey, sentMailboxId, loadRecentRecipients, loadSharedRecentRecipients]);
}
