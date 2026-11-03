import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimAlert, claimKey, claimNow, CLAIMS_STORAGE_KEY, HIDDEN_GRACE_MS } from '../claims';

const FIRE = Date.UTC(2026, 10, 10, 9);

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

/** A Web Lock: one holder at a time, across "tabs". */
function fakeLocks() {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    request: vi.fn(<T,>(_name: string, callback: () => T | Promise<T>) => {
      const run = tail.then(callback);
      tail = run.catch(() => {});
      return run;
    }),
  };
}

beforeEach(() => {
  localStorage.clear();
  setVisibility('visible');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, 'locks');
});

describe('claimNow', () => {
  it('says yes once', () => {
    const key = claimKey('acc', 'uid-1', 'a', FIRE);
    expect(claimNow(key, FIRE)).toBe(true);
    expect(claimNow(key, FIRE)).toBe(false);
  });

  it('tells occurrences and accounts apart', () => {
    expect(claimNow(claimKey('acc', 'uid-1', 'a', FIRE), FIRE)).toBe(true);
    expect(claimNow(claimKey('acc', 'uid-1', 'a', FIRE + 1000), FIRE + 1000)).toBe(true);
    expect(claimNow(claimKey('other', 'uid-1', 'a', FIRE), FIRE)).toBe(true);
  });

  it('forgets what is a day old', () => {
    vi.useFakeTimers({ now: FIRE });
    claimNow('old', FIRE - 25 * 3_600_000);
    claimNow('new', FIRE);
    expect(Object.keys(JSON.parse(localStorage.getItem(CLAIMS_STORAGE_KEY)!))).toEqual(['new']);
  });

  it('holds only the key, nothing of the event', () => {
    claimNow(claimKey('acc', 'uid-1', 'a', FIRE), FIRE);
    expect(localStorage.getItem(CLAIMS_STORAGE_KEY)).toBe(JSON.stringify({ [`acc:uid-1:a:${FIRE}`]: FIRE }));
  });
});

describe('claimAlert', () => {
  it('lets one of two tabs through when their timers run out together', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: fakeLocks() });
    const won = vi.fn();
    claimAlert('k', FIRE, () => won('tab 1'));
    claimAlert('k', FIRE, () => won('tab 2'));
    await vi.waitFor(() => expect(won).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(won.mock.calls).toEqual([['tab 1']]);
  });

  it('runs at once where there is no Web Lock', () => {
    const won = vi.fn();
    claimAlert('k', FIRE, won);
    expect(won).toHaveBeenCalledTimes(1);
  });

  it('lets a tab in view go first', () => {
    vi.useFakeTimers({ now: FIRE });
    setVisibility('hidden');
    const hidden = vi.fn();
    claimAlert('k', FIRE, hidden);
    setVisibility('visible');
    const visible = vi.fn();
    claimAlert('k', FIRE, visible);
    expect(visible).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HIDDEN_GRACE_MS);
    expect(hidden).not.toHaveBeenCalled();
  });

  it('still fires in a hidden tab when no other took it', () => {
    vi.useFakeTimers({ now: FIRE });
    setVisibility('hidden');
    const won = vi.fn();
    claimAlert('k', FIRE, won);
    expect(won).not.toHaveBeenCalled();
    vi.advanceTimersByTime(HIDDEN_GRACE_MS);
    expect(won).toHaveBeenCalledTimes(1);
  });
});
