// A plugin opening a message in the reader (api.ui.openEmail): what a click on
// a list row, or on a search result entry naming a message (#1338), does. The
// message is reached through the login that reads its account, the active one
// first, so a shared or group account's message opens too. The mail page opens
// it in place through the handler it sets; the Pro shell, whose mail tab stays
// mounted (hidden) beside the others, opens it in an email tab as a message
// link does there; on any other page the message is looked up and the tab
// loads its permalink, which names the login and the account in its query (a
// move within the app would drop that query before the mail page reads it). A
// message no login reads, or one its account does not have, is refused with an
// error the plugin sees.

import type { Email } from '../jmap/types';
import type { InstalledPlugin, SearchResultEmail } from '../plugin-types';
import { appPath, buildMailPath } from '../deep-links';
import { goInApp } from './page-navigation';
import { useAuthStore } from '@/stores/auth-store';
import { useProTabStore } from '@/stores/pro-tab-store';
import { readId, readObject, withinRate } from './host-api-input';

/** A message as the reader opens one that is not a row of the list: the login reaching it and its account. */
export type OpenableEmail = Required<Pick<Email, 'id' | 'sourceClientAccountId' | 'sourceAccountId'>>;

/**
 * The login through which the user reaches a message, the active one first;
 * null when none does (an account the user cannot read). Without an account
 * the message is the active login's own.
 */
export function reachableEmail(email: SearchResultEmail): OpenableEmail | null {
  const auth = useAuthStore.getState();
  const clients = [...auth.getAllConnectedClients()]
    .sort(([a], [b]) => Number(b === auth.activeAccountId) - Number(a === auth.activeAccountId));
  for (const [login, client] of clients) {
    if (!email.accountId) {
      return login === auth.activeAccountId
        ? { id: email.id, sourceClientAccountId: login, sourceAccountId: client.getAccountId() }
        : null;
    }
    const reaches = client.getAccountId() === email.accountId
      || client.getSharedAccounts().some((a) => a.id === email.accountId && a.capabilities.mail);
    if (reaches) return { id: email.id, sourceClientAccountId: login, sourceAccountId: email.accountId };
  }
  return null;
}

/**
 * What opening a message came to: 'opened', 'missing' when its account does
 * not have it, or the error that kept it from being tried or read.
 */
export type OpenEmailOutcome = 'opened' | 'missing' | Error;

/** Opens the message in the reader. */
export type OpenEmailHandler = (email: OpenableEmail) => Promise<OpenEmailOutcome>;

// The mail page or Pro shell on screen, the latest mounted last; it takes the
// request.
const handlers: OpenEmailHandler[] = [];

export function onOpenEmail(handler: OpenEmailHandler): () => void {
  handlers.push(handler);
  return () => {
    const at = handlers.lastIndexOf(handler);
    if (at >= 0) handlers.splice(at, 1);
  };
}

/** The permalink of a message, naming its login and account only when they are not the active login's own. */
function messagePath(email: OpenableEmail): string {
  const auth = useAuthStore.getState();
  const own = auth.getAllConnectedClients().get(email.sourceClientAccountId)?.getAccountId();
  return buildMailPath({
    mailboxId: null,
    threadId: null,
    emailId: email.id,
    loginId: email.sourceClientAccountId === auth.activeAccountId ? null : email.sourceClientAccountId,
    ownerAccountId: email.sourceAccountId === own ? null : email.sourceAccountId,
  });
}

/** Whether the message's account has it. */
async function exists(email: OpenableEmail): Promise<boolean> {
  const client = useAuthStore.getState().getAllConnectedClients().get(email.sourceClientAccountId);
  if (!client) return false;
  const found = await client.getEmailFields([email.id], [], email.sourceAccountId);
  return found.some((e) => e.id === email.id);
}

/**
 * The Pro shell's handler: the message in an email tab, as a message link
 * opens there (the tab fetches it and takes its subject as its title), once
 * its account is known to have it.
 */
export function proEmailTabOpener(loadingTitle: string): OpenEmailHandler {
  return async (email) => {
    if (!(await exists(email))) return 'missing';
    useProTabStore.getState().openEmailTab({
      accountId: email.sourceAccountId,
      clientAccountId: email.sourceClientAccountId,
      emailId: email.id,
      mailboxId: null,
      title: loadingTitle,
    });
    return 'opened';
  };
}

/** Times a minute a plugin may move the tab to a message's link. */
const LINK_LOADS_PER_MINUTE = 5;

/**
 * Times a minute a plugin may open a message in place. Opening one takes over
 * the reader and puts an open composer aside, so a plugin calling this in a
 * loop would keep the user from reading or writing; a user clicking through a
 * plugin's list stays well below it.
 */
const IN_PLACE_OPENS_PER_MINUTE = 30;

/** Checks the request and opens the message, or throws an error the plugin sees. */
export async function requestOpenEmail(plugin: InstalledPlugin, input: unknown): Promise<void> {
  const method = 'ui.openEmail';
  const data = readObject(input, method, 'email', ['id', 'accountId']);
  const id = readId(data.id, method);
  const accountId = data.accountId === undefined ? undefined : readId(data.accountId, method, 'accountId');
  const email = reachableEmail({ id, ...(accountId ? { accountId } : {}) });
  if (!email) {
    throw new Error(accountId
      ? `${method}: the user cannot read the account "${accountId}"`
      : `${method}: no account is signed in`);
  }
  const handler = handlers.at(-1);
  if (handler) {
    if (!withinRate('open-email-in-place', plugin.id, IN_PLACE_OPENS_PER_MINUTE)) {
      throw new Error(`${method}: at most ${IN_PLACE_OPENS_PER_MINUTE} times a minute`);
    }
    const outcome = await handler(email);
    if (outcome === 'missing') throw new Error(`${method}: no message "${id}" in the account`);
    if (outcome instanceof Error) throw new Error(`${method}: ${outcome.message}`);
    return;
  }
  if (!(await exists(email))) throw new Error(`${method}: no message "${id}" in the account`);
  if (!withinRate('open-email', plugin.id, LINK_LOADS_PER_MINUTE)) {
    throw new Error(`${method}: at most ${LINK_LOADS_PER_MINUTE} times a minute from outside the mail page`);
  }
  goInApp(messagePath(email), appPath(messagePath(email)));
}

/** Test helper. */
export function resetOpenEmail(): void {
  handlers.length = 0;
}
