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

import { downloadNameForType } from '@/lib/file-preview';

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

/** The type of every object URL a download is saved from. */
const DOWNLOAD_BLOB_TYPE = 'application/octet-stream';

/**
 * Whether the browser may start a download only after the click has
 * returned: WebKit (Safari, and every browser on iOS), the first time also
 * after its "Allow downloads" prompt. Chromium (also the desktop app) and
 * Firefox have the download under way when the click returns.
 */
function downloadMayStartLater(): boolean {
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent ?? '';
  return /AppleWebKit/.test(agent) && !/Chrome\/|Chromium\/|Edg\//.test(agent);
}

/**
 * Saves `blob` (or an object URL) as `filename` through an `<a download>`.
 * False, and nothing saved, when a device policy forbids it.
 *
 * A Blob is saved from an object URL of its own typed
 * application/octet-stream, whatever type the Blob carries. While that URL
 * lives it can be loaded on its own (the browser's downloads list keeps it as
 * the file's address), and a browser that ignores `download` opens it in the
 * tab: either way the browser saves the file again rather than showing it as
 * a document of the webmail origin. The file keeps its name, which is what
 * the operating system opens it by; a name without an extension gets the
 * one of the Blob's type when that type is on the inline-safe list
 * (downloadNameForType() in lib/file-preview.ts). The URL is revoked right
 * after the click, which has started the download by then, or after a minute
 * in a browser that may start it later; `revokeAfterMs` sets another delay.
 * An object URL passed in is the caller's and keeps its type, its name and
 * its lifetime.
 */
export function saveBlobAs(
  data: Blob | string,
  filename: string,
  options: { kind: DownloadKind; subject?: DownloadSubject; revokeAfterMs?: number },
): boolean {
  if (!downloadAllowed(options.kind, options.subject)) return false;
  if (typeof document === 'undefined') return false;
  const url = typeof data === 'string'
    ? data
    : URL.createObjectURL(data.type === DOWNLOAD_BLOB_TYPE ? data : data.slice(0, data.size, DOWNLOAD_BLOB_TYPE));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = typeof data === 'string' ? filename : downloadNameForType(filename, data.type);
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof data !== 'string') {
    const revokeAfterMs = options.revokeAfterMs ?? (downloadMayStartLater() ? 60_000 : 0);
    if (revokeAfterMs === 0) URL.revokeObjectURL(url);
    else setTimeout(() => URL.revokeObjectURL(url), revokeAfterMs);
  }
  return true;
}
