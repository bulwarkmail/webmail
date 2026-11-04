import type { Email, Identity, Mailbox } from "@/lib/jmap/types";
import { isAuthenticationSpoofed } from "@/lib/email-headers";

/**
 * The folder Restore puts a message in Trash back into. The server keeps no
 * record of the folder a message was deleted from, so this goes by what the
 * message is: a draft back to Drafts, mail you sent back to Sent, anything
 * else to the Inbox. In a list that mixes accounts, the message's own
 * account's folder. Undefined when there's no such folder.
 */
export function trashRestoreTarget(
  email: Pick<Email, "keywords" | "from" | "authenticationResults">,
  mailboxes: Mailbox[],
  identities: Pick<Identity, "email">[],
  ownerAccountId?: string,
): Mailbox | undefined {
  const from = email.from?.[0]?.email?.toLowerCase();
  const own = !!from
    && !isAuthenticationSpoofed(email.authenticationResults)
    && identities.some((identity) => identity.email?.toLowerCase() === from);
  const role = email.keywords?.["$draft"] === true ? "drafts" : own ? "sent" : "inbox";
  const pick = (wanted: string) => {
    const candidates = mailboxes.filter((m) => m.role === wanted);
    return candidates.find((m) => !!ownerAccountId && m.accountId === ownerAccountId)
      ?? candidates.find((m) => !m.isShared)
      ?? candidates[0];
  };
  return pick(role) ?? (role === "inbox" ? undefined : pick("inbox"));
}
