/**
 * What Explorer shows for the Windows drive: the engine's state mapped to Windows' states, and
 * the storage from the server, or from the files when the server sets no limit.
 */
import { describe, expect, it } from 'vitest';
import { driveStateOf, driveStatusFor, filesQuotaLevel, filesQuotaOf, filesRingQuota, type DriveStatusText } from '../drive-status';
import type { FilesSyncRootState, FilesSyncRootStatus } from '../types';

const text: DriveStatusText = {
  state: (state) => `state:${state}`,
  detail: (status, state) => `detail:${state}:${status?.pending ?? '-'}`,
  quota: (used, total) => (total === null ? `${used} used` : `${used} of ${total}`),
  notice: (level) => `notice:${level}`,
};

const root = (state: FilesSyncRootState, extra: Partial<FilesSyncRootStatus> = {}): FilesSyncRootStatus => ({
  rootId: 'drive-a1',
  state,
  pending: 0,
  done: 0,
  lastSyncedAt: null,
  ...extra,
});

describe('the engine state as Windows has it', () => {
  it('maps every engine state, honestly', () => {
    const all: Record<FilesSyncRootState, string> = {
      idle: 'synced',
      starting: 'syncing',
      syncing: 'syncing',
      paused: 'paused',
      // Waiting for the user's answer is a pause, not "up to date".
      'confirm-delete': 'paused',
      offline: 'offline',
      error: 'error',
      // Turned off by the organisation: it doesn't sync, so not up to date.
      blocked: 'error',
    };
    for (const [engine, windows] of Object.entries(all)) expect(driveStateOf(engine as FilesSyncRootState), engine).toBe(windows);
  });

  it('a root the engine has said nothing about yet is starting, or paused when it was left paused', () => {
    expect(driveStatusFor(undefined, false, null, text)).toMatchObject({ state: 'syncing', detail: 'detail:starting:-' });
    expect(driveStatusFor(undefined, true, null, text)).toMatchObject({ state: 'paused', detail: 'detail:paused:-' });
  });

  it('words come from the page: the short state and the line the settings page shows', () => {
    expect(driveStatusFor(root('syncing', { pending: 4 }), false, null, text)).toEqual({
      state: 'syncing',
      label: 'state:syncing',
      detail: 'detail:syncing:4',
      quota: null,
      notice: null,
    });
    expect(driveStatusFor(root('error', { errorKey: 'errors.disk_full' }), false, null, text)).toMatchObject({ state: 'error', label: 'state:error' });
  });
});

describe('the storage', () => {
  it("the server's limit when it sets one", () => {
    expect(filesQuotaOf({ used: 1_048_816, total: 104_857_600 }, 7)).toEqual({ used: 1_048_816, total: 104_857_600, source: 'server' });
    expect(filesQuotaOf({ used: 10, total: 100, warnAt: 50 }, null)).toEqual({ used: 10, total: 100, warnAt: 50, source: 'server' });
  });

  it('no limit: what the files take, without a total; not asked yet or not listed yet: nothing', () => {
    expect(filesQuotaOf(null, 7_341_096)).toEqual({ used: 7_341_096, total: null, source: 'files' });
    expect(filesQuotaOf(null, null)).toBeNull();
    expect(filesQuotaOf(undefined, 7_341_096)).toBeNull();
  });

  it('goes to Explorer with its label, and a notice near the limit', () => {
    const near = filesQuotaOf({ used: 95, total: 100 }, null);
    expect(driveStatusFor(root('idle'), false, near, text)).toMatchObject({ quota: { used: 95, total: 100, label: '95 of 100' }, notice: 'notice:full' });
    const warn = filesQuotaOf({ used: 75, total: 100 }, null);
    expect(driveStatusFor(root('idle'), false, warn, text).notice).toBe('notice:warn');
    const files = filesQuotaOf(null, 5);
    expect(driveStatusFor(root('idle'), false, files, text)).toMatchObject({ quota: { used: 5, total: null, label: '5 used' }, notice: null });
    expect(filesQuotaLevel(files)).toBe('ok');
  });

  it('the storage ring takes only a quota with a limit', () => {
    expect(filesRingQuota(filesQuotaOf({ used: 1, total: 2, warnAt: 1 }, null))).toEqual({ used: 1, total: 2, warnAt: 1 });
    expect(filesRingQuota(filesQuotaOf(null, 5))).toBeNull();
    expect(filesRingQuota(null)).toBeNull();
  });
});
