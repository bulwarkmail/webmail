import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { configureLogger, logger } from '@/lib/logger';
import { readFileEnv } from '@/lib/read-file-env';
import { CONFIG_ENV_MAP, DEFAULT_FEATURE_GATES, DEFAULT_POLICY, DEFAULT_THEME_POLICY, type SettingsPolicy } from './types';
import { ensureConfigDir, getConfigPath, assertWritable, isConfigReadOnly } from './paths';
import { isValidRelayUrl, normalizeRelayUrl } from '@/lib/push-relays';
import { sanitizeDefaultSidebarApps } from '@/lib/sidebar-apps';
import { sanitizePolicyDefaults } from './policy-defaults';
import { sanitizeOrganisationPolicy } from './organisation-policy';
import { sanitizeRestrictions, sanitizeScopes } from './policy-scopes';
import { versionOf } from '@/lib/shared-store/keys';
import { serializeLocal } from '@/lib/shared-store/local';
import { isSharedMode, type StoredDoc } from '@/lib/shared-store';
import { announceChange, onSharedChange } from '@/lib/shared-store/changes';
import { adminConfigDocs } from './admin-store';

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

/** The files load() reads; a change to either is picked up on the next check. */
const WATCHED_FILES = ['config.json', 'policy.json'] as const;
type WatchedFile = typeof WATCHED_FILES[number];

/**
 * How often, at most, the files' stat is compared with what was loaded.
 * Replicas sharing one config volume see each other's admin changes within
 * this time, without a restart.
 */
const CHANGE_CHECK_INTERVAL_MS = 5_000;

/** The policy version while no policy has been saved (the defaults apply). */
export const DEFAULT_POLICY_VERSION = 'default';

/**
 * A policy save based on a version that is no longer the current one:
 * someone else saved in between (another tab, another admin, a plugin
 * deletion). The caller's draft would undo their change.
 */
export class PolicyConflictError extends Error {
  constructor() {
    super('Someone else changed the policy after you opened this page. Reload to see their change; your edits stay here until you reload.');
    this.name = 'PolicyConflictError';
  }
}

/**
 * Whether `error` is a PolicyConflictError. By name, not instanceof: the
 * config manager on globalThis may come from another bundle's copy of this
 * module (the instrumentation creates it), whose class is a different object.
 */
export function isPolicyConflict(error: unknown): error is PolicyConflictError {
  return error instanceof Error && error.name === 'PolicyConflictError';
}

/** Policy writes in this process, one after another, so a version check and its write can't interleave. */
const POLICY_WRITE_QUEUE = 'admin-config\0policy.json';
/** Config read-modify-writes (updateAdminConfig) in this process, one after another. */
const CONFIG_WRITE_QUEUE = 'admin-config\0config.json';

interface ParsedDoc {
  /** null when the stored document doesn't parse (shared mode). */
  data: Record<string, unknown> | null;
  /** As the shared store computes it: changes whenever the bytes do. */
  version: string;
}

function parseDoc(raw: string): ParsedDoc {
  return { data: JSON.parse(raw), version: versionOf(Buffer.from(raw, 'utf-8')) };
}

/**
 * A document from the shared store. Data that doesn't parse comes back as
 * null with the document's version, so an If-Match save can still replace
 * it.
 */
function parseStored(doc: StoredDoc | null, onError?: (error: unknown) => void): ParsedDoc | null {
  if (!doc) return null;
  try {
    return { data: JSON.parse(doc.data.toString('utf-8')), version: doc.version };
  } catch (error) {
    onError?.(error);
    return { data: null, version: doc.version };
  }
}

/** Which stored document a change area reloads. */
const AREA_FILES = { config: 'config.json', policy: 'policy.json' } as const;
type ConfigArea = keyof typeof AREA_FILES;

/** Changes whenever the file is replaced or rewritten; null when it is missing. */
async function fileStamp(filename: string): Promise<string | null> {
  try {
    const s = await stat(getConfigPath(filename));
    return `${s.mtimeMs}:${s.size}:${s.ino}`;
  } catch {
    return null;
  }
}

class ConfigManager {
  private adminConfig: Record<string, unknown> = {};
  private policyCache: SettingsPolicy = { ...DEFAULT_POLICY };
  /** Version of the stored policy the cache came from; null while none is stored. */
  private policyVersion: string | null = null;
  private loaded = false;
  private fileStamps: Partial<Record<WatchedFile, string | null>> = {};
  private lastChangeCheck = 0;
  private changeCheck: Promise<void> | null = null;
  /** Shared mode: the first load, shared by every request that waits for it. */
  private sharedLoad: Promise<void> | null = null;
  /** Shared mode: counts writes applied from their result, so a reload that raced one reads again. */
  private writes = 0;
  /** Shared mode: counts reloads applied, so a write that raced one reads its result again. */
  private reloads = 0;
  private unlisten: (() => void) | null = null;

  /**
   * Shared mode (#1066): config and policy live in the shared store, and
   * every replica reloads them when another one announces a change.
   * Read-only config keeps reading the mounted files, as in local mode.
   */
  private usesStore(): boolean {
    return isSharedMode() && !isConfigReadOnly();
  }

  /** Load admin config and policy from disk. Called once at startup and on reload. */
  async load(): Promise<void> {
    if (this.usesStore()) return this.loadShared();
    // Stamped before reading, so a write that lands mid-read is seen next time.
    const stamps = await this.readStamps();
    this.apply(await this.readJsonFile('config.json'), await this.readJsonFile('policy.json'));
    this.fileStamps = stamps;
    this.lastChangeCheck = Date.now();
    logger.debug('ConfigManager loaded', { configKeys: Object.keys(this.adminConfig).length });
  }

  private apply(config: ParsedDoc | null, policy: ParsedDoc | null): void {
    this.adminConfig = config?.data || {};
    this.applyPolicyDoc(policy);
    this.loaded = true;
    this.applyLoggerSettings();
  }

  private applyPolicyDoc(policy: ParsedDoc | null): void {
    this.policyCache = policy?.data
      ? ConfigManager.completePolicy(policy.data as Partial<SettingsPolicy>)
      : { ...DEFAULT_POLICY };
    this.policyVersion = policy?.version ?? null;
  }

  private async loadShared(): Promise<void> {
    this.listenForChanges();
    const docs = adminConfigDocs();
    const [config, policy] = await Promise.all([docs.get('config.json'), docs.get('policy.json')]);
    this.apply(this.parseOrWarn('config.json', config), this.parseOrWarn('policy.json', policy));
    logger.debug('ConfigManager loaded from the shared store', { configKeys: Object.keys(this.adminConfig).length });
  }

  /** As a broken file on disk: logged, and the defaults apply. */
  private parseOrWarn(filename: string, doc: StoredDoc | null): ParsedDoc | null {
    return parseStored(doc, (error) => {
      logger.warn(`Failed to read ${filename} from the shared store`, { error: error instanceof Error ? error.message : 'Unknown error' });
    });
  }

  /** Reload config or policy when another replica changed it. Registered again on every load. */
  private listenForChanges(): void {
    this.unlisten?.();
    const off = (Object.keys(AREA_FILES) as ConfigArea[]).map((area) =>
      // A change of this process already replaced the copy in memory.
      onSharedChange(area, (origin) => (origin === 'remote' ? this.reloadShared(area) : undefined)),
    );
    this.unlisten = () => off.forEach((fn) => fn());
  }

  /**
   * Read one document again. Throws when the store can't be read, or when
   * writes of this process kept landing while reading; the change poller
   * then tries again. A document that doesn't parse keeps the copy in
   * memory (the policy takes its version, so a save can replace it).
   */
  private async reloadShared(area: ConfigArea): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const writes = this.writes;
      const doc = this.parseOrWarn(AREA_FILES[area], await adminConfigDocs().get(AREA_FILES[area]));
      // A write of this process landed while reading: its result may be newer.
      if (writes !== this.writes) continue;
      this.applyReloaded(area, doc);
      return;
    }
    throw new Error(`${AREA_FILES[area]} kept changing while it was reloaded`);
  }

  private applyReloaded(area: ConfigArea, doc: ParsedDoc | null): void {
    this.reloads++;
    if (doc && doc.data === null) {
      if (area === 'policy') this.policyVersion = doc.version;
      return;
    }
    if (area === 'config') {
      this.adminConfig = doc?.data || {};
      this.applyLoggerSettings();
    } else {
      this.applyPolicyDoc(doc);
    }
  }

  /**
   * After a write of this process: apply its result, unless a reload of
   * another replica's change was applied while it was in flight. That one
   * may be newer than the write, so the document is read again instead.
   */
  private async applyWritten(area: ConfigArea, reloadsBefore: number, apply: () => void): Promise<void> {
    this.writes++;
    if (this.reloads === reloadsBefore) {
      apply();
      return;
    }
    try {
      this.applyReloaded(area, this.parseOrWarn(AREA_FILES[area], await adminConfigDocs().get(AREA_FILES[area])));
    } catch {
      apply();
    }
  }

  /**
   * Shared mode: change the stored config.json with `change` (which edits
   * the object it gets), so only the keys a request names change and a
   * concurrent save of other keys on another replica stays.
   */
  private async updateSharedConfig(change: (config: Record<string, unknown>) => void | false): Promise<void> {
    const inMemory = this.adminConfig;
    const reloads = this.reloads;
    const result = await adminConfigDocs().update('config.json', (current) => {
      let base: Record<string, unknown> = {};
      if (current) {
        try {
          base = JSON.parse(current.toString('utf-8'));
        } catch {
          // Broken in the store: start from this replica's copy, as a broken file would.
          base = { ...inMemory };
        }
      }
      if (change(base) === false) return undefined;
      return JSON.stringify(base, null, 2);
    });
    if (result.data === undefined) return;
    await this.applyWritten('config', reloads, () => {
      if (result.data) this.adminConfig = JSON.parse(result.data.toString('utf-8'));
      this.applyLoggerSettings();
    });
    await announceChange('config');
  }

  private async readStamps(): Promise<Partial<Record<WatchedFile, string | null>>> {
    const stamps: Partial<Record<WatchedFile, string | null>> = {};
    for (const file of WATCHED_FILES) stamps[file] = await fileStamp(file);
    return stamps;
  }

  /**
   * Reload when config.json or policy.json changed on disk since the last
   * load (another replica on the same volume saved, or someone edited the
   * file). A file that can't be read or parsed keeps the values in memory
   * and is tried again at the next check.
   */
  private async reloadIfChanged(): Promise<void> {
    const stamps = await this.readStamps();
    if (WATCHED_FILES.every((file) => stamps[file] === this.fileStamps[file])) return;
    try {
      const [config, policy] = await Promise.all([
        this.readJsonFileOrThrow('config.json'),
        this.readJsonFileOrThrow('policy.json'),
      ]);
      this.apply(config, policy);
      this.fileStamps = stamps;
      logger.info('Admin config changed on disk; reloaded');
    } catch (error) {
      logger.warn('Admin config changed on disk but could not be read; keeping the current values', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /** At most every CHANGE_CHECK_INTERVAL_MS: one stat per watched file. */
  private checkForChanges(): Promise<void> {
    // Shared mode hears of changes from the store instead (listenForChanges).
    if (!this.loaded || this.usesStore()) return Promise.resolve();
    if (this.changeCheck) return this.changeCheck;
    const now = Date.now();
    if (now - this.lastChangeCheck < CHANGE_CHECK_INTERVAL_MS) return Promise.resolve();
    this.lastChangeCheck = now;
    this.changeCheck = this.reloadIfChanged().finally(() => {
      this.changeCheck = null;
    });
    return this.changeCheck;
  }

  /** Hand the configured log level and format to the logger. */
  private applyLoggerSettings(): void {
    configureLogger({
      level: this.get<string>('logLevel'),
      format: this.get<string>('logFormat'),
    });
  }

  /**
   * Ensure config is loaded. Once loaded, waits for the periodic check for
   * changes on disk when one is due (a stat per file, every few seconds).
   * In shared mode a request never waits on the store once the config is
   * loaded: changes arrive through the change notices.
   */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return this.checkForChanges();
    if (!this.usesStore()) return this.load();
    this.sharedLoad ??= this.load().finally(() => {
      this.sharedLoad = null;
    });
    await this.sharedLoad;
  }

  /**
   * Get a config value. Priority: admin override > env var > default.
   */
  get<T>(key: string, defaultValue?: T): T {
    // Synchronous callers can't wait: a due check runs in the background and
    // the next read sees its result.
    void this.checkForChanges();
    return ConfigManager.resolve(this.adminConfig, key, defaultValue);
  }

  /** A value as get() reads it, from the admin overrides in `adminConfig`. */
  private static resolve<T>(adminConfig: Record<string, unknown>, key: string, defaultValue?: T): T {
    // Admin override (highest priority)
    const mapping = CONFIG_ENV_MAP[key];
    if (key in adminConfig) {
      return adminConfig[key] as T;
    } else if (mapping && mapping.fileKey && mapping.fileKey in adminConfig) {
      const fileVal = readFileEnv(<string | undefined>adminConfig[mapping.fileKey]);
      if (fileVal !== null) {
        return parseEnvValue(fileVal, mapping.type) as T;
      }
    }

    // Environment variable
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
    void this.checkForChanges();
    const result: Record<string, { value: unknown; source: 'admin' | 'env' | 'default' }> = {};
    for (const [key, mapping] of Object.entries(CONFIG_ENV_MAP)) {
      if (key in this.adminConfig) {
        result[key] = { value: this.adminConfig[key], source: 'admin' };
      } else if (mapping.fileKey && mapping.fileKey in this.adminConfig) {
        const fileVal = readFileEnv(<string | undefined>this.adminConfig[mapping.fileKey]);
        if (fileVal !== null) {
          result[key] = { value: parseEnvValue(fileVal, mapping.type), source: 'admin' };
          continue;
        }

        result[key] = { value: mapping.defaultValue, source: 'default' };
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
    if (this.usesStore()) {
      return this.updateSharedConfig((config) => {
        Object.assign(config, updates);
      });
    }
    // Start from what is on disk, so a save here doesn't undo a change another
    // replica saved a moment ago. Same before every write below.
    await this.reloadIfChanged();
    Object.assign(this.adminConfig, updates);
    await this.writeJsonFile('config.json', this.adminConfig);
    this.applyLoggerSettings();
  }

  /**
   * Set one admin override to `change(current)`, where `current` is the value
   * as get() would return it from the stored config (override, else env,
   * else `defaultValue`). For values built on the current one, such as a
   * list with one entry changed: two saves at once, here or on another
   * replica, each build on the other's result. Return undefined to leave
   * it. Returns the value stored.
   */
  async updateAdminConfig<T>(key: string, change: (current: T) => T | undefined, defaultValue?: T): Promise<T | undefined> {
    assertWritable('update admin config');
    let stored: T | undefined;
    if (this.usesStore()) {
      await this.updateSharedConfig((config) => {
        stored = change(ConfigManager.resolve(config, key, defaultValue));
        if (stored === undefined) return false;
        config[key] = stored;
      });
      return stored;
    }
    return serializeLocal(CONFIG_WRITE_QUEUE, async () => {
      await this.reloadIfChanged();
      stored = change(ConfigManager.resolve(this.adminConfig, key, defaultValue));
      if (stored === undefined) return undefined;
      this.adminConfig[key] = stored;
      await this.writeJsonFile('config.json', this.adminConfig);
      this.applyLoggerSettings();
      return stored;
    });
  }

  /**
   * Remove an admin override, reverting to env/default.
   */
  async removeAdminOverride(key: string): Promise<void> {
    assertWritable('remove admin override');
    if (this.usesStore()) {
      return this.updateSharedConfig((config) => {
        delete config[key];
      });
    }
    await this.reloadIfChanged();
    delete this.adminConfig[key];
    await this.writeJsonFile('config.json', this.adminConfig);
    this.applyLoggerSettings();
  }

  /**
   * Whether the setup wizard has completed. Used by middleware to gate the
   * /setup routes and the rest of the app.
   */
  isSetupComplete(): boolean {
    void this.checkForChanges();
    return this.adminConfig.setupComplete === true;
  }

  /**
   * Mark setup wizard as complete. Called by the wizard's finish endpoint
   * after all other config has been written. Refuses in read-only mode.
   */
  async markSetupComplete(): Promise<void> {
    assertWritable('mark setup complete');
    if (this.usesStore()) {
      return this.updateSharedConfig((config) => {
        config.setupComplete = true;
      });
    }
    await this.reloadIfChanged();
    this.adminConfig.setupComplete = true;
    await this.writeJsonFile('config.json', this.adminConfig);
  }

  /**
   * Get the current settings policy.
   */
  getPolicy(): SettingsPolicy {
    void this.checkForChanges();
    return this.policyCache;
  }

  /**
   * The version of the policy getPolicy() returns, for an ETag. Changes with
   * every save; DEFAULT_POLICY_VERSION while none was saved.
   */
  getPolicyVersion(): string {
    return this.policyVersion ?? DEFAULT_POLICY_VERSION;
  }

  /**
   * The policy and its version, read together. Use this whenever both go
   * out (a body with its ETag): an await between two separate reads lets a
   * change from another replica pair an old policy with the new version.
   */
  getPolicyWithVersion(): { policy: SettingsPolicy; version: string } {
    return { policy: this.getPolicy(), version: this.getPolicyVersion() };
  }

  /**
   * Update the settings policy. Writes to disk. With `ifVersion` (from
   * getPolicyVersion when the caller read the policy) it refuses with a
   * PolicyConflictError when the stored policy has changed since, so a
   * draft based on an older policy can't undo someone else's save.
   * Returns the new version.
   */
  async setPolicy(policy: SettingsPolicy, options: { ifVersion?: string } = {}): Promise<string> {
    assertWritable('update settings policy');
    if (this.usesStore()) return this.setSharedPolicy(policy, options.ifVersion);
    return serializeLocal(POLICY_WRITE_QUEUE, async () => {
      if (options.ifVersion !== undefined) {
        // Compare with what is on disk now, not with what this process saw last.
        await this.reloadIfChanged();
        if (options.ifVersion !== this.getPolicyVersion()) throw new PolicyConflictError();
      }
      this.policyCache = ConfigManager.completePolicy(policy);
      await this.writeJsonFile('policy.json', this.policyCache as unknown as Record<string, unknown>);
      return this.getPolicyVersion();
    });
  }

  /**
   * Change the stored policy with `change` (return undefined to leave it).
   * For changes to one part of the policy that must not undo a save that
   * lands at the same time, such as dropping a deleted plugin's id.
   */
  async updatePolicy(change: (current: SettingsPolicy) => SettingsPolicy | undefined): Promise<void> {
    assertWritable('update settings policy');
    if (this.usesStore()) return this.updateSharedPolicy(change);
    await serializeLocal(POLICY_WRITE_QUEUE, async () => {
      // Change what is on disk now, not what this process saw last.
      await this.reloadIfChanged();
      const next = change(this.policyCache);
      if (next === undefined) return;
      this.policyCache = ConfigManager.completePolicy(next);
      await this.writeJsonFile('policy.json', this.policyCache as unknown as Record<string, unknown>);
    });
  }

  private async setSharedPolicy(policy: SettingsPolicy, ifVersion: string | undefined): Promise<string> {
    const completed = ConfigManager.completePolicy(policy);
    const expected = ifVersion === DEFAULT_POLICY_VERSION ? null : ifVersion;
    const reloads = this.reloads;
    const result = await adminConfigDocs().put(
      'policy.json',
      JSON.stringify(completed, null, 2),
      expected === undefined ? {} : { ifVersion: expected },
    );
    if (!result.ok) {
      this.writes++;
      // Show what is stored now, so a retry or a reload compares with it.
      this.applyReloaded('policy', this.parseOrWarn('policy.json', result.current));
      throw new PolicyConflictError();
    }
    const version = result.version;
    await this.applyWritten('policy', reloads, () => {
      this.policyCache = completed;
      this.policyVersion = version;
    });
    await announceChange('policy');
    return version;
  }

  private async updateSharedPolicy(change: (current: SettingsPolicy) => SettingsPolicy | undefined): Promise<void> {
    const reloads = this.reloads;
    const result = await adminConfigDocs().update('policy.json', (current) => {
      const stored = current
        ? ConfigManager.completePolicy(JSON.parse(current.toString('utf-8')) as Partial<SettingsPolicy>)
        : ConfigManager.completePolicy({});
      const next = change(stored);
      return next === undefined ? undefined : JSON.stringify(ConfigManager.completePolicy(next), null, 2);
    });
    if (result.data === undefined) return;
    await this.applyWritten('policy', reloads, () => {
      this.applyPolicyDoc(result.data && result.version ? parseStored({ data: result.data, version: result.version }) : null);
    });
    await announceChange('policy');
  }

  /**
   * A policy as it would be stored: defaults filled in, migrated and
   * sanitised, exactly as policy.json is on load. For previewing an import.
   */
  static completePolicy(policy: Partial<SettingsPolicy>): SettingsPolicy {
    return ConfigManager.normalizePolicy({
      ...DEFAULT_POLICY,
      ...policy,
      restrictions: { ...(policy.restrictions || {}) },
      defaults: { ...(policy.defaults || {}) },
      features: { ...DEFAULT_FEATURE_GATES, ...(policy.features || {}) },
      themePolicy: { ...DEFAULT_THEME_POLICY, ...(policy.themePolicy || {}) },
    });
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
    // Operator-pinned sidebar apps reach every user's rail, and policy.json can
    // be hand-edited, so the list is validated here rather than at render time.
    policy.defaultSidebarApps = sanitizeDefaultSidebarApps(policy.defaultSidebarApps);
    // Same for the values users start with (#1248).
    policy.defaults = sanitizePolicyDefaults(policy.defaults);
    ConfigManager.migrateSessionTimeout(policy);
    policy.restrictions = sanitizeRestrictions(policy.restrictions);
    policy.organisation = sanitizeOrganisationPolicy(policy.organisation);
    policy.scopes = sanitizeScopes(policy.scopes);
    return policy;
  }

  /**
   * The user setting `sessionTimeout` was never read by anything; an admin
   * who locked it to a number of minutes meant an idle timeout, which is
   * organisation.session.idleMinutes now. Moved over once, unless the
   * organisation setting is already there.
   */
  private static migrateSessionTimeout(policy: SettingsPolicy): void {
    const restriction = policy.restrictions?.sessionTimeout;
    const minutes = typeof restriction?.value === 'number' ? restriction.value : policy.defaults?.sessionTimeout;
    const raw = (policy.organisation ?? {}) as unknown as Record<string, Record<string, unknown> | undefined>;
    if (typeof minutes === 'number' && minutes > 0 && typeof raw.session?.idleMinutes !== 'number') {
      policy.organisation = { ...raw, session: { ...(raw.session ?? {}), idleMinutes: minutes } } as unknown as SettingsPolicy['organisation'];
    }
    if (policy.restrictions) delete policy.restrictions.sessionTimeout;
    if (policy.defaults) delete policy.defaults.sessionTimeout;
  }

  /**
   * Reload config from disk now. Changes on disk are also picked up on their
   * own within CHANGE_CHECK_INTERVAL_MS (see checkForChanges).
   */
  async reload(): Promise<void> {
    await this.load();
  }

  private async readJsonFile(filename: string): Promise<ParsedDoc | null> {
    try {
      return await this.readJsonFileOrThrow(filename);
    } catch (error) {
      logger.warn(`Failed to read ${filename}`, { error: error instanceof Error ? error.message : 'Unknown error' });
      return null;
    }
  }

  /** null when the file doesn't exist; throws when it can't be read or parsed. */
  private async readJsonFileOrThrow(filename: string): Promise<ParsedDoc | null> {
    try {
      return parseDoc(await readFile(getConfigPath(filename), 'utf-8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async writeJsonFile(filename: WatchedFile, data: Record<string, unknown>): Promise<void> {
    await ensureConfigDir();
    const targetPath = getConfigPath(filename);
    const tmpPath = targetPath + '.tmp';
    const text = JSON.stringify(data, null, 2);
    // Owner-only: config.json carries the session secret and OAuth client secrets.
    await writeFile(tmpPath, text, { encoding: 'utf-8', mode: 0o600 });
    await rename(tmpPath, targetPath);
    if (filename === 'policy.json') this.policyVersion = versionOf(Buffer.from(text, 'utf-8'));
    // Our own write is not a change to pick up.
    this.fileStamps[filename] = await fileStamp(filename);
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

/** See ConfigManager.completePolicy. */
export const completePolicy = (policy: Partial<SettingsPolicy>): SettingsPolicy => ConfigManager.completePolicy(policy);
