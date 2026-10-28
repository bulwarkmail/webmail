import { describe, expect, it, vi } from 'vitest';
import { createCrossTabRefresh } from '../cross-tab-refresh';
import { createFakeBrowser, deferred, settle, type FakeTab } from './helpers/fake-tabs';

type Counts = Record<string, number>;

function tabOf(browser: ReturnType<typeof createFakeBrowser>) {
  const tab: FakeTab = browser.openTab();
  const run = createCrossTabRefresh<Counts>('test', tab);
  const applied: Counts[] = [];
  return { tab, run, applied, apply: (v: Counts) => { applied.push(v); } };
}

describe('createCrossTabRefresh', () => {
  it('runs one refresh for two tabs that got the same push', async () => {
    const browser = createFakeBrowser();
    const a = tabOf(browser);
    const b = tabOf(browser);
    const slow = deferred<Counts>();
    const refreshA = vi.fn(() => slow.promise);
    const refreshB = vi.fn(async () => ({ work: 9 }));

    const runA = a.run('acct', 'state-2', refreshA, a.apply);
    const runB = b.run('acct', 'state-2', refreshB, b.apply);
    await settle();
    slow.resolve({ work: 3 });
    await Promise.all([runA, runB]);

    expect(refreshA).toHaveBeenCalledTimes(1);
    expect(refreshB).not.toHaveBeenCalled();
    expect(b.applied).toEqual([{ work: 3 }]);
    expect(a.applied).toEqual([]);
  });

  it('applies a result that arrived before the tab saw the push, without waiting', async () => {
    const browser = createFakeBrowser();
    const a = tabOf(browser);
    const b = tabOf(browser);
    await a.run('acct', 'state-2', async () => ({ work: 3 }), a.apply);
    await settle();

    const refreshB = vi.fn(async () => ({ work: 9 }));
    await b.run('acct', 'state-2', refreshB, b.apply);
    expect(refreshB).not.toHaveBeenCalled();
    expect(b.applied).toEqual([{ work: 3 }]);
  });

  it('refreshes again for a different push', async () => {
    const browser = createFakeBrowser();
    const a = tabOf(browser);
    const b = tabOf(browser);
    await a.run('acct', 'state-2', async () => ({ work: 3 }), a.apply);
    await settle();

    const refreshB = vi.fn(async () => ({ work: 4 }));
    await b.run('acct', 'state-3', refreshB, b.apply);
    expect(refreshB).toHaveBeenCalledTimes(1);
    expect(b.applied).toEqual([]);
  });

  it('does not make another account wait', async () => {
    const browser = createFakeBrowser();
    const a = tabOf(browser);
    const b = tabOf(browser);
    const slow = deferred<Counts>();
    const runA = a.run('acct-1', 'state-2', () => slow.promise, a.apply);
    const refreshB = vi.fn(async () => ({ work: 1 }));

    await b.run('acct-2', 'state-2', refreshB, b.apply);
    expect(refreshB).toHaveBeenCalledTimes(1);
    slow.resolve({ work: 3 });
    await runA;
  });

  it('refreshes in the waiting tab when the tab doing the work closes', async () => {
    const browser = createFakeBrowser();
    const a = tabOf(browser);
    const b = tabOf(browser);
    void a.run('acct', 'state-2', () => new Promise<Counts>(() => {}), a.apply);
    const refreshB = vi.fn(async () => ({ work: 5 }));
    const runB = b.run('acct', 'state-2', refreshB, b.apply);
    await settle();
    expect(refreshB).not.toHaveBeenCalled();

    a.tab.close();
    await runB;
    expect(refreshB).toHaveBeenCalledTimes(1);
    expect(b.applied).toEqual([]);
  });

  it('refreshes in the waiting tab when the other tab had nothing to share', async () => {
    const browser = createFakeBrowser();
    const a = tabOf(browser);
    const b = tabOf(browser);
    const failed = deferred<Counts | undefined>();
    const runA = a.run('acct', 'state-2', () => failed.promise, a.apply);
    const refreshB = vi.fn(async () => ({ work: 5 }));
    const runB = b.run('acct', 'state-2', refreshB, b.apply);
    await settle();
    failed.resolve(undefined);
    await Promise.all([runA, runB]);

    expect(refreshB).toHaveBeenCalledTimes(1);
  });

  it('refreshes on its own when the browser has no Web Locks or BroadcastChannel', async () => {
    const run = createCrossTabRefresh<Counts>('test', null);
    const refresh = vi.fn(async () => ({ work: 1 }));
    const apply = vi.fn();
    await run('acct', 'state-2', refresh, apply);
    await run('acct', 'state-2', refresh, apply);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(apply).not.toHaveBeenCalled();
  });
});
