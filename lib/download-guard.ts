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
 * The event the app listens for when iOS wants a fresh tap before it opens
 * the share sheet (components/share-sheet-host.tsx); detail.file is the File.
 */
export const SHARE_NEEDS_TAP_EVENT = 'bulwark:share-needs-tap';

/** An iPhone or iPad, the latter also when it asks for desktop sites and calls itself a Mac. */
export function isAppleMobile(
  nav: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> | undefined = typeof navigator === 'undefined' ? undefined : navigator,
): boolean {
  if (!nav) return false;
  if (/iPhone|iPad|iPod/.test(nav.userAgent ?? '')) return true;
  return nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1;
}

/** Extensions iOS shows in its download preview: PDF, pictures, audio and video, text, Office and iWork files. */
const IOS_PREVIEWABLE_EXT = new Set([
  'pdf', 'jpg', 'jpeg', 'png', 'gif', 'heic', 'heif', 'webp', 'bmp', 'tif', 'tiff',
  'mp4', 'mov', 'm4v', 'mp3', 'm4a', 'wav', 'aac',
  'txt', 'csv', 'rtf',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pages', 'numbers', 'key',
]);

/** Whether iOS can show this file in its download preview, by its type or its name. */
export function iosCanPreview(filename: string, type?: string): boolean {
  const mime = (type || '').toLowerCase().split(';')[0].trim();
  if (mime === 'application/pdf' || /^(image|video|audio)\//.test(mime) || mime === 'text/plain' || mime === 'text/csv') return true;
  const dot = filename.lastIndexOf('.');
  return dot >= 0 && IOS_PREVIEWABLE_EXT.has(filename.slice(dot + 1).toLowerCase());
}

function errorName(err: unknown): string {
  return err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
}

/**
 * On an iPhone or iPad, a blob: download opens in a preview window, and
 * above all in a web app on the home screen, there is nothing else. What iOS
 * can preview is fine there. An archive (a "Download all" zip) or an unknown
 * type comes up as a blank page with a file icon and no way to keep it. Such
 * a file goes to the share sheet instead, where "Save to Files" works. True
 * when it went there; false leaves it to the <a download>.
 *
 * The share sheet opens only straight after a tap. When fetching or zipping
 * took longer, SHARE_NEEDS_TAP_EVENT asks the app for one.
 */
function shareOnAppleMobile(blob: Blob, filename: string): boolean {
  if (typeof navigator === 'undefined' || !isAppleMobile() || iosCanPreview(filename, blob.type)) return false;
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
  const file = new File([blob], filename, { type: blob.type || DOWNLOAD_BLOB_TYPE });
  if (!navigator.canShare({ files: [file] })) return false;
  navigator.share({ files: [file] }).catch((err: unknown) => {
    const why = errorName(err);
    if (why === 'AbortError') return; // the sheet was closed
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(SHARE_NEEDS_TAP_EVENT, { detail: { file } }));
    }
  });
  return true;
}

/**
 * Whether the browser may start a download long after the click: WebKit
 * (Safari, and every browser on iOS), the first time only after its "Allow
 * downloads" prompt. Chromium (also the desktop app) and Firefox start it
 * from a task the click queues, which runs once the page's current task is
 * done; Firefox loses the download when the URL is revoked before that.
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
 * (downloadNameForType() in lib/file-preview.ts). The URL is never revoked
 * in the click's own task: it goes in a zero timeout, or after a minute in a
 * browser that may start the download later. `revokeAfterMs` sets another
 * delay, 0 being the zero timeout. An object URL passed in is the caller's
 * and keeps its type, its name and its lifetime.
 */
export function saveBlobAs(
  data: Blob | string,
  filename: string,
  options: { kind: DownloadKind; subject?: DownloadSubject; revokeAfterMs?: number },
): boolean {
  if (!downloadAllowed(options.kind, options.subject)) return false;
  if (typeof document === 'undefined') return false;
  if (typeof data !== 'string' && shareOnAppleMobile(data, downloadNameForType(filename, data.type))) return true;
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
    setTimeout(() => URL.revokeObjectURL(url), revokeAfterMs);
  }
  return true;
}
