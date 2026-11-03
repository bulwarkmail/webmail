import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSharedStore } from '@/lib/shared-store/__tests__/fake-shared';
import { setStoreForTests } from '@/lib/shared-store';

type Registry = typeof import('../registry');

let dir: string;
const info = { platform: 'Chrome, Windows', appVersion: '1.2.3' };

/** A second server process: its own copy of every module, the one store in common. */
async function instance(shared: ReturnType<typeof fakeSharedStore>): Promise<Registry> {
  vi.resetModules();
  const store = await import('@/lib/shared-store');
  store.setStoreForTests(shared);
  return import('../registry');
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bw-devices-'));
  vi.stubEnv('ADMIN_STATE_DIR', dir);
});

afterEach(() => {
  setStoreForTests(null);
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('two server instances sharing the store', () => {
  it('see one registry: a wipe asked on one reaches the device through the other, and the confirmation comes back', async () => {
    const shared = fakeSharedStore();
    const one = await instance(shared);
    const two = await instance(shared);
    expect(two).not.toBe(one);

    const { id, secret } = await one.registerDevice('alice@example.org', 'https://mail.example.org', info);
    const listed = await two.listDevices();
    expect(listed.total).toBe(1);
    expect(listed.devices[0]).toMatchObject({ id, user: 'alice@example.org', platform: 'Chrome, Windows', appVersion: '1.2.3', wipe: null });

    expect((await one.checkInDevice(id, secret, info))?.wipe).toBeNull();
    await two.requestDeviceWipe(id, 'admin');
    expect((await one.checkInDevice(id, secret, info))?.wipe).toMatchObject({ by: 'admin' });

    await one.confirmDeviceWipe(id, secret, 'admin');
    const after = (await two.listDevices()).devices[0];
    expect(after.wipe).toBeNull();
    expect(after.wipedAt).not.toBeNull();
    expect(after.wipeReason).toBe('admin');
  });

  it('keeps writes from both when they answer at once', async () => {
    const shared = fakeSharedStore();
    const one = await instance(shared);
    const two = await instance(shared);
    const { id, secret } = await one.registerDevice('alice@example.org', 'https://mail.example.org', info);
    await Promise.all([
      two.requestDeviceWipe(id, 'admin'),
      one.checkInDevice(id, secret, { ...info, appVersion: '1.2.4' }),
    ]);
    const device = await two.getDevice(id);
    expect(device?.wipe).toMatchObject({ by: 'admin' });
    expect(device?.appVersion).toBe('1.2.4');
  });
});

describe('a local store', () => {
  it('keeps a pending wipe through a restart, in the state dir, with no expiry', async () => {
    const registry: Registry = await import('../registry');
    const { id, secret } = await registry.registerDevice('alice@example.org', 'https://mail.example.org', info);
    await registry.requestDeviceWipe(id, 'admin');
    expect(registry.DEVICES_COLLECTION.ttlMs).toBeUndefined();

    // A new process reads the file.
    vi.resetModules();
    const restarted: Registry = await import('../registry');
    expect((await restarted.checkInDevice(id, secret, info))?.wipe).toMatchObject({ by: 'admin' });
    expect(readdirSync(path.join(dir, 'devices'), { recursive: true }).length).toBeGreaterThan(0);
  });

  it('stores only a hash of the secret, and never shows that either', async () => {
    const registry: Registry = await import('../registry');
    const { id, secret } = await registry.registerDevice('alice@example.org', 'https://mail.example.org', info);
    const file = readFileSync(path.join(dir, 'devices', `${id}.json`), 'utf8');
    expect(file).not.toContain(secret);
    expect(JSON.stringify(await registry.listDevices())).not.toContain('secretHash');
  });
});

describe('the rules', () => {
  it('a wrong secret reads as no such device and changes nothing', async () => {
    const registry: Registry = await import('../registry');
    const { id } = await registry.registerDevice('alice@example.org', 'https://mail.example.org', info);
    await registry.requestDeviceWipe(id, 'admin');
    expect(await registry.checkInDevice(id, 'f'.repeat(64), info)).toBeNull();
    expect(await registry.confirmDeviceWipe(id, 'f'.repeat(64), 'admin')).toBeNull();
    expect((await registry.getDevice(id))?.wipe).not.toBeNull();
  });

  it('a device that never answers keeps its pending wipe, also past the age where others go', async () => {
    const registry: Registry = await import('../registry');
    const waiting = await registry.registerDevice('alice@example.org', 'https://mail.example.org', info);
    const idle = await registry.registerDevice('bob@example.org', 'https://mail.example.org', info);
    await registry.requestDeviceWipe(waiting.id, 'admin');

    const later = Date.now() + registry.DEVICE_PRUNE_MS + 1000;
    const { devices } = await registry.listDevices({ now: later });
    expect(devices.map((device) => device.id)).toEqual([waiting.id]);
    expect(await registry.getDevice(idle.id)).toBeNull();
    expect((await registry.getDevice(waiting.id))?.wipe).not.toBeNull();
  });

  it('one user\'s wipe reaches all of that user\'s devices and no one else\'s', async () => {
    const registry: Registry = await import('../registry');
    const first = await registry.registerDevice('alice@example.org', 'https://mail.example.org', info);
    const second = await registry.registerDevice('alice@example.org', 'https://mail.example.org', info);
    const other = await registry.registerDevice('bob@example.org', 'https://mail.example.org', info);

    const asked = await registry.requestUserWipe(first.id.split('/')[0], 'admin');
    expect(asked.map((device) => device.id).sort()).toEqual([first.id, second.id].sort());
    expect((await registry.getDevice(other.id))?.wipe).toBeNull();
  });

  it('asks only once, and not of a device that already confirmed', async () => {
    const registry: Registry = await import('../registry');
    const { id, secret } = await registry.registerDevice('alice@example.org', 'https://mail.example.org', info);
    expect(await registry.requestDeviceWipe(id, 'admin')).not.toBeNull();
    expect(await registry.requestDeviceWipe(id, 'admin')).toBeNull();
    await registry.confirmDeviceWipe(id, secret, 'admin');
    expect(await registry.requestDeviceWipe(id, 'admin')).toBeNull();
  });

  it('a wipe taken back no longer reaches the device', async () => {
    const registry: Registry = await import('../registry');
    const { id, secret } = await registry.registerDevice('alice@example.org', 'https://mail.example.org', info);
    await registry.requestDeviceWipe(id, 'admin');
    await registry.cancelDeviceWipe(id);
    expect((await registry.checkInDevice(id, secret, info))?.wipe).toBeNull();
  });

  it('a check-in soon after the last one doesn\'t write again, a later one does', async () => {
    const registry: Registry = await import('../registry');
    const { id, secret } = await registry.registerDevice('alice@example.org', 'https://mail.example.org', info);
    const first = (await registry.getDevice(id))!.lastSeen;
    const soon = await registry.checkInDevice(id, secret, info, Date.parse(first) + 1000);
    expect(soon?.lastSeen).toBe(first);
    const later = await registry.checkInDevice(id, secret, info, Date.parse(first) + 60 * 60 * 1000);
    expect(later?.lastSeen).not.toBe(first);
  });

  it('caps a user\'s rows by dropping the oldest without a wipe waiting', async () => {
    const registry: Registry = await import('../registry');
    const oldest = await registry.registerDevice('alice@example.org', 'https://mail.example.org', info);
    await registry.requestDeviceWipe(oldest.id, 'admin');
    const next = await registry.registerDevice('alice@example.org', 'https://mail.example.org', info);
    for (let i = 2; i < registry.MAX_DEVICES_PER_USER; i += 1) {
      await registry.registerDevice('alice@example.org', 'https://mail.example.org', info);
    }
    await registry.registerDevice('alice@example.org', 'https://mail.example.org', info);
    const ids = (await registry.listDevices({ limit: 200 })).devices.map((device) => device.id);
    expect(ids).toHaveLength(registry.MAX_DEVICES_PER_USER);
    expect(ids).toContain(oldest.id);
    expect(ids).not.toContain(next.id);
  });

  it('finds a user by part of the address', async () => {
    const registry: Registry = await import('../registry');
    await registry.registerDevice('alice@example.org', 'https://mail.example.org', info);
    await registry.registerDevice('bob@example.org', 'https://mail.example.org', info);
    const { devices, total } = await registry.listDevices({ query: 'ALICE' });
    expect(total).toBe(1);
    expect(devices[0].user).toBe('alice@example.org');
  });
});
