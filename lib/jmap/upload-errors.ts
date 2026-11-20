/**
 * Blob uploads the server refused, with what the UI needs to explain them.
 *
 * The client throws "Failed to upload file: <status> - <body>" (the mail
 * import and the offline outbox read that message), or a RateLimitError when
 * the upload went through its fetch path. Either way the error is marked with
 * the HTTP status and, for a 429, how long the server asked to wait.
 */

export type UploadError = Error & {
  uploadStatus?: number;
  /** From Retry-After; undefined when the server didn't send it or the browser may not read it (CORS). */
  uploadRetryAfterMs?: number;
};

/** Milliseconds a Retry-After value asks to wait: delay-seconds or an HTTP date. Undefined when missing or unreadable. */
export function retryAfterMs(header: string | null | undefined, now: number = Date.now()): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** Marks `error` as an upload refused with `status`, keeping its message and class. */
export function markUploadRefused<E extends Error>(error: E, status: number, retryAfterHeader?: string | null): E {
  const marked = error as E & UploadError;
  marked.uploadStatus = status;
  const wait = status === 429 ? retryAfterMs(retryAfterHeader) : undefined;
  if (wait !== undefined) marked.uploadRetryAfterMs = wait;
  return error;
}

/** The error for an upload the server answered with an error status. */
export function uploadRefusedError(status: number, body: string, retryAfterHeader?: string | null): UploadError {
  return markUploadRefused(new Error(`Failed to upload file: ${status} - ${body}`), status, retryAfterHeader);
}

/**
 * For an upload refused with HTTP 429 (too many uploads): how long the server
 * asked to wait, when it said so. Null for any other error.
 */
export function uploadRateLimit(error: unknown): { retryAfterMs?: number } | null {
  if (!(error instanceof Error)) return null;
  const marked = error as UploadError;
  if (marked.uploadStatus === 429) {
    return marked.uploadRetryAfterMs !== undefined ? { retryAfterMs: marked.uploadRetryAfterMs } : {};
  }
  // A client that doesn't mark its errors (a plugin's, an older build's).
  if (marked.uploadStatus === undefined && /^Failed to upload file: 429\b/.test(error.message)) return {};
  return null;
}

/** Whole minutes to wait, at least one. */
export function retryAfterMinutes(ms: number): number {
  return Math.max(1, Math.ceil(ms / 60_000));
}
