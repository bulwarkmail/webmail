import { writeFile } from 'node:fs/promises';
import { logger } from '@/lib/logger';
import { ensureStateDir, getStatePath, isConfigReadOnly } from '@/lib/admin/paths';
import { ADMIN_CONFIG_COLLECTION, ADMIN_STATE_COLLECTION, adminConfigOptions, adminStateOptions } from '@/lib/admin/admin-store';
import { AUDIT_LOG_OPTIONS } from '@/lib/admin/audit';
import { GENERATED_SECRET_FILE, SHARED_SECRET_KEY } from '@/lib/auth/session-secret';
import { SESSION_LIMITS_COLLECTION, sessionLimitsLayout } from '@/lib/auth/session-age';
import { WOPI_COLLECTION, wopiRevocationsLayout } from '@/lib/wopi/revocation';
import { SETTINGS_COLLECTION } from '@/lib/settings-sync';
import { VAULT_COLLECTION } from '@/lib/plugin-secrets/vault';
import { ARCHIVE_COLLECTION } from '@/lib/account-archive-storage';
import { TELEMETRY_COLLECTION } from '@/lib/telemetry/state';
import { VERSION_CHECK_COLLECTION } from '@/lib/version-check/state';
import { getStore } from './index';
import { exportSteps as extExportSteps } from './import/ext';
import { localCollection, localLog } from './local';
import type { CollectionOptions } from './types';

/**
 * The way back from several instances to one (#1066): write everything the
 * shared store holds into this instance's data dirs, in the layout local
 * mode reads, so it can start without REDIS_URL on that volume. Started with
 * SHARED_STORE_EXPORT=1 (see instrumentation.node.ts), which exports and
 * exits instead of serving.
 *
 * Files of the same name are overwritten; other files are left alone.
 * Nothing in the store is changed. Short-lived state (sign-in limits,
 * pairing and hand-off codes, used impersonation links) isn't exported: it
 * lasts minutes and starts empty after any restart.
 */

export interface ExportStep {
  name: string;
  run(): Promise<number>;
}

/** Every document of a collection, from the store to its local files. */
export function exportCollection(name: string, options: CollectionOptions): ExportStep {
  return {
    name,
    async run() {
      // Read-only config is the mounted files on every replica already.
      if (options.configDir && isConfigReadOnly()) return 0;
      const shared = getStore().collection(name, options);
      const local = localCollection(name, options);
      let written = 0;
      for (const id of await shared.list()) {
        const doc = await shared.get(id);
        if (!doc) continue;
        await local.put(id, doc.data);
        written++;
      }
      return written;
    },
  };
}

const auditStep: ExportStep = {
  name: 'audit',
  async run() {
    const lines = await getStore().log('audit', AUDIT_LOG_OPTIONS).readAll();
    const local = localLog('audit', AUDIT_LOG_OPTIONS);
    await local.clear();
    await local.appendMany(lines);
    return lines.length;
  },
};

/** The generated session secret, so exported settings and credentials still decrypt. */
const secretStep: ExportStep = {
  name: 'session-secret',
  async run() {
    const secret = await getStore().kv.get(SHARED_SECRET_KEY);
    if (!secret) return 0;
    await ensureStateDir();
    await writeFile(getStatePath(GENERATED_SECRET_FILE), secret, { mode: 0o600 });
    return 1;
  },
};

export const EXPORT_STEPS: ExportStep[] = [
  secretStep,
  exportCollection(ADMIN_CONFIG_COLLECTION, adminConfigOptions),
  exportCollection(ADMIN_STATE_COLLECTION, adminStateOptions),
  // After admin-state: directory-keyrings.json is in that collection too and
  // is written again owner-only here.
  ...extExportSteps,
  auditStep,
  exportCollection(SESSION_LIMITS_COLLECTION, sessionLimitsLayout),
  exportCollection(WOPI_COLLECTION, wopiRevocationsLayout),
  exportCollection('settings', SETTINGS_COLLECTION),
  exportCollection('plugin-secrets', VAULT_COLLECTION),
  exportCollection('account-archives', ARCHIVE_COLLECTION),
  exportCollection('telemetry', TELEMETRY_COLLECTION),
  exportCollection('version-check', VERSION_CHECK_COLLECTION),
];

export async function exportSharedData(steps: ExportStep[] = EXPORT_STEPS): Promise<Record<string, number>> {
  const written: Record<string, number> = {};
  for (const step of steps) {
    written[step.name] = await step.run();
    logger.info('Exported from the shared store', { step: step.name, items: written[step.name] });
  }
  return written;
}
