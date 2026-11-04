/**
 * What a composer needs to start in another window. Plain data: it crosses a
 * BroadcastChannel and is kept in the pop-out's sessionStorage over a reload.
 * Attachments are blob references, already on the server.
 */

import type { ComposerDraftData } from '@/components/email/email-composer';
import type { ComposePrefill } from '@/lib/plugin-compose-gate';
import type { EmailWriteSource } from '@/stores/email-store';
import type { ProComposerMode, ProReplyContext } from '@/stores/pro-tab-store';

export interface ComposePopoutPayload {
  mode: ProComposerMode;
  replyTo?: ProReplyContext;
  initialDraftText?: string;
  initialData?: ComposerDraftData | null;
  prefill?: ComposePrefill | null;
  /** The message replied to or forwarded, for its $answered / $forwarded flag. */
  sourceEmailId?: string | null;
  sourceEmailSource?: EmailWriteSource | null;
  /** The mailbox a new message was started from; picks the identity (see the composer's prop). */
  composeFromAccountEmail?: string;
  /**
   * Files to attach as it opens: Send to and Open with in the desktop app. They cross to the
   * window as they are (BroadcastChannel clones a File) and aren't kept for a reload.
   */
  initialFiles?: File[];
}
