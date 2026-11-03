/**
 * One tab fires a reminder when there's no local store to decide it. The list sits in
 * localStorage and holds no more than the event's uid, and the Web Lock makes reading
 * and writing it one step across tabs: their timers run out at the same moment, so a
 * plain read and write would let both through.
 *
 * Keys are the series' uid, never the id: synthetic ids reshuffle when an override
 * changes, and a reminder fired again inside its ten minutes.
 *
 * The store path notes what it rang under its own prefix. That keeps the other path off
 * it at a handover, and doesn't count against the store's own summary later: a reminder
 * it rang and snoozed can still be missed.
 */

const STORAGE_KEY = 'calendar-alert-claims';
const LOCK = 'bulwark-calendar-alert-claim';
const KEEP_MS = 24 * 60 * 60 * 1000;
const STORE_PREFIX = 'store:';
/** A tab out of view waits, so the one in view is who shows the reminder. */
export const HIDDEN_GRACE_MS = 2000;

export function claimKey(account: string | null | undefined, uid: string, alertId: string, fireTimeMs: number): string {
  return `${account ?? ''}:${uid}:${alertId}:${fireTimeMs}`;
}

function readClaims(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, number> : {};
  } catch {
    return {};
  }
}

function writeClaim(claims: Record<string, number>, key: string, fireTimeMs: number): void {
  const now = Date.now();
  const kept = Object.fromEntries(Object.entries(claims).filter(([, fire]) => now - fire < KEEP_MS));
  kept[key] = fireTimeMs;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
  } catch {
    // Without storage each tab is on its own, as it always was.
  }
}

/** True for the first to ask. */
export function claimNow(key: string, fireTimeMs: number): boolean {
  const claims = readClaims();
  if (key in claims || `${STORE_PREFIX}${key}` in claims) return false;
  writeClaim(claims, key, fireTimeMs);
  return true;
}

/** The path without a store rang this one. */
export function firedWithoutStore(key: string): boolean {
  return key in readClaims();
}

/** The store path is ringing this. False when the other path already did. */
export function noteStoreFired(key: string, fireTimeMs: number): boolean {
  const claims = readClaims();
  if (key in claims) return false;
  writeClaim(claims, `${STORE_PREFIX}${key}`, fireTimeMs);
  return true;
}

/** Runs `won` in the one tab that gets the reminder. At once, when nothing makes it wait. */
export function claimAlert(key: string, fireTimeMs: number, won: () => void): void {
  const direct = () => {
    if (claimNow(key, fireTimeMs)) won();
  };
  const attempt = () => {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    if (!locks) {
      direct();
      return;
    }
    void locks.request(LOCK, () => claimNow(key, fireTimeMs)).then((claimed) => {
      if (claimed) won();
    }, direct);
  };
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') setTimeout(attempt, HIDDEN_GRACE_MS);
  else attempt();
}

/** A sign-out: the next person starts with a clean slate. */
export function clearClaims(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing was kept, then.
  }
}

export const CLAIMS_STORAGE_KEY = STORAGE_KEY;
