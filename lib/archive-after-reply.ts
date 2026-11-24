import { isArchiveActionEnabled } from '@/lib/archive-gate';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Email } from '@/lib/jmap/types';
import { useEmailStore, type EmailRestoreBatch } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';

/**
 * "Archive after replying": the message a reply or forward answered, bound
 * when the reply is sent to the login it was read through, so a send that
 * goes out after its Undo window archives that message even when the user
 * has switched login or folder since.
 */
export interface ArchiveAfterReply {
  /** The login client the answered message was read through. */
  client: IJMAPClient;
  emailId: string;
  threadId?: string;
}

/**
 * The archive to run once the reply has gone, or null when it doesn't apply:
 * the setting is off, the admin has the Archive action off, it isn't a reply
 * or forward, the original is a draft, or it lies in another account (a
 * shared Inbox), whose folders the reply has no Archive in.
 */
export function planArchiveAfterReply(opts: {
  mode: string | undefined;
  email: Pick<Email, 'id' | 'threadId' | 'keywords'> | null | undefined;
  emailId: string | undefined;
  client: IJMAPClient | null | undefined;
  /** The JMAP account the answered message lies in, when not the login's own. */
  accountId?: string;
}): ArchiveAfterReply | null {
  const { mode, email, emailId, client } = opts;
  if (!useSettingsStore.getState().archiveAfterReply || !isArchiveActionEnabled()) return null;
  if (mode !== 'reply' && mode !== 'replyAll' && mode !== 'forward') return null;
  if (!client || !emailId) return null;
  if (opts.accountId && opts.accountId !== client.getAccountId()) return null;
  const row = email?.id === emailId ? email : null;
  if (row?.keywords?.$draft) return null;
  return { client, emailId, threadId: row?.threadId };
}

/**
 * Archive the answered message's conversation the way Archive does, as far as
 * it is still in the Inbox: read from the server now, so a message the user
 * moved meanwhile stays where they put it. Returns what Undo puts back, or
 * null when nothing was archived.
 */
export async function runArchiveAfterReply(
  plan: ArchiveAfterReply,
  activeClient: IJMAPClient | null | undefined,
): Promise<EmailRestoreBatch[] | null> {
  if (!isArchiveActionEnabled()) return null;
  const { client, emailId, threadId } = plan;
  const inbox = (await client.getMailboxes()).find(m => m.role === 'inbox' && !m.isShared);
  if (!inbox) return null;
  const inboxId = inbox.originalId || inbox.id;
  const thread = threadId ? await client.getThread(threadId) : null;
  const memberIds = thread?.emailIds?.length ? [...new Set([emailId, ...thread.emailIds])] : [emailId];
  const members = await client.getEmailFields(memberIds, ['id', 'mailboxIds', 'keywords', 'receivedAt']);
  const inInbox = members.filter(m => (m.mailboxIds as Record<string, boolean> | undefined)?.[inboxId]);
  if (!inInbox.some(m => m.id === emailId)) return null;
  const emails = inInbox.map(m => ({
    id: m.id as string,
    mailboxIds: { ...(m.mailboxIds as Record<string, boolean>) },
    keywords: { ...(m.keywords as Record<string, boolean> | undefined) },
    receivedAt: m.receivedAt as string,
  })) as unknown as Email[];
  const archived = await useEmailStore.getState().batchArchive(activeClient ?? client, {
    emailIds: emails.map(e => e.id),
    client,
    emails,
    userArchive: true,
  });
  if (!archived) return null;
  return [{
    client,
    accountId: client.getAccountId(),
    points: emails.map(e => ({ id: e.id, mailboxIds: e.mailboxIds, seen: !!e.keywords?.$seen })),
  }];
}
