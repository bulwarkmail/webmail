/**
 * What went wrong, in the words the settings page shows: keys under `files_sync.errors.`
 * (the ui writes the strings). Errors are told apart by name, not instanceof: Next has more
 * than one copy of a module.
 */

import type { FilesError } from '@/lib/desktop/types';

export type FilesSyncErrorName =
  | 'offline'
  | 'server_refused'
  | 'too_large'
  | 'name_invalid'
  | 'disk_full'
  | 'denied'
  | 'busy'
  | 'quota'
  | 'not_found'
  | 'policy'
  | 'failed';

/** The key in the `files_sync` namespace. */
export function errorKey(name: FilesSyncErrorName): string {
  return `errors.${name}`;
}

/** A disk answer the engine can't go on from for this item. */
export class LocalError extends Error {
  constructor(readonly error: FilesError) {
    super(`files:${error}`);
    this.name = 'LocalError';
  }
}

export function localErrorName(error: FilesError): FilesSyncErrorName {
  switch (error) {
    case 'full':
      return 'disk_full';
    case 'denied':
    case 'outside':
    case 'gesture':
      return 'denied';
    case 'busy':
      return 'busy';
    case 'name':
      return 'name_invalid';
    case 'policy':
      return 'policy';
    case 'missing':
      return 'not_found';
    default:
      return 'failed';
  }
}

/** The server can't be reached, or is too busy now: the work waits, nothing failed. */
export function isOffline(error: unknown): boolean {
  const e = error as { name?: string; kind?: string; status?: number } | null;
  if (e?.name !== 'TransportError') return false;
  if (e.kind === 'network' || e.kind === 'rate') return true;
  return e.kind === 'http' && typeof e.status === 'number' && e.status >= 500;
}

/** The server no longer takes this login. */
export function isAuthRefused(error: unknown): boolean {
  const e = error as { name?: string; kind?: string } | null;
  return e?.name === 'TransportError' && e.kind === 'auth';
}

/** What a server error on one item means. */
export function remoteErrorName(error: unknown): FilesSyncErrorName {
  const e = error as { name?: string; type?: string; status?: number } | null;
  if (isOffline(error)) return 'offline';
  if (isAuthRefused(error)) return 'server_refused';
  if (e?.name === 'TransportError' && e.status === 413) return 'too_large';
  switch (e?.type) {
    case 'overQuota':
      return 'quota';
    case 'forbidden':
    case 'accountReadOnly':
      return 'denied';
    case 'notFound':
      return 'not_found';
    case 'tooLarge':
      return 'too_large';
    case 'invalidProperties':
    case 'alreadyExists':
      return 'name_invalid';
    default:
      return 'failed';
  }
}
