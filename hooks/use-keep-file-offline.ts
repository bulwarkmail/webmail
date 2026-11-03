'use client';

import { useCallback, useMemo } from 'react';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
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
  const account = useAuthStore((s) => s.activeAccountId);
  const { active, pinned, pin, unpin } = useKeptFiles(account);
  const own = client?.getAccountId() ?? '';

  const keptOffline = useMemo(() => new Set(pinned.map((file) => (file.jmap === own ? file.id : `${file.jmap}:${file.id}`))), [pinned, own]);

  const canKeepOffline = useCallback((resource: FileRef) => active && !!own && !resource.isDirectory && !resource.isSymlink, [active, own]);

  const toggleKeptOffline = useCallback(async (resource: FileRef) => {
    const ref = fileRefFor(resource.id, own);
    await (keptOffline.has(resource.id) ? unpin(ref) : pin(ref)).catch(() => {});
  }, [own, keptOffline, pin, unpin]);

  return { keptOffline, canKeepOffline, toggleKeptOffline };
}
