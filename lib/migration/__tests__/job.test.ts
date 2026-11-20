// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { FakeMailSource, FakeTarget, fakeClock, type FakeFolder } from './fakes';

// The mailbox-migration job and what the API routes do: which credential
// opens the target, the app password of a self-service migration, the
// password expiry, user-entered sources, and that no password or secret
// leaves the server.

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: log }));
vi.mock('@/lib/auth/session-secret', () => ({ getSessionSecret: () => 's'.repeat(64), hasSessionSecret: () => true }));

const master = vi.hoisted(() => ({ config: null as null | { jwtSecret: string; masterUser: string; masterPassword: string; expectedIssuer: string } }));
vi.mock('@/lib/impersonation/master-config', () => ({
  readImpersonationConfig: () => master.config,
  resolveImpersonationServerUrl: async () => 'https://mail.example.com',
}));

const deleteAppPassword = vi.hoisted(() => vi.fn(async (_opts: { serverUrl: string; authHeader: string; id: string }) => {}));
vi.mock('@/lib/impersonation/app-password', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/impersonation/app-password')>()),
  deleteAppPassword,
}));

/** Stalwart's session answer per Authorization header: the username, or 401. */
const sessions = vi.hoisted(() => new Map<string, string>());
vi.mock('../jmap-target', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../jmap-target')>();
  const { TargetAuthError } = await import('../types');
  return {
    ...actual,
    fetchTargetSession: async (_serverUrl: string, auth: string) => {
      const username = sessions.get(auth);
      if (!username) throw new TargetAuthError();
      return { username, primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a' } };
    },
  };
});

const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return { ...actual, default: { ...actual, lookup: (...args: unknown[]) => lookup(...args) }, lookup: (...args: unknown[]) => lookup(...args) };
});

import { setMigrationDepsForTests, basicAuth, MESSAGES } from '../runtime';
import { masterAuthHeader } from '@/lib/impersonation/app-password';
import { forgetAt, migrationJobSettled, startMigrationJob, stopMigrationJob, tick } from '../job';
import { decryptSecret, encryptSecret } from '../secrets';
import { listAccounts, listMigrations, loadMigration, loadSources, saveOptions } from '../store';
import * as service from '../service';

const SERVER = 'https://mail.example.com';
const SECRET = 'app-secret-XYZ';
const SOURCE_PASSWORD = 'old-server-pw-123';
const ADMIN_PASSWORD = 'dovecot-master-pw';
const user: service.MigrationUser = { username: 'alice@example.com', accountName: 'alice@example.com', serverUrl: SERVER, trusted: true };

let dir: string;
let clock: ReturnType<typeof fakeClock>;
let mailboxes: Map<string, FakeMailSource>;
let targets: Map<string, FakeTarget>;
let opened: { mail: { user: string; password: string; allowPrivateHost: boolean }[]; target: string[] };

function inbox(count: number, from = 1): FakeFolder {
  return { delimiter: '/', noselect: false, uidValidity: '1', messages: Array.from({ length: count }, (_, i) => ({ uid: from + i, messageId: `m${from + i}@x` })) };
}

function targetFor(auth: string): FakeTarget {
  let t = targets.get(auth);
  if (!t) {
    t = new FakeTarget();
    targets.set(auth, t);
  }
  return t;
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'bw-migration-'));
  vi.stubEnv('MIGRATION_DATA_DIR', dir);
  setStoreForTests(null);
  resetLocalStoreForTests();
  master.config = null;
  sessions.clear();
  deleteAppPassword.mockClear();
  log.info.mockClear();
  log.warn.mockClear();
  lookup.mockReset();
  lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  clock = fakeClock(Date.now());
  mailboxes = new Map();
  targets = new Map();
  opened = { mail: [], target: [] };
  setMigrationDepsForTests({
    clock,
    openMail: async (login) => {
      opened.mail.push({ user: login.user, password: login.password, allowPrivateHost: login.allowPrivateHost });
      const source = mailboxes.get(login.user.split('*')[0]) ?? new FakeMailSource({ INBOX: inbox(3) });
      mailboxes.set(login.user.split('*')[0], source);
      return source;
    },
    openTarget: async (_serverUrl, auth) => {
      opened.target.push(auth);
      const viaMaster = Buffer.from(auth.slice(6), 'base64').toString().includes('%master@example.com:');
      if (!viaMaster && !sessions.has(auth)) {
        const { TargetAuthError } = await import('../types');
        throw new TargetAuthError();
      }
      return targetFor(auth);
    },
  });
  await startMigrationJob();
});

afterEach(async () => {
  await stopMigrationJob();
  setMigrationDepsForTests(null);
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function runJob(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await tick();
    await migrationJobSettled();
  }
}

function useMaster() {
  master.config = { jwtSecret: 'j'.repeat(32), masterUser: 'master@example.com', masterPassword: 'master-pw', expectedIssuer: 'x' };
}

async function addSource(extra: Record<string, unknown> = {}) {
  return service.saveSource({
    name: 'Old mail server',
    imap: { host: 'imap.old.example.com', port: 993, security: 'tls' },
    adminLogin: { username: 'migrator', password: ADMIN_PASSWORD },
    allowSelfService: true,
    ...extra,
  });
}

function appPassword(expiresInMs = 30 * 86_400_000, secret = SECRET, id = 'ap-1') {
  sessions.set(basicAuth(user.username, secret), user.username);
  return { id, secret, expiresAt: new Date(clock.now() + expiresInMs).toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

function allFiles(root: string): string[] {
  return readdirSync(root, { recursive: true }).map((f) => path.join(root, String(f))).filter((f) => statSync(f).isFile());
}

describe('bulk migrations', () => {
  it('are refused without the master user', async () => {
    const source = await addSource();
    const overview = await service.adminOverview();
    expect(overview.masterConfigured).toBe(false);
    await expect(service.startBulkMigration({ sourceId: source.id, csv: 'source_user,target_account,source_password\na,a@example.com,x' }))
      .rejects.toMatchObject({ code: 'no-master', message: MESSAGES.noMaster });
  });

  it('refuse a CSV with a bad row and start one entry per row of a good one', async () => {
    useMaster();
    const source = await addSource();
    const exists = async (target: string) => target !== 'ghost@example.com';
    const bad = await service.startBulkMigration({ sourceId: source.id, csv: 'source_user,target_account,source_password\na,a@example.com,x\nb,ghost@example.com,y' }, exists);
    expect(bad).toEqual({ problems: [{ row: 3, reason: 'Target ghost@example.com does not exist on Stalwart.' }] });
    expect(await listMigrations()).toHaveLength(0);

    const good = await service.startBulkMigration({ sourceId: source.id, csv: 'source_user,target_account,source_password\na,a@example.com,x\nb,b@example.com,' }, exists);
    expect('migration' in good && good.migration.accountCount).toBe(2);
  });

  it('copy as the target through the master user, with the admin login where the row has no password', async () => {
    useMaster();
    const source = await addSource();
    await service.startBulkMigration({ sourceId: source.id, csv: `source_user,target_account,source_password\nalice,alice@example.com,${SOURCE_PASSWORD}\nbob,bob@example.com,` }, async () => true);
    await runJob();
    const aliceAuth = masterAuthHeader('alice@example.com', 'master@example.com', 'master-pw');
    const bobAuth = masterAuthHeader('bob@example.com', 'master@example.com', 'master-pw');
    expect(targetFor(aliceAuth).emails).toHaveLength(3);
    expect(targetFor(bobAuth).emails).toHaveLength(3);
    expect(opened.mail).toContainEqual({ user: 'alice', password: SOURCE_PASSWORD, allowPrivateHost: true });
    expect(opened.mail).toContainEqual({ user: 'bob*migrator', password: ADMIN_PASSWORD, allowPrivateHost: true });
    const [migration] = await listMigrations();
    const bob = (await listAccounts(migration.id)).find((a) => a.sourceUser === 'bob')!;
    expect(bob.report.problems.map((p) => p.reason)).toContain("Calendars and contacts need the user's password");
  });

  it('fail an account when the master user went away', async () => {
    useMaster();
    const source = await addSource();
    await service.startBulkMigration({ sourceId: source.id, csv: `source_user,target_account,source_password\nalice,alice@example.com,${SOURCE_PASSWORD}` }, async () => true);
    master.config = null;
    await runJob();
    const [migration] = await listMigrations();
    const [account] = await listAccounts(migration.id);
    expect(account.status).toBe('failed');
    expect(account.error).toBe(MESSAGES.noMaster);
  });

  it('continue after a stop and start (leader change) without duplicates', async () => {
    useMaster();
    mailboxes.set('alice', new FakeMailSource({ INBOX: inbox(45) }));
    const source = await addSource();
    await service.startBulkMigration({ sourceId: source.id, csv: `source_user,target_account,source_password\nalice,alice@example.com,${SOURCE_PASSWORD}` }, async () => true);
    const target = targetFor(masterAuthHeader('alice@example.com', 'master@example.com', 'master-pw'));
    let imports = 0;
    target.onImport = () => {
      if (++imports === 1) void stopMigrationJob();
    };
    await tick();
    await migrationJobSettled();
    expect(target.emails).toHaveLength(20);
    const [migration] = await listMigrations();
    expect((await listAccounts(migration.id))[0].status).toBe('mail');

    // A new leader: fresh process state, the same store.
    await startMigrationJob();
    await runJob();
    const [account] = await listAccounts(migration.id);
    expect(account.status).toBe('done');
    expect(target.emails).toHaveLength(45);
    expect(new Set(target.emails.map((e) => e.content)).size).toBe(45);

    // A delta pass right after copies nothing.
    await service.adminRequestPass(migration.id);
    await runJob();
    expect(target.emails).toHaveLength(45);
  });
});

describe('self-service migrations', () => {
  it('store the app password encrypted, take the target from the session and copy with username:secret', async () => {
    const source = await addSource();
    await service.startUserMigration(user, {
      sourceId: source.id, username: 'alice', password: SOURCE_PASSWORD, target: 'boss@example.com', appPassword: appPassword(),
    });
    const [migration] = await listMigrations();
    const [account] = await listAccounts(migration.id);
    expect(account.target).toBe(user.username);
    expect(migration.owner).toEqual({ username: user.username, accountName: user.accountName });
    expect(decryptSecret(migration.appPassword!.secretEnc)).toBe(SECRET);
    await runJob();
    expect(opened.target).toEqual([basicAuth(user.username, SECRET)]);
    expect(targetFor(basicAuth(user.username, SECRET)).emails).toHaveLength(3);
    // Self-service always uses the user's own login, never the admin's.
    expect(opened.mail).toEqual([{ user: 'alice', password: SOURCE_PASSWORD, allowPrivateHost: true }]);
  });

  it('refuse an app password that opens another account', async () => {
    const source = await addSource();
    const ap = appPassword();
    sessions.set(basicAuth(user.username, ap.secret), 'bob@example.com');
    await expect(service.startUserMigration(user, { sourceId: source.id, username: 'alice', password: 'x', appPassword: ap }))
      .rejects.toMatchObject({ code: 'wrong-account' });
    expect(await listMigrations()).toHaveLength(0);
  });

  it('allow one active migration per user, and show users only their own', async () => {
    const source = await addSource();
    await service.startUserMigration(user, { sourceId: source.id, username: 'alice', password: 'x', appPassword: appPassword() });
    await expect(service.startUserMigration(user, { sourceId: source.id, username: 'alice', password: 'x', appPassword: appPassword() }))
      .rejects.toMatchObject({ code: 'active-exists' });
    const other = { ...user, username: 'bob@example.com', accountName: 'bob@example.com' };
    expect((await service.userOverview(other)).migration).toBeNull();
    expect((await service.userOverview(user)).migration?.sourceName).toBe('Old mail server');
  });

  it('ask for a fresh app password near its expiry or on a 401, and delete the old one', async () => {
    const source = await addSource();
    await service.startUserMigration(user, { sourceId: source.id, username: 'alice', password: 'x', appPassword: appPassword(12 * 3_600_000) });
    await runJob();
    expect(await service.userRequestPass(user, {})).toEqual({ renew: true });

    const fresh = appPassword(30 * 86_400_000, 'second-secret', 'ap-2');
    expect(await service.userRequestPass(user, { appPassword: fresh })).toEqual({ queued: 1 });
    expect(deleteAppPassword).toHaveBeenCalledWith(expect.objectContaining({ id: 'ap-1', authHeader: basicAuth(user.username, 'second-secret') }));
    await runJob();

    // Stalwart refuses the stored one (deleted by the user meanwhile).
    sessions.delete(basicAuth(user.username, 'second-secret'));
    expect(await service.userRequestPass(user, {})).toEqual({ renew: true });
    await expect(service.adminRequestPass((await listMigrations())[0].id)).rejects.toMatchObject({ message: MESSAGES.userAccessExpired });
  });

  it('delete the stored passwords and the app password on Finish, and refuse passes after', async () => {
    const source = await addSource();
    await service.startUserMigration(user, { sourceId: source.id, username: 'alice', password: SOURCE_PASSWORD, appPassword: appPassword() });
    await runJob();
    await service.userFinish(user);
    expect(deleteAppPassword).toHaveBeenCalledWith(expect.objectContaining({ id: 'ap-1' }));
    const [migration] = await listMigrations();
    expect(migration.finishedAt).toBeDefined();
    expect(migration.appPassword?.secretEnc).toBeUndefined();
    expect((await listAccounts(migration.id))[0].passwordEnc).toBeUndefined();
    expect((await listAccounts(migration.id))[0].report.counts.messages.copied).toBe(3);
    await expect(service.userRequestPass(user, {})).rejects.toMatchObject({ code: 'finished' });
  });

  it('forget the stored passwords after the configured days since the last pass', async () => {
    await saveOptions({ concurrency: 2, forgetAfterDays: 7, allowUserServers: false });
    const source = await addSource();
    await service.startUserMigration(user, { sourceId: source.id, username: 'alice', password: SOURCE_PASSWORD, appPassword: appPassword() });
    await runJob();
    let [migration] = await listMigrations();
    expect(forgetAt(migration, 7)).toBe(migration.lastPassAt + 7 * 86_400_000);
    clock.time += 6 * 86_400_000;
    await runJob();
    expect((await loadMigration(migration.id))!.credentialsForgottenAt).toBeUndefined();
    clock.time += 2 * 86_400_000;
    await runJob();
    [migration] = await listMigrations();
    expect(migration.credentialsForgottenAt).toBeDefined();
    expect((await listAccounts(migration.id))[0].passwordEnc).toBeUndefined();
    expect(deleteAppPassword).toHaveBeenCalled();
    await expect(service.userRequestPass(user, {})).rejects.toMatchObject({ code: 'forgotten' });
  });
});

describe('servers users enter', () => {
  const custom = (over: Record<string, unknown> = {}) => ({ imap: { host: 'imap.public.example', port: 993, security: 'tls' }, ...over });
  const start = (c: unknown) => service.startUserMigration(user, { sourceId: 'other', custom: c, username: 'alice', password: 'x', appPassword: appPassword() });

  it('are refused while "Let users enter any server" is off', async () => {
    await expect(start(custom())).rejects.toMatchObject({ code: 'not-allowed' });
    expect((await service.userOverview(user)).allowOther).toBe(false);
  });

  it('must be public, encrypted, with https DAV, checked against DNS', async () => {
    await saveOptions({ concurrency: 2, forgetAfterDays: 30, allowUserServers: true });
    await expect(start(custom({ imap: { host: 'mail.corp.internal', port: 993, security: 'tls' } }))).rejects.toMatchObject({ code: 'blocked', message: service.PUBLIC_ONLY });
    await expect(start(custom({ imap: { host: 'mailserver', port: 993, security: 'tls' } }))).rejects.toMatchObject({ code: 'blocked' });
    for (const ip of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '192.168.1.1']) {
      await expect(start(custom({ imap: { host: ip, port: 993, security: 'tls' } })), ip).rejects.toMatchObject({ code: 'blocked' });
    }
    await expect(start(custom({ imap: { host: 'imap.public.example', port: 143, security: 'none' } }))).rejects.toMatchObject({ code: 'none-security' });
    await expect(start(custom({ caldavUrl: 'http://dav.public.example/caldav/' }))).rejects.toMatchObject({ code: 'dav-https' });
    // A public name that resolves inside.
    lookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
    await expect(start(custom())).rejects.toMatchObject({ code: 'blocked' });
    expect(await listMigrations()).toHaveLength(0);

    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await start(custom());
    await runJob();
    // Every connection of the job checks the address again: no private hosts for it.
    expect(opened.mail.at(-1)!.allowPrivateHost).toBe(false);
  });

  it('get no more passes once the admin turns the option off', async () => {
    await saveOptions({ concurrency: 2, forgetAfterDays: 30, allowUserServers: true });
    await start(custom());
    await runJob();
    await saveOptions({ concurrency: 2, forgetAfterDays: 30, allowUserServers: false });
    await expect(service.userRequestPass(user, {})).rejects.toMatchObject({ message: service.NOT_ALLOWED_ANY_MORE });
    const overview = await service.adminOverview();
    expect(overview.migrations[0]).toMatchObject({ kind: 'self', customHosts: ['imap.public.example:993'] });
  });
});

describe('secrets', () => {
  it('round-trip encrypted and stay out of files, answers, reports and logs', async () => {
    expect(decryptSecret(encryptSecret('pässwörd'))).toBe('pässwörd');
    expect(encryptSecret('x')).not.toBe(encryptSecret('x'));
    expect(decryptSecret('garbage')).toBeNull();

    useMaster();
    const source = await addSource();
    await service.startBulkMigration({ sourceId: source.id, csv: `source_user,target_account,source_password\nalice,alice@example.com,${SOURCE_PASSWORD}` }, async () => true);
    await service.startUserMigration(user, { sourceId: source.id, username: 'alice', password: SOURCE_PASSWORD, appPassword: appPassword() });
    await runJob();

    const secrets = [SOURCE_PASSWORD, ADMIN_PASSWORD, SECRET];
    const answers = JSON.stringify([
      await service.adminOverview(),
      await service.userOverview(user),
      await service.migrationAccounts((await listMigrations())[0].id, {}),
      (await loadSources()).map(service.publicSource),
    ]);
    const report = service.reportCsv((await Promise.all((await listMigrations()).map((m) => listAccounts(m.id)))).flat());
    const logs = JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
    const files = allFiles(dir).map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const secret of secrets) {
      expect(answers, 'API').not.toContain(secret);
      expect(report, 'report').not.toContain(secret);
      expect(logs, 'logs').not.toContain(secret);
      expect(files, 'files').not.toContain(secret);
    }
    expect(answers).toContain('"passwordSaved":true');
    // Message content stays out of the report too.
    expect(report).not.toContain('body 1');
    if (process.platform !== 'win32') {
      for (const file of allFiles(dir)) expect(statSync(file).mode & 0o777, file).toBe(0o600);
    }
  });

  it('keep the saved admin password when a source is saved without one', async () => {
    const source = await addSource();
    const saved = await service.saveSource({ id: source.id, name: 'Renamed', imap: { host: 'imap.old.example.com' }, adminLogin: { username: 'migrator' } });
    expect(saved.adminLogin).toEqual({ username: 'migrator', format: '{user}*{admin}', passwordSaved: true });
    expect(JSON.stringify(saved)).not.toContain(ADMIN_PASSWORD);
  });
});
