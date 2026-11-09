/** Storage quota as the UI shows it. */
export interface StorageQuota {
  used: number;
  /**
   * The limit the user actually works against: softLimit when the server
   * sets one below hardLimit, since writes start failing there (RFC 9425
   * §4.1, #1242). Otherwise hardLimit.
   */
  total: number;
  /** hardLimit, only when it is above `total` (inbound mail still lands up to it). */
  hardLimit?: number;
  /** warnLimit, only when it is below `total`. */
  warnAt?: number;
}

/** A Quota object as RFC 9425 defines it, plus the pre-RFC `limit` some servers send. */
export interface JMAPQuota {
  resourceType?: string;
  scope?: string;
  types?: string[];
  used?: number;
  hardLimit?: number;
  softLimit?: number | null;
  warnLimit?: number | null;
  limit?: number;
}

const positive = (n: number | null | undefined): n is number =>
  typeof n === "number" && Number.isFinite(n) && n > 0;

/** Picks the mail storage quota out of a Quota/get list. */
export function toStorageQuota(quotas: JMAPQuota[]): StorageQuota | null {
  const coversMail = (q: JMAPQuota) =>
    !q.types?.length || q.types.some((t) => t === "Email" || t === "Mail");
  // storage quotas use resourceType "octets" (e.g. Stalwart, with
  // scope "account"); fall back to the pre-RFC "mail" shape for older servers.
  const q =
    quotas.find((q) => q.resourceType === "octets" && coversMail(q)) ||
    quotas.find((q) => q.resourceType === "mail" || q.scope === "mail");
  return q ? fromQuota(q) : null;
}

/**
 * Picks the storage quota Files counts against out of a Quota/get list: an octets quota whose
 * types name FileNode (the one with the fewest other types, if several), else one that names no
 * types and so covers everything. Stalwart 1.0 and 0.16 both send one shared quota, `scope`
 * account, types Email, SieveScript, FileNode, CalendarEvent and ContactCard, and only when the
 * account has a limit; with none the list is empty.
 */
export function toFilesQuota(quotas: JMAPQuota[]): StorageQuota | null {
  const octets = quotas.filter((q) => q.resourceType === "octets");
  const forFiles = octets
    .filter((q) => q.types?.includes("FileNode"))
    .sort((a, b) => (a.types?.length ?? 0) - (b.types?.length ?? 0));
  const q = forFiles[0] ?? octets.find((q) => !q.types?.length);
  return q ? fromQuota(q) : null;
}

function fromQuota(q: JMAPQuota): StorageQuota {
  const hard = q.hardLimit ?? q.limit ?? 0;
  const soft = positive(q.softLimit) && (!positive(hard) || q.softLimit < hard) ? q.softLimit : undefined;
  const total = soft ?? hard;
  const quota: StorageQuota = { used: q.used ?? 0, total };
  if (soft !== undefined && positive(hard)) quota.hardLimit = hard;
  if (positive(q.warnLimit) && (!positive(total) || q.warnLimit < total)) quota.warnAt = q.warnLimit;
  return quota;
}

export type QuotaLevel = "ok" | "warn" | "full";

/** Colour band for a quota: warnLimit when the server sets one, else 70%; full above 90%. */
export function quotaLevel(quota: StorageQuota): QuotaLevel {
  if (quota.total <= 0) return "ok";
  if (quota.used / quota.total > 0.9) return "full";
  if (quota.warnAt !== undefined ? quota.used >= quota.warnAt : quota.used / quota.total > 0.7) return "warn";
  return "ok";
}
