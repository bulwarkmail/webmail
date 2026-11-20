import { isIP } from 'node:net';
import { readImpersonationConfig, resolveImpersonationServerUrl } from '@/lib/impersonation/master-config';
import { masterAuthHeader } from '@/lib/impersonation/app-password';
import { isIntranetAddress, isIntranetHostName, resolveCheckedAddress } from '@/lib/security/url-guard';
import { isPrivateAddress } from '@/lib/security/ip-ranges';
import { getStore } from '@/lib/shared-store';
import { checkTargetsExist, parseMigrationCsv, type CsvProblem } from './csv';
import { newAccountState } from './engine';
import { dropAppPassword, forgetAt, forgetCredentials } from './job';
import { fetchTargetSession } from './jmap-target';
import { basicAuth, logMigration, MESSAGES, migrationDeps, type MigrationDeps } from './runtime';
import { encryptSecret, decryptSecret } from './secrets';
import {
  accountKey,
  deleteMigrationDocs,
  isRunning,
  listAccounts,
  listMigrations,
  loadMigration,
  loadOptions,
  loadSources,
  newId,
  normalizeOptions,
  putAccount,
  putMigration,
  saveOptions,
  updateAccount,
  updateMigration,
  updateSources,
  type AccountDoc,
  type MigrationDoc,
} from './store';
import {
  DEFAULT_LOGIN_FORMAT,
  PHASES,
  SourceError,
  TargetAuthError,
  type AccountStatus,
  type CopyWhat,
  type MigrationOptions,
  type PublicSource,
  type SourceEndpoints,
  type StoredSource,
} from './types';

/**
 * What the admin and user API routes do with migrations. Errors the caller
 * shows carry a `code` the Settings page translates; the admin panel shows
 * the English message.
 */

export class MigrationRequestError extends Error {
  constructor(message: string, readonly status = 400, readonly code?: string) {
    super(message);
    this.name = 'MigrationRequestError';
  }
}

export const PUBLIC_ONLY = "This server can't be reached from here. Only servers on the public internet are allowed.";
export const NOT_ALLOWED_ANY_MORE = 'Your administrator no longer allows this server.';
const DAY_MS = 24 * 60 * 60 * 1000;

function now(): number {
  return migrationDeps().clock.now();
}

// ─── Input checks ──────────────────────────────────────────────────────────

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;

function str(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function checkHost(raw: unknown, label: string, userEntered: boolean): string {
  const host = str(raw, 253).replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (!host || (!isIP(host) && !HOST_NAME.test(host))) throw new MigrationRequestError(`${label}: enter a host name.`);
  if (host === 'localhost' || host.endsWith('.localhost')) throw new MigrationRequestError(`${label}: this address is not allowed.`, 400, 'blocked');
  if (isIP(host) && isPrivateAddress(host) && (userEntered || !isIntranetAddress(host))) {
    throw new MigrationRequestError(userEntered ? PUBLIC_ONLY : `${label}: this address is not allowed.`, 400, 'blocked');
  }
  if (userEntered && isIntranetHostName(host)) throw new MigrationRequestError(PUBLIC_ONLY, 400, 'blocked');
  return host;
}

function checkPort(raw: unknown, fallback: number, label: string): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new MigrationRequestError(`${label}: the port must be between 1 and 65535.`);
  return port;
}

function checkDavUrl(raw: unknown, label: string, userEntered: boolean): string | undefined {
  const value = str(raw, 2000);
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MigrationRequestError(`${label}: enter a full address such as https://dav.example.com/.`);
  }
  if (url.username || url.password) throw new MigrationRequestError(`${label}: leave the login out of the address.`);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new MigrationRequestError(`${label}: the address must start with https://.`);
  const host = checkHost(url.hostname, label, userEntered);
  if (url.protocol === 'http:' && (userEntered || !isIntranetHostName(host))) {
    throw new MigrationRequestError(`${label}: the address must start with https://.`, 400, 'dav-https');
  }
  return url.toString();
}

/** Endpoints from a request: an admin's source, or a server a user typed in (public, encrypted only). */
export function parseEndpoints(raw: unknown, userEntered: boolean): SourceEndpoints {
  const input = (raw ?? {}) as Record<string, unknown>;
  const imapIn = (input.imap ?? {}) as Record<string, unknown>;
  const security = imapIn.security === undefined ? 'tls' : imapIn.security;
  if (security !== 'tls' && security !== 'starttls' && security !== 'none') throw new MigrationRequestError('IMAP: choose TLS, STARTTLS or None.');
  const imapHost = checkHost(imapIn.host, 'IMAP', userEntered);
  if (security === 'none' && (userEntered || !isIntranetHostName(imapHost))) {
    throw new MigrationRequestError('IMAP: None is only allowed for a server on your intranet.', 400, 'none-security');
  }
  const endpoints: SourceEndpoints = {
    imap: { host: imapHost, port: checkPort(imapIn.port, security === 'tls' ? 993 : 143, 'IMAP'), security },
  };
  const caldavUrl = checkDavUrl(input.caldavUrl, 'CalDAV', userEntered);
  const carddavUrl = checkDavUrl(input.carddavUrl, 'CardDAV', userEntered);
  if (caldavUrl) endpoints.caldavUrl = caldavUrl;
  if (carddavUrl) endpoints.carddavUrl = carddavUrl;
  const sieveIn = input.sieve as Record<string, unknown> | null | undefined;
  if (sieveIn && str(sieveIn.host)) {
    endpoints.sieve = { host: checkHost(sieveIn.host, 'ManageSieve', userEntered), port: checkPort(sieveIn.port, 4190, 'ManageSieve') };
  }
  return endpoints;
}

function parseWhat(raw: unknown): CopyWhat {
  const input = (raw ?? {}) as Record<string, unknown>;
  const what = { mail: input.mail !== false, contacts: input.contacts !== false, calendars: input.calendars !== false, filters: input.filters !== false };
  if (!PHASES.some((phase) => what[phase])) throw new MigrationRequestError('Choose at least one thing to copy.');
  return what;
}

// ─── Views (never a password) ──────────────────────────────────────────────

export function publicSource(source: StoredSource): PublicSource {
  return {
    id: source.id,
    name: source.name,
    imap: source.imap,
    ...(source.caldavUrl ? { caldavUrl: source.caldavUrl } : {}),
    ...(source.carddavUrl ? { carddavUrl: source.carddavUrl } : {}),
    ...(source.sieve ? { sieve: source.sieve } : {}),
    ...(source.adminLogin ? { adminLogin: { username: source.adminLogin.username, format: source.adminLogin.format, passwordSaved: !!source.adminLogin.passwordEnc } } : {}),
    allowSelfService: source.allowSelfService,
  };
}

export interface PublicAccount {
  key: string;
  row?: number;
  sourceUser: string;
  target: string;
  status: AccountStatus;
  phase?: string;
  pausedUntil?: number;
  progress: AccountDoc['progress'];
  report: AccountDoc['report'];
  error?: string;
  errorCode?: string;
  passes: number;
  passStartedAt?: number;
  passFinishedAt?: number;
  passwordSaved: boolean;
}

export function publicAccount(doc: AccountDoc): PublicAccount {
  return {
    key: doc.key,
    ...(doc.row !== undefined ? { row: doc.row } : {}),
    sourceUser: doc.sourceUser,
    target: doc.target,
    status: doc.status,
    ...(doc.phase ? { phase: doc.phase } : {}),
    ...(doc.pausedUntil ? { pausedUntil: doc.pausedUntil } : {}),
    progress: doc.progress,
    report: doc.report,
    ...(doc.error ? { error: doc.error } : {}),
    ...(doc.errorCode ? { errorCode: doc.errorCode } : {}),
    passes: doc.passes,
    ...(doc.passStartedAt ? { passStartedAt: doc.passStartedAt } : {}),
    ...(doc.passFinishedAt ? { passFinishedAt: doc.passFinishedAt } : {}),
    passwordSaved: !!doc.passwordEnc,
  };
}

export interface PublicMigration {
  id: string;
  kind: 'bulk' | 'self';
  startedBy: string;
  sourceName: string;
  /** The hosts a user typed in, for the admin's eyes. */
  customHosts?: string[];
  what: CopyWhat;
  createdAt: number;
  lastPassAt: number;
  finishedAt?: number;
  credentialsForgottenAt?: number;
  /** When the stored passwords go, unless the migration is finished first. */
  forgetAt?: number;
  appPasswordExpiresAt?: string;
  accountCount: number;
  statusCounts: Partial<Record<AccountStatus, number>>;
  progress: { messagesDone: number; messagesTotal: number };
  running: boolean;
}

function hostsOf(endpoints: SourceEndpoints): string[] {
  const out = [`${endpoints.imap.host}:${endpoints.imap.port}`];
  for (const url of [endpoints.caldavUrl, endpoints.carddavUrl]) if (url) out.push(new URL(url).host);
  if (endpoints.sieve) out.push(`${endpoints.sieve.host}:${endpoints.sieve.port}`);
  return [...new Set(out)];
}

export function publicMigration(doc: MigrationDoc, accounts: AccountDoc[], options: MigrationOptions): PublicMigration {
  const statusCounts: Partial<Record<AccountStatus, number>> = {};
  const progress = { messagesDone: 0, messagesTotal: 0 };
  for (const account of accounts) {
    statusCounts[account.status] = (statusCounts[account.status] ?? 0) + 1;
    progress.messagesDone += account.progress.messagesDone;
    progress.messagesTotal += account.progress.messagesTotal;
  }
  return {
    id: doc.id,
    kind: doc.kind,
    startedBy: doc.startedBy,
    sourceName: doc.sourceName,
    ...(doc.custom ? { customHosts: hostsOf(doc.custom) } : {}),
    what: doc.what,
    createdAt: doc.createdAt,
    lastPassAt: doc.lastPassAt,
    ...(doc.finishedAt ? { finishedAt: doc.finishedAt } : {}),
    ...(doc.credentialsForgottenAt ? { credentialsForgottenAt: doc.credentialsForgottenAt } : {}),
    ...(!doc.finishedAt && !doc.credentialsForgottenAt ? { forgetAt: forgetAt(doc, options.forgetAfterDays) } : {}),
    ...(doc.appPassword && !doc.credentialsForgottenAt ? { appPasswordExpiresAt: doc.appPassword.expiresAt } : {}),
    accountCount: accounts.length,
    statusCounts,
    progress,
    running: accounts.some(isRunning),
  };
}

// ─── Admin: sources and options ────────────────────────────────────────────

export function isMasterConfigured(): boolean {
  return readImpersonationConfig() !== null;
}

export async function adminOverview() {
  const [sources, options, migrations] = await Promise.all([loadSources(), loadOptions(), listMigrations()]);
  const list = await Promise.all(migrations.map(async (m) => publicMigration(m, await listAccounts(m.id), options)));
  return { masterConfigured: isMasterConfigured(), sources: sources.map(publicSource), options, migrations: list };
}

/**
 * Add or change a source. `password`: a new admin password; absent keeps
 * the saved one. An admin login without a username removes the login.
 */
export async function saveSource(raw: unknown): Promise<PublicSource> {
  const input = (raw ?? {}) as Record<string, unknown>;
  const name = str(input.name, 100);
  if (!name) throw new MigrationRequestError('Enter a name.');
  const endpoints = parseEndpoints(input, false);
  const loginIn = input.adminLogin as Record<string, unknown> | null | undefined;
  const username = str(loginIn?.username, 320);
  const format = str(loginIn?.format, 200) || DEFAULT_LOGIN_FORMAT;
  if (username && !format.includes('{user}')) throw new MigrationRequestError('The login format must contain {user}.');
  const newPassword = typeof loginIn?.password === 'string' && loginIn.password !== '' ? loginIn.password : null;
  const id = str(input.id, 64);
  const time = now();
  let saved: StoredSource | null = null;
  await updateSources((sources) => {
    const existing = id ? sources.find((s) => s.id === id) : undefined;
    if (id && !existing) throw new MigrationRequestError('No such source.', 404);
    const passwordEnc = newPassword ? encryptSecret(newPassword) : existing?.adminLogin?.passwordEnc;
    saved = {
      id: existing?.id ?? newId(),
      name,
      ...endpoints,
      ...(username ? { adminLogin: { username, format, ...(passwordEnc ? { passwordEnc } : {}) } } : {}),
      allowSelfService: input.allowSelfService === true,
      createdAt: existing?.createdAt ?? time,
      updatedAt: time,
    };
    return existing ? sources.map((s) => (s.id === existing.id ? saved! : s)) : [...sources, saved];
  });
  return publicSource(saved!);
}

export async function deleteSource(id: string): Promise<boolean> {
  let found = false;
  await updateSources((sources) => {
    found = sources.some((s) => s.id === id);
    return sources.filter((s) => s.id !== id);
  });
  return found;
}

export async function saveMigrationOptions(raw: unknown): Promise<MigrationOptions> {
  const options = normalizeOptions(raw as Partial<MigrationOptions>);
  await saveOptions(options);
  return options;
}

// ─── Testing a connection ──────────────────────────────────────────────────

export type TestProtocol = 'imap' | 'carddav' | 'caldav' | 'sieve';
export type TestOutcome = { protocol: TestProtocol; ok: true } | { protocol: TestProtocol; ok: false; kind: SourceError['kind']; error: string };

const KIND_WORDS: Record<SourceError['kind'], string> = {
  tls: 'TLS failed',
  auth: 'Login refused',
  network: 'Not reachable',
  blocked: 'Blocked address',
  protocol: 'Unexpected answer',
};

function outcome(protocol: TestProtocol, error: unknown): TestOutcome {
  const kind: SourceError['kind'] = error instanceof SourceError ? error.kind : (error as { code?: string })?.code === 'EBLOCKED' ? 'blocked' : 'network';
  return { protocol, ok: false, kind, error: KIND_WORDS[kind] };
}

/** Connect to each configured protocol with a login typed in for the test (never stored). */
export async function testEndpoints(endpoints: SourceEndpoints, login: { user: string; password: string; sieveLogin?: string }, allowPrivateHost: boolean): Promise<TestOutcome[]> {
  const deps: MigrationDeps = migrationDeps();
  const tests: Promise<TestOutcome>[] = [];
  tests.push((async () => {
    try {
      const mail = await deps.openMail({ ...endpoints.imap, user: login.user, password: login.password, allowPrivateHost });
      await mail.listFolders();
      await mail.close();
      return { protocol: 'imap', ok: true } as const;
    } catch (error) {
      return outcome('imap', error);
    }
  })());
  for (const [protocol, url, kind] of [['carddav', endpoints.carddavUrl, 'carddav'], ['caldav', endpoints.caldavUrl, 'caldav']] as const) {
    if (!url) continue;
    tests.push((async () => {
      try {
        const dav = await deps.openDav({ kind, url, username: login.user, password: login.password, allowPrivateHost });
        await dav.listCollections();
        return { protocol, ok: true } as const;
      } catch (error) {
        return outcome(protocol, error);
      }
    })());
  }
  if (endpoints.sieve) {
    const sieve = endpoints.sieve;
    tests.push((async () => {
      try {
        const client = await deps.openSieve({ host: sieve.host, port: sieve.port, login: login.sieveLogin ?? login.user, password: login.password, allowPrivateHost });
        await client.listScripts();
        await client.close();
        return { protocol: 'sieve', ok: true } as const;
      } catch (error) {
        return outcome('sieve', error);
      }
    })());
  }
  return Promise.all(tests);
}

/** Admin "Test": a saved source (by id) or the form as it stands, with a login typed into the dialog. */
export async function adminTestSource(raw: unknown): Promise<TestOutcome[]> {
  const input = (raw ?? {}) as Record<string, unknown>;
  const user = str(input.username, 320);
  const password = typeof input.password === 'string' ? input.password : '';
  if (!user || !password) throw new MigrationRequestError('Enter a username and password to test with.');
  const endpoints = input.source ? parseEndpoints(input.source, false) : (await loadSources()).find((s) => s.id === input.id);
  if (!endpoints) throw new MigrationRequestError('No such source.', 404);
  return testEndpoints(endpoints, { user, password }, true);
}

// ─── Admin: bulk migrations ────────────────────────────────────────────────

async function targetExists(serverUrl: string, target: string): Promise<boolean> {
  const master = readImpersonationConfig();
  if (!master) return false;
  try {
    await fetchTargetSession(serverUrl, masterAuthHeader(target, master.masterUser, master.masterPassword));
    return true;
  } catch {
    return false;
  }
}

async function bulkSetup(sourceId: string) {
  if (!isMasterConfigured()) throw new MigrationRequestError(MESSAGES.noMaster, 409, 'no-master');
  const source = (await loadSources()).find((s) => s.id === sourceId);
  if (!source) throw new MigrationRequestError('Choose a source server.', 400);
  const serverUrl = await resolveImpersonationServerUrl();
  if (!serverUrl) throw new MigrationRequestError('No JMAP server is configured.', 409);
  return { source, serverUrl: serverUrl.replace(/\/+$/, '') };
}

export interface CsvCheck {
  rows: number;
  problems: CsvProblem[];
}

/** Check a CSV without starting anything: every bad row with its number and reason. */
export async function validateBulkCsv(sourceId: string, csv: string, existsFn?: (target: string) => Promise<boolean>) {
  const { source, serverUrl } = await bulkSetup(sourceId);
  const adminPasswordSaved = !!source.adminLogin?.passwordEnc;
  const { rows, problems } = parseMigrationCsv(csv, { sourceHasAdminLogin: adminPasswordSaved });
  const missing = await checkTargetsExist(rows, existsFn ?? ((target) => targetExists(serverUrl, target)));
  const all = [...problems, ...missing].sort((a, b) => a.row - b.row);
  return { source, serverUrl, rows: rows.filter((r) => !missing.some((m) => m.row === r.row)), problems: all };
}

export async function startBulkMigration(raw: unknown, existsFn?: (target: string) => Promise<boolean>): Promise<{ migration: PublicMigration } | { problems: CsvProblem[] }> {
  const input = (raw ?? {}) as Record<string, unknown>;
  const csv = typeof input.csv === 'string' ? input.csv : '';
  if (csv.length > 5_000_000) throw new MigrationRequestError('The list is too large.');
  const what = parseWhat(input.what);
  const { source, serverUrl, rows, problems } = await validateBulkCsv(str(input.sourceId, 64), csv, existsFn);
  if (problems.length > 0) return { problems };
  const time = now();
  const doc: MigrationDoc = {
    id: newId(),
    kind: 'bulk',
    createdAt: time,
    startedBy: 'admin',
    sourceId: source.id,
    sourceName: source.name,
    what,
    serverUrl,
    accountCount: rows.length,
    lastPassAt: time,
    touchedAt: time,
  };
  // The accounts first: the job only looks at migrations it can list.
  for (const [index, row] of rows.entries()) {
    await putAccount({
      ...newAccountState(),
      migrationId: doc.id,
      key: accountKey(index + 1),
      row: row.row,
      sourceUser: row.sourceUser,
      target: row.target,
      ...(row.password ? { passwordEnc: encryptSecret(row.password) } : {}),
    });
  }
  await putMigration(doc);
  logMigration('bulk migration started', { migration: doc.id, accounts: rows.length });
  const options = await loadOptions();
  return { migration: publicMigration(doc, await listAccounts(doc.id), options) };
}

// ─── Passes, cancel, finish, remove (admin and user) ───────────────────────

/** Whether the source of a self-service migration is still allowed. */
async function selfServiceAllowed(migration: MigrationDoc): Promise<boolean> {
  if (migration.custom) return (await loadOptions()).allowUserServers;
  const source = (await loadSources()).find((s) => s.id === migration.sourceId);
  return !!source?.allowSelfService;
}

/** Whether the stored app password still opens the account; false on expiry or 401. */
async function appPasswordWorks(migration: MigrationDoc, withinMs = 0): Promise<boolean> {
  const secret = decryptSecret(migration.appPassword?.secretEnc);
  if (!secret || !migration.appPassword || !migration.owner) return false;
  if (Date.parse(migration.appPassword.expiresAt) <= now() + withinMs) return false;
  try {
    await fetchTargetSession(migration.serverUrl, basicAuth(migration.owner.username, secret));
    return true;
  } catch (error) {
    if (error instanceof TargetAuthError) return false;
    // Stalwart unreachable: the pass will tell.
    return true;
  }
}

/** Queue a pass for the account (or all of them) that isn't running. */
async function queuePass(migration: MigrationDoc, key?: string): Promise<number> {
  let queued = 0;
  for (const account of await listAccounts(migration.id)) {
    if (key && account.key !== key) continue;
    if (isRunning(account)) continue;
    await updateAccount(migration.id, account.key, (doc) => {
      if (isRunning(doc)) return undefined;
      queued++;
      const next: AccountDoc = { ...doc, status: 'queued' };
      delete next.cancelRequested;
      delete next.error;
      delete next.errorCode;
      return next;
    });
  }
  const time = now();
  await updateMigration(migration.id, (doc) => ({ ...doc, lastPassAt: time, touchedAt: time }));
  return queued;
}

function checkPassable(migration: MigrationDoc): void {
  if (migration.finishedAt) throw new MigrationRequestError('This migration is finished.', 409, 'finished');
  if (migration.credentialsForgottenAt) throw new MigrationRequestError(MESSAGES.passwordsForgotten, 409, 'forgotten');
}

export async function adminRequestPass(migrationId: string, key?: string): Promise<number> {
  const migration = await loadMigration(migrationId);
  if (!migration) throw new MigrationRequestError('No such migration.', 404);
  checkPassable(migration);
  if (migration.kind === 'bulk' && !isMasterConfigured()) throw new MigrationRequestError(MESSAGES.noMaster, 409, 'no-master');
  if (migration.kind === 'self') {
    if (!(await selfServiceAllowed(migration))) throw new MigrationRequestError(NOT_ALLOWED_ANY_MORE, 409, 'not-allowed');
    if (!(await appPasswordWorks(migration))) throw new MigrationRequestError(MESSAGES.userAccessExpired, 409, 'user-access-expired');
  }
  return queuePass(migration, key);
}

export async function cancelMigration(migrationId: string, key?: string): Promise<void> {
  if (!(await loadMigration(migrationId))) throw new MigrationRequestError('No such migration.', 404);
  for (const account of await listAccounts(migrationId)) {
    if (key && account.key !== key) continue;
    await updateAccount(migrationId, account.key, (doc) => {
      if (!isRunning(doc)) return undefined;
      // Not started yet: nothing to stop after a batch.
      if (doc.status === 'queued' && !doc.phase) return { ...doc, status: 'cancelled' };
      return { ...doc, cancelRequested: true };
    });
  }
  const time = now();
  await updateMigration(migrationId, (doc) => ({ ...doc, touchedAt: time }));
}

/** End a migration for good: stored passwords and the app password go, the report stays. */
export async function finishMigration(migrationId: string): Promise<void> {
  const migration = await loadMigration(migrationId);
  if (!migration) throw new MigrationRequestError('No such migration.', 404);
  await cancelMigration(migrationId);
  const time = now();
  await forgetCredentials(migration, time);
  await updateMigration(migrationId, (doc) => ({ ...doc, finishedAt: doc.finishedAt ?? time, touchedAt: time }));
  logMigration('migration finished', { migration: migrationId });
}

export async function removeMigration(migrationId: string): Promise<void> {
  const migration = await loadMigration(migrationId);
  if (!migration) throw new MigrationRequestError('No such migration.', 404);
  await cancelMigration(migrationId);
  await dropAppPassword(migration);
  await deleteMigrationDocs(migrationId);
  logMigration('migration removed', { migration: migrationId });
}

export async function migrationAccounts(migrationId: string, query: { q?: string; status?: string; offset?: number; limit?: number }) {
  const all = (await listAccounts(migrationId)).map(publicAccount);
  const q = (query.q ?? '').trim().toLowerCase();
  const filtered = all.filter((a) =>
    (!q || a.sourceUser.toLowerCase().includes(q) || a.target.toLowerCase().includes(q))
    && (!query.status || query.status === 'all' || a.status === query.status
      || (query.status === 'running' && ['queued', 'mail', 'contacts', 'calendars', 'filters', 'paused'].includes(a.status))));
  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.min(500, Math.max(1, query.limit ?? 100));
  return { total: filtered.length, accounts: filtered.slice(offset, offset + limit) };
}

// ─── Report ────────────────────────────────────────────────────────────────

function csvField(value: string | number | undefined): string {
  const text = value === undefined ? '' : String(value);
  // A leading = + - @ would be a formula in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const REPORT_KINDS = ['messages', 'folders', 'contacts', 'events', 'scripts'] as const;

/** The report of every account as CSV: counts and problems, never passwords or message content. */
export function reportCsv(accounts: AccountDoc[]): string {
  const header = ['source_user', 'target_account', 'status',
    ...REPORT_KINDS.flatMap((kind) => [`${kind}_copied`, `${kind}_skipped`, `${kind}_failed`]), 'problems'];
  const lines = [header.join(',')];
  for (const account of accounts) {
    const counts = account.report.counts;
    const problems = account.report.problems.map((p) => `${p.phase}${p.item ? ` ${p.item}` : ''}: ${p.reason}`).join(' | ');
    lines.push([
      account.sourceUser, account.target, account.status,
      ...REPORT_KINDS.flatMap((kind) => [counts[kind].copied, counts[kind].skipped, counts[kind].failed]),
      problems,
    ].map(csvField).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

// ─── Self-service ──────────────────────────────────────────────────────────

export interface MigrationUser {
  /** The login the session signed in with. */
  username: string;
  /** The account the sign-in resolved to (key per-user data on it). */
  accountName: string;
  serverUrl: string;
  trusted: boolean;
}

const TEST_LIMIT = { max: 10, windowMs: 15 * 60 * 1000 };

/** "Test connection": 10 tries per 15 minutes per user, as other server checks users trigger. */
export async function reserveUserTest(user: MigrationUser): Promise<{ ok: boolean; retryAfterMs: number }> {
  const result = await getStore().counters.reserve([
    { key: `migration-test:${user.accountName}|${user.serverUrl}`, max: TEST_LIMIT.max, windowMs: TEST_LIMIT.windowMs },
  ], Date.now());
  return { ok: result.ok, retryAfterMs: result.retryAfterMs };
}

function ownsMigration(migration: MigrationDoc, user: MigrationUser): boolean {
  return migration.kind === 'self' && migration.owner?.accountName === user.accountName && migration.serverUrl === user.serverUrl;
}

export async function userMigrations(user: MigrationUser): Promise<MigrationDoc[]> {
  return (await listMigrations()).filter((m) => ownsMigration(m, user));
}

/** What the Settings section shows: which sources the user may pick, and their own migration. */
export async function userOverview(user: MigrationUser) {
  const [sources, options] = await Promise.all([loadSources(), loadOptions()]);
  const offered = sources.filter((s) => s.allowSelfService).map((s) => ({ id: s.id, name: s.name, hasDav: !!(s.caldavUrl || s.carddavUrl), hasSieve: !!s.sieve }));
  const own = (await userMigrations(user))[0];
  let migration: (PublicMigration & { account: PublicAccount | null }) | null = null;
  if (own) {
    const accounts = await listAccounts(own.id);
    migration = { ...publicMigration(own, accounts, options), account: accounts[0] ? publicAccount(accounts[0]) : null };
  }
  return {
    available: user.trusted && (offered.length > 0 || options.allowUserServers),
    sources: offered,
    allowOther: options.allowUserServers,
    /** For the app password's expiry: it lasts as long as the stored passwords. */
    forgetAfterDays: options.forgetAfterDays,
    migration,
  };
}

/** The source a user picked: an admin source that allows self-service, or a server they typed in. */
async function userSource(raw: Record<string, unknown>): Promise<{ sourceId: string | null; custom?: SourceEndpoints; name: string; endpoints: SourceEndpoints }> {
  const options = await loadOptions();
  if (raw.sourceId === 'other') {
    if (!options.allowUserServers) throw new MigrationRequestError(NOT_ALLOWED_ANY_MORE, 403, 'not-allowed');
    const custom = parseEndpoints(raw.custom, true);
    return { sourceId: null, custom, name: custom.imap.host, endpoints: custom };
  }
  const source = (await loadSources()).find((s) => s.id === raw.sourceId && s.allowSelfService);
  if (!source) throw new MigrationRequestError(NOT_ALLOWED_ANY_MORE, 403, 'not-allowed');
  return { sourceId: source.id, name: source.name, endpoints: source };
}

/** Before any connection to a server a user typed in: every host must resolve to public addresses. */
async function checkPublicHosts(endpoints: SourceEndpoints): Promise<void> {
  const hosts = [endpoints.imap.host, ...(endpoints.sieve ? [endpoints.sieve.host] : [])];
  for (const url of [endpoints.caldavUrl, endpoints.carddavUrl]) if (url) hosts.push(new URL(url).hostname);
  for (const host of new Set(hosts)) {
    try {
      await resolveCheckedAddress(host);
    } catch (error) {
      if ((error as { code?: string }).code === 'EBLOCKED') throw new MigrationRequestError(PUBLIC_ONLY, 400, 'blocked');
      // Not found and the like: the connection reports it.
    }
  }
}

/**
 * Only an account on this deployment's own mail server may have the server
 * reach other servers: a sign-in to a server the user picked could
 * otherwise try logins anywhere, with as many accounts as it makes.
 */
function requireTrusted(user: MigrationUser): void {
  if (!user.trusted) throw new MigrationRequestError('Moving a mailbox needs an account on this deployment\'s mail server.', 403, 'untrusted');
}

export async function userTestSource(user: MigrationUser, raw: unknown): Promise<TestOutcome[]> {
  requireTrusted(user);
  const input = (raw ?? {}) as Record<string, unknown>;
  const { endpoints, custom } = await userSource(input);
  const username = str(input.username, 320);
  const password = typeof input.password === 'string' ? input.password : '';
  if (!username || !password) throw new MigrationRequestError('Enter your username and password for the old server.', 400, 'login-missing');
  const limit = await reserveUserTest(user);
  if (!limit.ok) throw new MigrationRequestError('Too many tries. Wait a few minutes.', 429, 'rate-limited');
  if (custom) await checkPublicHosts(custom);
  return testEndpoints(endpoints, { user: username, password }, !custom);
}

/** Check that an app password opens the signed-in user's own account. */
async function verifyAppPassword(user: MigrationUser, secret: string): Promise<void> {
  let sessionUser: string | undefined;
  try {
    sessionUser = (await fetchTargetSession(user.serverUrl, basicAuth(user.username, secret))).username;
  } catch (error) {
    if (error instanceof TargetAuthError) throw new MigrationRequestError('The app password was refused.', 403, 'app-password-refused');
    throw new MigrationRequestError('The mail server could not be reached.', 502);
  }
  if (!sessionUser || sessionUser.toLowerCase() !== user.username.toLowerCase()) {
    throw new MigrationRequestError('This app password opens another account.', 403, 'wrong-account');
  }
}

function parseAppPassword(raw: unknown): { id: string; secret: string; expiresAt: string } | null {
  const input = raw as Record<string, unknown> | null | undefined;
  if (!input) return null;
  const id = str(input.id, 200);
  const secret = typeof input.secret === 'string' ? input.secret : '';
  const expiresAt = str(input.expiresAt, 40);
  if (!id || !secret || secret.length > 1000 || Number.isNaN(Date.parse(expiresAt))) {
    throw new MigrationRequestError('Invalid app password.', 400);
  }
  return { id, secret, expiresAt };
}

/** Start a self-service migration into the signed-in user's own account. The target comes from the session alone. */
export async function startUserMigration(user: MigrationUser, raw: unknown): Promise<PublicMigration> {
  requireTrusted(user);
  const input = (raw ?? {}) as Record<string, unknown>;
  const appPassword = parseAppPassword(input.appPassword);
  if (!appPassword) throw new MigrationRequestError('Invalid app password.', 400);
  const { sourceId, custom, name, endpoints } = await userSource(input);
  const username = str(input.username, 320);
  const password = typeof input.password === 'string' ? input.password : '';
  if (!username || !password) throw new MigrationRequestError('Enter your username and password for the old server.', 400, 'login-missing');
  const what = parseWhat(input.what);
  if ((await userMigrations(user)).some((m) => !m.finishedAt)) {
    throw new MigrationRequestError('Finish or remove your current migration first.', 409, 'active-exists');
  }
  if (custom) await checkPublicHosts(endpoints);
  await verifyAppPassword(user, appPassword.secret);
  const time = now();
  const doc: MigrationDoc = {
    id: newId(),
    kind: 'self',
    createdAt: time,
    startedBy: user.username,
    sourceId,
    ...(custom ? { custom } : {}),
    sourceName: name,
    what,
    serverUrl: user.serverUrl,
    owner: { username: user.username, accountName: user.accountName },
    appPassword: { id: appPassword.id, secretEnc: encryptSecret(appPassword.secret), expiresAt: appPassword.expiresAt },
    accountCount: 1,
    lastPassAt: time,
    touchedAt: time,
  };
  await putAccount({
    ...newAccountState(),
    migrationId: doc.id,
    key: accountKey(1),
    sourceUser: username,
    target: user.username,
    passwordEnc: encryptSecret(password),
  });
  await putMigration(doc);
  logMigration('self-service migration started', { migration: doc.id, custom: !!custom });
  return publicMigration(doc, await listAccounts(doc.id), await loadOptions());
}

async function ownMigration(user: MigrationUser): Promise<MigrationDoc> {
  const own = (await userMigrations(user))[0];
  if (!own) throw new MigrationRequestError('No migration.', 404);
  return own;
}

/** How soon before its expiry the browser gets asked for a fresh app password. */
export const RENEW_WITHIN_MS = DAY_MS;

/**
 * "Copy new items" from Settings. Without a fresh app password, answers
 * `renew` when the stored one expires within a day or Stalwart refuses it;
 * the browser then makes one and asks again with it, and the old one is
 * deleted.
 */
export async function userRequestPass(user: MigrationUser, raw: unknown): Promise<{ renew: true } | { queued: number }> {
  const input = (raw ?? {}) as Record<string, unknown>;
  const migration = await ownMigration(user);
  checkPassable(migration);
  if (!(await selfServiceAllowed(migration))) throw new MigrationRequestError(NOT_ALLOWED_ANY_MORE, 403, 'not-allowed');
  const fresh = parseAppPassword(input.appPassword);
  if (fresh) {
    await verifyAppPassword(user, fresh.secret);
    const old = migration;
    await updateMigration(migration.id, (doc) => ({
      ...doc,
      appPassword: { id: fresh.id, secretEnc: encryptSecret(fresh.secret), expiresAt: fresh.expiresAt },
    }));
    if (old.appPassword && old.appPassword.id !== fresh.id) {
      await dropAppPassword({ ...old, appPassword: { ...old.appPassword, secretEnc: encryptSecret(fresh.secret) } });
    }
  } else if (!(await appPasswordWorks(migration, RENEW_WITHIN_MS))) {
    return { renew: true };
  }
  const updated = (await loadMigration(migration.id))!;
  return { queued: await queuePass(updated) };
}

export async function userCancel(user: MigrationUser): Promise<void> {
  await cancelMigration((await ownMigration(user)).id);
}

export async function userFinish(user: MigrationUser): Promise<void> {
  await finishMigration((await ownMigration(user)).id);
}

export async function userRemove(user: MigrationUser): Promise<void> {
  await removeMigration((await ownMigration(user)).id);
}

export async function userReportCsv(user: MigrationUser): Promise<string> {
  return reportCsv(await listAccounts((await ownMigration(user)).id));
}


export type { PublicSource } from './types';
