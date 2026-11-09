import { configManager } from '@/lib/admin/config-manager';
import { isConfigReadOnly } from '@/lib/admin/paths';

/**
 * The three lifecycle states for the running container.
 *
 *   bootstrap    - no config persisted yet and no JMAP_SERVER_URL env. The
 *                  setup wizard is served at /setup; everything else 302s
 *                  there.
 *   configured   - setup wizard finished (admin override config.json carries
 *                  setupComplete=true). Normal app; /setup returns 404.
 *   env-managed  - JMAP_SERVER_URL is set in the environment, so the
 *                  operator is configuring via .env (legacy / CI path), or
 *                  demo mode is on (DEMO_MODE=true), which needs no mail
 *                  server at all. The wizard stays disabled.
 */
export type SetupState = 'bootstrap' | 'configured' | 'env-managed';

/**
 * Cheap to call on every request. configManager keeps `setupComplete` in
 * memory after the initial load, so this is just env reads + an in-memory
 * boolean check.
 */
export function detectSetupState(): SetupState {
  if (configManager.isSetupComplete()) return 'configured';
  if (process.env.JMAP_SERVER_URL && process.env.JMAP_SERVER_URL.trim() !== '') {
    return 'env-managed';
  }
  // Demo mode signs everyone into built-in sample data; there is nothing for
  // the wizard to set up. Read through the config manager so an admin
  // override of demoMode wins over DEMO_MODE, as everywhere else.
  if (configManager.get<boolean>('demoMode', false) === true) return 'env-managed';
  // Read-only config dir + no setupComplete flag means the volume was
  // mounted :ro before the wizard ran. Fall through to bootstrap so the
  // failure (write attempt during wizard) surfaces with a clear error
  // rather than silently 404'ing /setup.
  if (isConfigReadOnly()) return 'bootstrap';
  return 'bootstrap';
}
