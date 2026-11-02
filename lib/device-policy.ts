/**
 * Device policies (policy.json `organisation.devices`, enterprise pack item
 * 13): admin switches that make copying mail out of Bulwark harder: no
 * attachment downloads or opening in a new tab, no mail or folder export, no
 * printing, no install prompt, push without sender and subject, and a
 * watermark.
 *
 * Which account's policy applies (several accounts can be signed in, with
 * different domain and group scopes):
 * - for a message, attachment or file: the account it belongs to
 *   (devicesForAccount, with the email's `sourceClientAccountId` in the
 *   unified views);
 * - where there is no such thing (the install prompt, Ctrl+P, a page that
 *   mixes accounts): the strictest of every account signed in here
 *   (getStrictestDevices).
 *
 * Everything here except the push text and the office editor (both checked
 * on the server, app/api/push/preview and app/api/wopi) runs in the
 * browser: someone who knows the browser's tools can get around it, and
 * other mail apps or a screenshot always can. The admin page and the docs
 * say so.
 *
 * Every user-facing path asks canDownload/canExport/canPrint to hide its
 * button, and the anchor and new-tab helpers (lib/download-guard.ts) refuse
 * as a backstop. Never fetchBlob or fetchBlobArrayBuffer: phishing reports,
 * the export engine and previews read blobs too.
 */

import { DEFAULT_ORGANISATION_POLICY, type OrganisationPolicy } from '@/lib/admin/organisation-policy';
import { setDownloadGuard } from '@/lib/download-guard';
import { subjectForAccount } from '@/lib/org/account-subjects';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { usePolicyStore } from '@/stores/policy-store';

export type DevicePolicy = OrganisationPolicy['devices'];

export const NO_DEVICE_LIMITS: DevicePolicy = DEFAULT_ORGANISATION_POLICY.devices;

const KEYS = Object.keys(NO_DEVICE_LIMITS) as (keyof DevicePolicy)[];

function devicesOf(policy: { organisation?: OrganisationPolicy } | null | undefined): DevicePolicy {
  return { ...NO_DEVICE_LIMITS, ...(policy?.organisation?.devices ?? {}) };
}

/**
 * A local account id, something that knows which account it came from (an
 * email in a unified view, `sourceClientAccountId`), or the JMAP client of
 * an account.
 */
export type DeviceSubject = string | null | undefined | { sourceClientAccountId?: string | null } | { client: object };

/**
 * The signed-in account a message belongs to, for every device decision:
 * its stamp in the unified views and Pro tabs, else the account whose
 * folders the sidebar shows (another account's Inbox opened from the
 * multi-account sidebar), else the active account (null). The same rule as
 * resolveEmailBlobContext uses to fetch the message.
 */
export function deviceSubjectOf(email: { sourceClientAccountId?: string | null } | null | undefined): string | null {
  return email?.sourceClientAccountId ?? useEmailStore.getState().viewingAccountId ?? null;
}

function accountIdOf(subject: DeviceSubject): string | null {
  if (!subject) return null;
  if (typeof subject === 'string') return subject;
  if ('client' in subject) {
    const auth = useAuthStore.getState();
    if (subject.client === auth.client) return auth.activeAccountId ?? null;
    try {
      for (const [id, client] of auth.getAllConnectedClients?.() ?? []) if (client === subject.client) return id;
    } catch {
      // A stand-in auth store in tests.
    }
    return null;
  }
  return deviceSubjectOf(subject);
}

/** The device policy of one signed-in account (the active one for null). */
export function devicesForAccount(subject: DeviceSubject): DevicePolicy {
  const accountId = accountIdOf(subject);
  const store = usePolicyStore.getState();
  const accountSubject = subjectForAccount(accountId);
  const policy = accountSubject === store.subject ? store.policy : store.resolveFor(accountSubject);
  return devicesOf(policy);
}

/** Local ids of every account signed in here, the active one included. */
export function signedInAccountIds(): string[] {
  const auth = useAuthStore.getState();
  const ids = new Set<string>();
  try {
    for (const id of auth.getAllConnectedClients?.().keys() ?? []) ids.add(id);
  } catch {
    // A stand-in auth store in tests.
  }
  if (auth.activeAccountId) ids.add(auth.activeAccountId);
  return [...ids];
}

/** Every switch that any signed-in account has on: for pages that aren't about one account. */
export function getStrictestDevices(): DevicePolicy {
  const out: DevicePolicy = { ...devicesForAccount(null) };
  for (const id of signedInAccountIds()) {
    const devices = devicesForAccount(id);
    for (const key of KEYS) if (devices[key]) out[key] = true;
  }
  return out;
}

/** The switches that keep mail in: a copy may only go where they are at least as strict. */
const KEEP_IN: (keyof DevicePolicy)[] = ['noDownloads', 'noExport', 'noPrint', 'watermark'];

/**
 * Whether mail of account `from` may be copied into account `to` ("Copy to"
 * another signed-in account): not into an account where downloads, export
 * or printing are allowed or the watermark is off while `from` has them.
 */
export function canCopyBetween(from: DeviceSubject, to: DeviceSubject): boolean {
  const source = devicesForAccount(from);
  const target = devicesForAccount(to);
  return KEEP_IN.every((key) => !source[key] || target[key]);
}

/** Attachments and files may be downloaded or opened in a new tab. */
export function canDownload(subject?: DeviceSubject): boolean {
  return !devicesForAccount(subject).noDownloads;
}

/** Messages and folders may be exported (EML, mbox, ZIP, View source, drag-out). */
export function canExport(subject?: DeviceSubject): boolean {
  return !devicesForAccount(subject).noExport;
}

/** Messages and pages may be printed. */
export function canPrint(subject?: DeviceSubject): boolean {
  return !devicesForAccount(subject).noPrint;
}

/** For pages without one account: nothing may be downloaded if any signed-in account forbids it. */
export function canDownloadAnywhere(): boolean {
  return !getStrictestDevices().noDownloads;
}

export function canPrintAnywhere(): boolean {
  return !getStrictestDevices().noPrint;
}

export function canExportAnywhere(): boolean {
  return !getStrictestDevices().noExport;
}

// The backstop in the anchor and new-tab helpers asks this. Without an
// account (undefined) it takes the strictest of the signed-in accounts; null
// is the active account.
setDownloadGuard((kind, subject) => {
  const devices = subject === undefined ? getStrictestDevices() : devicesForAccount(subject);
  return kind === 'export' ? !devices.noExport : !devices.noDownloads;
});

/** The signed-in address of the account a message belongs to, for the watermark. */
export function watermarkAddress(subject: DeviceSubject): string {
  const accountId = accountIdOf(subject);
  const auth = useAuthStore.getState();
  if (accountId && accountId !== auth.activeAccountId) {
    const email = subjectForAccount(accountId)?.email;
    if (email) return email;
  }
  return auth.username ?? usePolicyStore.getState().subject?.email ?? '';
}

/** The text of the watermark: the user's address and today's date. */
export function watermarkText(address: string, now: Date = new Date(), locale?: string): string {
  let date: string;
  try {
    date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(now);
  } catch {
    date = now.toISOString().slice(0, 10);
  }
  return [address.trim(), date].filter(Boolean).join(' · ');
}
