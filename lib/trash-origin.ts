/**
 * Where a message was before it went to Trash, so "Restore" can put it back there.
 * JMAP doesn't keep that, so this device notes it when Bulwark moves mail to Trash.
 * A message deleted elsewhere, or one whose folder is gone, goes back to the Inbox
 * of its own account.
 */

import type { Email, Mailbox } from "./jmap/types";
import { resolveMoveOwnerAccountId } from "./move-targets";

const KEY = "bulwark.trashOrigin.v1";
const KEPT = 2000;

type Store = Record<string, string>;

function read(): Store {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Store = {};
    for (const [id, mailboxId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof mailboxId === "string") out[id] = mailboxId;
    }
    return out;
  } catch {
    return {};
  }
}

/** Notes the folder each message is in, as it goes to Trash. */
export function rememberTrashOrigins(
  emails: Array<Pick<Email, "id" | "mailboxIds">>,
  mailboxes: Array<Pick<Mailbox, "id" | "role">>,
): void {
  const store = read();
  let changed = false;
  for (const email of emails) {
    const from = Object.keys(email.mailboxIds ?? {}).find((id) => {
      const mailbox = mailboxes.find((m) => m.id === id);
      return !mailbox || (mailbox.role !== "trash" && mailbox.role !== "junk");
    });
    if (!from) continue;
    // Newest last, so the oldest go first when the list is full.
    delete store[email.id];
    store[email.id] = from;
    changed = true;
  }
  if (!changed) return;
  const ids = Object.keys(store);
  for (const id of ids.slice(0, Math.max(0, ids.length - KEPT))) delete store[id];
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Storage full or off: Restore goes to the Inbox.
  }
}

/** The Inbox of the account a message lives in. */
function inboxFor(email: Pick<Email, "sourceAccountId" | "mailboxIds">, mailboxes: Mailbox[], selectedMailboxId?: string | null): Mailbox | undefined {
  const accountId = resolveMoveOwnerAccountId(email, mailboxes, selectedMailboxId);
  const shared = mailboxes.find((m) => m.isShared && m.role === "inbox" && m.accountId === accountId);
  return shared ?? mailboxes.find((m) => !m.isShared && m.role === "inbox");
}

/**
 * Where Restore puts a message: the folder it was in, if that still exists and takes
 * mail, else its account's Inbox.
 */
export function restoreTarget(
  email: Pick<Email, "id" | "sourceAccountId" | "mailboxIds">,
  mailboxes: Mailbox[],
  selectedMailboxId?: string | null,
): string | undefined {
  const origin = read()[email.id];
  const mailbox = origin ? mailboxes.find((m) => m.id === origin) : undefined;
  if (mailbox && mailbox.role !== "trash" && mailbox.myRights?.mayAddItems !== false) return mailbox.id;
  return inboxFor(email, mailboxes, selectedMailboxId)?.id;
}

/** One place for several messages: where they all came from, or the Inbox when they differ. */
export function restoreTargetForAll(
  emails: Array<Pick<Email, "id" | "sourceAccountId" | "mailboxIds">>,
  mailboxes: Mailbox[],
  selectedMailboxId?: string | null,
): string | undefined {
  if (emails.length === 0) return undefined;
  const targets = new Set(emails.map((email) => restoreTarget(email, mailboxes, selectedMailboxId)));
  if (targets.size === 1) return [...targets][0];
  return inboxFor(emails[0], mailboxes, selectedMailboxId)?.id;
}
