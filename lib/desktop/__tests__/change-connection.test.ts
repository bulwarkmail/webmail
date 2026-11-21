import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BulwarkDesktopBridge } from '../types';

// The question window, answered with Change.
vi.mock('../dialog-window', () => ({
  askInWindow: () => ({ answer: Promise.resolve({ button: 1 }) }),
}));
vi.mock('@/lib/welcome-tips', () => ({ markWelcomeTipsSeen: () => {} }));

import { askAndChangeConnection } from '../change-connection';

const TEXT = { title: 'Change connection?', message: 'The app restarts.', confirm: 'Change', cancel: 'Cancel' };

function bridgeWith(change: (...args: unknown[]) => Promise<boolean>) {
  window.bulwarkDesktop = { version: 1, platform: 'win32', menu: { setState: () => {}, changeConnection: change } } as unknown as BulwarkDesktopBridge;
}

afterEach(() => {
  window.bulwarkDesktop = undefined;
});

describe('askAndChangeConnection', () => {
  it("asks the shell to open on the organisation's web address for the sign-in page's link (desktop#5)", async () => {
    const change = vi.fn(async () => true);
    bridgeWith(change);
    expect(await askAndChangeConnection(TEXT, 'org')).toBe(true);
    expect(change).toHaveBeenCalledWith('org');
  });

  it('calls File > Change connection… as before, with nothing, so the shell asks how to connect', async () => {
    const change = vi.fn(async () => true);
    bridgeWith(change);
    await askAndChangeConnection(TEXT);
    expect(change).toHaveBeenCalledTimes(1);
    expect(change.mock.calls[0]).toEqual([]);
  });
});
