/**
 * Messages of the offline outbox (#523) that a sign-out deleted unsent.
 * Every sign-out the user didn't confirm for that (the idle and maximum
 * session limits, a refused token renewal, an account removed in another
 * way) names them: on the sign-in page, or in a toast when another account
 * stays signed in. Kept in sessionStorage (this tab only, gone with it), and
 * only the subjects.
 */

const KEY = 'bulwark-offline-lost';
const MAX = 20;

export function rememberLost(subjects: string[]): void {
  if (subjects.length === 0) return;
  try {
    const before = readLost();
    window.sessionStorage.setItem(KEY, JSON.stringify([...before, ...subjects].slice(-MAX)));
  } catch {
    /* storage unavailable */
  }
}

function readLost(): string[] {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

/** The subjects, once (the sign-in page shows them and they go). */
export function consumeLost(): string[] {
  const lost = readLost();
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
  return lost;
}
