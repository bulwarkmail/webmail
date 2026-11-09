/**
 * Mail Nora deleted for good (emptied from Trash) that the server still
 * keeps: Stalwart Enterprise's archive of deleted items, which Settings >
 * Recover deleted items lists and restores (lib/recovery/archived-items.ts).
 *
 * Each entry is the x:ArchivedItem the server answers with (`@type`,
 * `from` as "Name <address>", `archivedAt` when it was deleted for good,
 * `archivedUntil` when the server drops it) and the message a restore puts
 * back in the Inbox: unread, without keywords, under its own date.
 */
import type { Email } from '@/lib/jmap/types';
import { at, authPass, listHeaders, mail } from './mail';
import { MB } from './mailboxes';
import { addr, BOB, LISA, PRIYA, WORK_DOMAIN } from './people';

export interface DemoArchivedItem {
  /** The x:ArchivedItem/get record. */
  item: {
    '@type': 'Email';
    id: string;
    accountId: string;
    from: string;
    subject: string;
    receivedAt: string;
    archivedAt: string;
    archivedUntil: string;
    size: number;
    blobId: string;
  };
  /** The message as it comes back. */
  email: Email;
}

/** How long the server keeps deleted mail (Stalwart's archiveDeletedItemsFor). */
const KEEP_DAYS = 30;

export function createDemoArchivedItems(accountId: string): DemoArchivedItem[] {
  const entry = (archivedDaysAgo: number, archivedHour: number, email: Email): DemoArchivedItem => {
    const from = email.from![0];
    const archivedAt = at(archivedDaysAgo, archivedHour, 12);
    return {
      item: {
        '@type': 'Email',
        id: `archived-${email.id}`,
        accountId,
        from: `${from.name} <${from.email}>`,
        subject: email.subject ?? '',
        receivedAt: email.receivedAt,
        archivedAt,
        archivedUntil: new Date(new Date(archivedAt).getTime() + KEEP_DAYS * 86_400_000).toISOString(),
        size: email.size,
        blobId: `archived-blob-${email.id}`,
      },
      // Back in the Inbox, unread and without keywords, as the restore task leaves it.
      email: { ...email, mailboxIds: { [MB.inbox]: true }, keywords: {} },
    };
  };

  return [
    entry(1, 18, mail({
      id: 'demo-archived-budget-v2', mailbox: MB.inbox, date: at(3, 14, 5),
      from: addr(PRIYA),
      subject: 'Beacon budget v2: infra line items',
      text: 'Nora,\n\nUpdated the infra part of the Beacon budget after the soak test. The eu-2 replicas stay at three, so the monthly line goes from 4,200 to 5,100 EUR. Everything else is unchanged. The sheet is in Documents/budget-2026.xlsx, tab "Beacon".\n\nCan you sign this off before the go/no-go? Finance wants it by the end of the week.\n\nPriya',
      headers: authPass(WORK_DOMAIN),
    })),
    entry(2, 9, mail({
      id: 'demo-archived-canary-list', mailbox: MB.inbox, date: at(4, 16, 40),
      from: addr(BOB),
      subject: 'Canary tenants: final list',
      text: 'The five canary tenants for the 5% step, all agreed with their account managers:\n\n1. Lumen Logistics\n2. Hoffmann & Partner\n3. Demir Retail\n4. Northwind\n5. Cooper Creative\n\nThey all have webhooks on and more than 1,000 deliveries a day, so we see problems fast.\n\nBob',
      headers: authPass(WORK_DOMAIN),
    })),
    entry(3, 11, mail({
      id: 'demo-archived-infra-weekly', mailbox: MB.inbox, date: at(5, 6, 0),
      from: { name: 'Infra Weekly', email: 'digest@infraweekly.example' },
      subject: 'Infra Weekly #212: rollbacks, retries and one very long postmortem',
      text: 'Infra Weekly #212\n\n1. Rolling back without rolling over: notes from three teams that roll back by numbers, not by feeling.\n2. Retry budgets in practice.\n3. The postmortem of the week is 40 pages long and worth all of them.\n\nManage your subscription at infraweekly.example/manage.',
      headers: { ...authPass('infraweekly.example'), ...listHeaders('Infra Weekly', 'infraweekly.example') },
    })),
    entry(6, 15, mail({
      id: 'demo-archived-blog-draft', mailbox: MB.inbox, date: at(8, 10, 20),
      from: addr(LISA),
      subject: 'Launch post: first draft',
      text: 'Hi Nora,\n\nFirst draft of the Beacon launch post is in the shared doc. I kept the technical part short and linked the docs instead. Could you check the paragraph on retries? I am not sure I got the budget right.\n\nLisa',
      headers: authPass(WORK_DOMAIN),
    })),
  ];
}
