'use client';

import { useCallback, useMemo } from 'react';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { isReportable } from '@/lib/phishing-report';
import { isPhishingMarked } from '@/lib/phishing-links';
import { phishingSetupForEmail } from '@/lib/phishing-report-flow';
import { useAccountSubjects } from '@/lib/org/account-subjects';
import { emailKeyFor } from '@/lib/thread-utils';
import { usePolicyStore } from '@/stores/policy-store';
import { useEmailStore } from '@/stores/email-store';
import { usePhishingReportStore } from '@/stores/phishing-report-store';

/**
 * The roles of the folders a message is in, from the mailboxes the store
 * knows: in search results or All mail the open folder says nothing about
 * whether a message is the user's own sent mail.
 */
function folderRoles(email: Email, mailboxes: Mailbox[]): string[] {
  const roles: string[] = [];
  for (const id of Object.keys(email.mailboxIds ?? {})) {
    const box = mailboxes.find((m) => m.id === id || m.originalId === id);
    if (box?.role) roles.push(box.role);
  }
  return roles;
}

function reportable(email: Email, mailboxRole: string | null | undefined, mailboxes: Mailbox[]): boolean {
  return isReportable(email, mailboxRole, folderRoles(email, mailboxes)) && !!phishingSetupForEmail(email);
}

/** Asks "Report phishing?" for the messages of `emails` that can be reported. */
export function requestPhishingReport(emails: Email[], mailboxRole?: string | null): void {
  const mailboxes = useEmailStore.getState().mailboxes;
  const list = emails.filter((email) => reportable(email, mailboxRole, mailboxes));
  if (list.length === 0) return;
  // A selection across accounts may go to more than one address: name each.
  const addresses = [...new Set(list.map((email) => phishingSetupForEmail(email)!.address))];
  usePhishingReportStore.getState().ask(list, addresses);
}

/**
 * "Report phishing" for a set of messages in a folder of `mailboxRole`:
 * available while the admin set an address for at least one of their
 * accounts and one of them can be reported. Follows the policy as it loads.
 */
export function usePhishingReport(emails: ReadonlyArray<Email | null | undefined>, mailboxRole?: string | null) {
  const policy = usePolicyStore((s) => s.policy);
  const rawPolicy = usePolicyStore((s) => s.rawPolicy);
  const subjects = useAccountSubjects((s) => s.subjects);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const reported = usePhishingReportStore((s) => s.reported);
  const list = useMemo(() => emails.filter((e): e is Email => !!e), [emails]);
  const candidates = useMemo(
    () => list.filter((email) => !reported[emailKeyFor(email)] && reportable(email, mailboxRole, mailboxes)),
    // The setup is read from the stores these follow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [list, mailboxRole, mailboxes, reported, policy, rawPolicy, subjects],
  );
  const report = useCallback(() => requestPhishingReport(candidates, mailboxRole), [candidates, mailboxRole]);
  return { available: candidates.length > 0, count: candidates.length, report };
}

/**
 * Whether a message shows as reported: its $phishing keyword, or reported
 * in this session (a view that holds its own copy of the message, like a
 * Pro tab, doesn't see the new keyword until it loads the message again).
 */
export function usePhishingMarked(email: Email | null | undefined): boolean {
  const reported = usePhishingReportStore((s) => (email ? s.reported[emailKeyFor(email)] === true : false));
  return isPhishingMarked(email) || reported;
}
