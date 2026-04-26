import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { logger } from '@/lib/logger';
import { readFileEnv } from '@/lib/read-file-env';
import { CONFIG_ENV_MAP, DEFAULT_POLICY, DEFAULT_THEME_POLICY, type SettingsPolicy } from './types';

function getAdminDir(): string {
  return process.env.ADMIN_DATA_DIR || path.join(process.cwd(), 'data', 'admin');
}

function parseEnvValue(value: string, type: string): unknown {
  switch (type) {
    case 'boolean':
      return value === 'true';
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
      this.policyCache = {
        ...DEFAULT_POLICY,
        ...policy,
        themePolicy: { ...DEFAULT_THEME_POLICY, ...(policy.themePolicy || {}) },
      };
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
    Object.assign(this.adminConfig, updates);
    await this.writeJsonFile('config.json', this.adminConfig);
  }

  /**
   * Remove an admin override, reverting to env/default.
   */
  async removeAdminOverride(key: string): Promise<void> {
    delete this.adminConfig[key];
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
    this.policyCache = { ...DEFAULT_POLICY, ...policy };
    await this.writeJsonFile('policy.json', this.policyCache as unknown as Record<string, unknown>);
  }

  /**
   * Reload config from disk (for manual file edits or multi-instance).
   */
  async reload(): Promise<void> {
    await this.load();
  }

  private async readJsonFile(filename: string): Promise<Record<string, unknown> | null> {
    const filePath = path.join(getAdminDir(), filename);
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
    const dir = getAdminDir();
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    const targetPath = path.join(dir, filename);
    const tmpPath = targetPath + '.tmp';
    await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    await rename(tmpPath, targetPath);
  }
}

export const configManager = new ConfigManager();
