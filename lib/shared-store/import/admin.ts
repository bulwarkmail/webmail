import type { ImportStep } from '../import';
import { getStore, type CollectionOptions } from '../index';
import { localCollection, localLog } from '../local';
import {
  ADMIN_CONFIG_COLLECTION,
  ADMIN_STATE_COLLECTION,
  adminConfigOptions,
  adminStateOptions,
} from '@/lib/admin/admin-store';
import { AUDIT_LOG_OPTIONS } from '@/lib/admin/audit';
import { INIT_EPOCH } from '../changes';

/** Set once every audit line is in the shared log. */
export const AUDIT_IMPORT_DONE_KEY = 'import:audit-done';
/** Lines per store call: 50 000 lines are 100 calls, not 50 000. */
const AUDIT_BATCH = 500;

/**
 * The current audit.log, as the dashboard shows it; the rotated files stay
 * on disk. In batches, in order. The marker is written after the last one,
 * so an import that stopped halfway (the replica died, the store dropped)
 * is redone from the start on the next boot instead of being left short.
 * A store that is already initialised but has no marker (a forced re-run)
 * only gets the lines when its log is empty: its lines may be new entries.
 */
async function importAuditLog(): Promise<number> {
  const store = getStore();
  if (await store.kv.get(AUDIT_IMPORT_DONE_KEY)) return 0;
  const shared = store.log('audit', AUDIT_LOG_OPTIONS);
  const initialised = !!(await store.epochs.all())[INIT_EPOCH];
  if (initialised && (await shared.length()) > 0) return 0;
  await shared.clear();
  const lines = (await localLog('audit', AUDIT_LOG_OPTIONS).readAll()).slice(-AUDIT_LOG_OPTIONS.maxEntries);
  for (let i = 0; i < lines.length; i += AUDIT_BATCH) await shared.appendMany(lines.slice(i, i + AUDIT_BATCH));
  await store.kv.set(AUDIT_IMPORT_DONE_KEY, JSON.stringify({ at: new Date().toISOString(), lines: lines.length }));
  return lines.length;
}

/**
 * Part `admin` of the import (#1066): the admin config, the admin password
 * and its state, and the audit log of a single-instance install. Reads the
 * local files as local mode does and writes only what the shared store
 * doesn't hold yet. With ADMIN_CONFIG_READONLY the config collection is the
 * mounted files on every replica, so nothing of it is copied.
 */

async function copyDocs(name: string, options: CollectionOptions, ids: string[]): Promise<number> {
  const local = localCollection(name, options);
  const shared = getStore().collection(name, options);
  let written = 0;
  for (const id of ids) {
    const doc = await local.get(id);
    if (!doc) continue;
    if ((await shared.put(id, doc.data, { ifVersion: null })).ok) written++;
  }
  return written;
}

export const steps: ImportStep[] = [
  {
    name: 'admin-config',
    run: () => copyDocs(ADMIN_CONFIG_COLLECTION, adminConfigOptions, ['config.json', 'policy.json', 'admin.json', '.config-locked']),
  },
  {
    name: 'admin-state',
    run: () => copyDocs(ADMIN_STATE_COLLECTION, adminStateOptions, ['admin-state.json']),
  },
  { name: 'audit', run: importAuditLog },
];
