/**
 * How a send reaches the outbox (#523) without the email store importing
 * offline mode (which imports the stores). Registered by lib/offline/offline-mode.ts;
 * null while offline mode isn't running, and then every send goes out as before.
 */

import type { SendEmailResult } from '@/lib/jmap/types';
import type { OfflineClientRef } from '@/lib/jmap/offline-hooks';

export interface RawSendOptions {
  identityId: string;
  delayedUntil?: string;
  envelopeRecipients?: string[];
  submitOnly?: boolean;
}

export interface OutboxHooks {
  /** Whether a send from this client goes to the outbox now (offline, with offline mode on for its account). */
  shouldQueue(client: OfflineClientRef): boolean;
  /** Keeps a finished send (useEmailStore.sendEmail's arguments after the client). */
  queueEmail(client: OfflineClientRef, args: unknown[]): Promise<SendEmailResult>;
  /** Keeps a finished raw message (a plugin's signed or encrypted send). */
  queueRaw(client: OfflineClientRef, raw: Blob, options: RawSendOptions): Promise<SendEmailResult>;
  /** Uploads the files of a message that were attached offline, now that the server is back. */
  resolveHeldAttachments<T extends { blobId: string }>(client: OfflineClientRef, attachments: T[]): Promise<T[]>;
}

const KEY = '__bulwarkOutboxHooks';
type HookGlobal = typeof globalThis & { [KEY]?: OutboxHooks | null };

export function setOutboxHooks(hooks: OutboxHooks | null): void {
  (globalThis as HookGlobal)[KEY] = hooks;
}

export function getOutboxHooks(): OutboxHooks | null {
  return (globalThis as HookGlobal)[KEY] ?? null;
}
