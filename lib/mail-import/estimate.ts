/**
 * How long an import takes at a server's upload limit. Stalwart's default is 1000
 * uploads or 50 MB per user per hour, and each message is an upload. Without a count of
 * the messages this goes by bytes, so it is the least the import can take.
 */

export const DEFAULT_UPLOAD_LIMIT = { files: 1000, bytes: 50_000_000 };

export function importHours(
  amount: { bytes: number; messages?: number },
  limit: { files?: number; bytes?: number } = DEFAULT_UPLOAD_LIMIT,
): number {
  const byBytes = amount.bytes / (limit.bytes || DEFAULT_UPLOAD_LIMIT.bytes);
  const byCount = (amount.messages ?? 0) / (limit.files || DEFAULT_UPLOAD_LIMIT.files);
  return Math.max(byBytes, byCount);
}

export type DurationWords = { unit: "hours" | "days"; count: number };

/** Below this the limit doesn't matter enough to mention: the dialog's general note covers it. */
export const WORTH_SAYING_HOURS = 1;

/** Whole hours up to two days, whole days after that, rounded up. */
export function durationWords(hours: number): DurationWords {
  if (hours < 48) return { unit: "hours", count: Math.ceil(hours) };
  return { unit: "days", count: Math.ceil(hours / 24) };
}
