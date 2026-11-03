/**
 * Which messages count as new mail for the desktop app's notifications, for every
 * connected login, whichever page or folder is open.
 *
 * With the local store the source is its `created` event (noteCreatedEmails): the
 * engine has already worked out the delta. Without one, each login's push change is
 * resolved here with Email/changes on a baseline of its own, the way
 * reportNewInboxMail does for plugins. Both can see the same message; it's only told
 * once.
 */

import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { isMailboxMuted } from '@/lib/notification-mutes';
import { subscribePushStateChanges } from '@/lib/push-events';
import { useSettingsStore } from '@/stores/settings-store';

export interface NewMail {
  client: IJMAPClient;
  /** The JMAP account the message is in. */
  accountId: string;
  email: Email;
}

const MAX_PAGES = 5;
const MAX_CHANGES = 200;
const SEEN_LIMIT = 500;
/** An import or a restore creates old mail: nobody is waiting to hear about that. */
const NEWEST_AGE_MS = 24 * 60 * 60 * 1000;
/** Folders mail lands in by itself, when not only the Inbox notifies. */
const NOT_ARRIVALS = new Set(['junk', 'trash', 'sent', 'drafts', 'archive']);

function mailboxIdsOf(email: Email): string[] {
  return Object.keys(email.mailboxIds ?? {}).filter((id) => email.mailboxIds[id]);
}

/** The folder a new message counts for, or null if it stays silent. */
export function notifyingMailbox(email: Email, accountId: string, ownAccountId: string, mailboxes: readonly Mailbox[], now = Date.now()): Mailbox | null {
  if (email.keywords?.$seen || email.keywords?.$draft) return null;
  const received = email.receivedAt ? new Date(email.receivedAt).getTime() : now;
  if (now - received > NEWEST_AGE_MS) return null;
  const { notificationMutes, pushNotifyInboxOnly } = useSettingsStore.getState();
  const here = new Set(mailboxIdsOf(email));
  const mine = mailboxes.filter((mailbox) => (mailbox.accountId ?? ownAccountId) === accountId && here.has(mailbox.originalId || mailbox.id));
  const counts = mine.filter((mailbox) => (pushNotifyInboxOnly ? mailbox.role === 'inbox' : !NOT_ARRIVALS.has(mailbox.role ?? '')));
  // Mail filed in a muted folder and an unmuted one still notifies.
  return counts.find((mailbox) => !isMailboxMuted(notificationMutes, accountId, mailbox.originalId || mailbox.id)) ?? null;
}

export interface NewMailWatch {
  /** The local store's `created` event for this login's account. */
  noteCreated(client: IJMAPClient, accountId: string, ids: readonly string[]): void;
  /** Takes a state to work from, so the first push after the start can tell what's new. */
  seed(client: IJMAPClient): void;
  stop(): void;
}

export function startNewMailWatch(onMail: (mail: NewMail[]) => void): NewMailWatch {
  const baselines = new WeakMap<IJMAPClient, Map<string, string>>();
  const seen: string[] = [];
  let queue: Promise<void> = Promise.resolve();
  let stopped = false;

  const baselinesOf = (client: IJMAPClient) => {
    let map = baselines.get(client);
    if (!map) {
      map = new Map();
      baselines.set(client, map);
    }
    return map;
  };

  const enqueue = (run: () => Promise<void>) => {
    const next = queue.then(run, run).catch((error) => {
      console.error('Failed to check for new mail:', error);
    });
    queue = next;
    return next;
  };

  const report = async (client: IJMAPClient, accountId: string, ids: readonly string[]) => {
    const fresh = ids.filter((id) => !seen.includes(`${accountId}/${id}`));
    if (fresh.length === 0 || stopped) return;
    for (const id of fresh) seen.push(`${accountId}/${id}`);
    seen.splice(0, Math.max(0, seen.length - SEEN_LIMIT));
    const [emails, mailboxes] = await Promise.all([client.getSomeEmails(fresh, accountId), client.getAllMailboxes()]);
    const own = client.getAccountId();
    const mail = emails
      .filter((email) => notifyingMailbox(email, accountId, own, mailboxes))
      .map((email) => ({ client, accountId, email }));
    if (mail.length > 0 && !stopped) onMail(mail);
  };

  const check = async (client: IJMAPClient, accountId: string, pushed: string) => {
    const map = baselinesOf(client);
    const since = map.get(accountId);
    if (!since || !client.getEmailChanges) {
      map.set(accountId, pushed);
      return;
    }
    if (since === pushed) return;
    const created: string[] = [];
    let state = since;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const delta = await client.getEmailChanges(state, accountId, MAX_CHANGES);
      if (!delta) {
        // Too old for the server: start again from here.
        map.set(accountId, pushed);
        return;
      }
      created.push(...delta.created);
      state = delta.newState;
      if (!delta.hasMoreChanges) break;
    }
    map.set(accountId, state);
    await report(client, accountId, created);
  };

  const stopPush = subscribePushStateChanges((change, client) => {
    for (const [accountId, types] of Object.entries(change.changed ?? {})) {
      const pushed = types?.Email;
      if (pushed) void enqueue(() => check(client, accountId, pushed));
    }
  });

  return {
    noteCreated(client, accountId, ids) {
      void enqueue(() => report(client, accountId, ids));
    },
    seed(client) {
      void enqueue(async () => {
        const map = baselinesOf(client);
        const own = client.getAccountId();
        const mailboxes = await client.getAllMailboxes();
        const inboxes = mailboxes.filter((mailbox) => mailbox.role === 'inbox');
        await Promise.all(inboxes.map(async (inbox) => {
          const accountId = inbox.accountId ?? own;
          if (map.has(accountId)) return;
          const { state } = await client.getEmails(inbox.originalId || inbox.id, accountId, 1);
          if (state && !map.has(accountId)) map.set(accountId, state);
        }));
      });
    },
    stop() {
      stopped = true;
      stopPush();
    },
  };
}
