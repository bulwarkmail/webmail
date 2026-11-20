/**
 * Which team notes a user has seen, per conversation: the dot on a list row
 * means "a note arrived since you last opened this conversation". Per user,
 * so not a keyword on the shared message.
 *
 * Kept in the user's own Inbox private metadata (`org.bulwarkmail.team.seen`,
 * lib/jmap/bulwark-metadata.ts) where the server has it, so it follows the
 * user across devices; in local storage otherwise (Stalwart 0.16). The own
 * Inbox's private budget is 16 KB and settings sync plans up to 12 KB of it,
 * so this entry stays under 3 KB: the oldest conversations go first.
 *
 *   { v: 1, a: { "<group account id>": { b: <minute>, s: { "<thread id>": <minute> } } } }
 *
 * Minutes since the epoch, base 36. `b` is when the user first opened that
 * team mailbox: older notes count as seen, so nobody starts with a dot on
 * every conversation of the last 90 days.
 */

export const SEEN_METADATA_KEY = 'team.seen';
export const MAX_SEEN_BYTES = 3072;

export interface TeamSeen {
  /** First time this user opened the team mailbox, ms. */
  baseline: number;
  /** Per thread id: the newest note time seen, ms. */
  threads: Record<string, number>;
}

export type SeenMap = Record<string, TeamSeen>;

const toMinute = (ms: number) => Math.floor(ms / 60_000).toString(36);
const fromMinute = (value: unknown) => (typeof value === 'string' && /^[0-9a-z]{1,10}$/.test(value) ? parseInt(value, 36) * 60_000 : NaN);

/** Reads a stored value; anything malformed is dropped, never thrown. */
export function decodeSeen(raw: unknown): SeenMap {
  const out: SeenMap = {};
  const accounts = (raw as { v?: unknown; a?: unknown } | null)?.a;
  if (!accounts || typeof accounts !== 'object' || (raw as { v?: unknown }).v !== 1) return out;
  for (const [accountId, entry] of Object.entries(accounts as Record<string, unknown>)) {
    const baseline = fromMinute((entry as { b?: unknown })?.b);
    if (!Number.isFinite(baseline)) continue;
    const threads: Record<string, number> = {};
    for (const [threadId, minute] of Object.entries(((entry as { s?: unknown }).s ?? {}) as Record<string, unknown>)) {
      const at = fromMinute(minute);
      if (Number.isFinite(at)) threads[threadId] = at;
    }
    out[accountId] = { baseline, threads };
  }
  return out;
}

/**
 * The stored value, at most MAX_SEEN_BYTES: threads seen longest ago are
 * dropped first (a dropped thread falls back to the baseline, so at worst an
 * old conversation's dot comes back), and threads already covered by the
 * baseline are never stored.
 */
export function encodeSeen(map: SeenMap, maxBytes = MAX_SEEN_BYTES): { v: 1; a: Record<string, { b: string; s: Record<string, string> }> } {
  const rows: Array<{ accountId: string; threadId: string; at: number }> = [];
  for (const [accountId, seen] of Object.entries(map)) {
    for (const [threadId, at] of Object.entries(seen.threads)) {
      if (at > seen.baseline) rows.push({ accountId, threadId, at });
    }
  }
  rows.sort((a, b) => b.at - a.at);
  const build = (count: number) => {
    const a: Record<string, { b: string; s: Record<string, string> }> = {};
    for (const [accountId, seen] of Object.entries(map)) a[accountId] = { b: toMinute(seen.baseline), s: {} };
    for (const row of rows.slice(0, count)) a[row.accountId].s[row.threadId] = toMinute(row.at);
    return { v: 1 as const, a };
  };
  let count = rows.length;
  let value = build(count);
  // Shrink by halves, then step back up: a few rounds, not one per thread.
  if (bytes(value) > maxBytes) {
    let low = 0;
    let high = count;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (bytes(build(mid)) <= maxBytes) low = mid;
      else high = mid - 1;
    }
    count = low;
    value = build(count);
  }
  return value;
}

function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Whether a note at `at` by someone else is new to the user in this thread. */
export function isUnseen(seen: TeamSeen | undefined, threadId: string, at: number): boolean {
  if (!seen) return false;
  return at > Math.max(seen.baseline, seen.threads[threadId] ?? 0);
}

/** Marks a thread seen up to `at` (never backwards). */
export function markThreadSeen(map: SeenMap, accountId: string, threadId: string, at: number, now = Date.now()): SeenMap {
  const current = map[accountId] ?? { baseline: now, threads: {} };
  if ((current.threads[threadId] ?? 0) >= at) return map;
  return { ...map, [accountId]: { ...current, threads: { ...current.threads, [threadId]: at } } };
}
