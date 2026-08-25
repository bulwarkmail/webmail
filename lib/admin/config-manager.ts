import { readFile, writeFile, rename } from 'node:fs/promises';
import { logger } from '@/lib/logger';
import { readFileEnv } from '@/lib/read-file-env';
import { CONFIG_ENV_MAP, DEFAULT_FEATURE_GATES, DEFAULT_POLICY, DEFAULT_THEME_POLICY, type SettingsPolicy } from './types';
import { ensureConfigDir, getConfigPath, assertWritable } from './paths';
import { isValidRelayUrl, normalizeRelayUrl } from '@/lib/push-relays';

function parseEnvValue(value: string, type: string): unknown {
  switch (type) {
    case 'boolean':
      return value === 'true';
    case 'json':
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    case 'string':
    case 'url':
    case 'enum':
      return value;
    default:
      return value;
  }
}

class ConfigManager {
  private adminConfig: Record<string, unknown> = {};
  private policyCache: SettingsPolicy = { ...DEFAULT_POLICY };
  private loaded = false;

  /** Load admin config and policy from disk. Called once at startup and on reload. */
  async load(): Promise<void> {
    this.adminConfig = await this.readJsonFile('config.json') || {};
    const policy = await this.readJsonFile('policy.json');
    if (policy) {
      this.policyCache = ConfigManager.normalizePolicy({
        ...DEFAULT_POLICY,
        ...policy,
        features: { ...DEFAULT_FEATURE_GATES, ...(policy.features || {}) },
        themePolicy: { ...DEFAULT_THEME_POLICY, ...(policy.themePolicy || {}) },
      });
    } else {
      this.policyCache = { ...DEFAULT_POLICY };
    }
    this.loaded = true;
    logger.debug('ConfigManager loaded', { configKeys: Object.keys(this.adminConfig).length });
  }

  /** Ensure config is loaded (no-op if already loaded). */
  async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  /**
   * Get a config value. Priority: admin override > env var > default.
   */
  get<T>(key: string, defaultValue?: T): T {
    // Admin override (highest priority)
    if (key in this.adminConfig) {
      return this.adminConfig[key] as T;
    }

    // Environment variable
    const mapping = CONFIG_ENV_MAP[key];
    if (mapping) {
      const envVal = process.env[mapping.envVar];
      if (envVal !== undefined) {
        return parseEnvValue(envVal, mapping.type) as T;
      }
      if (mapping.fileEnvVar) {
        const fileVal = readFileEnv(process.env[mapping.fileEnvVar]);
        if (fileVal !== null) {
          return parseEnvValue(fileVal, mapping.type) as T;
        }
      }
      if (defaultValue !== undefined) return defaultValue;
      return mapping.defaultValue as T;
    }

    return defaultValue as T;
  }

  /**
   * Get all config values as a flat object (merged from all layers).
   */
  getAll(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, mapping] of Object.entries(CONFIG_ENV_MAP)) {
      result[key] = this.get(key, mapping.defaultValue);
    }
    return result;
  }

  /**
   * Get all config values with source information (for admin UI).
   */
  getAllWithSources(): Record<string, { value: unknown; source: 'admin' | 'env' | 'default' }> {
    const result: Record<string, { value: unknown; source: 'admin' | 'env' | 'default' }> = {};
    for (const [key, mapping] of Object.entries(CONFIG_ENV_MAP)) {
      if (key in this.adminConfig) {
        result[key] = { value: this.adminConfig[key], source: 'admin' };
      } else {
        const envVal = process.env[mapping.envVar];
        if (envVal !== undefined) {
          result[key] = { value: parseEnvValue(envVal, mapping.type), source: 'env' };
          continue;
        }
        if (mapping.fileEnvVar) {
          const fileVal = readFileEnv(process.env[mapping.fileEnvVar]);
          if (fileVal !== null) {
            result[key] = { value: parseEnvValue(fileVal, mapping.type), source: 'env' };
            continue;
          }
        }
        result[key] = { value: mapping.defaultValue, source: 'default' };
      }
    }
    return result;
  }

  /**
   * Update admin config overrides. Writes to disk.
   */
  async setAdminConfig(updates: Record<string, unknown>): Promise<void> {
    assertWritable('update admin config');
    Object.assign(this.adminConfig, updates);
    await this.writeJsonFile('config.json', this.adminConfig);
  }

  /**
   * Remove an admin override, reverting to env/default.
   */
  async removeAdminOverride(key: string): Promise<void> {
    assertWritable('remove admin override');
    delete this.adminConfig[key];
    await this.writeJsonFile('config.json', this.adminConfig);
  }

  /**
   * Whether the setup wizard has completed. Used by middleware to gate the
   * /setup routes and the rest of the app.
   */
  isSetupComplete(): boolean {
    return this.adminConfig.setupComplete === true;
  }

  /**
   * Mark setup wizard as complete. Called by the wizard's finish endpoint
   * after all other config has been written. Refuses in read-only mode.
   */
  async markSetupComplete(): Promise<void> {
    assertWritable('mark setup complete');
    this.adminConfig.setupComplete = true;
    await this.writeJsonFile('config.json', this.adminConfig);
  }

  /**
   * Get the current settings policy.
   */
  getPolicy(): SettingsPolicy {
    return this.policyCache;
  }

  /**
   * Update the settings policy. Writes to disk.
   */
  async setPolicy(policy: SettingsPolicy): Promise<void> {
    assertWritable('update settings policy');
    this.policyCache = ConfigManager.normalizePolicy({
      ...DEFAULT_POLICY,
      ...policy,
      features: { ...DEFAULT_FEATURE_GATES, ...(policy.features || {}) },
      themePolicy: { ...DEFAULT_THEME_POLICY, ...(policy.themePolicy || {}) },
    });
    await this.writeJsonFile('policy.json', this.policyCache as unknown as Record<string, unknown>);
  }

  /**
   * Migrates deprecated feature gates forward. The standalone "All Mail" view
   * (`allMailViewEnabled`) was folded into the unified "All mail" entry, so an
   * admin who enabled it keeps that entry available via `crossAllViewEnabled`.
   * Idempotent - safe to run on every load.
   */
  private static normalizePolicy(policy: SettingsPolicy): SettingsPolicy {
    if (policy.features.allMailViewEnabled) {
      policy.features.crossAllViewEnabled = true;
    }
    // Users pick a relay from this list, so half-filled or malformed entries
    // must never reach them as a selectable option.
    policy.pushRelays = (Array.isArray(policy.pushRelays) ? policy.pushRelays : [])
      .map(relay => ({
        label: typeof relay?.label === 'string' ? relay.label.trim() : '',
        url: normalizeRelayUrl(typeof relay?.url === 'string' ? relay.url : ''),
      }))
      .filter(relay => isValidRelayUrl(relay.url));
    const defaultRelay = normalizeRelayUrl(policy.pushRelayUrl);
    policy.pushRelayUrl = isValidRelayUrl(defaultRelay) ? defaultRelay : '';
    return policy;
  }

  /**
   * Reload config from disk (for manual file edits or multi-instance).
   */
  async reload(): Promise<void> {
    await this.load();
  }

  private async readJsonFile(filename: string): Promise<Record<string, unknown> | null> {
    const filePath = getConfigPath(filename);
    try {
      const raw = await readFile(filePath, 'utf-8');
      return JSON.parse(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      logger.warn(`Failed to read ${filename}`, { error: error instanceof Error ? error.message : 'Unknown error' });
      return null;
    }
  }

  private async writeJsonFile(filename: string, data: Record<string, unknown>): Promise<void> {
    await ensureConfigDir();
    const targetPath = getConfigPath(filename);
    const tmpPath = targetPath + '.tmp';
    await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    await rename(tmpPath, targetPath);
  }
}

// Stash the singleton on globalThis so HMR / multiple module-evaluation
// boundaries (middleware vs route handlers in dev with turbopack) all share
// the same in-memory state. Without this, marking setupComplete=true in a
// route handler is invisible to the next middleware run, and the wizard
// redirect after finish never fires.
const SINGLETON_KEY = Symbol.for('bulwark.admin.configManager');
type GlobalWithConfig = typeof globalThis & { [SINGLETON_KEY]?: ConfigManager };
const g = globalThis as GlobalWithConfig;
export const configManager: ConfigManager =
  g[SINGLETON_KEY] ?? (g[SINGLETON_KEY] = new ConfigManager());
