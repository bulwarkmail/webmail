// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTimeout as realSleep } from 'node:timers/promises';
import { NextRequest } from 'next/server';
import { replicaId, setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { INIT_EPOCH, announceChange, pollChanges, resetChangesForTests } from '@/lib/shared-store/changes';
import { separateDiskStore, type SeparateDiskStore } from './helpers/separate-disk-store';

// The background jobs with several replicas (#1066): only the holder of the
// scheduler-leader lease runs them, another replica takes over when the
// holder's lease runs out and keeps the stored schedule, and a scheduled
// heartbeat is claimed with a compare-and-set so two leaders can't both send.

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: log }));
vi.mock('@/lib/admin/third-party-mode', () => ({ isNoThirdPartyTrafficOn: async () => false }));
const buildPayload = vi.hoisted(() => vi.fn(async () => ({ schema: '1' })));
vi.mock('@/lib/telemetry/payload', () => ({ buildPayload, markProcessStart: () => {} }));
const sent = vi.hoisted(() => vi.fn(async (_url: string, _init?: unknown) => new Response('ok')));
vi.mock('@/lib/telemetry/endpoint-guard', () => ({
  resolveEndpointAllowed: async () => ({ ok: true }),
  fetchTelemetryTarget: (url: string, init?: unknown) => sent(url, init),
}));
vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: async () => ({ session: { sub: 'admin' } }),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: async () => {} }));

import {
  LEADER_LEASE, isSchedulerLeader, resetSchedulerLeaderForTests, schedulerLeaderSettled, startSchedulerLeader, stopSchedulerLeader,
} from '@/lib/scheduler-leader';
import { loadState, saveState, sendOnce, startScheduler, stopScheduler, updateState } from '@/lib/telemetry';
import { POST as telemetryRoute } from '@/app/api/admin/telemetry/route';

const MIN = 60_000;
const COLLECTOR = 'https://collector.example.org/v1/heartbeat';
const jobs = [{ name: 'telemetry', start: startScheduler, stop: stopScheduler }];

let dir: string;
let store: SeparateDiskStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bw-leader-'));
  vi.stubEnv('TELEMETRY_DATA_DIR', path.join(dir, 'telemetry'));
  vi.stubEnv('BULWARK_TELEMETRY', '');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-10-31T12:00:00.000Z'));
  store = separateDiskStore();
  setStoreForTests(store);
  sent.mockClear();
  log.info.mockClear();
});

afterEach(async () => {
  await stopSchedulerLeader();
  resetSchedulerLeaderForTests();
  await stopScheduler();
  resetChangesForTests();
  vi.useRealTimers();
  setStoreForTests(null);
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  store.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

async function consentOn(nextScheduledAt: string | null) {
  await saveState({ ...(await loadState()), consent: 'on', endpoint: COLLECTOR, nextScheduledAt });
}

/** Let time pass; the leader's tries and job starts do real file I/O, so wait for them too. */
async function pass(ms: number) {
  for (let passed = 0; passed < ms; passed += 10_000) {
    await vi.advanceTimersByTimeAsync(Math.min(10_000, ms - passed));
    await schedulerLeaderSettled();
  }
}

/** Another replica holding (and renewing) the lease while `ms` pass here. */
async function otherReplicaLeads(ms: number) {
  for (let passed = 0; passed < ms; passed += 10_000) {
    expect(await store.leases.acquire(LEADER_LEASE, 'replica-a', 30_000)).toBe(true);
    await pass(10_000);
  }
}

/** Let a heartbeat a timer set off finish its real file I/O, so "not sent" means it. */
async function ioSettles() {
  await realSleep(200);
}

/** The heartbeat the timer set off does real I/O before it sends. */
async function sends(times: number) {
  await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(times));
}

describe('scheduler leader with a shared store', () => {
  it('only the holder sends; when its lease runs out another replica takes over and keeps the schedule', async () => {
    const slot = new Date(Date.now() + 20 * MIN).toISOString();
    await consentOn(slot);
    await store.leases.acquire(LEADER_LEASE, 'replica-a', 30_000);

    await startSchedulerLeader(jobs);
    expect(isSchedulerLeader()).toBe(false);
    await otherReplicaLeads(5 * MIN);
    await ioSettles();
    expect(isSchedulerLeader()).toBe(false);

    // replica-a is gone: its lease expires after 30 s, the next try takes it.
    await pass(40_000);
    expect(isSchedulerLeader()).toBe(true);
    expect(log.info).toHaveBeenCalledWith('scheduler: leading', expect.objectContaining({ replica: expect.any(String) }));
    expect((await loadState()).nextScheduledAt).toBe(slot);
    expect(sent).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(new Date(slot).getTime() - Date.now() + 1000);
    await sends(1);
  });

  it('stops its timers when it can no longer reach the store', async () => {
    const slot = new Date(Date.now() + 5 * MIN).toISOString();
    await consentOn(slot);
    await startSchedulerLeader(jobs);
    expect(isSchedulerLeader()).toBe(true);

    store.down = true;
    await pass(10_000);
    expect(isSchedulerLeader()).toBe(false);
    expect(log.info).toHaveBeenCalledWith('scheduler: stopped leading', expect.objectContaining({ reason: expect.stringContaining('shared store') }));
    // Past the slot with the store still down: no heartbeat from here.
    await pass(6 * MIN);
    await ioSettles();
    expect(sent).not.toHaveBeenCalled();
    expect(isSchedulerLeader()).toBe(false);
  });

  it('stops leading when the store lost its data', async () => {
    await store.epochs.bump(INIT_EPOCH);
    await consentOn(new Date(Date.now() + 5 * MIN).toISOString());
    await startSchedulerLeader(jobs);
    expect(isSchedulerLeader()).toBe(true);

    // Flushed: the init epoch is gone, and the next poll notices.
    resetLocalStoreForTests();
    await pollChanges();
    await pass(10_000);
    expect(isSchedulerLeader()).toBe(false);
    expect(log.info).toHaveBeenCalledWith('scheduler: stopped leading', expect.objectContaining({ reason: 'the shared store lost its data' }));
  });

  it('stops its timers when another replica has taken the lease', async () => {
    const slot = new Date(Date.now() + 5 * MIN).toISOString();
    await consentOn(slot);
    await startSchedulerLeader(jobs);
    expect(isSchedulerLeader()).toBe(true);

    // This replica's lease is gone (it stalled past the TTL) and replica-a took it.
    await store.leases.release(LEADER_LEASE, replicaId());
    await otherReplicaLeads(6 * MIN);
    await ioSettles();
    expect(isSchedulerLeader()).toBe(false);
    expect(sent).not.toHaveBeenCalled();
  });

  it('does not arm a new timer after a send that was in flight when the lead moved', async () => {
    const slot = new Date(Date.now() + MIN).toISOString();
    await consentOn(slot);
    let finish!: (res: Response) => void;
    sent.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    await startSchedulerLeader(jobs);

    await vi.advanceTimersByTimeAsync(MIN + 1000);
    await sends(1);
    // The lead moves to replica-a while the heartbeat hangs.
    await store.leases.release(LEADER_LEASE, replicaId());
    expect(await store.leases.acquire(LEADER_LEASE, 'replica-a', 30_000)).toBe(true);
    await pass(10_000);
    expect(isSchedulerLeader()).toBe(false);
    await stopSchedulerLeader(); // no more tries from this replica

    finish(new Response('ok'));
    await ioSettles();
    await vi.advanceTimersByTimeAsync(27 * 60 * MIN);
    await ioSettles();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops a job whose restart finished after the replica stepped down', async () => {
    let running = false;
    let starts = 0;
    let finishStart: (() => void) | null = null;
    const job = {
      name: 'telemetry',
      start: async () => {
        if (++starts === 2) await new Promise<void>((resolve) => { finishStart = resolve; });
        running = true;
      },
      stop: async () => { running = false; },
    };
    await startSchedulerLeader([job]);
    expect(running).toBe(true);

    // Consent changed: the restart's start hangs while the lead is lost.
    const restarted = announceChange('telemetry');
    await vi.waitFor(() => expect(finishStart).not.toBeNull());
    store.down = true;
    await pass(10_000);
    expect(isSchedulerLeader()).toBe(false);
    finishStart!();
    await restarted;
    expect(running).toBe(false);
  });

  it('version check: does not arm a new timer after a check that was in flight when it stopped', async () => {
    vi.stubEnv('VERSION_CHECK_DATA_DIR', path.join(dir, 'version-check'));
    vi.stubEnv('BULWARK_UPDATE_CHECK', '');
    vi.stubEnv('BULWARK_UPDATE_CHECK_URL', 'https://version.example/');
    vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '1.20.0');
    let finish!: (res: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const versionCheck = await import('@/lib/version-check');
    try {
      await versionCheck.startScheduler();
      await vi.advanceTimersByTimeAsync(31_000);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await versionCheck.stopScheduler();
      finish(new Response('{}', { status: 500 }));
      await ioSettles();
      await vi.advanceTimersByTimeAsync(2 * 60 * MIN);
      await ioSettles();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await versionCheck.stopScheduler();
      vi.unstubAllGlobals();
    }
  });

  it('sends once when two leaders fire for the same slot, and not again after it', async () => {
    const slot = new Date(Date.now() - 1000).toISOString();
    await consentOn(slot);

    const results = await Promise.all([
      sendOnce({ reason: 'scheduled', slot }),
      sendOnce({ reason: 'scheduled', slot }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(sent).toHaveBeenCalledTimes(1);

    // The paused leader wakes up an hour later, still holding that slot.
    vi.advanceTimersByTime(60 * MIN);
    expect((await sendOnce({ reason: 'scheduled', slot })).ok).toBe(false);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('sends once when the old leader stalled past its slot and the new one picked a later slot', async () => {
    const oldSlot = new Date(Date.now() - 1000).toISOString();
    await consentOn(oldSlot);
    // The new leader found the slot passed and scheduled an hour out.
    const newSlot = new Date(Date.now() + 60 * MIN).toISOString();
    // The stalled leader wakes up and sends for its slot first.
    expect((await sendOnce({ reason: 'scheduled', slot: oldSlot })).ok).toBe(true);
    vi.advanceTimersByTime(61 * MIN);
    expect((await sendOnce({ reason: 'scheduled', slot: newSlot })).ok).toBe(false);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('sends once when a leader died after sending but before storing the next slot', async () => {
    const slot = new Date(Date.now() - 1000).toISOString();
    await consentOn(slot);
    expect((await sendOnce({ reason: 'scheduled', slot })).ok).toBe(true);
    // nextScheduledAt still names the slot just sent; the next leader
    // finds it passed and fires an hour later.
    vi.advanceTimersByTime(60 * MIN);
    expect((await sendOnce({ reason: 'scheduled', slot: new Date().toISOString() })).ok).toBe(false);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('still sends the next scheduled heartbeat after a manual "send now"', async () => {
    const slot = new Date(Date.now() - 1000).toISOString();
    await consentOn(slot);
    expect((await sendOnce({ reason: 'scheduled', slot })).ok).toBe(true);
    vi.advanceTimersByTime(20 * 60 * MIN);
    expect((await sendOnce({ reason: 'admin-manual' })).ok).toBe(true);
    vi.advanceTimersByTime(2 * 60 * MIN);
    expect((await sendOnce({ reason: 'scheduled', slot: new Date().toISOString() })).ok).toBe(true);
    expect(sent).toHaveBeenCalledTimes(3);
  });

  it('gives the slot back when the payload cannot be built', async () => {
    const slot = new Date(Date.now() - 1000).toISOString();
    await consentOn(slot);
    buildPayload.mockRejectedValueOnce(new Error('store down'));
    expect((await sendOnce({ reason: 'scheduled', slot })).ok).toBe(false);
    expect((await loadState()).lastSentAt).toBeNull();
    expect((await sendOnce({ reason: 'scheduled', slot })).ok).toBe(true);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('gives the slot back when the send fails', async () => {
    const slot = new Date(Date.now() - 1000).toISOString();
    await consentOn(slot);
    sent.mockResolvedValueOnce(new Response('no', { status: 500 }));
    expect((await sendOnce({ reason: 'scheduled', slot })).ok).toBe(false);
    expect((await loadState()).lastSentAt).toBeNull();
    expect((await sendOnce({ reason: 'scheduled', slot })).ok).toBe(true);
  });

  it('sends on "send now" from a replica that does not lead, even right after a heartbeat', async () => {
    await consentOn(null);
    await store.leases.acquire(LEADER_LEASE, 'replica-a', 30_000);
    await startSchedulerLeader(jobs);
    expect(isSchedulerLeader()).toBe(false);
    await updateState((state) => { state.lastSentAt = new Date().toISOString(); });

    const res = await telemetryRoute(new NextRequest('http://localhost/api/admin/telemetry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'send-now' }),
    }));
    expect(res.status).toBe(200);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('starts the heartbeat on the leader when consent is turned on through another replica', async () => {
    await store.epochs.bump(INIT_EPOCH);
    await startSchedulerLeader(jobs);
    expect(isSchedulerLeader()).toBe(true);
    expect((await loadState()).nextScheduledAt).toBeNull();

    // The other replica's admin route: write, then bump the epoch.
    await updateState((state) => { state.consent = 'on'; state.endpoint = COLLECTOR; });
    await store.epochs.bump('telemetry');
    await pollChanges();

    expect((await loadState()).nextScheduledAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(61 * MIN);
    await sends(1);
  });
});

describe('scheduler leader on a single instance', () => {
  it('sends a scheduled heartbeat an hour after the last one, as before', async () => {
    setStoreForTests(null);
    const slot = new Date(Date.now() - 1000).toISOString();
    await consentOn(slot);
    expect((await sendOnce({ reason: 'scheduled', slot })).ok).toBe(true);
    vi.advanceTimersByTime(60 * MIN);
    expect((await sendOnce({ reason: 'scheduled', slot: new Date().toISOString() })).ok).toBe(true);
    expect((await loadState()).lastScheduledSentAt).toBeUndefined();
  });

  it('leads at once and restarts the heartbeat when consent changes in this process', async () => {
    setStoreForTests(null);
    await startSchedulerLeader(jobs);
    expect(isSchedulerLeader()).toBe(true);
    expect(log.info).toHaveBeenCalledWith('scheduler: leading', expect.anything());

    const res = await telemetryRoute(new NextRequest('http://localhost/api/admin/telemetry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'set-consent', consent: 'on' }),
    }));
    expect(res.status).toBe(200);
    expect(vi.getTimerCount()).toBe(1);

    await telemetryRoute(new NextRequest('http://localhost/api/admin/telemetry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'set-consent', consent: 'off' }),
    }));
    expect(vi.getTimerCount()).toBe(0);
  });
});
