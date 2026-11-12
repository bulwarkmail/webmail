import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { threadKeyFor } from '@/lib/thread-utils';
import { resolveEmailBlobContext, useEmailStore, type EmailWriteSource } from '@/stores/email-store';

/**
 * After a reply went out: reads the answered message's conversation again
 * when it is expanded in the list on screen, so the reply shows there
 * without the conversation collapsing.
 *
 * The conversation is the one of the listed row that is the answered
 * message: the row with its id in the login and account the reply was
 * written to (`source`). Message and thread ids repeat across accounts and
 * logins, so a row of another account with that id is another message, and
 * its conversation is left alone. Without a source the row has to be the
 * only one with the id.
 *
 * It is read through that row's own login (its stamp, else the login
 * browsed) and account, and not at all while that login has no client.
 */
export async function refreshRepliedThread(
  emailId: string,
  source: EmailWriteSource | null | undefined,
  passedClient: IJMAPClient | null,
): Promise<void> {
  const state = useEmailStore.getState();
  const rows = state.emails.filter((row) => row.id === emailId);
  const placeOf = (row: (typeof rows)[number]) => resolveEmailBlobContext(row, passedClient);
  const row = source?.clientAccountId
    ? rows.find((candidate) => {
        const place = placeOf(candidate);
        const own = place.client?.getAccountId();
        return place.clientAccountId === source.clientAccountId && (place.accountId ?? own) === (source.accountId ?? own);
      })
    : rows.length === 1 ? rows[0] : undefined;
  if (!row?.threadId || !state.expandedThreadIds.has(threadKeyFor(row))) return;

  const place = placeOf(row);
  if (!place.client) return;
  const fullEmails = await place.client.getThreadEmails(row.threadId, place.accountId ?? place.client.getAccountId());
  if (fullEmails.length === 0) return;
  useEmailStore.setState((current) => {
    const cache = new Map(current.threadEmailsCache);
    cache.set(threadKeyFor(row), fullEmails);
    return { threadEmailsCache: cache };
  });
}
