// Host side of what a plugin may know about the signed-in user and the mail
// accounts they reach (permission account:read): their own account and
// address, which accounts are team (group) mailboxes, and people from the
// server's directory. And a small piece of shared data a plugin may keep in a
// mail account (api.accountData, Stalwart 1.0 metadata).
//
// Stalwart uses the account id as the principal id, so the user's own
// account id names them in the directory and in keywords other members see.

import type { IJMAPClient } from '../jmap/client-interface';
import type { InstalledPlugin } from '../plugin-types';
import { useAccountStore } from '@/stores/account-store';
import { useIdentityStore } from '@/stores/identity-store';
import { resolveEmailBlobContext } from '@/stores/email-store';
import { directoryScopeFor, inDirectoryScope } from '@/lib/directory-scope';
import { isValidMetadataKey, MetadataTooLargeError, metadataValueBytes } from '../jmap/bulwark-metadata';
import { confirmGroups, mailAccountKind, type MailAccountKind } from './account-kind';
import { readObject, readString, sessionClient, withinRate } from './host-api-input';

export interface PluginSelfView {
  /** The user's own JMAP account id, which Stalwart also uses as their principal id. */
  accountId: string;
  /** The address the user signed in with. */
  email: string;
  /** Their name: the account's display name, else their first identity's, else the address. */
  name: string;
}

export interface PluginMailAccountView {
  accountId: string;
  /** The account's name; for a group account the group's address. */
  name: string;
  kind: MailAccountKind;
  isReadOnly: boolean;
  /** The open folder belongs to this account. */
  isOpen: boolean;
}

export interface PluginPersonView {
  id: string;
  /** "individual", "group", or what else the server says. */
  type: string;
  name: string;
  email: string;
}

export function doUserGetSelf(): PluginSelfView {
  const client = sessionClient('user.getSelf');
  const email = client.getUsername?.() ?? '';
  const accountId = client.getAccountId();
  const { accounts, activeAccountId } = useAccountStore.getState();
  const active = accounts.find((a) => a.id === activeAccountId);
  const identity = useIdentityStore.getState().identities.find((i) => i.name);
  return {
    accountId,
    email,
    name: active?.displayName?.trim() || identity?.name?.trim() || email,
  };
}

function mailAccountIds(client: IJMAPClient): string[] {
  const own = client.getAccountId();
  const shared = typeof client.getSharedAccounts === 'function' ? client.getSharedAccounts() : [];
  const ids = shared.length > 0 ? shared.filter((a) => a.isPrimary || a.capabilities.mail).map((a) => a.id) : [own];
  if (!ids.includes(own)) ids.unshift(own);
  return ids;
}

/**
 * The mail accounts of the signed-in login, each with its kind. Waits for
 * the server's word on which are groups (account-kind.ts), so a plugin
 * asking right after sign-in already hears "group" for a team mailbox.
 */
export async function doUserGetMailAccounts(): Promise<PluginMailAccountView[]> {
  const client = sessionClient('user.getMailAccounts');
  await confirmGroups(client);
  const own = client.getAccountId();
  const open = resolveEmailBlobContext({}, client);
  const openId = open.client === client ? open.accountId || own : null;
  return mailAccountIds(client).map((accountId) => {
    const info = client.getAccountInfo?.(accountId);
    return {
      accountId,
      name: info?.name || (accountId === own ? client.getUsername?.() ?? '' : accountId),
      kind: mailAccountKind(client, accountId),
      isReadOnly: info?.isReadOnly === true,
      isOpen: accountId === openId,
    };
  });
}

/** `accountArg` as one of the login's mail accounts, or the user's own when not given. */
function namedAccount(client: IJMAPClient, method: string, accountArg: unknown): string {
  if (accountArg === undefined) return client.getAccountId();
  const accountId = readString(accountArg, method, 'accountId', 256, { min: 1 });
  if (!mailAccountIds(client).includes(accountId)) throw new Error(`${method}: no mail account "${accountId}"`);
  return accountId;
}

// ─── Directory (directory:read) ───────────────────────────────

/** Most people one user.findPeople call returns. */
export const MAX_PLUGIN_PEOPLE = 20;
/** Most ids one call may ask for. */
export const MAX_PLUGIN_PEOPLE_IDS = 20;
/** The shortest search text: one or two letters would page through the directory. */
export const MIN_PLUGIN_PEOPLE_TEXT = 3;
/** Lookups one plugin may make a minute. */
export const PLUGIN_PEOPLE_PER_MINUTE = 10;
const DIRECTORY_TTL_MS = 5 * 60_000;

interface DirectoryCache {
  at: number;
  complete: boolean;
  people: PluginPersonView[];
}

/** Per client, per account: the listing and the load in flight. */
const directories = new WeakMap<object, Map<string, DirectoryCache>>();
const directoryLoads = new WeakMap<object, Map<string, Promise<DirectoryCache>>>();

async function loadDirectory(client: IJMAPClient, accountId: string): Promise<DirectoryCache> {
  const cached = directories.get(client)?.get(accountId);
  if (cached && Date.now() - cached.at < DIRECTORY_TTL_MS) return cached;
  let loads = directoryLoads.get(client);
  if (!loads) {
    loads = new Map();
    directoryLoads.set(client, loads);
  }
  const running = loads.get(accountId);
  if (running) return running;
  const inFlight = loads;
  const load = (async () => {
    let complete = false;
    let principals: Array<{ id: string; type?: string; name?: string; description?: string | null; email?: string | null }> = [];
    if (client.supportsPrincipals()) {
      if (typeof client.listPrincipals === 'function') {
        const listing = await client.listPrincipals(accountId);
        complete = listing.status === 'ok';
        principals = listing.principals;
      } else {
        principals = await client.getPrincipals(accountId);
        complete = true;
      }
    }
    // The admin policy's directory rules apply here as in the app's own lists.
    const scope = await directoryScopeFor(client, principals);
    if (scope) {
      principals = principals.filter((p) => inDirectoryScope(p.email || (p.name?.includes('@') ? p.name : ''), scope));
    }
    const entry: DirectoryCache = {
      at: Date.now(),
      complete,
      people: principals.map((p) => ({
        id: p.id,
        type: typeof p.type === 'string' ? p.type : 'individual',
        name: (p.description || p.name || p.email || p.id).trim(),
        email: (p.email || (p.name?.includes('@') ? p.name : '') || '').trim().toLowerCase(),
      })),
    };
    let byAccount = directories.get(client);
    if (!byAccount) {
      byAccount = new Map();
      directories.set(client, byAccount);
    }
    byAccount.set(accountId, entry);
    return entry;
  })().finally(() => { inFlight.delete(accountId); });
  inFlight.set(accountId, load);
  return load;
}

/**
 * People from the server's directory, as the account named (`accountId`,
 * else the user's own) sees it: by principal id (`ids`, at most 20), or
 * whose name or address contains `text` (3 characters or more). At most 20
 * results and 10 lookups a minute. `complete` is false when the
 * administrator turned directory lookups off: then only the people the user
 * already shares an account with (their own and their groups) are known.
 */
export async function doUserFindPeople(plugin: InstalledPlugin, query: unknown): Promise<{ people: PluginPersonView[]; complete: boolean }> {
  const method = 'user.findPeople';
  const opts = readObject(query, method, 'query', ['text', 'ids', 'accountId']);
  const client = sessionClient(method);
  let ids: Set<string> | null = null;
  if (opts.ids !== undefined) {
    if (!Array.isArray(opts.ids) || opts.ids.length === 0 || opts.ids.length > MAX_PLUGIN_PEOPLE_IDS
      || !opts.ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 256)) {
      throw new Error(`${method}: ids must be a list of 1 to ${MAX_PLUGIN_PEOPLE_IDS} ids`);
    }
    ids = new Set(opts.ids as string[]);
  }
  const text = opts.text === undefined ? '' : readString(opts.text, method, 'text', 200, { trim: true }).toLowerCase();
  if (!ids && !text) throw new Error(`${method}: give text or ids`);
  if (text && text.length < MIN_PLUGIN_PEOPLE_TEXT) throw new Error(`${method}: text needs at least ${MIN_PLUGIN_PEOPLE_TEXT} characters`);
  const accountId = namedAccount(client, method, opts.accountId);
  if (!withinRate('directory', plugin.id, PLUGIN_PEOPLE_PER_MINUTE)) throw new Error(`${method}: too many lookups, try again in a minute`);
  const { people, complete } = await loadDirectory(client, accountId);
  const found = people.filter((p) => (!ids || ids.has(p.id))
    && (!text || p.name.toLowerCase().includes(text) || p.email.includes(text)));
  return { people: found.slice(0, MAX_PLUGIN_PEOPLE), complete };
}

// ─── Shared data in a mail account ────────────────────────────

/**
 * Largest value a plugin keeps in one account: half of the 8 KB Stalwart
 * takes per entry. Every entry counts against the mailbox's 64 KB, which
 * Bulwark's own shared tags and team templates need too.
 */
export const MAX_PLUGIN_DATA_BYTES = 4096;
/** Reads and changes one plugin may make a minute. */
export const PLUGIN_DATA_READS_PER_MINUTE = 30;
export const PLUGIN_DATA_WRITES_PER_MINUTE = 20;

/** The metadata key a plugin's data lives under: org.bulwarkmail.plugin.<id>. */
export function pluginDataKey(pluginId: string): string | null {
  const key = `plugin.${pluginId.toLowerCase()}`;
  return isValidMetadataKey(key) ? key : null;
}

/**
 * The plugin's value in the account's shared Inbox metadata. `supported` is
 * false on servers without metadata (Stalwart before 1.0); the value is then
 * null.
 */
export async function doAccountDataGet(plugin: InstalledPlugin, accountArg: unknown): Promise<{ supported: boolean; value: unknown }> {
  const method = 'accountData.get';
  const client = sessionClient(method);
  const accountId = namedAccount(client, method, accountArg);
  const key = pluginDataKey(plugin.id);
  if (!key || typeof client.getBulwarkMetadata !== 'function' || !client.supportsBulwarkMetadata?.(accountId)) {
    return { supported: false, value: null };
  }
  if (!withinRate('account-data-read', plugin.id, PLUGIN_DATA_READS_PER_MINUTE)) throw new Error(`${method}: too many reads, try again in a minute`);
  const entries = await client.getBulwarkMetadata(accountId);
  if (!entries) return { supported: false, value: null };
  return { supported: true, value: entries[key] ?? null };
}

/** Replace (or with null remove) the plugin's value in the account's shared Inbox metadata. */
export async function doAccountDataSet(plugin: InstalledPlugin, accountArg: unknown, value: unknown): Promise<void> {
  const method = 'accountData.set';
  const client = sessionClient(method);
  const accountId = namedAccount(client, method, accountArg);
  const key = pluginDataKey(plugin.id);
  if (!key || typeof client.setBulwarkMetadata !== 'function' || !client.supportsBulwarkMetadata?.(accountId)) {
    throw new Error(`${method}: this server keeps no shared data for plugins`);
  }
  if (value === undefined) throw new Error(`${method}: value is required (null removes it)`);
  let size: number;
  try { size = metadataValueBytes(value); } catch { throw new Error(`${method}: value must be JSON`); }
  if (value !== null && size > MAX_PLUGIN_DATA_BYTES) {
    throw new Error(`${method}: the value is ${size} bytes; at most ${MAX_PLUGIN_DATA_BYTES} fit`);
  }
  if (!withinRate('account-data', plugin.id, PLUGIN_DATA_WRITES_PER_MINUTE)) throw new Error(`${method}: too many changes, try again in a minute`);
  try {
    await client.setBulwarkMetadata(accountId, key, value);
  } catch (error) {
    if (error instanceof MetadataTooLargeError) throw new Error(`${method}: the server has no room for the value (${error.message})`);
    throw new Error(`${method}: ${error instanceof Error ? error.message : 'could not save'}`);
  }
}
