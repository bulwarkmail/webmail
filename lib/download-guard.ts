/**
 * The backstop of the device policies (lib/device-policy.ts): every helper
 * that hands a file to the user, `<a download>` or a new tab, asks here
 * first. The buttons are already hidden when a policy is on; this catches a
 * path that forgot, a keyboard shortcut, a plugin, or a policy that changed
 * while a dialog was open.
 *
 * Kept free of store imports, so lib/jmap/client.ts and other low-level
 * modules can use it without an import cycle: lib/device-policy.ts installs
 * the check when it loads. Reading blobs (fetchBlob, fetchBlobArrayBuffer)
 * is never refused here, only handing them out.
 */

/** What is being handed out: an attachment or file (noDownloads), or mail (noExport). */
export type DownloadKind = 'attachment' | 'file' | 'export';

/**
 * The account the thing belongs to: a local account id, an email with
 * `sourceClientAccountId`, or the JMAP client of the account; null is the
 * active account. Left out (undefined): every signed-in account must allow
 * it.
 */
export type DownloadSubject = string | null | undefined | { sourceClientAccountId?: string | null } | { client: object };

type Guard = (kind: DownloadKind, subject: DownloadSubject) => boolean;

let guard: Guard | null = null;

/** Installed by lib/device-policy.ts. */
export function setDownloadGuard(next: Guard | null): void {
  guard = next;
}

/** The event the app listens for to say why nothing happened (components/device-policy-host.tsx). */
export const DOWNLOAD_BLOCKED_EVENT = 'bulwark:download-blocked';

/** Whether handing this out is allowed, without telling the user (the caller has another way, such as an in-app preview). */
export function downloadAllowedQuietly(kind: DownloadKind, subject?: DownloadSubject): boolean {
  try {
    return guard ? guard(kind, subject) : true;
  } catch {
    return false;
  }
}

/** Whether handing this out is allowed; says so in the app when it isn't. */
export function downloadAllowed(kind: DownloadKind, subject?: DownloadSubject): boolean {
  const allowed = downloadAllowedQuietly(kind, subject);
  if (!allowed && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(DOWNLOAD_BLOCKED_EVENT, { detail: { kind } }));
  }
  return allowed;
}

/**
 * Saves `blob` (or an object URL) as `filename` through an `<a download>`.
 * False, and nothing saved, when a device policy forbids it.
 */
export function saveBlobAs(
  data: Blob | string,
  filename: string,
  options: { kind: DownloadKind; subject?: DownloadSubject; revokeAfterMs?: number },
): boolean {
  if (!downloadAllowed(options.kind, options.subject)) return false;
  if (typeof document === 'undefined') return false;
  const url = typeof data === 'string' ? data : URL.createObjectURL(data);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 0 revokes at once (the click has started the download by then).
  if (typeof data !== 'string') {
    if (options.revokeAfterMs === 0) URL.revokeObjectURL(url);
    else setTimeout(() => URL.revokeObjectURL(url), options.revokeAfterMs ?? 60_000);
  }
  return true;
}
