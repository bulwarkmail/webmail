"use client";

import { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { inboxUnread } from '@/lib/account-inbox-unread';
import { buildAppBadgeWorkerState, writeAppBadgeWorkerState, type AppBadgeShare } from '@/lib/app-badge-worker';
import { getDesktopBridge } from '@/lib/desktop/bridge';
import { isPopoutWindow } from '@/lib/popout/window-role';

/**
 * Leaves the app badge's number, and each login's share in it, for the service
 * worker, which keeps the icon right on push while no window is open (#1516).
 * The shares are the ones useAllInboxesUnread adds up: the open login's own
 * Inbox and, with "count every account" on, every other signed-in login's.
 */
export function useAppBadgeWorkerState(count: number, enabled: boolean): void {
  const username = useAuthStore((s) => s.username);
  const ownAccountId = useAuthStore((s) => s.client?.getAccountId?.() ?? null);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const own = useEmailStore((s) => s.mailboxes.find((m) => m.role === 'inbox' && !m.isShared)?.unreadEmails ?? 0);
  const allAccounts = useSettingsStore((s) => s.unreadBadgeAllAccounts);
  const accountMailboxes = useEmailStore((s) => s.accountMailboxes);
  const connected = useAccountStore(
    useShallow((s) => s.accounts.filter((a) => a.isConnected).map((a) => `${a.id}\n${a.username}`)),
  );
  const written = useRef<string | null>(null);

  useEffect(() => {
    // A pop-out has its own account and no say in the badge.
    if (isPopoutWindow()) return;
    // The desktop app badges its icon itself (useAppBadge).
    const workerBadges = enabled && !getDesktopBridge()?.os;
    const logins = connected.map((entry) => {
      const [id, name] = entry.split('\n');
      return { id, name };
    });
    const shares: AppBadgeShare[] = [{ username, accountId: ownAccountId, unread: own }];
    if (allAccounts) {
      for (const login of logins) {
        if (login.id === activeAccountId) continue;
        const client = useAuthStore.getState().getClientForAccount(login.id);
        shares.push({ username: login.name, accountId: client?.getAccountId?.(), unread: inboxUnread(accountMailboxes[login.id]) ?? 0 });
      }
    }
    // The open login counts once, whether or not its entry is listed as connected yet.
    const names = [username, ...logins.filter((login) => login.id !== activeAccountId).map((login) => login.name)];
    const state = buildAppBadgeWorkerState(workerBadges, count, shares, names);
    const json = JSON.stringify(state);
    if (json === written.current) return;
    written.current = json;
    void writeAppBadgeWorkerState(state);
  }, [count, enabled, username, ownAccountId, activeAccountId, own, allAccounts, accountMailboxes, connected]);
}
