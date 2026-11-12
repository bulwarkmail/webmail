import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAppLockPhase, resetAppLockForTests, startAppLock } from '../controller';
import { APP_LOCK_HOLDER, writeAppLockFile } from '../state';

// What a tab tells the service worker about the app lock (public/sw.js shows push
// notifications with no page around and goes by it). The worker counts "unlocked"
// only while a tab that said so is open, so every tab that opens with the lock on
// says so, once it knows; a tab still asking whether another holds the key says nothing.
// With the lock off a tab says "off".

let posted: Array<Record<string, unknown>> = [];
let held: Array<{ name: string }> = [];
let stopTab: () => void = () => {};

beforeEach(() => {
  posted = [];
  held = [];
  localStorage.clear();
  resetAppLockForTests();
  Object.defineProperty(window.navigator, 'serviceWorker', {
    configurable: true,
    value: { controller: { postMessage: (message: Record<string, unknown>) => posted.push(message) } },
  });
  Object.defineProperty(window.navigator, 'locks', {
    configurable: true,
    value: {
      // The tab with the key lives on: a request for its lock waits.
      request: vi.fn(() => new Promise(() => {})),
      query: vi.fn(async () => ({ held, pending: [] })),
    },
  });
});

afterEach(() => {
  stopTab();
  stopTab = () => {};
  resetAppLockForTests();
  delete (window.navigator as { serviceWorker?: unknown }).serviceWorker;
  delete (window.navigator as { locks?: unknown }).locks;
});

const appLockMessages = () => posted.filter((message) => message.type === 'app-lock').map((message) => message.state);

describe('what a tab tells the service worker', () => {
  it('a tab that opens while another holds the key says "unlocked", and never "locked" while it asks', async () => {
    writeAppLockFile({ on: true, locked: false });
    held = [{ name: APP_LOCK_HOLDER }];
    stopTab = startAppLock();
    await vi.waitFor(() => expect(getAppLockPhase()).toBe('open'));
    expect(appLockMessages()).toEqual(['unlocked']);
  });

  it('a tab with the lock off says "off": nothing stored in the worker then means the state was deleted', async () => {
    stopTab = startAppLock();
    await vi.waitFor(() => expect(appLockMessages()).toEqual(['off']));
    expect(getAppLockPhase()).toBe('open');
  });

  it('a tab that finds nobody holding the key says "locked"', async () => {
    writeAppLockFile({ on: true, locked: false });
    stopTab = startAppLock();
    await vi.waitFor(() => expect(getAppLockPhase()).toBe('locked'));
    expect(appLockMessages()).toContain('locked');
    expect(appLockMessages()).not.toContain('unlocked');
  });
});
