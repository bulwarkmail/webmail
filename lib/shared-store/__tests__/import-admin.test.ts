/**
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Moving a single-instance install to a shared store (#1066): the admin
// config, password, state and audit log come along, a second run changes
// nothing, and the local files stay as they were.

import { steps } from '../import/admin';
import { importLocalData } from '../import';
import { getStore, setStoreForTests } from '../index';
import { resetLocalStoreForTests } from '../local';
import { separateFakeStore } from '@/lib/admin/__tests__/shared-store-fake';
import { adminConfigDocs, adminStateDocs } from '@/lib/admin/admin-store';
import { AUDIT_LOG_OPTIONS } from '@/lib/admin/audit';
import { INIT_EPOCH } from '../changes';

let dir: string;
let store: ReturnType<typeof separateFakeStore>;
/** Store calls of the shared audit log; `failAfter` makes the n+1st batch fail, as an outage would. */
const calls = { append: 0, appendMany: 0, failAfter: Infinity };
const config = (file: string) => path.join(dir, 'config', file);
const state = (file: string) => path.join(dir, 'state', file);
const LOCAL: Record<string, string> = {};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bw-import-admin-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', path.join(dir, 'config'));
  vi.stubEnv('ADMIN_STATE_DIR', path.join(dir, 'state'));
  mkdirSync(path.join(dir, 'config'));
  mkdirSync(path.join(dir, 'state'));
  const files = {
    [config('config.json')]: JSON.stringify({ appName: 'Imported', setupComplete: true }, null, 2),
    [config('policy.json')]: JSON.stringify({ features: { calendarEnabled: false } }, null, 2),
    [config('admin.json')]: JSON.stringify({ passwordHash: '$scrypt$N=16384,r=8,p=1$c2FsdA==$aGFzaA==' }, null, 2),
    [config('.config-locked')]: '2026-10-31T12:00:00.000Z',
    [state('admin-state.json')]: JSON.stringify({ createdAt: 'x', lastLogin: null, passwordChangedAt: 'x', sessionGeneration: 3 }, null, 2),
    [state('audit.log')]: '{"ts":"1","action":"admin.login","detail":{},"ip":"1"}\n{"ts":"2","action":"admin.logout","detail":{},"ip":"1"}\n',
  };
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(file, content);
    LOCAL[file] = content;
  }
  resetLocalStoreForTests();
  store = separateFakeStore(path.join(dir, 'store'));
  const log = store.log.bind(store);
  calls.append = 0;
  calls.appendMany = 0;
  calls.failAfter = Infinity;
  store.log = (name, options) => {
    const inner = log(name, options);
    return {
      ...inner,
      append: async (line) => {
        calls.append++;
        return inner.append(line);
      },
      appendMany: async (lines) => {
        if (++calls.appendMany > calls.failAfter) throw new Error('store went away (test)');
        return inner.appendMany(lines);
      },
    };
  };
  setStoreForTests(store);
});

afterEach(() => {
  setStoreForTests(null);
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('admin import', () => {
  it('copies the admin files once and leaves them on disk', async () => {
    const mtimes = Object.keys(LOCAL).map((file) => statSync(file).mtimeMs);

    expect((await importLocalData(steps)).imported).toEqual({ 'admin-config': 4, 'admin-state': 1, audit: 2 });
    for (const id of ['config.json', 'policy.json', 'admin.json', '.config-locked']) {
      expect((await adminConfigDocs().get(id))!.data.toString('utf-8')).toBe(LOCAL[config(id)]);
    }
    expect((await adminStateDocs().get('admin-state.json'))!.data.toString('utf-8')).toBe(LOCAL[state('admin-state.json')]);
    const log = await getStore().log('audit', AUDIT_LOG_OPTIONS).readAll();
    expect(log.map((line) => JSON.parse(line).action)).toEqual(['admin.login', 'admin.logout']);

    expect((await importLocalData(steps)).imported).toEqual({ 'admin-config': 0, 'admin-state': 0, audit: 0 });
    expect(await getStore().log('audit', AUDIT_LOG_OPTIONS).length()).toBe(2);

    Object.keys(LOCAL).forEach((file, i) => {
      expect(readFileSync(file, 'utf-8')).toBe(LOCAL[file]);
      expect(statSync(file).mtimeMs).toBe(mtimes[i]);
    });
  });

  it('copies a long audit log in batches, in order', async () => {
    const lines = Array.from({ length: 1201 }, (_, i) => JSON.stringify({ ts: String(i), action: 'admin.login', detail: {}, ip: '1' }));
    writeFileSync(state('audit.log'), lines.map((l) => `${l}\n`).join(''));
    expect((await importLocalData(steps)).imported.audit).toBe(1201);
    expect(calls).toMatchObject({ append: 0, appendMany: 3 });
    expect(await getStore().log('audit', AUDIT_LOG_OPTIONS).readAll()).toEqual(lines);
  });

  it('redoes an audit import that stopped halfway, without doubling lines', async () => {
    const lines = Array.from({ length: 1100 }, (_, i) => JSON.stringify({ ts: String(i), action: 'admin.login', detail: {}, ip: '1' }));
    writeFileSync(state('audit.log'), lines.map((l) => `${l}\n`).join(''));
    calls.failAfter = 1;
    await expect(importLocalData(steps)).rejects.toThrow(/went away/);
    expect(await getStore().log('audit', AUDIT_LOG_OPTIONS).length()).toBe(500);

    calls.failAfter = Infinity;
    expect((await importLocalData(steps)).imported.audit).toBe(1100);
    expect(await getStore().log('audit', AUDIT_LOG_OPTIONS).readAll()).toEqual(lines);
    expect((await importLocalData(steps)).imported.audit).toBe(0);
  });

  it('leaves the log of a running deployment alone on a forced re-run', async () => {
    await store.epochs.bump(INIT_EPOCH);
    await getStore().log('audit', AUDIT_LOG_OPTIONS).append('{"ts":"9","action":"admin.login","detail":{},"ip":"2"}');
    expect((await importLocalData(steps)).imported.audit).toBe(0);
    expect(await getStore().log('audit', AUDIT_LOG_OPTIONS).length()).toBe(1);
  });

  it('keeps what the store already holds', async () => {
    await adminConfigDocs().put('config.json', '{"appName":"Already shared"}');
    expect((await importLocalData(steps)).imported['admin-config']).toBe(3);
    expect((await adminConfigDocs().get('config.json'))!.data.toString('utf-8')).toBe('{"appName":"Already shared"}');
  });
});
