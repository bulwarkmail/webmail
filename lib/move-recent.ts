/**
 * The folders messages were last moved to, per account, most recent first.
 * Kept on this device only; the Move lists show the few that still exist.
 */

const KEY = "bulwark.moveRecent.v1";
const KEPT = 8;

type Store = Record<string, string[]>;

function read(): Store {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Store = {};
    for (const [account, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(ids)) out[account] = ids.filter((id): id is string => typeof id === "string").slice(0, KEPT);
    }
    return out;
  } catch {
    return {};
  }
}

export function readRecentMoveTargets(accountId: string | undefined): string[] {
  if (!accountId) return [];
  return read()[accountId] ?? [];
}

export function noteMoveTarget(accountId: string | undefined, mailboxId: string): void {
  if (!accountId || !mailboxId) return;
  const store = read();
  store[accountId] = [mailboxId, ...(store[accountId] ?? []).filter((id) => id !== mailboxId)].slice(0, KEPT);
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Storage full or off: the list just has no recents.
  }
}
