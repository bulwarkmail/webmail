'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Eye, Loader2, Undo } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { IS_LITE } from '@/lib/lite';
import { canReturnToOwnAccount, returnToOwnAccount } from '@/lib/impersonation/return-client';
import { useAccountStore } from '@/stores/account-store';

/**
 * A strip across the top of the apps while an impersonation handoff is
 * open and the server holds the session that started it (#1538): "Return
 * to my account" ends the impersonation and signs back in as that account.
 * Hidden when there is nothing to return to (no session before the
 * handoff, the handle expired or was used, Lite), where signing out stays
 * the way back.
 */
export function ImpersonationReturnBar() {
  const t = useTranslations('impersonation');
  const mailbox = useAccountStore((s) => {
    const active = s.accounts.find((a) => a.id === s.activeAccountId);
    return active?.impersonated ? (active.email || active.username) : null;
  });
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (IS_LITE || !mailbox) return;
    let cancelled = false;
    void canReturnToOwnAccount().then((yes) => {
      if (!cancelled) setAvailable(yes);
    });
    return () => {
      cancelled = true;
    };
  }, [mailbox]);

  if (IS_LITE || !mailbox || !available) return null;

  const onReturn = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await returnToOwnAccount();
    } catch {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      data-testid="impersonation-return-bar"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-sm text-amber-800 dark:text-amber-200 sm:px-4"
    >
      <Eye className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{t('return_notice', { mailbox })}</span>
      <Button variant="outline" size="xs" onClick={onReturn} disabled={busy} aria-busy={busy || undefined}>
        {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Undo aria-hidden="true" />}
        {t('return_button')}
      </Button>
    </div>
  );
}
