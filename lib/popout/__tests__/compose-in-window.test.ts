import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulwarkDesktopBridge } from '@/lib/desktop/types';
import { DEFAULT_POLICY_SNAPSHOT, type PolicyEntry, type PolicySnapshot } from '@/lib/desktop/policy-schema';
import { resetDesktopPrefsCache, setDesktopPref } from '@/lib/desktop/preferences';
import { useAuthStore } from '@/stores/auth-store';

const windows = vi.hoisted(() => ({
  open: vi.fn(),
  handOver: vi.fn(async () => true),
  cancel: vi.fn(),
}));

vi.mock('../open', () => ({
  openComposerWindow: (account?: string | null) => {
    windows.open(account);
    return { handOver: windows.handOver, cancel: windows.cancel };
  },
}));
// jsdom has no sealed sessions; what decides here is the desktop bridge.
vi.mock('../support', () => ({
  hasDesktopWindows: () => !!window.bulwarkDesktop?.windows,
  popoutsAvailable: () => !!window.bulwarkDesktop?.windows,
}));

const { composeInWindowHere, openComposerInWindow } = await import('../compose-in-window');

function desktop(policy?: PolicyEntry<'ComposeInNewWindow'>) {
  const snapshot = { ...DEFAULT_POLICY_SNAPSHOT, ...(policy ? { ComposeInNewWindow: policy } : {}) } as PolicySnapshot;
  window.bulwarkDesktop = {
    version: 1,
    platform: 'win32',
    windows: {},
    // A new object per policy, as the shell's contextBridge hands out.
    policy: { get: () => snapshot, onChange: () => () => {} },
  } as unknown as BulwarkDesktopBridge;
}

const FORCED_ON = { value: true, source: 'forced-machine', locked: true } as const;
const FORCED_OFF = { value: false, source: 'forced-machine', locked: true } as const;
const RECOMMENDED_ON = { value: true, source: 'recommended-machine', locked: false } as const;

beforeEach(() => {
  localStorage.clear();
  resetDesktopPrefsCache();
  useAuthStore.setState({ isDemoMode: false, activeAccountId: 'login-a' } as never);
});

afterEach(() => {
  window.bulwarkDesktop = undefined;
  vi.clearAllMocks();
});

describe('always write messages in a new window', () => {
  it('is off until the user turns it on', () => {
    desktop();
    expect(composeInWindowHere()).toBe(false);
    setDesktopPref('composeInWindow', true);
    expect(composeInWindowHere()).toBe(true);
  });

  it('never in a browser', () => {
    setDesktopPref('composeInWindow', true);
    expect(composeInWindowHere()).toBe(false);
  });

  it('a forced policy wins over the user, both ways', () => {
    desktop(FORCED_ON);
    setDesktopPref('composeInWindow', false);
    expect(composeInWindowHere()).toBe(true);

    window.bulwarkDesktop = undefined;
    desktop(FORCED_OFF);
    setDesktopPref('composeInWindow', true);
    expect(composeInWindowHere()).toBe(false);
  });

  it('a recommendation holds until the user chooses', () => {
    desktop(RECOMMENDED_ON);
    expect(composeInWindowHere()).toBe(true);
    setDesktopPref('composeInWindow', false);
    expect(composeInWindowHere()).toBe(false);
  });

  it('a shell older than the policy sends none: the user decides', () => {
    desktop();
    const { ComposeInNewWindow: _left, ...older } = DEFAULT_POLICY_SNAPSHOT;
    (window.bulwarkDesktop as { policy: unknown }).policy = { get: () => older, onChange: () => () => {} };
    setDesktopPref('composeInWindow', true);
    expect(composeInWindowHere()).toBe(true);
  });

  it('not in the demo', () => {
    desktop(FORCED_ON);
    useAuthStore.setState({ isDemoMode: true } as never);
    expect(composeInWindowHere()).toBe(false);
  });
});

describe('opening the composer in its window', () => {
  it('hands the composer over through the login it was opened in', async () => {
    desktop(FORCED_ON);
    const notShown = vi.fn();
    expect(openComposerInWindow({ mode: 'reply', sourceEmailId: 'm1' }, { notShown })).toBe(true);
    expect(windows.open).toHaveBeenCalledWith('login-a');
    expect(windows.handOver).toHaveBeenCalledWith({ mode: 'reply', sourceEmailId: 'm1' });
    await Promise.resolve();
    expect(notShown).not.toHaveBeenCalled();
  });

  it('calls it off and says so when the window never shows it', async () => {
    desktop(FORCED_ON);
    windows.handOver.mockResolvedValueOnce(false);
    const notShown = vi.fn();
    openComposerInWindow({ mode: 'compose' }, { notShown });
    await vi.waitFor(() => expect(notShown).toHaveBeenCalledTimes(1));
    expect(windows.cancel).toHaveBeenCalledTimes(1);
  });

  it('opens nothing with the setting off', () => {
    desktop();
    expect(openComposerInWindow({ mode: 'compose' }, { notShown: vi.fn() })).toBe(false);
    expect(windows.open).not.toHaveBeenCalled();
  });
});
