"use client";

import { useCallback, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useFocusTrap } from '@/hooks/use-focus-trap';
import { useConfig } from '@/hooks/use-config';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import { archiveIdentity, decryptArchive, type ArchiveOwner } from '@/lib/account-archive';
import { fetchArchive, restoreArchive } from '@/lib/account-archive-client';
import { toUnicodeEmail } from '@/lib/idn';
import { archiveErrorText, restoreSummary } from '@/components/settings/account-archive-settings';

const promptKey = (owner: ArchiveOwner) => `account-archive-prompt:${archiveIdentity(owner)}`;

function wasOffered(owner: ArchiveOwner): boolean {
  try { return localStorage.getItem(promptKey(owner)) !== null; } catch { return false; }
}
function markOffered(owner: ArchiveOwner) {
  try { localStorage.setItem(promptKey(owner), 'offered'); } catch { /* storage unavailable */ }
}

/**
 * On a browser that knows only the account just signed in to, offers once to
 * bring back the account list saved for it. Declining leaves the restore in
 * Settings; the offer does not come back for that account in this browser.
 */
export function AccountArchiveRestorePrompt() {
  const enabled = usePolicyStore(s => s.isFeatureEnabled('accountArchiveEnabled'));
  const signedIn = useAuthStore(s => s.isAuthenticated && !s.isDemoMode);
  const username = useAuthStore(s => s.username);
  const serverUrl = useAuthStore(s => s.serverUrl);
  // A browser that already holds other accounts is not a new device.
  const onlyAccount = useAccountStore(s => s.accounts.length === 1);
  const [owner, setOwner] = useState<ArchiveOwner | null>(null);

  useEffect(() => {
    // An open offer stays open while the restore adds accounts; signing in to
    // another account instead hides it (the check before rendering).
    if (!enabled || !signedIn || !onlyAccount || !username || !serverUrl) return;
    const candidate = { username, serverUrl };
    if (wasOffered(candidate)) return;
    let cancelled = false;
    fetchArchive(candidate)
      .then(envelope => { if (!cancelled && envelope) setOwner(candidate); })
      .catch(() => { /* An optional lookup must not get in the way of mail. */ });
    return () => { cancelled = true; };
  }, [enabled, signedIn, onlyAccount, username, serverUrl]);

  const close = useCallback(() => {
    if (owner) markOffered(owner);
    setOwner(null);
  }, [owner]);

  if (!owner || owner.username !== username || owner.serverUrl !== serverUrl) return null;
  return createPortal(<RestoreDialog owner={owner} close={close} />, document.body);
}

function RestoreDialog({ owner, close }: { owner: ArchiveOwner; close: () => void }) {
  const t = useTranslations('settings.account.backup');
  const id = useId();
  const { rememberMeEnabled } = useConfig();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const done = message !== null && !message.error;
  const onEscape = useCallback(() => { if (!busy) close(); }, [busy, close]);
  const ref = useFocusTrap({ isActive: true, onEscape, restoreFocus: true });

  const restore = async () => {
    setBusy(true); setMessage(null);
    try {
      const envelope = await fetchArchive(owner);
      if (!envelope) throw new Error('storage_failed');
      const result = await restoreArchive(await decryptArchive(owner, envelope, password), rememberMeEnabled);
      setPassword('');
      setMessage({ error: false, text: restoreSummary(t, result) });
    } catch (err) {
      setMessage({ error: true, text: archiveErrorText(t, err) });
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
      <div
        ref={ref} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
        className="max-h-[90dvh] w-full max-w-md space-y-4 overflow-y-auto rounded-lg border border-border bg-background p-6 shadow-xl"
      >
        <h2 id={`${id}-title`} className="text-lg font-semibold">{t('prompt_title')}</h2>
        <p id={`${id}-description`} className="text-sm text-muted-foreground">
          {t('prompt_description', { account: toUnicodeEmail(owner.username) })}
        </p>
        {done ? (
          <>
            <p role="status" className="text-sm text-foreground">{message?.text}</p>
            <div className="flex justify-end">
              <Button type="button" onClick={close}>{t('prompt_done')}</Button>
            </div>
          </>
        ) : (
          <form className="space-y-3" onSubmit={e => { e.preventDefault(); void restore(); }}>
            <label className="block text-sm font-medium" htmlFor={`${id}-password`}>{t('password')}</label>
            <Input
              id={`${id}-password`} type="password" value={password} required autoFocus autoComplete="current-password"
              aria-describedby={`${id}-hint`} onChange={e => setPassword(e.target.value)}
            />
            <p id={`${id}-hint`} className="text-xs text-muted-foreground">{t('restore_hint')}</p>
            {message && <p role="alert" className="text-sm text-destructive">{message.text}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="ghost" disabled={busy} onClick={close}>{t('prompt_not_now')}</Button>
              <Button type="submit" disabled={busy}>{t('restore')}</Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
