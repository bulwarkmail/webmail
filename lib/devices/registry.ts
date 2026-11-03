/**
 * The devices that keep mail for this instance: browsers with offline mode on
 * and desktop apps. One durable document per device and account, so every
 * replica sees the same list and a pending wipe outlives a restart.
 *
 * No `ttlMs`: a machine that stays off for a year still has its wipe waiting.
 * Rows nobody has seen for half a year and with no wipe waiting go when a new
 * row registers (at most hourly for the whole registry) or an admin lists them.
 *
 * A check-in proves itself with the device's secret, not with a session, and
 * nothing here asks the mail server. A device whose password was revoked has
 * to be able to learn about its wipe. The secret only lets a device read and
 * answer for its own row.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getStatePath } from '@/lib/admin/paths';
import { settingsId } from '@/lib/settings-sync';
import { getStore, type CollectionOptions } from '@/lib/shared-store';
import type { DeviceView, WipeReason } from './types';

/**
 * A new row is written to the state dir and stays half a year, for anyone with a
 * session. Enough for an office turning this on in one morning: a device turned
 * away tries again in a quarter of an hour.
 */
export const REGISTER_PER_HOUR = 60;
export const DEVICE_ID_RE = /^[0-9a-f]{64}\/[0-9a-f]{32}$/;
export const DEVICE_SECRET_RE = /^[0-9a-f]{64}$/;
const USER_KEY_RE = /^[0-9a-f]{64}$/;
const DEVICE_FILE_RE = /^[0-9a-f]{64}\/[0-9a-f]{32}\.json$/;

/** A user with more rows than this loses the oldest one that has no wipe waiting. */
export const MAX_DEVICES_PER_USER = 100;
/** Not seen for this long and no wipe waiting: abandoned, and forgotten. */
export const DEVICE_PRUNE_MS = 180 * 24 * 60 * 60 * 1000;
/** A check-in within this time of the last write doesn't write again. */
const LAST_SEEN_WRITE_MS = 5 * 60 * 1000;
const READ_CONCURRENCY = 50;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

export const DEVICES_COLLECTION: CollectionOptions = {
  local: {
    dir: () => getStatePath('devices'),
    file: (id) => `${id}.json`,
    idOf: (relative) => (DEVICE_FILE_RE.test(relative) ? relative.slice(0, -'.json'.length) : null),
    mode: 0o600,
  },
};

interface StoredDevice extends Omit<DeviceView, 'id' | 'userKey'> {
  secretHash: string;
}

function collection() {
  return getStore().collection('devices', DEVICES_COLLECTION);
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function secretMatches(device: StoredDevice, secret: string): boolean {
  const given = Buffer.from(hashSecret(secret));
  const stored = Buffer.from(device.secretHash);
  return given.length === stored.length && timingSafeEqual(given, stored);
}

function parse(data: Buffer | null | undefined): StoredDevice | null {
  if (!data) return null;
  try {
    return JSON.parse(data.toString('utf8')) as StoredDevice;
  } catch {
    return null;
  }
}

function toView(id: string, device: StoredDevice): DeviceView {
  const { secretHash: _secretHash, ...rest } = device;
  return { id, userKey: id.split('/')[0], ...rest };
}

async function readDevice(id: string): Promise<StoredDevice | null> {
  return parse((await collection().get(id))?.data);
}

async function readMany(ids: string[]): Promise<Array<[string, StoredDevice]>> {
  const found: Array<[string, StoredDevice]> = [];
  for (let start = 0; start < ids.length; start += READ_CONCURRENCY) {
    const batch = ids.slice(start, start + READ_CONCURRENCY);
    const devices = await Promise.all(batch.map((id) => readDevice(id)));
    devices.forEach((device, index) => {
      if (device) found.push([batch[index], device]);
    });
  }
  return found;
}

/** Every row of this user has a wipe waiting, which can't be dropped, and the cap is reached. */
export class TooManyDevicesError extends Error {
  constructor() {
    super('Too many devices');
    this.name = 'TooManyDevicesError';
  }
}

async function makeRoomFor(userKey: string, now: number): Promise<void> {
  const rows = await pruned(await readMany(await collection().list(`${userKey}/`)), now);
  const over = rows.length - MAX_DEVICES_PER_USER + 1;
  if (over <= 0) return;
  const removable = rows
    .filter(([, device]) => !device.wipe)
    .sort(([, a], [, b]) => a.lastSeen.localeCompare(b.lastSeen));
  if (removable.length < over) throw new TooManyDevicesError();
  for (const [id] of removable.slice(0, over)) await collection().delete(id);
}

/** Abandoned rows of everyone, however long no admin has looked. One replica, once an hour. */
async function pruneAbandoned(now: number): Promise<void> {
  const { ok } = await getStore().counters.reserve([{ key: 'device-prune', max: 1, windowMs: PRUNE_EVERY_MS }]);
  if (ok) await pruned(await readMany(await collection().list('')), now);
}

export interface DeviceInfo {
  platform: string;
  appVersion: string;
}

/** A new row for this browser profile and account. The secret goes back to the device once and is kept only as a hash. */
export async function registerDevice(user: string, server: string, info: DeviceInfo): Promise<{ id: string; secret: string; user: string; server: string }> {
  const userKey = settingsId(user, server);
  await makeRoomFor(userKey, Date.now());
  await pruneAbandoned(Date.now()).catch(() => {});
  const id = `${userKey}/${randomBytes(16).toString('hex')}`;
  const secret = randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  const device: StoredDevice = {
    user,
    server,
    platform: info.platform,
    appVersion: info.appVersion,
    firstSeen: now,
    lastSeen: now,
    wipe: null,
    wipedAt: null,
    wipeReason: null,
    secretHash: hashSecret(secret),
  };
  await collection().put(id, JSON.stringify(device), { ifVersion: null });
  return { id, secret, user, server };
}

/** Null when the row is gone or the secret doesn't fit. Both read the same to the caller. */
export async function checkInDevice(id: string, secret: string, info: DeviceInfo, now = Date.now()): Promise<DeviceView | null> {
  const current = await readDevice(id);
  if (!current || !secretMatches(current, secret)) return null;
  const stale = now - Date.parse(current.lastSeen) >= LAST_SEEN_WRITE_MS;
  if (!stale && current.platform === info.platform && current.appVersion === info.appVersion) return toView(id, current);
  const { data } = await collection().update(id, (raw) => {
    const device = parse(raw);
    if (!device) return undefined;
    return JSON.stringify({ ...device, ...info, lastSeen: new Date(now).toISOString() });
  });
  const device = parse(data);
  return device ? toView(id, device) : toView(id, current);
}

export type WipeConfirmation = { device: DeviceView; changed: boolean } | 'no_wipe_asked';

/**
 * The device says it wiped. Null when the row is gone or the secret doesn't fit.
 * Only a change is news: a device sends this again until it gets through, and
 * anyone with a row could send it for ever. `admin` needs a request the row
 * still has. Anyone can say they wiped themselves, but not that an admin told them.
 */
export async function confirmDeviceWipe(id: string, secret: string, reason: WipeReason, now = Date.now()): Promise<WipeConfirmation | null> {
  const current = await readDevice(id);
  if (!current || !secretMatches(current, secret)) return null;
  const at = new Date(now).toISOString();
  let refused = false;
  const { data } = await collection().update(id, (raw) => {
    refused = false;
    const device = parse(raw);
    if (!device) return undefined;
    if (device.wipedAt && !device.wipe) return undefined;
    if (reason === 'admin' && !device.wipe) {
      refused = true;
      return undefined;
    }
    return JSON.stringify({ ...device, wipe: null, wipedAt: at, wipeReason: reason, lastSeen: at });
  });
  if (refused) return 'no_wipe_asked';
  const device = parse(data);
  if (device) return { device: toView(id, device), changed: true };
  const after = await readDevice(id);
  return after ? { device: toView(id, after), changed: false } : null;
}

/**
 * The account signed out here and took its data with it: the row has nothing
 * left to look after. A wipe still waiting is answered by that, and stays on the
 * record the way any confirmed wipe does. Null when the secret doesn't fit.
 */
export async function dropDevice(id: string, secret: string, now = Date.now()): Promise<{ confirmed: DeviceView | null } | null> {
  const current = await readDevice(id);
  if (!current) return { confirmed: null };
  if (!secretMatches(current, secret)) return null;
  if (current.wipe) {
    const answer = await confirmDeviceWipe(id, secret, 'user', now);
    return { confirmed: answer && answer !== 'no_wipe_asked' && answer.changed ? answer.device : null };
  }
  await collection().delete(id);
  return { confirmed: null };
}

/** Null when nothing changed: no such row, a wipe already waiting, or a row that confirmed and has nothing left. */
export async function requestDeviceWipe(id: string, by: string, now = Date.now()): Promise<DeviceView | null> {
  const requestedAt = new Date(now).toISOString();
  const { data } = await collection().update(id, (raw) => {
    const device = parse(raw);
    if (!device || device.wipedAt || device.wipe) return undefined;
    return JSON.stringify({ ...device, wipe: { requestedAt, by } });
  });
  const device = parse(data);
  return device ? toView(id, device) : null;
}

/** Every device of a user that hasn't wiped already, one request each. */
export async function requestUserWipe(userKey: string, by: string, now = Date.now()): Promise<DeviceView[]> {
  // No more than a user can have: nothing a stray write left behind makes this unbounded.
  const ids = (await collection().list(`${userKey}/`)).slice(0, MAX_DEVICES_PER_USER);
  const results = await Promise.all(ids.map((id) => requestDeviceWipe(id, by, now)));
  return results.filter((device): device is DeviceView => device !== null);
}

export async function cancelDeviceWipe(id: string): Promise<DeviceView | null> {
  const { data } = await collection().update(id, (raw) => {
    const device = parse(raw);
    if (!device?.wipe) return undefined;
    return JSON.stringify({ ...device, wipe: null });
  });
  const device = parse(data);
  return device ? toView(id, device) : null;
}

export async function forgetDevice(id: string): Promise<boolean> {
  return collection().delete(id);
}

export async function getDevice(id: string): Promise<DeviceView | null> {
  const device = await readDevice(id);
  return device ? toView(id, device) : null;
}

export function isUserKey(value: unknown): value is string {
  return typeof value === 'string' && USER_KEY_RE.test(value);
}

export interface DevicePage {
  devices: DeviceView[];
  total: number;
}

/** One page, by user then device. `query` looks through every row, so it reads them all. */
export async function listDevices(options: { offset?: number; limit?: number; query?: string; now?: number } = {}): Promise<DevicePage> {
  const { offset = 0, limit = 100, query, now = Date.now() } = options;
  const ids = await collection().list('');
  const needle = query?.trim().toLowerCase();
  if (!needle) {
    const page = await readMany(ids.slice(offset, offset + limit));
    const kept = await pruned(page, now);
    return { devices: kept.map(([id, device]) => toView(id, device)), total: ids.length };
  }
  const everything = await pruned(await readMany(ids), now);
  const matching = everything.filter(([, device]) => device.user.toLowerCase().includes(needle));
  return {
    devices: matching.slice(offset, offset + limit).map(([id, device]) => toView(id, device)),
    total: matching.length,
  };
}

/** What the admin is about to see: old rows go, a row with a wipe waiting never does. */
async function pruned(rows: Array<[string, StoredDevice]>, now: number): Promise<Array<[string, StoredDevice]>> {
  const kept: Array<[string, StoredDevice]> = [];
  for (const row of rows) {
    const [id, device] = row;
    if (!device.wipe && now - Date.parse(device.lastSeen) > DEVICE_PRUNE_MS) await collection().delete(id);
    else kept.push(row);
  }
  return kept;
}
