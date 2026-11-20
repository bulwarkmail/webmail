import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Mailbox } from '@/lib/jmap/types';

/**
 * "File in folder" in the composer of a reply or forward: once the message
 * is out, it goes into the picked folder as well as Sent, and the message it
 * answers moves there. The folder is one of the original's account.
 */

/** Roles a reply and its original are never filed in. */
const NOT_A_FILING_FOLDER = new Set(['drafts', 'sent', 'trash', 'junk', 'outbox', 'scheduled']);

/**
 * The folders of the account the original is in that can take both
 * messages. `accountId`: that account, when it is a shared or group one.
 */
export function fileWithOriginalTargets(mailboxes: Mailbox[], accountId: string | undefined, ownAccountId: string | undefined): Mailbox[] {
  const shared = !!accountId && accountId !== ownAccountId;
  return mailboxes.filter((m) => {
    if (shared ? !(m.isShared && m.accountId === accountId) : m.isShared) return false;
    if (NOT_A_FILING_FOLDER.has(m.role ?? '')) return false;
    return m.myRights?.mayAddItems !== false;
  });
}

export interface FileWithOriginalResult {
  originalMoved: boolean;
  replyFiled: boolean;
  /** The reply lies in another account than the folder, so it stays in Sent only. */
  replyElsewhere: boolean;
}

/**
 * Files the sent reply in `folder` and moves the original there. Each step
 * runs on its own: a refused move still files the reply, and the other way
 * round.
 *
 * `moveOriginal` is the host's move of the original into `folder`, so the
 * list on screen and plugins hear of it; resolves false when it moved nothing.
 */
export async function fileReplyWithOriginal(opts: {
  folder: Mailbox;
  /** The login client and JMAP account (absent: the login's own) the original and the folder are in. */
  client: IJMAPClient;
  accountId?: string;
  /**
   * The sent copy: the account it lies in (absent: the login's own), and
   * whether it went out through the login the original is read through.
   */
  reply?: { id: string; accountId?: string; sameLogin: boolean };
  moveOriginal: () => Promise<boolean>;
}): Promise<FileWithOriginalResult> {
  const { folder, client, reply } = opts;
  const folderAccountId = opts.accountId ?? client.getAccountId();
  const sameAccount = !!reply && reply.sameLogin && (reply.accountId ?? client.getAccountId()) === folderAccountId;

  let replyFiled = false;
  if (reply && sameAccount) {
    try {
      await client.addEmailToMailbox(reply.id, folder.originalId ?? folder.id, opts.accountId);
      replyFiled = true;
    } catch {
      replyFiled = false;
    }
  }

  let originalMoved = false;
  try {
    originalMoved = await opts.moveOriginal();
  } catch {
    originalMoved = false;
  }

  return { originalMoved, replyFiled, replyElsewhere: !!reply && !sameAccount };
}
