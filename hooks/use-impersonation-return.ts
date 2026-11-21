'use client';

import { useEffect, useState } from 'react';
import { IS_LITE } from '@/lib/lite';
import { canReturnToOwnAccount } from '@/lib/impersonation/return-client';
import { pluginHasPermission } from '@/lib/plugin-sandbox/permissions';
import { get as activePlugin } from '@/lib/plugin-sandbox/registry';
import { usePluginSlotOffers } from '@/hooks/use-plugin-slot-offers';
import { useAccountStore } from '@/stores/account-store';

/**
 * "Return to my account" after an impersonation handoff (#1538): the mailbox
 * the active session impersonates (null when it is the user's own), and
 * whether the server holds a session to return to. The answer is asked for
 * once per impersonated account and shared by everything that shows the
 * way back: the core strip and the `canReturn` prop of the app-top-banner
 * slot. A return reloads the page, which starts the cache over.
 */
const answers = new Map<string, Promise<boolean>>();

export function resetImpersonationReturnCacheForTests(): void {
  answers.clear();
}

export function useImpersonationReturn(): { mailbox: string | null; available: boolean } {
  const active = useAccountStore((s) => s.accounts.find((a) => a.id === s.activeAccountId));
  const accountId = active?.impersonated ? active.id : null;
  const mailbox = active?.impersonated ? (active.email || active.username) : null;
  const [answer, setAnswer] = useState<{ accountId: string; available: boolean } | null>(null);

  useEffect(() => {
    if (IS_LITE || !accountId) return;
    let cancelled = false;
    let pending = answers.get(accountId);
    if (!pending) {
      pending = canReturnToOwnAccount();
      answers.set(accountId, pending);
    }
    void pending.then((available) => {
      if (!cancelled) setAnswer({ accountId, available });
    });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const available = !IS_LITE && !!accountId && answer?.accountId === accountId && answer.available;
  return { mailbox, available };
}

/**
 * Whether an enabled plugin draws the way back itself: it shows a banner in
 * the app-top-banner slot and holds `auth:impersonation-return`, the
 * permission that gets it the `canReturn` prop and the
 * `api.user.returnToOwnAccount()` call. The core strip then stays away, so
 * the button isn't there twice. A plugin that fails to load offers no
 * banner, and the core strip comes back.
 */
export function usePluginDrawsImpersonationReturn(): boolean {
  const offers = usePluginSlotOffers('app-top-banner');
  return offers.some((offer) => {
    const plugin = activePlugin(offer.pluginId)?.plugin;
    return !!plugin && pluginHasPermission(plugin, 'auth:impersonation-return');
  });
}
