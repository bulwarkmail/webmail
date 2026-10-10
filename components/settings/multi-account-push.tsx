'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SettingsSection } from './settings-section';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { disableWebPush, enableWebPushForAccounts, isWebPushEnabled, isWebPushSupported } from '@/lib/web-push';

interface FailedAccount {
  id: string;
  name: string;
  email: string;
  reason: string;
}

function failureReason(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/**
 * Turn push on or off for several accounts at once.
 *
 * The per-account panel above only ever addresses the account on screen, so
 * arming a fresh device used to mean switching account N times. One browser
 * subscription already serves every account (see `enableWebPushForAccounts`);
 * what was missing was a place to register them all against it in one go.
 */
export function MultiAccountPushSettings({ relayBaseUrl }: { relayBaseUrl?: string }) {
  const t = useTranslations('settings.notifications.push_all');
  const accounts = useAccountStore(s => s.accounts);
  // Re-read the client map whenever a connection appears or drops.
  const revision = useAuthStore(s => s.connectedAccountsRevision);
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  // Which accounts the last bulk enable left off, and why: a bare count
  // leaves the user guessing which login to retry.
  const [failures, setFailures] = useState<FailedAccount[]>([]);

  const connected = accounts.filter(a => a.isConnected && useAuthStore.getState().getClientForAccount(a.id));

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

  if (!isWebPushSupported() || connected.length < 2) return null;

  const toggle = (id: string, on: boolean) => setChosen(prev => {
    const next = new Set(prev);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  const run = async (action: 'enable' | 'disable') => {
    const auth = useAuthStore.getState();
    const targets = connected.filter(a => chosen.has(a.id));
    if (!targets.length) return;
    setBusy(true); setNotice(''); setFailures([]);
    try {
      if (action === 'enable') {
        const outcome = await enableWebPushForAccounts(
          targets.map(a => ({ accountId: a.id, client: auth.getClientForAccount(a.id)!, accountLabel: a.username })),
          { relayBaseUrl, inboxOnly: useSettingsStore.getState().pushNotifyInboxOnly },
        );
        setNotice(outcome.failed.length
          ? t('result_partial', { enabled: outcome.enabled.length, failed: outcome.failed.length })
          : t('result_enabled', { count: outcome.enabled.length }));
        setFailures(outcome.failed.map(({ accountId, error }) => {
          const account = targets.find(a => a.id === accountId);
          return {
            id: accountId,
            name: account ? (account.displayName || account.label || account.username) : accountId,
            email: account ? (account.email || account.username) : '',
            reason: failureReason(error),
          };
        }));
      } else {
        // Teardown swallows its own failures, so every account ends up local-off.
        for (const account of targets) {
          await disableWebPush({ client: auth.getClientForAccount(account.id)!, relayBaseUrl });
        }
        setNotice(t('result_disabled', { count: targets.length }));
      }
      setChosen(new Set());
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const allChosen = connected.length > 0 && connected.every(a => chosen.has(a.id));

  return <SettingsSection title={t('title')} description={t('description')}>
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" disabled={busy} checked={allChosen}
          onChange={e => setChosen(e.target.checked ? new Set(connected.map(a => a.id)) : new Set())} />
        {t('select_all')}
      </label>
      <ul className="space-y-2">
        {connected.map(account => <li key={account.id}>
          <label className="flex items-start gap-2 ps-6 text-sm">
            <input type="checkbox" className="mt-1" disabled={busy} checked={chosen.has(account.id)}
              onChange={e => toggle(account.id, e.target.checked)} />
            <span>
              <span className="block">{account.displayName || account.label || account.username}</span>
              <span className="block text-xs text-muted-foreground">
                {account.email || account.username} · {enabled[account.id] ? t('state_on') : t('state_off')}
              </span>
            </span>
          </label>
        </li>)}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => void run('enable')} disabled={busy || !chosen.size}>
          {busy && <Loader2 className="me-2 h-4 w-4 animate-spin" />}{t('enable_selected')}
        </Button>
        <Button type="button" variant="outline" onClick={() => void run('disable')} disabled={busy || !chosen.size}>
          {t('disable_selected')}
        </Button>
      </div>
      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
      {failures.length > 0 && <ul role="alert" className="space-y-1 text-sm text-destructive">
        {failures.map(f => <li key={f.id}>
          <span className="font-medium">{f.name}</span>
          {f.email && f.email !== f.name && <span> ({f.email})</span>}
          <span>: {f.reason}</span>
        </li>)}
      </ul>}
    </div>
  </SettingsSection>;
}
