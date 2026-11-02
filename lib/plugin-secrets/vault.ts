// Per-user store of the credentials users connected for plugins. One
// encrypted document per mail account; the secrets never leave the server
// again except as an auth header on a request the proxy forwards to the
// credential's own origin.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { decryptPayload, encryptPayload } from '@/lib/auth/crypto';
import { getStore, type CollectionOptions } from '@/lib/shared-store';
import { isStoreUnavailable, isStoredDataUnreadable, StoredDataUnreadableError } from '@/lib/stored-data-errors';
import { moveUnreadableAside } from '@/lib/stored-data-quarantine';
import type { CredentialInject } from './credentials';

export interface VaultUser {
  username: string;
  serverUrl: string;
}

export interface StoredCredential {
  origin: string;
  inject: CredentialInject;
  label: string;
  username?: string;
  secret?: string;
  createdAt: string;
  updatedAt: string;
}

/** What the browser may see about a stored credential: never the secret. */
export interface CredentialSummary {
  pluginId: string;
  credentialId: string;
  label: string;
  origin: string;
  username?: string;
  connected: boolean;
  updatedAt: string;
}

type VaultData = Record<string, Record<string, StoredCredential>>;

/** Cap on credentials per user, across all plugins. */
export const MAX_USER_CREDENTIALS = 64;

export function vaultDir(): string {
  return process.env.PLUGIN_SECRETS_DIR
    || path.join(process.env.SETTINGS_DATA_DIR || path.join(process.cwd(), 'data', 'settings'), '..', 'plugin-secrets');
}

export function userKey(user: VaultUser): string {
  return createHash('sha256').update(`${user.username}:${user.serverUrl}`).digest('hex');
}

const VAULT_FILE = /^[0-9a-f]{64}\.enc$/;

/**
 * One document per account, keyed by userKey (#1066). Local mode: today's
 * `<vault dir>/<key>.enc`, base64 `encryptPayload` text, mode 0600.
 */
export const VAULT_COLLECTION: CollectionOptions = {
  local: {
    dir: () => vaultDir(),
    file: (id) => `${id}.enc`,
    idOf: (relative) => (VAULT_FILE.test(relative) ? relative.slice(0, -'.enc'.length) : null),
    mode: 0o600,
  },
};

function collection() {
  return getStore().collection('plugin-secrets', VAULT_COLLECTION);
}

/**
 * The user's credentials from a stored document; {} for none. One that
 * doesn't decrypt (another session secret) throws StoredDataUnreadableError,
 * so no write lands on top of it before it is moved aside (see modify).
 */
function decode(user: VaultUser, raw: Buffer | null): VaultData {
  if (!raw) return {};
  const payload = decryptPayload(raw.toString('utf8'), 'plugin-secrets');
  if (!payload) throw new StoredDataUnreadableError('plugin credentials');
  // Bound to this user: a file copied over from another account's name
  // decrypts, but carries the other account's key and is ignored.
  if (payload.u !== userKey(user)) return {};
  const data = payload.d;
  return data && typeof data === 'object' ? (data as VaultData) : {};
}

async function load(user: VaultUser): Promise<VaultData> {
  let stored;
  try {
    stored = await collection().get(userKey(user));
  } catch (error) {
    if (isStoreUnavailable(error)) throw error;
    throw new StoredDataUnreadableError('plugin credentials', { cause: error });
  }
  try {
    return decode(user, stored?.data ?? null);
  } catch (error) {
    // Reads as no credentials; the next write moves it aside.
    if (isStoredDataUnreadable(error)) return {};
    throw error;
  }
}

/**
 * Change the user's credentials in one step against what is stored now, so
 * two writes at once (two tabs, two replicas) both land. `change` edits the
 * data it gets and says whether it changed anything; it may run more than
 * once. An empty vault is deleted.
 *
 * A vault that doesn't decrypt is moved aside first (kept next to the
 * original as `.unreadable-<time>`, never overwritten), and the write goes
 * on as if nothing was stored.
 */
async function modify<T>(user: VaultUser, change: (data: VaultData) => { result: T; changed: boolean }): Promise<T> {
  const docs = collection();
  const id = userKey(user);
  for (let attempt = 0; ; attempt++) {
    try {
      let result!: T;
      await docs.update(id, (current) => {
        const data = decode(user, current);
        const out = change(data);
        result = out.result;
        if (!out.changed) return undefined;
        if (Object.keys(data).length === 0) return current ? null : undefined;
        return encryptPayload({ u: userKey(user), d: data }, 'plugin-secrets');
      });
      return result;
    } catch (error) {
      if (!isStoredDataUnreadable(error) || attempt >= 2) throw error;
      const current = await docs.get(id);
      if (current) await moveUnreadableAside(docs, id, current, path.join(vaultDir(), `${id}.enc`), 'plugin credentials');
    }
  }
}

export async function getUserCredential(user: VaultUser, pluginId: string, credentialId: string): Promise<StoredCredential | null> {
  const data = await load(user);
  return data[pluginId]?.[credentialId] ?? null;
}

export async function listUserCredentials(user: VaultUser, pluginId?: string): Promise<CredentialSummary[]> {
  const data = await load(user);
  const out: CredentialSummary[] = [];
  for (const [pid, creds] of Object.entries(data)) {
    if (pluginId && pid !== pluginId) continue;
    for (const [cid, c] of Object.entries(creds)) {
      out.push({
        pluginId: pid, credentialId: cid, label: c.label, origin: c.origin,
        ...(c.username ? { username: c.username } : {}),
        connected: !!c.secret || c.inject.type === 'none',
        updatedAt: c.updatedAt,
      });
    }
  }
  return out;
}

export class VaultFullError extends Error {
  constructor() {
    super(`At most ${MAX_USER_CREDENTIALS} plugin credentials per account`);
  }
}

/**
 * Save a credential. Changing the origin of a saved one drops its secret, so
 * a secret is only ever sent where the user first approved it.
 */
export function putUserCredential(
  user: VaultUser,
  pluginId: string,
  credentialId: string,
  input: { origin: string; inject: CredentialInject; label: string; username?: string; secret?: string },
): Promise<void> {
  return modify(user, (data) => {
    const existing = data[pluginId]?.[credentialId];
    const count = Object.values(data).reduce((n, c) => n + Object.keys(c).length, 0);
    if (!existing && count >= MAX_USER_CREDENTIALS) throw new VaultFullError();
    const now = new Date().toISOString();
    const keepSecret = existing && existing.origin === input.origin ? existing.secret : undefined;
    data[pluginId] = {
      ...(data[pluginId] ?? {}),
      [credentialId]: {
        origin: input.origin,
        inject: input.inject,
        label: input.label,
        ...(input.username ? { username: input.username } : {}),
        ...((input.secret ?? keepSecret) ? { secret: input.secret ?? keepSecret } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      },
    };
    return { result: undefined, changed: true };
  });
}

/** Store a secret captured from a response for an existing credential. */
export function setUserCredentialSecret(
  user: VaultUser,
  pluginId: string,
  credentialId: string,
  secret: string,
  username?: string,
): Promise<boolean> {
  return modify(user, (data) => {
    const existing = data[pluginId]?.[credentialId];
    if (!existing) return { result: false, changed: false };
    data[pluginId][credentialId] = {
      ...existing,
      secret,
      ...(username ? { username } : {}),
      updatedAt: new Date().toISOString(),
    };
    return { result: true, changed: true };
  });
}

/** Remove one credential, or all of a plugin's when credentialId is omitted. */
export function deleteUserCredentials(user: VaultUser, pluginId: string, credentialId?: string): Promise<void> {
  return modify(user, (data) => {
    if (!data[pluginId]) return { result: undefined, changed: false };
    if (credentialId) {
      delete data[pluginId][credentialId];
      if (Object.keys(data[pluginId]).length === 0) delete data[pluginId];
    } else {
      delete data[pluginId];
    }
    return { result: undefined, changed: true };
  });
}
