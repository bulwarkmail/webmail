// ---------------------------------------------------------------------------
// One refresh for every open tab
//
// Each tab of the same browser holds its own push connection, so one change on
// the server sets off the same refresh in every tab at once. For refreshes
// that are expensive on the server, the tabs take turns on a Web Lock named
// after the account: the first one runs the refresh and posts the result on a
// BroadcastChannel, and the tabs queued behind it apply that result instead of
// asking the server again.
//
// A result only stands in for a tab's own refresh when it was produced for the
// same trigger (the `token`, e.g. the pushed state strings). A tab whose
// leader closes or fails before posting gets the lock next and refreshes by
// itself, so no tab is left with old data. Without Web Locks or
// BroadcastChannel every tab refreshes on its own, as before.
// ---------------------------------------------------------------------------

interface CrossTabResult<T> {
  key: string;
  token: string;
  value: T;
}

interface CrossTabEnv {
  locks: Pick<LockManager, 'request'>;
  channel: Pick<BroadcastChannel, 'postMessage' | 'addEventListener'>;
}

function browserEnv(name: string): CrossTabEnv | null {
  if (typeof BroadcastChannel !== 'function' || typeof navigator === 'undefined' || !navigator.locks) return null;
  return { locks: navigator.locks, channel: new BroadcastChannel(name) };
}

/** How long a tab that got the lock waits for the previous holder's post. */
const POST_GRACE_MS = 250;

function isResult(data: unknown): data is CrossTabResult<unknown> {
  const d = data as Partial<CrossTabResult<unknown>> | null;
  return !!d && typeof d.key === 'string' && typeof d.token === 'string' && 'value' in d;
}

/**
 * Returns `run(key, token, refresh, apply)`. `refresh` does the work in this
 * tab and resolves to the value to share, or undefined when there is nothing
 * worth sharing (it failed). `apply` takes another tab's value instead.
 * `key` names the account; requests for different keys never wait on each
 * other.
 */
export function createCrossTabRefresh<T>(name: string, env: CrossTabEnv | null = browserEnv(name)) {
  const latest = new Map<string, CrossTabResult<T>>();
  const listeners = new Set<(result: CrossTabResult<T>) => void>();
  env?.channel.addEventListener('message', (event) => {
    const data = (event as MessageEvent).data;
    if (!isResult(data)) return;
    const result = data as CrossTabResult<T>;
    latest.set(result.key, result);
    for (const listener of [...listeners]) listener(result);
  });

  return async function run(
    key: string,
    token: string,
    refresh: () => Promise<T | undefined>,
    apply: (value: T) => void,
  ): Promise<void> {
    if (!env) {
      await refresh();
      return;
    }
    const channel = env.channel;
    const known = latest.get(key);
    if (known?.token === token) {
      apply(known.value);
      return;
    }

    const lockName = `${name}:${key}`;
    const lead = async () => {
      const value = await refresh();
      if (value === undefined) return;
      const result: CrossTabResult<T> = { key, token, value };
      latest.set(key, result);
      channel.postMessage(result);
    };

    // While queued, a matching result ends the wait. Once holding the lock,
    // the tab before may have posted it just before letting go: the post
    // and the lock travel separately, so give the post a moment to land.
    const abort = new AbortController();
    let holding = false;
    let done = false;
    let landed = () => {};
    const posted = new Promise<void>((resolve) => { landed = resolve; });
    const onResult = (result: CrossTabResult<T>) => {
      if (done || result.key !== key || result.token !== token) return;
      if (holding) {
        landed();
        return;
      }
      done = true;
      abort.abort();
      apply(result.value);
    };
    listeners.add(onResult);
    try {
      const ranAlone = await env.locks.request(lockName, { ifAvailable: true }, async (lock) => {
        if (!lock) return false;
        holding = true;
        await lead();
        return true;
      });
      if (ranAlone || done) return;
      await env.locks.request(lockName, { signal: abort.signal }, async () => {
        holding = true;
        if (latest.get(key)?.token !== token) {
          await Promise.race([posted, new Promise((resolve) => setTimeout(resolve, POST_GRACE_MS))]);
        }
        const result = latest.get(key);
        if (result?.token === token) apply(result.value);
        else await lead();
      });
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    } finally {
      listeners.delete(onResult);
    }
  };
}
