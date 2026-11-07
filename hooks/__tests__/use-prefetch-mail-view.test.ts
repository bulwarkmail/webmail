/**
 * The sign-in page runs the mail view's code once its form is drawn and the
 * browser is idle (hooks/use-prefetch-mail-view.ts), and at the latest when
 * the sign-in starts.
 */
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/components/mail/mail-app', () => {
  loads.count++;
  return { MailApp: () => null };
});
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ prefetch: vi.fn() }) }));

let idle: (() => void)[] = [];

beforeEach(() => {
  vi.resetModules();
  loads.count = 0;
  idle = [];
  vi.stubGlobal('requestIdleCallback', (cb: () => void) => { idle.push(cb); return idle.length; });
  vi.stubGlobal('cancelIdleCallback', () => {});
});
afterEach(() => vi.unstubAllGlobals());

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the mail view warm-up', () => {
  it('waits for the form, then for idle', async () => {
    const { useWarmMailViewWhenIdle } = await import('../use-prefetch-mail-view');
    const { rerender } = renderHook(({ shown }) => useWarmMailViewWhenIdle(shown), { initialProps: { shown: false } });
    expect(idle).toHaveLength(0);
    rerender({ shown: true });
    expect(idle).toHaveLength(1);
    await settle();
    expect(loads.count).toBe(0);
    idle[0]();
    await settle();
    expect(loads.count).toBe(1);
  });

  it('is not scheduled again once the sign-in has started it', async () => {
    const { useWarmMailViewWhenIdle, warmMailView } = await import('../use-prefetch-mail-view');
    warmMailView();
    renderHook(() => useWarmMailViewWhenIdle(true));
    expect(idle).toHaveLength(0);
  });

  it('leaves it to the sign-in when the browser asks to save data or the link is 2G', async () => {
    const { useWarmMailViewWhenIdle } = await import('../use-prefetch-mail-view');
    for (const connection of [{ saveData: true, effectiveType: '4g' }, { effectiveType: '2g' }, { effectiveType: 'slow-2g' }]) {
      Object.defineProperty(navigator, 'connection', { configurable: true, value: connection });
      idle = [];
      const { unmount } = renderHook(() => useWarmMailViewWhenIdle(true));
      expect(idle, JSON.stringify(connection)).toHaveLength(0);
      unmount();
    }
    Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: false, effectiveType: '4g' } });
    renderHook(() => useWarmMailViewWhenIdle(true));
    expect(idle).toHaveLength(1);
    delete (navigator as unknown as { connection?: unknown }).connection;
  });
});
