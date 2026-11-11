import { useEffect } from 'react';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { SMART_FOLDER_PREFIX, isSmartFolderId } from '@/lib/smart-folder-types';

/** Own-account saved views; system views never enter this collection. */
export function useSmartFolder(mailboxId?: string | null, client?: IJMAPClient | null) {
  const folders = useSettingsStore((s) => s.smartFolders);
  const folder = folders.find((f) => f.enabled && SMART_FOLDER_PREFIX + f.id === mailboxId);
  const definition = folder ? JSON.stringify(folder) : null;
  useEffect(() => {
    if (!client || !isSmartFolderId(mailboxId)) return;
    const state = useEmailStore.getState();
    if (definition) {
      void state.fetchEmails(client, mailboxId);
    } else {
      const inbox = state.mailboxes.find((m) => m.role === 'inbox' && !m.isShared);
      if (inbox) { state.selectMailbox(inbox.id); void state.fetchEmails(client, inbox.id); }
      else { useEmailStore.setState({ selectedMailbox: undefined, emails: [], totalEmails: 0, hasMoreEmails: false }); }
    }
  }, [definition, mailboxId, client]);
  return folder;
}
