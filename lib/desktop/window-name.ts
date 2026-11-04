"use client";

import { useEffect } from 'react';
import { getDesktopBridge } from './bridge';
import { useAccountStore } from '@/stores/account-store';

/**
 * What the desktop app's Window menu calls this window (the shell numbers two alike and
 * cuts long ones). The main window goes by its view and account ("Inbox - a@example.org"),
 * not by the message open in it, so it never reads like a message window; a message window
 * by its subject; a composer by its subject or "New message". Nothing in a browser.
 */
export function windowMenuName(view: string | null | undefined, account: string | null | undefined): string | null {
  const parts = [view?.trim(), account?.trim()].filter(Boolean);
  return parts.length ? parts.join(' - ') : null;
}

/** Tells the shell this window's Window menu name. `withAccount` adds the account in view, for the main window. */
export function useDesktopWindowName(view: string | null | undefined, { withAccount = false }: { withAccount?: boolean } = {}): void {
  const account = useAccountStore((s) => (withAccount ? s.accounts.find((a) => a.id === s.activeAccountId)?.email ?? null : null));
  const name = windowMenuName(view, account);
  useEffect(() => {
    if (!name) return;
    getDesktopBridge()?.windows?.setMenuName?.(name);
  }, [name]);
}
