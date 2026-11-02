import type { MessagePriority } from '@/lib/message-priority';

/** What the composer's onSend hands its host beyond the message itself. */
export interface ComposerSendExtras {
  requestReadReceipt?: boolean;
  requestDsn?: boolean;
  requireTls?: boolean;
  priority?: MessagePriority;
  headers?: Record<string, string>;
  labelHeaders?: Record<string, string>;
  localAccountId?: string;
  draftAccountId?: string;
}

/**
 * The options object of useEmailStore.sendEmail for a composer send. Every
 * host of the composer (the mail page, a Pro compose tab) passes it whole,
 * so none drops the read receipt, DSN, REQUIRETLS, priority, plugin headers
 * or the classification label: the Pro tab used to send without them.
 */
export function composerSendOptions(data: ComposerSendExtras): ComposerSendExtras & { outbox: true } {
  return {
    // Every step of the send ran at Send, so offline mode may keep the
    // finished message in its outbox (#523).
    outbox: true,
    requestReadReceipt: data.requestReadReceipt,
    requestDsn: data.requestDsn,
    requireTls: data.requireTls,
    priority: data.priority,
    headers: data.headers,
    labelHeaders: data.labelHeaders,
    localAccountId: data.localAccountId,
    draftAccountId: data.draftAccountId,
  };
}
