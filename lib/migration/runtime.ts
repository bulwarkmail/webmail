import { logger } from '@/lib/logger';
import { readImpersonationConfig } from '@/lib/impersonation/master-config';
import { masterAuthHeader } from '@/lib/impersonation/app-password';
import { createDavSource } from './dav-source';
import { realClock, type AccountSources, type EngineClock } from './engine';
import { ImapMailSource, type ImapLogin } from './imap-source';
import { JmapMigrationTarget } from './jmap-target';
import { openManageSieve } from './managesieve';
import { decryptSecret } from './secrets';
import { loadSources, type AccountDoc, type MigrationDoc } from './store';
import { NOTES } from './engine';
import type { DavSource, MailSource, MigrationTarget, SieveSource, SourceEndpoints, StoredSource } from './types';

/**
 * How a migration reaches its servers: which source, with which login, and
 * which credential opens the Stalwart account. The protocol clients are
 * behind `deps` so tests run the job against fakes.
 */

export interface DavOpenOptions {
  kind: 'carddav' | 'caldav';
  url: string;
  username: string;
  password: string;
  allowPrivateHost: boolean;
}

export interface SieveOpenOptions {
  host: string;
  port: number;
  login: string;
  password: string;
  allowPrivateHost: boolean;
}

export interface MigrationDeps {
  openMail(login: ImapLogin): Promise<MailSource>;
  openDav(options: DavOpenOptions): Promise<DavSource>;
  openSieve(options: SieveOpenOptions): Promise<SieveSource>;
  openTarget(serverUrl: string, authHeader: string): Promise<MigrationTarget>;
  clock: EngineClock;
}

const defaultDeps: MigrationDeps = {
  openMail: (login) => ImapMailSource.open(login),
  openDav: async (options) => createDavSource(options),
  openSieve: (options) => openManageSieve(options),
  openTarget: (serverUrl, authHeader) => JmapMigrationTarget.open({ serverUrl, authHeader }),
  clock: realClock,
};

const KEY = Symbol.for('bulwark.migrationDeps');

export function migrationDeps(): MigrationDeps {
  const g = globalThis as typeof globalThis & { [KEY]?: MigrationDeps };
  return g[KEY] ?? defaultDeps;
}

/** Swap the protocol clients (tests). Null restores the real ones. */
export function setMigrationDepsForTests(deps: Partial<MigrationDeps> | null): void {
  const g = globalThis as typeof globalThis & { [KEY]?: MigrationDeps };
  if (deps) g[KEY] = { ...defaultDeps, ...deps };
  else delete g[KEY];
}

export function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}

/** The admin login string for a user: `{user}*{admin}` by default (Dovecot master user). */
export function formatAdminLogin(format: string, user: string, admin: string): string {
  return format.replaceAll('{user}', user).replaceAll('{admin}', admin);
}

export class MigrationSetupError extends Error {
  constructor(message: string, readonly code?: 'target-auth') {
    super(message);
    this.name = 'MigrationSetupError';
  }
}

export const MESSAGES = {
  noMaster: 'Bulk migration needs the Stalwart master user. Set BULWARK_STALWART_MASTER_USER and BULWARK_STALWART_MASTER_PASSWORD.',
  sourceRemoved: 'The source server was removed.',
  passwordsForgotten: 'The stored passwords were deleted. Start a new migration.',
  userAccessExpired: "The user's access for this migration expired. The user can start a new pass in Settings.",
  appPasswordExpired: 'The app password for this migration expired.',
} as const;

/** The source endpoints of a migration, and whether its hosts are ones the admin entered. */
export async function migrationSource(migration: MigrationDoc): Promise<{ endpoints: SourceEndpoints; admin: StoredSource | null; allowPrivateHost: boolean }> {
  if (migration.custom) return { endpoints: migration.custom, admin: null, allowPrivateHost: false };
  const source = (await loadSources()).find((s) => s.id === migration.sourceId);
  if (!source) throw new MigrationSetupError(MESSAGES.sourceRemoved);
  return { endpoints: source, admin: source, allowPrivateHost: true };
}

/** The Authorization header the job opens the target account with. */
export function targetAuthHeader(migration: MigrationDoc, account: Pick<AccountDoc, 'target'>, now: number): string {
  if (migration.kind === 'bulk') {
    const master = readImpersonationConfig();
    if (!master) throw new MigrationSetupError(MESSAGES.noMaster);
    return masterAuthHeader(account.target, master.masterUser, master.masterPassword);
  }
  const secret = decryptSecret(migration.appPassword?.secretEnc);
  if (!secret || !migration.owner || !migration.appPassword || Date.parse(migration.appPassword.expiresAt) <= now) {
    throw new MigrationSetupError(MESSAGES.appPasswordExpired, 'target-auth');
  }
  return basicAuth(migration.owner.username, secret);
}

/** The sources of one account entry, with the login the row calls for. */
export async function accountSources(migration: MigrationDoc, account: AccountDoc): Promise<AccountSources> {
  const deps = migrationDeps();
  const { endpoints, admin, allowPrivateHost } = await migrationSource(migration);
  const own = decryptSecret(account.passwordEnc);
  let login: { user: string; password: string };
  let davLogin: { user: string; password: string } | null;
  if (own) {
    login = { user: account.sourceUser, password: own };
    davLogin = login;
  } else {
    const adminPassword = migration.kind === 'bulk' && admin?.adminLogin ? decryptSecret(admin.adminLogin.passwordEnc) : null;
    if (!adminPassword || !admin?.adminLogin) throw new MigrationSetupError(MESSAGES.passwordsForgotten);
    login = { user: formatAdminLogin(admin.adminLogin.format, account.sourceUser, admin.adminLogin.username), password: adminPassword };
    davLogin = null;
  }
  const skipReasons: AccountSources['skipReasons'] = {};
  const sources: AccountSources = { skipReasons };
  sources.mail = () => deps.openMail({ ...endpoints.imap, user: login.user, password: login.password, allowPrivateHost });
  if (!davLogin) {
    skipReasons.contacts = NOTES.davNeedsPassword;
    skipReasons.calendars = NOTES.davNeedsPassword;
  } else {
    const dav = davLogin;
    if (endpoints.carddavUrl) {
      const url = endpoints.carddavUrl;
      sources.contacts = () => deps.openDav({ kind: 'carddav', url, username: dav.user, password: dav.password, allowPrivateHost });
    } else {
      skipReasons.contacts = NOTES.noCardDav;
    }
    if (endpoints.caldavUrl) {
      const url = endpoints.caldavUrl;
      sources.calendars = () => deps.openDav({ kind: 'caldav', url, username: dav.user, password: dav.password, allowPrivateHost });
    } else {
      skipReasons.calendars = NOTES.noCalDav;
    }
  }
  if (endpoints.sieve) {
    const sieve = endpoints.sieve;
    sources.sieve = () => deps.openSieve({ host: sieve.host, port: sieve.port, login: login.user, password: login.password, allowPrivateHost });
  } else {
    skipReasons.filters = NOTES.noSieve;
  }
  return sources;
}

/** Log a migration event: ids and counts only, never passwords, secrets or message data. */
export function logMigration(message: string, fields: Record<string, string | number | boolean | null>): void {
  logger.info(`migration: ${message}`, fields);
}
