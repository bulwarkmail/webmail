import { getStore } from '@/lib/shared-store';
import { localCollection } from '@/lib/shared-store/local';
import type { CollectionOptions } from '@/lib/shared-store/types';
import type { ImportStep } from '@/lib/shared-store/import';
import { SETTINGS_COLLECTION } from '@/lib/settings-sync';
import { VAULT_COLLECTION } from '@/lib/plugin-secrets/vault';
import { ARCHIVE_COLLECTION } from '@/lib/account-archive-storage';
import { TELEMETRY_COLLECTION } from '@/lib/telemetry/state';
import { VERSION_CHECK_COLLECTION } from '@/lib/version-check/state';

/**
 * Part `data` of the shared-store import (#1066): every document of these
 * collections, read from the local files exactly as local mode reads them,
 * written to the shared store only where it holds nothing yet. The bytes go
 * over as they are: settings and plugin credentials stay encrypted with the
 * session secret, which the boot imports first.
 */
function copyCollection(name: string, options: CollectionOptions): ImportStep {
  return {
    name,
    async run() {
      const local = localCollection(name, options);
      const shared = getStore().collection(name, options);
      let written = 0;
      for (const id of await local.list()) {
        const doc = await local.get(id);
        if (!doc) continue;
        if ((await shared.put(id, doc.data, { ifVersion: null })).ok) written++;
      }
      return written;
    },
  };
}

export const steps: ImportStep[] = [
  copyCollection('settings', SETTINGS_COLLECTION),
  copyCollection('plugin-secrets', VAULT_COLLECTION),
  copyCollection('account-archives', ARCHIVE_COLLECTION),
  // state.json, logins.json and the instance id .telemetry-id
  copyCollection('telemetry', TELEMETRY_COLLECTION),
  copyCollection('version-check', VERSION_CHECK_COLLECTION),
];
