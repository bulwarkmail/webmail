/**
 * Plugin storage (`api.storage`) is kept per account.
 *
 * It used to live under `plugin:<pluginId>:<key>` for everyone signed in to
 * this browser, and stayed after signing out: a plugin running for the next
 * account (or the next person on a shared computer) read what it stored for
 * the previous one, e.g. quick-notes' notes on someone else's mail. Keys are
 * now `plugin:<pluginId>:@<accountId>:<key>`, and signing an account out
 * deletes its keys. Everything stays under `plugin:<pluginId>:`, so
 * uninstalling a plugin still removes all of it.
 *
 * Deliberately free of store imports: the auth store calls into it.
 */

const PLUGIN_PREFIX = 'plugin:';

function accountTag(accountId: string): string {
  return `@${encodeURIComponent(accountId)}:`;
}

/** Prefix of one plugin's keys for one account. */
export function pluginStoragePrefix(pluginId: string, accountId: string): string {
  return `${PLUGIN_PREFIX}${pluginId}:${accountTag(accountId)}`;
}

function removeKeys(match: (key: string) => boolean): void {
  if (typeof window === 'undefined') return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && match(key)) doomed.push(key);
    }
    for (const key of doomed) window.localStorage.removeItem(key);
  } catch {
    // Storage unavailable: nothing was kept.
  }
}

const claimed = new Set<string>();

/**
 * Hand keys written before storage was per account to the first account
 * that uses the plugin, once per page load.
 */
export function claimLegacyPluginStorage(pluginId: string, accountId: string): void {
  if (typeof window === 'undefined' || claimed.has(pluginId)) return;
  claimed.add(pluginId);
  const legacy = `${PLUGIN_PREFIX}${pluginId}:`;
  const scoped = pluginStoragePrefix(pluginId, accountId);
  try {
    const moves: [string, string][] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(legacy) && !key.startsWith(`${legacy}@`)) {
        moves.push([key, scoped + key.slice(legacy.length)]);
      }
    }
    for (const [from, to] of moves) {
      const value = window.localStorage.getItem(from);
      if (value !== null && window.localStorage.getItem(to) === null) window.localStorage.setItem(to, value);
      window.localStorage.removeItem(from);
    }
  } catch {
    // Storage unavailable.
  }
}

/** Delete what every plugin stored for this account. */
export function clearPluginStorageForAccount(accountId: string): void {
  const tag = accountTag(accountId);
  removeKeys((key) => {
    if (!key.startsWith(PLUGIN_PREFIX)) return false;
    const idEnd = key.indexOf(':', PLUGIN_PREFIX.length);
    return idEnd > 0 && key.startsWith(tag, idEnd + 1);
  });
}

/** Delete all plugin storage: nobody is signed in any more. */
export function clearAllPluginStorage(): void {
  removeKeys((key) => key.startsWith(PLUGIN_PREFIX));
  claimed.clear();
}
