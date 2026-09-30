import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { useEmailStore, resolveEmailActionContext } from '@/stores/email-store';
import { useIdentityStore } from '@/stores/identity-store';
import { cachedRemoteIdentities } from '@/hooks/use-pro-multi-account-identities';
import { extractListId, headerValue, normalizeAddress, unfoldHeader } from './quick-rules';

/** The account a rule made from a message goes into. */
export interface QuickRuleTarget {
  /** The login client that reaches the account. */
  client: IJMAPClient;
  /** AccountEntry id of that login, when known. */
  clientAccountId: string | null;
  /** Login + JMAP account: equal for messages of one account. */
  key: string;
  /** JMAP mail account the message belongs to. */
  accountId: string;
  sieveAccountId: string;
  /** A shared or group account: no rules are offered for it. */
  shared: boolean;
  supportsSieve: boolean;
  /** The account's own folders (store ids). */
  mailboxes: Mailbox[];
}

// JMAP account ids are opaque per server, so two logins can share one; the
// client object tells them apart.
const clientKeys = new WeakMap<object, number>();
let nextClientKey = 1;
function clientKey(client: IJMAPClient): number {
  let key = clientKeys.get(client);
  if (key === undefined) {
    key = nextClientKey++;
    clientKeys.set(client, key);
  }
  return key;
}

/**
 * Resolve the account of `email` the way the email actions do (source stamps
 * in aggregate views, else the viewed account), so a rule for a message of
 * account B is never written to account A's script.
 */
export function resolveQuickRuleTarget(email: Email): QuickRuleTarget | null {
  const auth = useAuthStore.getState();
  if (!auth.client) return null;
  const context = resolveEmailActionContext(email, auth.client);
  const client = context.client;
  const ownAccountId = client.getAccountId();
  const accountId = context.accountId ?? ownAccountId;
  // A shared folder's store id is namespaced (`owner:id`), and so are the
  // mailboxIds of the messages in it. Its bare `originalId` can equal one of
  // the user's own folder ids (a group account has an Inbox too), so it must
  // not be compared.
  const inSharedFolder = Object.keys(email.mailboxIds ?? {}).some(id =>
    context.mailboxes.some(m => m.isShared && m.id === id));
  const clientAccountId = email.sourceClientAccountId
    ?? useEmailStore.getState().viewingAccountId
    ?? auth.activeAccountId
    ?? null;
  return {
    client,
    clientAccountId,
    key: `${clientKey(client)}|${accountId}`,
    accountId,
    sieveAccountId: client.getSieveAccountId(),
    shared: accountId !== ownAccountId || inSharedFolder,
    supportsSieve: typeof client.supportsSieve === 'function' && client.supportsSieve(),
    mailboxes: context.mailboxes.filter(m => !m.isShared),
  };
}

/**
 * The folder `email` is in, within the target account: the selected folder
 * when the message is in it, else the message's own folder (unified, tag and
 * search views have no real folder selected).
 */
export function sourceMailboxOf(email: Email, target: QuickRuleTarget): Mailbox | undefined {
  const ids = Object.entries(email.mailboxIds ?? {}).filter(([, on]) => on).map(([id]) => id);
  const selected = useEmailStore.getState().selectedMailbox;
  const find = (id: string) => target.mailboxes.find(m => m.id === id);
  if (selected && ids.includes(selected)) {
    const mailbox = find(selected);
    if (mailbox) return mailbox;
  }
  for (const id of ids) {
    const mailbox = find(id);
    if (mailbox) return mailbox;
  }
  return undefined;
}

/**
 * Every address the user sends as, across the connected accounts: rules are
 * never offered against one of them.
 */
export function getOwnAddresses(): Set<string> {
  const addresses = new Set<string>();
  const add = (value: string | null | undefined) => {
    const address = normalizeAddress(value);
    if (address.includes('@')) addresses.add(address);
  };
  for (const identity of useAuthStore.getState().identities ?? []) add(identity.email);
  for (const identity of useIdentityStore.getState().identities ?? []) add(identity.email);
  for (const identity of cachedRemoteIdentities()) add(identity.email);
  for (const account of useAccountStore.getState().accounts ?? []) {
    add(account.email);
    add(account.username);
  }
  return addresses;
}

const listIdCache = new Map<string, string | null>();

/** The List-Id of `email` if it is known without a request. */
export function knownListId(target: QuickRuleTarget, email: Email): string | null | undefined {
  const header = headerValue(email.headers, 'List-Id');
  if (header !== undefined) return extractListId(header);
  // A fetched message carries every header it has; no List-Id means none.
  if (email.headers && Object.keys(email.headers).length > 0) return null;
  return listIdCache.get(`${target.key}|${email.id}`);
}

/**
 * Fetch the List-Id of the messages that do not carry their headers (list
 * rows). Only the one header is asked for, and only when the Rules menu
 * opens, so the list itself is not slowed down.
 */
export async function loadListIds(target: QuickRuleTarget, emails: Email[]): Promise<void> {
  const missing = emails.filter(e => knownListId(target, e) === undefined).map(e => e.id);
  if (missing.length === 0) return;
  // Stalwart parses List-Id as a structured header and answers the text form
  // with null, so the raw form is asked for too; the id itself is plain ASCII.
  const records = await target.client.getEmailFields(
    missing, ['header:List-Id:asText', 'header:List-Id'], target.accountId,
  );
  const found = new Map(records.map(r => [
    String(r.id),
    extractListId(r['header:List-Id:asText'] ?? unfoldHeader(r['header:List-Id'])),
  ]));
  for (const id of missing) listIdCache.set(`${target.key}|${id}`, found.get(id) ?? null);
}
