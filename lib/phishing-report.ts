/**
 * "Report phishing" (enterprise pack item 2): sends a message to the
 * address the admin set (policy.json `organisation.phishingReport`) and
 * moves it to Junk with $junk and $phishing. A sibling of
 * lib/plugin-sandbox/host-api-forward.ts: it sends without the composer.
 *
 * - One report per message, also for a selection: report desks (Microsoft
 *   Defender among them) discard reports with several messages attached,
 *   and RFC 5965 §2(e) says one message per report.
 * - No copy in Sent: a live phishing message shouldn't sit there to be
 *   clicked again; the admin's mailbox is the record.
 * - The forward format attaches the original by its blobId (Email/set in
 *   Drafts, then EmailSubmission with onSuccessDestroyEmail), so nothing is
 *   uploaded and nothing counts against the upload quota. A message of
 *   another account (a shared or group mailbox) has its blob copied to the
 *   sending account first (Blob/copy).
 * - The report skips the pre-send checks and finalisers of the send
 *   pipeline (external-recipient confirm, organisation signature and
 *   disclaimer), classification labels and plugins' onBeforeEmailSend: the
 *   address is the admin's, and the report is not the user's mail (send
 *   surface 'report-phishing', never passed to the pipeline).
 */

import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Email, Identity } from '@/lib/jmap/types';
import type { SettingsPolicy } from '@/lib/admin/types';
import { DEFAULT_ORGANISATION_POLICY, type PhishingReportFormat } from '@/lib/admin/organisation-policy';
import { emailExportFilename } from '@/lib/download-filename';
import { sortIdentities } from '@/lib/identity-order';

/** RFC 9051 §2.3.2: the user reported the message as phishing. */
export const PHISHING_KEYWORD = '$phishing';

export interface PhishingReportSetup {
  address: string;
  format: PhishingReportFormat;
}

/** The setup in a policy; null while reporting is off (no address). */
export function phishingReportSetup(policy: SettingsPolicy | null | undefined): PhishingReportSetup | null {
  const section = policy?.organisation?.phishingReport ?? DEFAULT_ORGANISATION_POLICY.phishingReport;
  const address = section.address.trim();
  return address ? { address, format: section.format === 'arf' ? 'arf' : 'forward' } : null;
}

/** Folders whose messages are the user's own: nothing to report there. */
const OWN_MAIL_ROLES = new Set(['sent', 'drafts', 'scheduled']);

/**
 * Whether `email`, shown in a folder of `mailboxRole`, can be reported.
 * `folderRoles`: the roles of the folders the message itself is in (search
 * results and All mail show the user's own sent mail too).
 */
export function isReportable(
  email: Pick<Email, 'blobId' | 'keywords' | 'isScheduled'>,
  mailboxRole?: string | null,
  folderRoles: readonly string[] = [],
): boolean {
  if (!email.blobId || email.isScheduled) return false;
  if (mailboxRole && OWN_MAIL_ROLES.has(mailboxRole)) return false;
  if (folderRoles.some((role) => OWN_MAIL_ROLES.has(role))) return false;
  if (email.keywords?.$draft) return false;
  // Reported already: it is in Junk with its links off.
  return email.keywords?.[PHISHING_KEYWORD] !== true;
}

/** The subject of the report: Microsoft's reporting mailboxes read "Phishing:" as the verdict. */
export function reportSubject(subject: string | undefined | null): string {
  const clean = (subject ?? '').replace(/[\r\n]+/g, ' ').trim();
  return clean ? `Phishing: ${clean}` : 'Phishing';
}

/** The short text of a forwarded report. English: it is read by the security team, not the user. */
export function reportText(reporter: { name?: string; email: string }): string {
  const who = reporter.name?.trim() ? `${reporter.name.trim()} <${reporter.email}>` : reporter.email;
  return `Reported as phishing by ${who} with Bulwark.\r\nThe reported message is attached unchanged.\r\n`;
}

/** The identity a report goes out from: the login's own address first. */
export function reporterIdentity(identities: Identity[], username: string): Identity | null {
  const usable = identities.filter((identity) => identity.email && !identity.email.includes('*'));
  return sortIdentities(usable, username)[0] ?? null;
}

export interface ReportContext {
  /** The login the message is reachable through. */
  client: IJMAPClient;
  /** The JMAP account the message lives in (a shared one, for a group mailbox). */
  sourceAccountId: string;
  setup: PhishingReportSetup;
  /** Builds the raw ARF report (lib/phishing-report-arf.ts); needed for format 'arf'. */
  buildArf?: (input: ArfInput) => Promise<Blob>;
}

export interface ArfInput {
  client: IJMAPClient;
  email: Email;
  sourceAccountId: string;
  reporter: Identity;
  to: string;
}

/**
 * Sends one report for `email`. Throws when nothing went out; resolves once
 * the server took the submission.
 */
export async function sendPhishingReport(email: Email, ctx: ReportContext): Promise<void> {
  const { client, setup } = ctx;
  if (!email.blobId) throw new Error('The message has no content to report');
  const identity = reporterIdentity(await client.getIdentities(), client.getUsername());
  if (!identity) throw new Error('No sender address to report from');

  if (setup.format === 'arf') {
    if (!ctx.buildArf) throw new Error('ARF reports are not available');
    const raw = await ctx.buildArf({ client, email, sourceAccountId: ctx.sourceAccountId, reporter: identity, to: setup.address });
    // Imported into Drafts and destroyed once submitted: no Sent copy.
    await client.submitRawEmail(raw, identity.id, undefined, [setup.address]);
    return;
  }

  // The original's own blob, attached by id; copied over when the message
  // lives in another account than the one the report goes out from.
  const sendAccountId = (await client.resolveSendAccountId?.(identity.email)) ?? client.getAccountId();
  let blobId = email.blobId;
  if (ctx.sourceAccountId !== sendAccountId) {
    const copied = await client.copyBlobs(ctx.sourceAccountId, [blobId], sendAccountId);
    const copy = copied[blobId];
    if (!copy) throw new Error('The message could not be copied to the account that sends the report');
    blobId = copy;
  }
  await client.sendEmail(
    [setup.address],
    reportSubject(email.subject),
    reportText(identity),
    undefined,
    undefined,
    identity.id,
    identity.email,
    undefined,
    identity.name || undefined,
    undefined,
    [{
      blobId,
      name: emailExportFilename(email, { template: '{date}-{subject}' }),
      type: 'message/rfc822',
      size: email.size,
      disposition: 'attachment',
    }],
    undefined,
    undefined,
    undefined,
    undefined,
    { noSentCopy: true },
  );
}
