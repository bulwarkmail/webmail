import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestOutboxSync } from '../outbox-sync';

// Background Sync where the browser has it. Elsewhere, and in Electron where
// register rejects, nothing changes and nothing throws.

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function browserWith(opts: { syncManager?: boolean; registration?: unknown; worker?: boolean }) {
  if (opts.syncManager) vi.stubGlobal('SyncManager', class {});
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: opts.worker === false ? undefined : { getRegistration: async () => opts.registration },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined });
});

describe('requestOutboxSync', () => {
  it('registers the tag the worker listens for', async () => {
    const register = vi.fn(async () => {});
    browserWith({ syncManager: true, registration: { sync: { register } } });
    requestOutboxSync();
    await settle();
    expect(register).toHaveBeenCalledWith('bulwark-outbox');
  });

  it('does nothing in a browser without Background Sync', async () => {
    const register = vi.fn(async () => {});
    browserWith({ syncManager: false, registration: { sync: { register } } });
    requestOutboxSync();
    await settle();
    expect(register).not.toHaveBeenCalled();
  });

  it('does nothing with no worker registered', async () => {
    browserWith({ syncManager: true, registration: undefined });
    expect(() => requestOutboxSync()).not.toThrow();
    await settle();
  });

  it('does nothing without service workers', async () => {
    browserWith({ syncManager: true, worker: false });
    expect(() => requestOutboxSync()).not.toThrow();
    await settle();
  });

  it('swallows the rejection Electron answers with', async () => {
    const rejected = vi.fn();
    process.on('unhandledRejection', rejected);
    const register = vi.fn(async () => { throw new DOMException('Background Sync is disabled', 'UnknownError'); });
    browserWith({ syncManager: true, registration: { sync: { register } } });
    requestOutboxSync();
    await settle();
    await settle();
    process.off('unhandledRejection', rejected);
    expect(register).toHaveBeenCalled();
    expect(rejected).not.toHaveBeenCalled();
  });
});
