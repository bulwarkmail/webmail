"use client";

import { useEffect, useSyncExternalStore } from 'react';
import { getDesktopBridge } from '@/lib/desktop/bridge';
import { isPopoutWindow } from '@/lib/popout/window-role';
import { getTitleBadge, setTitleBadge, subscribeTitleBadge } from '@/lib/title-badge';

function insideRambox(): boolean {
  const rambox = (window as unknown as { rambox?: { setUnreadCount?: unknown } }).rambox;
  return typeof rambox?.setUnreadCount === 'function';
}

export function useTitleBadge(count: number, enabled = true): void {
  useEffect(() => {
    const leads = insideRambox() && !getDesktopBridge() && !isPopoutWindow();
    setTitleBadge(leads ? (enabled ? count : 0) : null);
  }, [count, enabled]);

  useEffect(() => () => setTitleBadge(null), []);
}

export function useTitleBadgeCount(): number | null {
  return useSyncExternalStore(subscribeTitleBadge, getTitleBadge, () => null);
}
