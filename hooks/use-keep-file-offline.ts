'use client';

import { useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useDevicePolicy } from '@/hooks/use-device-policy';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { scopeForAccount } from '@/lib/offline/offline-mode';
import { useOfflineStore } from '@/lib/offline/state';
import { toast } from '@/stores/toast-store';
import { useAuthStore } from '@/stores/auth-store';
import { useKeptFiles } from './use-kept-files';

interface FileRef {
  id: string;
  isDirectory?: boolean;
  isSymlink?: boolean;
}

/**
 * Nodes of another account are listed as "accountId:nodeId" (stores/file-store.ts).
 * The store keeps them under the account they live in.
 */
export function fileRefFor(id: string, ownAccount: string): { jmap: string; id: string } {
  const at = id.indexOf(':');
  return at > 0 ? { jmap: id.slice(0, at), id: id.slice(at + 1) } : { jmap: ownAccount, id };
}

/** "Keep offline" in the Files app. Nothing to offer when the account doesn't keep mail here. */
export function useKeepFileOffline(client: IJMAPClient | null | undefined) {
  const t = useTranslations('offlineStorage');
  const account = useAuthStore((s) => s.activeAccountId);
  const { active, pinned, pin, unpin } = useKeptFiles(account);
  const own = client?.getAccountId() ?? '';

  const keptOffline = useMemo(() => new Set(pinned.map((file) => (file.jmap === own ? file.id : `${file.jmap}:${file.id}`))), [pinned, own]);

  // Nothing to offer where the organisation or the user keeps no files.
  const devices = useDevicePolicy();
  useOfflineStore((s) => (account ? s.choices[account] : undefined));
  const attachmentsAllowed = !devices.noOfflineAttachments && !!account && scopeForAccount(account).scope.attachments;

  const canKeepOffline = useCallback(
    (resource: FileRef) => active && attachmentsAllowed && !!own && !resource.isDirectory && !resource.isSymlink,
    [active, attachmentsAllowed, own],
  );

  const toggleKeptOffline = useCallback(async (resource: FileRef) => {
    const ref = fileRefFor(resource.id, own);
    if (keptOffline.has(resource.id)) {
      await unpin(ref);
      return;
    }
    // A file so new the store hasn't listed it yet has nothing to pin.
    await pin(ref).catch(() => toast.info(t('pin_not_ready')));
  }, [own, keptOffline, pin, unpin, t]);

  return { keptOffline, canKeepOffline, toggleKeptOffline };
}
