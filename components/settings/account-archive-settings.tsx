"use client";

import { useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthStore } from '@/stores/auth-store';
import { decryptArchive, encryptArchive, ARCHIVE_MIN_PASSWORD, type ArchiveOwner } from '@/lib/account-archive';
import { collectAccounts, fetchArchive, putArchive, removeArchive, restoreAccounts } from '@/lib/account-archive-client';
import { toUnicodeEmail } from '@/lib/idn';
import { SettingsSection } from './settings-section';

const KNOWN_ERRORS = ['mismatch', 'password_length', 'unlock_failed', 'owner_signin_required', 'https_required'];

/** Save this browser's account list, encrypted, under the active account; restore it on another device. */
export function AccountArchiveSettings() {
  const t = useTranslations('settings.account.backup');
  const id = useId();
  const username = useAuthStore(s => s.username);
  const serverUrl = useAuthStore(s => s.serverUrl);
  const [saved, setSaved] = useState<boolean | null>(null);
  const [mode, setMode] = useState<'save' | 'restore' | null>(null);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const owner: ArchiveOwner | null = username && serverUrl ? { username, serverUrl } : null;

  useEffect(() => {
    setSaved(null);
    if (!username || !serverUrl) return;
    let cancelled = false;
    fetchArchive({ username, serverUrl })
      .then(envelope => { if (!cancelled) setSaved(envelope !== null); })
      .catch(() => { if (!cancelled) setSaved(false); });
    return () => { cancelled = true; };
  }, [username, serverUrl]);

  if (!owner) return null;

  const open = (next: 'save' | 'restore' | null) => {
    setMode(next); setPassword(''); setConfirmation(''); setMessage(null);
  };
  const run = async (action: () => Promise<string>) => {
    setBusy(true); setMessage(null);
    try {
      const text = await action();
      open(null);
      setMessage({ error: false, text });
    }
    catch (err) {
      const code = err instanceof Error ? err.message : '';
      setMessage({ error: true, text: t(`errors.${KNOWN_ERRORS.includes(code) ? code : 'storage_failed'}`) });
    } finally { setBusy(false); }
  };

  const save = () => run(async () => {
    if (password !== confirmation) throw new Error('mismatch');
    const accounts = collectAccounts();
    await putArchive(owner, await encryptArchive(owner, accounts, password));
    setSaved(true);
    return t('saved', { count: accounts.length });
  });
  const restore = () => run(async () => {
    const envelope = await fetchArchive(owner);
    if (!envelope) { setSaved(false); throw new Error('storage_failed'); }
    const result = restoreAccounts(await decryptArchive(owner, envelope, password));
    return [t('restored', result), result.skipped ? t('skipped', { count: result.skipped }) : ''].join(' ').trim();
  });
  const remove = () => {
    if (!window.confirm(t('delete_confirm'))) return;
    void run(async () => { await removeArchive(owner); setSaved(false); return t('deleted'); });
  };

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      <p className="text-sm text-muted-foreground">
        {saved === null ? '…' : t(saved ? 'status_saved' : 'status_none', { account: toUnicodeEmail(owner.username) })}
      </p>
      {mode === null ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={() => open('save')}>{t('save')}</Button>
          {saved && <Button type="button" size="sm" variant="outline" onClick={() => open('restore')}>{t('restore')}</Button>}
          {saved && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={remove}>{t('delete')}</Button>}
        </div>
      ) : (
        <form
          className="space-y-3 max-w-md"
          onSubmit={e => { e.preventDefault(); void (mode === 'save' ? save() : restore()); }}
        >
          <label className="block text-sm font-medium" htmlFor={`${id}-password`}>{t('password')}</label>
          <Input
            id={`${id}-password`} type="password" value={password} required autoFocus
            minLength={mode === 'save' ? ARCHIVE_MIN_PASSWORD : undefined}
            autoComplete={mode === 'save' ? 'new-password' : 'current-password'}
            aria-describedby={`${id}-hint`} onChange={e => setPassword(e.target.value)}
          />
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            {t(mode === 'save' ? 'password_hint' : 'restore_hint')}
          </p>
          {mode === 'save' && (
            <>
              <label className="block text-sm font-medium" htmlFor={`${id}-confirm`}>{t('confirm')}</label>
              <Input
                id={`${id}-confirm`} type="password" value={confirmation} required autoComplete="new-password"
                onChange={e => setConfirmation(e.target.value)}
              />
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy}>{t(mode === 'save' ? 'save' : 'restore')}</Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => open(null)}>{t('cancel')}</Button>
          </div>
        </form>
      )}
      {message && (
        <p role={message.error ? 'alert' : 'status'} className={message.error ? 'text-sm text-destructive' : 'text-sm text-foreground'}>
          {message.text}
        </p>
      )}
    </SettingsSection>
  );
}
