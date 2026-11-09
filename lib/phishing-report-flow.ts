/**
 * The app side of "Report phishing" (lib/phishing-report.ts sends one
 * report): which policy applies to a message, sending one report per
 * message, moving each to Junk with $phishing, and undoing the move.
 *
 * The policy is the one of the account the message is reached through
 * (its own login in the unified inbox), so a domain or group scope with its
 * own report address applies to its own mail.
 */

import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Email } from '@/lib/jmap/types';
import { subjectForAccount } from '@/lib/org/account-subjects';
import { emailKeyFor } from '@/lib/thread-utils';
import { debug } from '@/lib/debug';
import { useAuthStore } from '@/stores/auth-store';
import { resolveEmailActionContext, useEmailStore } from '@/stores/email-store';
import { usePolicyStore } from '@/stores/policy-store';
import { usePhishingReportStore } from '@/stores/phishing-report-store';
import { emailHooks } from '@/lib/plugin-hooks';
import {
  PHISHING_KEYWORD,
  phishingReportSetup,
  sendPhishingReport,
  type ArfInput,
  type PhishingReportSetup,
} from './phishing-report';

/** The report setup for a message, from the policy of the account it is in. */
export function phishingSetupForEmail(email: Pick<Email, 'sourceClientAccountId'> | null | undefined): PhishingReportSetup | null {
  const view = usePolicyStore.getState();
  const subject = subjectForAccount(email?.sourceClientAccountId ?? null);
  const policy = subject === view.subject ? view.policy : view.resolveFor(subject);
  return phishingReportSetup(policy);
}

interface MovedReport {
  email: Email;
  /** Moved through the store (its undo cache knows the folder) or straight through the client. */
  via: 'store' | { client: IJMAPClient; accountId?: string; mailboxId: string };
}

export interface PhishingReportOutcome {
  /** Every address the reports went to (accounts with different policies differ). */
  addresses: string[];
  /** Reports that went out. */
  reported: Email[];
  /** Messages whose report didn't go out. */
  failed: Email[];
  /** Reported, but the move to Junk failed or a plugin stopped it. */
  notMoved: Email[];
  /** What undo moves back. */
  moved: MovedReport[];
}

// Loaded only when an admin picked the ARF format.
async function loadArfBuilder(): Promise<(input: ArfInput) => Promise<Blob>> {
  const { buildArfReportBlob } = await import('./phishing-report-arf');
  return buildArfReportBlob;
}

/** The folder a message is in, for a move back that the store can't do. */
function firstMailboxId(email: Email): string | null {
  const ids = Object.keys(email.mailboxIds ?? {}).filter((id) => email.mailboxIds[id]);
  return ids[0] ?? null;
}

/**
 * Reports each message on its own, then moves it to Junk. Messages that
 * can't be reported (reporting off for their account) count as failed.
 */
export async function reportEmailsAsPhishing(emails: Email[]): Promise<PhishingReportOutcome> {
  const active = useAuthStore.getState().client;
  if (!active) throw new Error('Not signed in');
  const outcome: PhishingReportOutcome = { addresses: [], reported: [], failed: [], notMoved: [], moved: [] };
  let buildArf: ((input: ArfInput) => Promise<Blob>) | undefined;

  for (const email of emails) {
    const setup = phishingSetupForEmail(email);
    if (!setup) {
      outcome.failed.push(email);
      continue;
    }
    if (!outcome.addresses.includes(setup.address)) outcome.addresses.push(setup.address);
    const { client, accountId } = resolveEmailActionContext(email, active);
    try {
      if (setup.format === 'arf' && !buildArf) buildArf = await loadArfBuilder();
      await sendPhishingReport(email, { client, sourceAccountId: accountId ?? client.getAccountId(), setup, buildArf });
    } catch (error) {
      debug.error('Phishing report failed:', error);
      outcome.failed.push(email);
      continue;
    }
    outcome.reported.push(email);
    // Every open view of it shows the banner and turns its links off now.
    usePhishingReportStore.getState().markReported([emailKeyFor(email)], true);

    // Like "Mark as spam" (plugins' onBeforeEmailSpamToggle still runs),
    // with $phishing, and read: it shouldn't count as new mail in Junk.
    const store = useEmailStore.getState();
    const known = store.emails.some((e) => emailKeyFor(e) === emailKeyFor(email))
      || (!!store.selectedEmail && emailKeyFor(store.selectedEmail) === emailKeyFor(email));
    try {
      if (known) {
        const moved = await store.markAsSpam(active, email.id, emailKeyFor(email), { keywords: [PHISHING_KEYWORD], markRead: true });
        if (moved) outcome.moved.push({ email, via: 'store' });
        else outcome.notMoved.push(email);
      } else {
        // A message the list doesn't hold (a Pro tab, a conversation's older
        // message): straight to its account, with the plugins' spam hooks
        // as "Mark as spam" runs them.
        const toggle = { emailIds: [email.id], spam: true };
        if (emailHooks.onBeforeEmailSpamToggle.size > 0 && !(await emailHooks.onBeforeEmailSpamToggle.intercept(toggle))) {
          outcome.notMoved.push(email);
          continue;
        }
        const mailboxId = firstMailboxId(email);
        await client.markAsSpam(email.id, accountId, true, [PHISHING_KEYWORD]);
        void emailHooks.onEmailSpamToggle.emit(toggle);
        if (mailboxId) outcome.moved.push({ email, via: { client, accountId, mailboxId } });
      }
    } catch (error) {
      debug.error('Moving a reported message to Junk failed:', error);
      outcome.notMoved.push(email);
    }
  }
  return outcome;
}

/** Moves the reported messages back and clears $junk and $phishing. Resolves to how many came back. */
export async function undoPhishingReports(outcome: PhishingReportOutcome): Promise<number> {
  const active = useAuthStore.getState().client;
  if (!active) return 0;
  let back = 0;
  for (const { email, via } of outcome.moved) {
    try {
      let done = false;
      if (via === 'store') {
        done = await useEmailStore.getState().undoSpam(active, email.id, emailKeyFor(email), { clearKeywords: [PHISHING_KEYWORD] });
      } else {
        const toggle = { emailIds: [email.id], spam: false };
        if (emailHooks.onBeforeEmailSpamToggle.size > 0 && !(await emailHooks.onBeforeEmailSpamToggle.intercept(toggle))) continue;
        await via.client.undoSpam(email.id, via.mailboxId, via.accountId, [PHISHING_KEYWORD]);
        void emailHooks.onEmailSpamToggle.emit(toggle);
        done = true;
      }
      if (done) {
        back++;
        usePhishingReportStore.getState().markReported([emailKeyFor(email)], false);
      }
    } catch (error) {
      debug.error('Moving a reported message back failed:', error);
    }
  }
  return back;
}
