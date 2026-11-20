import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { getStateDir } from '@/lib/admin/paths';
import { getStore, type CollectionOptions, type DocCollection } from '@/lib/shared-store';
import type { AccountState, EngineStore } from './engine';
import {
  DEFAULT_OPTIONS,
  RUNNING_STATUSES,
  type CopyWhat,
  type DavCopyEntry,
  type MigrationOptions,
  type SourceEndpoints,
  type StoredSource,
} from './types';

/**
 * Where migrations live (#1066 shared store, so a new scheduler leader
 * continues where the old one stopped):
 *
 * - `migration-config`: `sources` (the admin's source servers) and `options`.
 * - `migrations`: per migration `<id>/migration`, per account entry
 *   `<id>/a-<n>`, and next to each account what doesn't fit its document:
 *   the Message-ID hashes per folder (`<id>/h-<n>-<folder>-<chunk>`) and the
 *   DAV copy maps (`<id>/d-<n>-contacts`, `…-calendars`).
 *
 * Passwords inside the documents are encrypted (secrets.ts); local mode
 * writes the files with mode 0600 all the same.
 */

export function getMigrationDataDir(): string {
  return process.env.MIGRATION_DATA_DIR || path.join(getStateDir(), 'migrations');
}

export const MIGRATION_CONFIG_COLLECTION: CollectionOptions = {
  local: { dir: () => path.join(getMigrationDataDir(), 'config'), file: (id) => `${id}.json`, idOf: (rel) => (rel.endsWith('.json') ? rel.slice(0, -5) : null), mode: 0o600 },
};

export const MIGRATIONS_COLLECTION: CollectionOptions = {
  local: { dir: () => path.join(getMigrationDataDir(), 'jobs'), file: (id) => `${id}.json`, idOf: (rel) => (rel.endsWith('.json') ? rel.slice(0, -5) : null), mode: 0o600 },
};

function config(): DocCollection {
  return getStore().collection('migration-config', MIGRATION_CONFIG_COLLECTION);
}

function migrations(): DocCollection {
  return getStore().collection('migrations', MIGRATIONS_COLLECTION);
}

async function readJson<T>(collection: DocCollection, id: string): Promise<T | null> {
  const doc = await collection.get(id);
  if (!doc) return null;
  try {
    return JSON.parse(doc.data.toString('utf8')) as T;
  } catch {
    return null;
  }
}

/** Read-change-write a JSON document; `fn` returns the new value, null to delete, undefined to keep. */
async function updateJson<T>(collection: DocCollection, id: string, fn: (current: T | null) => T | null | undefined): Promise<T | null> {
  const { data } = await collection.update(id, (raw) => {
    let current: T | null = null;
    if (raw) {
      try { current = JSON.parse(raw.toString('utf8')) as T; } catch { current = null; }
    }
    const next = fn(current);
    if (next === undefined) return undefined;
    return next === null ? null : JSON.stringify(next);
  });
  if (data === undefined) return readJson<T>(collection, id);
  return data ? (JSON.parse(data.toString('utf8')) as T) : null;
}

export function newId(): string {
  return `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
}

// ─── Sources and options ───────────────────────────────────────────────────

export async function loadSources(): Promise<StoredSource[]> {
  return (await readJson<{ sources: StoredSource[] }>(config(), 'sources'))?.sources ?? [];
}

export async function updateSources(fn: (sources: StoredSource[]) => StoredSource[]): Promise<StoredSource[]> {
  const next = await updateJson<{ sources: StoredSource[] }>(config(), 'sources', (current) => ({ sources: fn(current?.sources ?? []) }));
  return next?.sources ?? [];
}

export function normalizeOptions(raw: Partial<MigrationOptions> | null | undefined): MigrationOptions {
  const concurrency = Number(raw?.concurrency);
  const days = Number(raw?.forgetAfterDays);
  return {
    concurrency: Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 10 ? concurrency : DEFAULT_OPTIONS.concurrency,
    forgetAfterDays: Number.isInteger(days) && days >= 1 && days <= 365 ? days : DEFAULT_OPTIONS.forgetAfterDays,
    allowUserServers: raw?.allowUserServers === true,
  };
}

export async function loadOptions(): Promise<MigrationOptions> {
  return normalizeOptions(await readJson<MigrationOptions>(config(), 'options'));
}

export async function saveOptions(options: MigrationOptions): Promise<void> {
  await config().put('options', JSON.stringify(normalizeOptions(options)));
}

// ─── Migrations and accounts ───────────────────────────────────────────────

export interface MigrationDoc {
  id: string;
  kind: 'bulk' | 'self';
  createdAt: number;
  /** "admin", or the login of the user who started it. */
  startedBy: string;
  /** An admin-defined source. */
  sourceId: string | null;
  /** A server the user typed in. */
  custom?: SourceEndpoints;
  sourceName: string;
  what: CopyWhat;
  /** The Stalwart JMAP server the accounts are on. */
  serverUrl: string;
  /** Self-service: whose account it is. */
  owner?: { username: string; accountName: string };
  /** Self-service: the app password the job signs in to Stalwart with. */
  appPassword?: { id: string; secretEnc?: string; expiresAt: string };
  accountCount: number;
  /** A pass was last asked for (start or "Copy new items"). Stored passwords go some days after it. */
  lastPassAt: number;
  finishedAt?: number;
  credentialsForgottenAt?: number;
  /** Bumped by every request that gives the job work, so it rescans the accounts. */
  touchedAt: number;
}

/** An account entry: who goes where, and the engine's state. */
export interface AccountDoc extends AccountState {
  migrationId: string;
  key: string;
  /** Row in the CSV (bulk). */
  row?: number;
  sourceUser: string;
  /** The Stalwart login of the target. */
  target: string;
  /** The user's source password, encrypted; absent when empty or forgotten. */
  passwordEnc?: string;
  cancelRequested?: boolean;
}

const migrationDocId = (id: string) => `${id}/migration`;
export const accountKey = (index: number) => `a-${String(index).padStart(5, '0')}`;
const accountDocId = (migrationId: string, key: string) => `${migrationId}/${key}`;

export async function loadMigration(id: string): Promise<MigrationDoc | null> {
  return readJson<MigrationDoc>(migrations(), migrationDocId(id));
}

/** The migration document and its version, to tell whether anything asked for work since. */
export async function migrationVersion(id: string): Promise<string | null> {
  return (await migrations().get(migrationDocId(id)))?.version ?? null;
}

export async function listMigrations(): Promise<MigrationDoc[]> {
  const ids = (await migrations().list('')).filter((id) => id.endsWith('/migration'));
  const docs = await Promise.all(ids.map((id) => readJson<MigrationDoc>(migrations(), id)));
  return docs.filter((d): d is MigrationDoc => !!d).sort((a, b) => b.createdAt - a.createdAt);
}

export async function putMigration(doc: MigrationDoc): Promise<void> {
  await migrations().put(migrationDocId(doc.id), JSON.stringify(doc));
}

export async function updateMigration(id: string, fn: (doc: MigrationDoc) => MigrationDoc | undefined): Promise<MigrationDoc | null> {
  return updateJson<MigrationDoc>(migrations(), migrationDocId(id), (current) => (current ? fn(current) : undefined));
}

export async function listAccountKeys(migrationId: string): Promise<string[]> {
  return (await migrations().list(`${migrationId}/a-`)).map((id) => id.slice(migrationId.length + 1));
}

export async function loadAccount(migrationId: string, key: string): Promise<AccountDoc | null> {
  return readJson<AccountDoc>(migrations(), accountDocId(migrationId, key));
}

export async function listAccounts(migrationId: string): Promise<AccountDoc[]> {
  const keys = await listAccountKeys(migrationId);
  const docs = await Promise.all(keys.map((key) => loadAccount(migrationId, key)));
  return docs.filter((d): d is AccountDoc => !!d);
}

export async function putAccount(doc: AccountDoc): Promise<void> {
  await migrations().put(accountDocId(doc.migrationId, doc.key), JSON.stringify(doc));
}

export async function updateAccount(migrationId: string, key: string, fn: (doc: AccountDoc) => AccountDoc | undefined): Promise<AccountDoc | null> {
  return updateJson<AccountDoc>(migrations(), accountDocId(migrationId, key), (current) => (current ? fn(current) : undefined));
}

export async function deleteMigrationDocs(migrationId: string): Promise<void> {
  const ids = await migrations().list(`${migrationId}/`);
  // The migration document last: a half-deleted migration still lists.
  for (const id of ids.filter((id) => !id.endsWith('/migration'))) await migrations().delete(id);
  await migrations().delete(migrationDocId(migrationId));
}

export function isRunning(doc: Pick<AccountDoc, 'status'>): boolean {
  return RUNNING_STATUSES.includes(doc.status);
}

// ─── The engine's store for one account ────────────────────────────────────

const HASH_CHUNK = 2000;

function folderKey(folder: string): string {
  return createHash('sha256').update(folder).digest('hex').slice(0, 16);
}

const STATE_KEYS: (keyof AccountState)[] = [
  'status', 'phase', 'pausedUntil', 'progress', 'copyMap', 'inflight', 'report', 'error', 'errorCode', 'passStartedAt', 'passFinishedAt', 'passes',
];

export function accountEngineStore(migrationId: string, key: string): EngineStore {
  const col = migrations();
  const hashPrefix = (folder: string) => `${migrationId}/h-${key}-${folderKey(folder)}-`;
  return {
    async save(state) {
      await updateAccount(migrationId, key, (current) => {
        const next: AccountDoc = { ...current };
        for (const k of STATE_KEYS) {
          if (state[k] === undefined) delete next[k];
          else (next as unknown as Record<string, unknown>)[k] = state[k];
        }
        // A finished pass has nothing left to cancel.
        if (!isRunning(next)) delete next.cancelRequested;
        return next;
      });
    },
    async isCancelled() {
      return (await loadAccount(migrationId, key))?.cancelRequested === true;
    },
    async loadHashes(folder) {
      const ids = await col.list(hashPrefix(folder));
      const out = new Set<string>();
      for (const id of ids) {
        const chunk = await readJson<string[]>(col, id);
        for (const hash of chunk ?? []) out.add(hash);
      }
      return out;
    },
    async appendHashes(folder, hashes) {
      const prefix = hashPrefix(folder);
      const ids = await col.list(prefix);
      let index = ids.length > 0 ? Math.max(...ids.map((id) => Number(id.slice(prefix.length)) || 0)) : 0;
      let rest = hashes;
      while (rest.length > 0) {
        const id = `${prefix}${String(index).padStart(5, '0')}`;
        let taken = 0;
        await updateJson<string[]>(col, id, (current) => {
          const list = current ?? [];
          const room = Math.max(0, HASH_CHUNK - list.length);
          taken = Math.min(room, rest.length);
          return taken > 0 ? [...list, ...rest.slice(0, taken)] : undefined;
        });
        rest = rest.slice(taken);
        if (rest.length > 0) index++;
      }
    },
    async loadDav(kind) {
      return (await readJson<Record<string, DavCopyEntry>>(col, `${migrationId}/d-${key}-${kind}`)) ?? {};
    },
    async saveDav(kind, map) {
      await col.put(`${migrationId}/d-${key}-${kind}`, JSON.stringify(map));
    },
  };
}
