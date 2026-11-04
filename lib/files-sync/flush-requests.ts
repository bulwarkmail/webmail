/**
 * "Upload what waits first" before the Files drive goes or a synced folder stops (pass-3
 * files-p3-2, files-p3-3). Whoever is about to stop a root (the settings page, the sign-out
 * gate) asks here; FilesFlushDialog (components/files-sync/files-sync-flush.tsx) runs the
 * upload with its progress and answers: go on, or keep the drive / stay signed in / keep
 * syncing. Nothing waiting: it answers at once and nothing shows.
 */

export type FilesFlushPurpose = 'turn-off' | 'sign-out' | 'stop-folder';

export interface FilesFlushRequest {
  id: number;
  rootId: string;
  kind: 'drive' | 'folder';
  purpose: FilesFlushPurpose;
}

let current: (FilesFlushRequest & { resolve: (go: boolean) => void }) | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * Resolves true when the root may stop now (nothing waits any more, or the user said go on
 * anyway), false to keep it. One at a time: a new request answers an open one with false.
 */
export function requestFlush(request: Omit<FilesFlushRequest, 'id'>): Promise<boolean> {
  if (current) current.resolve(false);
  return new Promise((resolve) => {
    seq += 1;
    const entry = {
      ...request,
      id: seq,
      resolve: (go: boolean) => {
        if (current !== entry) return;
        current = null;
        changed();
        resolve(go);
      },
    };
    current = entry;
    changed();
  });
}

export function currentFlushRequest(): FilesFlushRequest | null {
  return current;
}

export function answerFlush(id: number, go: boolean): void {
  if (current?.id === id) current.resolve(go);
}

export function subscribeFlushRequests(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests only. */
export function resetFlushRequestsForTests(): void {
  current = null;
  listeners.clear();
}
