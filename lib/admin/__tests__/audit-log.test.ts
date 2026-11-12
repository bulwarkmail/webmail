// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The admin audit log: today's audit.log in the state dir on one instance,
// one log for every replica with a shared store (#1066).

const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: log }));

import { auditLog, readAuditLog } from '../audit';
import { getStore, setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { separateFakeStore } from './shared-store-fake';

let dir: string;
const statePath = (file: string) => path.join(dir, 'state', file);
/** The shared log as another replica reads it. */
const sharedLines = () => getStore().log('audit', {
  local: { path: () => statePath('audit.log'), maxBytes: 10 * 1024 * 1024, rotations: 3 },
  maxEntries: 50_000,
}).readAll();

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-audit-'));
  vi.stubEnv('ADMIN_STATE_DIR', path.join(dir, 'state'));
  resetLocalStoreForTests();
  log.error.mockClear();
});

afterEach(async () => {
  setStoreForTests(null);
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('audit log on one instance', () => {
  it('appends one JSON line per entry to audit.log and reads them newest first', async () => {
    await auditLog('admin.login', {}, '203.0.113.1');
    await auditLog('config.update', { changes: [{ key: 'sessionSecret', old: 'a', new: 'b' }] }, '203.0.113.2');
    const lines = (await readFile(statePath('audit.log'), 'utf-8')).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    expect(JSON.parse(lines[0])).toMatchObject({ action: 'admin.login', detail: {}, ip: '203.0.113.1' });
    expect(Object.keys(JSON.parse(lines[0]))).toEqual(['ts', 'action', 'detail', 'ip']);
    expect(JSON.parse(lines[1]).detail.changes[0]).toEqual({ key: 'sessionSecret', old: '[redacted]', new: '[redacted]' });

    const { entries, total } = await readAuditLog();
    expect(total).toBe(2);
    expect(entries.map((e) => e.action)).toEqual(['config.update', 'admin.login']);
  });

  it('rotates audit.log at 10 MB and keeps three older files', async () => {
    await mkdir(path.join(dir, 'state'), { recursive: true });
    await writeFile(statePath('audit.log'), `${'x'.repeat(10 * 1024 * 1024)}\n`);
    await writeFile(statePath('audit.log.1'), 'one\n');
    await writeFile(statePath('audit.log.2'), 'two\n');
    await writeFile(statePath('audit.log.3'), 'three\n');
    await auditLog('admin.login', {}, '203.0.113.1');

    expect(existsSync(statePath('audit.log'))).toBe(false);
    expect((await readFile(statePath('audit.log.1'), 'utf-8')).endsWith('"ip":"203.0.113.1"}\n')).toBe(true);
    expect(await readFile(statePath('audit.log.2'), 'utf-8')).toBe('one\n');
    expect(await readFile(statePath('audit.log.3'), 'utf-8')).toBe('two\n');
    // The entry moved to audit.log.1 and is still shown.
    expect((await readAuditLog()).entries.map((e) => e.action)).toEqual(['admin.login']);

    await auditLog('admin.logout', {}, '203.0.113.1');
    expect((await readAuditLog()).entries.map((e) => e.action)).toEqual(['admin.logout', 'admin.login']);
  });

  it('shows the entries of the rotated files too, newest first, with the filter and pages', async () => {
    await mkdir(path.join(dir, 'state'), { recursive: true });
    const line = (action: string, n: number) => `${JSON.stringify({ ts: `2026-11-0${n}T00:00:00.000Z`, action, detail: { n }, ip: '203.0.113.1' })}\n`;
    await writeFile(statePath('audit.log.3'), line('config.update', 1));
    await writeFile(statePath('audit.log.2'), line('admin.login_failed', 2));
    await writeFile(statePath('audit.log.1'), line('config.update', 3) + line('admin.login_failed', 4));
    await auditLog('admin.login', {}, '203.0.113.1');

    const all = await readAuditLog();
    expect(all.total).toBe(5);
    expect(all.entries.map((e) => e.action)).toEqual(['admin.login', 'admin.login_failed', 'config.update', 'admin.login_failed', 'config.update']);
    const changes = await readAuditLog(1, 50, 'config.update');
    expect(changes.entries.map((e) => (e.detail as { n: number }).n)).toEqual([3, 1]);
    const second = await readAuditLog(2, 2);
    expect(second.entries.map((e) => e.action)).toEqual(['config.update', 'admin.login_failed']);
  });
});

describe('audit log with a shared store', () => {
  let store: ReturnType<typeof separateFakeStore>;
  beforeEach(() => {
    store = separateFakeStore(path.join(dir, 'store'));
    setStoreForTests(store);
  });

  it('keeps every entry of replicas writing at once, whole', async () => {
    const replicas = await Promise.all([0, 1, 2].map(async () => {
      vi.resetModules();
      return (await import('../audit')).auditLog;
    }));
    await Promise.all(Array.from({ length: 60 }, (_, i) => replicas[i % 3]('admin.login', { n: i, note: 'line\nbreak' }, `198.51.100.${i}`)));

    const lines = await sharedLines();
    expect(lines).toHaveLength(60);
    const numbers = lines.map((line) => JSON.parse(line).detail.n).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 60 }, (_, i) => i));
    expect((await readAuditLog(1, 100)).total).toBe(60);
    // Nothing in this replica's state dir.
    expect(existsSync(statePath('audit.log'))).toBe(false);
  });

  it('puts the entry in the server log when the store is down', async () => {
    store.down = true;
    await expect(auditLog('admin.login_failed', {}, '203.0.113.9')).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith('Failed to write audit log', expect.objectContaining({
      entry: expect.objectContaining({ action: 'admin.login_failed', ip: '203.0.113.9' }),
    }));
  });
});
