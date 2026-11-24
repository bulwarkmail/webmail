import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const where = vi.hoisted(() => ({ popout: false, desktop: false }));
vi.mock('@/lib/popout/window-role', async (original) => ({
  ...(await original<typeof import('@/lib/popout/window-role')>()),
  isPopoutWindow: () => where.popout,
}));
vi.mock('@/lib/desktop/bridge', async (original) => ({
  ...(await original<typeof import('@/lib/desktop/bridge')>()),
  getDesktopBridge: () => (where.desktop ? ({ version: 1 } as never) : null),
}));

import { useTitleBadge } from '@/hooks/use-title-badge';
import { getTitleBadge, setTitleBadge } from '@/lib/title-badge';

const rambox = () => {
  (window as { rambox?: unknown }).rambox = { setUnreadCount: vi.fn(), clearUnreadCount: vi.fn() };
};

afterEach(() => {
  where.popout = false;
  where.desktop = false;
  delete (window as { rambox?: unknown }).rambox;
  setTitleBadge(null);
});

describe('useTitleBadge', () => {
  it('leaves a browser tab title as it is', () => {
    renderHook(() => useTitleBadge(7, true));
    expect(getTitleBadge()).toBeNull();
  });

  it('keeps a Rambox pop-up, which has no unread count of its own, as it is', () => {
    (window as { rambox?: unknown }).rambox = { getAppLogo: vi.fn() };
    renderHook(() => useTitleBadge(7, true));
    expect(getTitleBadge()).toBeNull();
  });

  describe('inside Rambox', () => {
    beforeEach(rambox);

    it('leads the title with the unread count', () => {
      const { rerender } = renderHook(({ count }) => useTitleBadge(count, true), { initialProps: { count: 7 } });
      expect(getTitleBadge()).toBe(7);
      rerender({ count: 0 });
      expect(getTitleBadge()).toBe(0);
    });

    it('leads with zero when the badge setting is off, so Rambox shows none', () => {
      renderHook(() => useTitleBadge(7, false));
      expect(getTitleBadge()).toBe(0);
    });

    it('takes it away on unmount', () => {
      const { unmount } = renderHook(() => useTitleBadge(7, true));
      unmount();
      expect(getTitleBadge()).toBeNull();
    });

    it('keeps it out of a pop-out, which is a single message or a composer', () => {
      where.popout = true;
      renderHook(() => useTitleBadge(7, true));
      expect(getTitleBadge()).toBeNull();
    });
  });

  it('keeps it out of the desktop app, which badges its own taskbar icon', () => {
    rambox();
    where.desktop = true;
    renderHook(() => useTitleBadge(7, true));
    expect(getTitleBadge()).toBeNull();
  });
});
