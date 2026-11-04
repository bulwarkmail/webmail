/**
 * Where a feature with data of its own on this device signs up for wipes:
 * edit-in-place's opened files, for one. Free of the stores, so anything can
 * import it. Registering is all a feature has to do.
 *
 * A cleaner runs on every remote wipe, policy wipe, wipe from settings and
 * refused login, before the account signs out. `account` is an account id, or
 * `null` when everything on this device goes. A cleaner should finish quickly
 * and may not ask the user anything. Bridge calls are fine, network isn't: a
 * wipe often runs because the server said no.
 *
 * A cleaner that can't finish, as a program holds a file, throws WipeIncompleteError: the wipe
 * then doesn't count as done, isn't reported as done, and runs again at the next start.
 */

export type WipeCleaner = (account: string | null) => void | Promise<void>;

export class WipeIncompleteError extends Error {
  override name = 'WipeIncompleteError';
}

const cleaners = new Set<WipeCleaner>();

export function onDeviceWipe(cleaner: WipeCleaner): () => void {
  cleaners.add(cleaner);
  return () => cleaners.delete(cleaner);
}

/** How long a wipe waits for one cleaner. What's on screen waits with it. */
const CLEANER_BUDGET_MS = 10_000;

/** False when a cleaner says it couldn't finish. */
export async function runWipeCleaners(account: string | null): Promise<boolean> {
  let complete = true;
  await Promise.all([...cleaners].map(async (cleaner) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        cleaner(account),
        new Promise((resolve) => { timer = setTimeout(resolve, CLEANER_BUDGET_MS); }),
      ]);
    } catch (error) {
      // One feature failing must not keep the others' data.
      if ((error as Error | undefined)?.name === 'WipeIncompleteError') complete = false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }));
  return complete;
}
