'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { SettingItem, ToggleSwitch } from './settings-section';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { disableWebPush, enableWebPushForAccounts, isWebPushEnabled, isWebPushSupported } from '@/lib/web-push';
import { webPushErrorKey } from '@/lib/web-push-errors';

/** The accounts signed in here with a live connection: each can have push on this device. */
export function usePushAccounts() {
  const accounts = useAccountStore((s) => s.accounts);
  // Re-read the client map whenever a connection appears or drops.
  useAuthStore((s) => s.connectedAccountsRevision);
  const isDemoMode = useAuthStore((s) => s.isDemoMode);
  if (isDemoMode || !isWebPushSupported()) return [];
  return accounts.filter((a) => a.isConnected && useAuthStore.getState().getClientForAccount(a.id));
}

/**
 * One switch per account for notifications while the app is closed, under
 * "Notifications when … is closed" (settings-p2-17). It replaces a checklist
 * with "Enable for selected" and "Disable for selected": with a switch each,
 * an account's state is what its switch shows. One browser subscription
 * serves every account (see `enableWebPushForAccounts`).
 */
export function AccountPushSwitches({ relayBaseUrl, disabled = false, onChanged }: {
  relayBaseUrl?: string;
  /** No relay to send through: the switches show their state but can't turn on. */
  disabled?: boolean;
  /** After a switch changed something, so the page can re-read its own state. */
  onChanged?: () => void;
}) {
  const tPush = useTranslations('settings.notifications.push');
  const connected = usePushAccounts();
  const revision = useAuthStore((s) => s.connectedAccountsRevision);
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // The reason an account's switch didn't move, shown under it.
  const [failures, setFailures] = useState<Record<string, string>>({});

  const failureReason = (error: unknown): string => {
    const key = webPushErrorKey(error);
    if (key) return tPush(key);
    return error instanceof Error && error.message ? error.message : String(error);
  };

  const refresh = useCallback(async () => {
    // Push state is stored under the JMAP account id the server assigned (see
    // enableWebPush), not under the login's own id: read it back the same way.
    const entries = await Promise.all(
      useAccountStore.getState().accounts.map(async (a) => {
        const jmapAccountId = useAuthStore.getState().getClientForAccount(a.id)?.getAccountId();
        return [a.id, jmapAccountId ? await isWebPushEnabled(jmapAccountId) : false] as const;
      }),
    );
    setEnabled(Object.fromEntries(entries));
  }, []);

  useEffect(() => { void refresh(); }, [refresh, revision]);

  if (connected.length < 2) return null;

  const change = async (account: (typeof connected)[number], on: boolean) => {
    const client = useAuthStore.getState().getClientForAccount(account.id);
    if (!client) return;
    setBusy(account.id);
    setFailures(({ [account.id]: _dropped, ...rest }) => rest);
    try {
      if (on) {
        const outcome = await enableWebPushForAccounts(
          [{ accountId: account.id, client, accountLabel: account.username }],
          {
            relayBaseUrl,
            inboxOnly: useSettingsStore.getState().pushNotifyInboxOnly,
            mutes: useSettingsStore.getState().notificationMutes,
          },
        );
        const failed = outcome.failed[0];
        if (failed) setFailures((prev) => ({ ...prev, [account.id]: failureReason(failed.error) }));
      } else {
        await disableWebPush({ client, relayBaseUrl });
      }
    } catch (error) {
      setFailures((prev) => ({ ...prev, [account.id]: failureReason(error) }));
    } finally {
      setBusy(null);
      await refresh();
      onChanged?.();
    }
  };

  return (
    <>
      {connected.map((account) => {
        const name = account.displayName || account.label || account.username;
        const email = account.email || account.username;
        const failure = failures[account.id];
        return (
          <div key={account.id} data-testid="account-push-row">
            <SettingItem label={name} description={email !== name ? email : undefined}>
              <ToggleSwitch
                checked={!!enabled[account.id]}
                disabled={busy !== null || (disabled && !enabled[account.id])}
                ariaLabel={email !== name ? `${name} (${email})` : name}
                onChange={(on) => void change(account, on)}
              />
            </SettingItem>
            {failure && <p role="alert" className="-mt-2 pb-2 text-xs text-destructive">{failure}</p>}
          </div>
        );
      })}
    </>
  );
}
