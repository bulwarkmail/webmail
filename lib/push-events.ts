/**
 * Fan-out of live push state changes to whatever is on screen.
 *
 * The push bindings (lib/push-bindings.ts) live at the app level, so the
 * calendar, contacts and files pages get changes too, not only the mail view
 * (#1349). Each surface subscribes here while it is mounted and picks out the
 * data types it shows.
 */

import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { StateChange } from '@/lib/jmap/types';
import type { PushRole } from '@/lib/push-bindings';

export type PushStateListener = (change: StateChange, client: IJMAPClient, role: PushRole) => void;

const listeners = new Set<PushStateListener>();

/** Subscribes to every login's push changes; returns the unsubscribe. */
export function subscribePushStateChanges(listener: PushStateListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function emitPushStateChange(change: StateChange, client: IJMAPClient, role: PushRole): void {
  for (const listener of [...listeners]) {
    try {
      listener(change, client, role);
    } catch (error) {
      console.error('Push listener failed:', error);
    }
  }
}

/** Whether a change touches any of the given data types, in any account. */
export function changesAnyType(change: StateChange, types: readonly string[]): boolean {
  return Object.values(change.changed).some((c) => !!c && types.some((t) => t in c));
}
