import { afterEach, describe, expect, it, vi } from 'vitest';

/** A sign-out leaves nothing of the account on the OS's surfaces. */

vi.setConfig({ testTimeout: 60_000 });

describe('sign-out', () => {
  afterEach(() => {
    window.bulwarkDesktop = undefined;
  });

  it('clears what the desktop app shows outside its windows', async () => {
    const clearSurfaces = vi.fn();
    window.bulwarkDesktop = { version: 1, platform: 'win32', os: { clearSurfaces } } as never;
    const { purgeSignedOutData } = await import('@/lib/sign-out-cleanup');
    purgeSignedOutData();
    expect(clearSurfaces).toHaveBeenCalled();
  });

  it('in a browser there is nothing to clear', async () => {
    const { clearDesktopSurfaces } = await import('../bridge');
    expect(() => clearDesktopSurfaces()).not.toThrow();
  });
});
