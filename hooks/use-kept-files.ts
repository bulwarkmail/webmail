'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getStore } from '@/lib/store/client/api';
import { offlineActive } from '@/lib/offline/offline-mode';
import { useOfflineStore } from '@/lib/offline/state';

/** A row of the Files area's `files.kept`. */
export interface KeptFile {
  jmap: string;
  id: string;
  name: string;
  size: number | null;
  pinned: boolean;
  kept: boolean;
  error: string | null;
}

/**
 * The files an account keeps offline, and pinning them. Nothing when the
 * account doesn't keep mail here, or the build has no Files area.
 */
export function useKeptFiles(account: string | null | undefined) {
  const [files, setFiles] = useState<KeptFile[]>([]);
  const lastSynced = useOfflineStore((s) => (account ? s.lastSyncedAt[account] : undefined));
  const active = useOfflineStore((s) => !!account && s.enabled.includes(account)) && offlineActive(account);

  const read = useCallback(async () => {
    if (!account || !active) {
      setFiles([]);
      return;
    }
    try {
      setFiles((await getStore().area<{ files: KeptFile[] }>(account, 'files.kept'))?.files ?? []);
    } catch {
      // The store is starting or being deleted, or this build has no Files area.
      setFiles([]);
    }
  }, [account, active]);

  useEffect(() => { void read(); }, [read, lastSynced]);

  const pinned = useMemo(() => files.filter((file) => file.pinned), [files]);

  const pin = useCallback(async (ref: { jmap: string; id: string }) => {
    if (!account) return;
    await getStore().area(account, 'files.pin', ref);
    await read();
  }, [account, read]);

  const unpin = useCallback(async (ref: { jmap: string; id: string }) => {
    if (!account) return;
    // The store being in trouble: the list says what's so.
    await getStore().area(account, 'files.unpin', ref).catch(() => {});
    await read();
  }, [account, read]);

  return { active, files, pinned, pin, unpin };
}
