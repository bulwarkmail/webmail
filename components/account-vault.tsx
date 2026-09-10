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
import { toast } from '@/stores/toast-store';
import { collectVault, fetchVault, putVault } from '@/lib/account-vault-client';
import { decryptVault, encryptVault, vaultIdentity, type VaultOwner, type VaultRecord } from '@/lib/account-vault';

function revisionKey(owner: VaultOwner): string { return `account-vault-revision:${vaultIdentity(owner)}`; }
function rememberRevision(owner: VaultOwner, revision: string): void {
  try { localStorage.setItem(revisionKey(owner), revision); } catch { /* storage unavailable */ }
}

function promptKey(owner: VaultOwner): string { return `account-vault-prompt:${vaultIdentity(owner)}`; }

/** Offer an import once per account/browser, after mail authentication succeeds. */
export function AccountVaultImportPrompt() {
  const { settingsSyncEnabled, oauthOnly } = useConfig();
  const authenticated = useAuthStore(s => s.isAuthenticated && s.authMode === 'basic' && !s.isDemoMode);
  const username = useAuthStore(s => s.username);
  const serverUrl = useAuthStore(s => s.serverUrl);
  const [found, setFound] = useState<{ owner: VaultOwner; record: VaultRecord } | null>(null);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    setFound(null); setAccepted(false);
    if (!settingsSyncEnabled || oauthOnly || !authenticated || !username || !serverUrl) return;
    const owner = { username, serverUrl };
    try {
      if (localStorage.getItem(revisionKey(owner)) || localStorage.getItem(promptKey(owner))) return;
    } catch { /* storage unavailable: still allow importing */ }
    let cancelled = false;
    fetchVault(owner).then(record => {
      if (!cancelled && record) setFound({ owner, record });
    }).catch(() => { /* A failed optional lookup must not interrupt mail login. */ });
    return () => { cancelled = true; };
  }, [settingsSyncEnabled, oauthOnly, authenticated, username, serverUrl]);

  if (!settingsSyncEnabled || oauthOnly || !authenticated || !found
    || found.owner.username !== username || found.owner.serverUrl !== serverUrl) return null;
  const close = () => {
    try { localStorage.setItem(promptKey(found.owner), 'dismissed'); } catch { /* storage unavailable */ }
    setFound(null);
  };
  return createPortal(accepted
    ? <VaultDialog owner={found.owner} initialRecord={found.record} manage={false} close={close} />
    : <ImportOffer owner={found.owner} accept={() => setAccepted(true)} close={close} />, document.body);
}

function ImportOffer({ owner, accept, close }: { owner: VaultOwner; accept: () => void; close: () => void }) {
  const t = useTranslations('account_vault');
  const id = useId();
  const ref = useFocusTrap({ isActive: true, onEscape: close, restoreFocus: true });
  return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
      className="w-full max-w-lg space-y-4 rounded-lg border border-border bg-background p-6 shadow-xl">
      <h2 id={`${id}-title`} className="text-lg font-semibold">{t('detected_title')}</h2>
      <p id={`${id}-description`}>{t('detected_description', { username: owner.username })}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={accept}>{t('import')}</Button>
        <Button type="button" variant="ghost" onClick={close}>{t('not_now')}</Button>
      </div>
    </div>
  </div>;
}

export function AccountVault({ owner, manage = false, label }: { owner: VaultOwner; manage?: boolean; label?: string }) {
  const { settingsSyncEnabled, oauthOnly } = useConfig();
  const t = useTranslations('account_vault');
  const [open, setOpen] = useState<VaultOwner | null>(null);
  if (!settingsSyncEnabled || oauthOnly) return null;
  return <>
    <Button type="button" variant="outline" onClick={() => setOpen({ username: owner.username, serverUrl: owner.serverUrl })} disabled={!owner.username || !owner.serverUrl}>
      {label || t(manage ? 'manage' : 'unlock')}
    </Button>
    {open && createPortal(<VaultDialog owner={open} manage={manage} close={() => setOpen(null)} />, document.body)}
  </>;
}

function VaultDialog({ owner, manage, close, initialRecord }: { owner: VaultOwner; manage: boolean; close: () => void; initialRecord?: VaultRecord }) {
  const t = useTranslations('account_vault');
  const id = useId();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [importPasswords, setImportPasswords] = useState(true);
  const [savePasswords, setSavePasswords] = useState(true);
  const [record, setRecord] = useState<VaultRecord | null | undefined>(initialRecord);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const onEscape = useCallback(() => { if (!busy) close(); }, [busy, close]);
  const ref = useFocusTrap({ isActive: true, onEscape, restoreFocus: true });
  const accounts = useAccountStore(s => s.accounts);
  const ownerUsername = owner.username;
  const ownerServer = owner.serverUrl;

  useEffect(() => {
    if (initialRecord) return;
    let cancelled = false;
    fetchVault({ username: ownerUsername, serverUrl: ownerServer }).then(value => {
      if (!cancelled) setRecord(value);
    }).catch(() => { if (!cancelled) setError(t('errors.storage_failed')); });
    return () => { cancelled = true; };
  }, [ownerUsername, ownerServer, t, initialRecord]);

  const showError = (err: unknown) => {
    const code = err instanceof Error ? err.message : '';
    const known = ['invalid_archive', 'https_required', 'password_length', 'unlock_failed', 'disabled',
      'storage_failed', 'owner_signin_required', 'conflict', 'accounts_disconnected', 'account_limit', 'account_conflict'];
    setError(t(`errors.${known.includes(code) ? code : 'storage_failed'}`));
  };

  const unlock = async () => {
    if (!record) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const contents = await decryptVault(record.envelope, password, owner);
      const result = await useAuthStore.getState().restoreVault(contents, rememberMe, importPasswords);
      rememberRevision(owner, record.revision);
      setPassword('');
      if (result.pending && !result.failed) {
        const message = t('imported_without_passwords', { count: contents.accounts.length, pending: result.pending });
        setNotice(message); toast.success(message); if (!manage) close();
      }
      else if (!result.connected) setError(t('errors.accounts_disconnected'));
      else if (result.failed) { setNotice(t('partial', result)); toast.warning(t('partial', result)); }
      else { setNotice(t('restored', result)); if (!manage) close(); }
    } catch (err) { showError(err); }
    finally { setBusy(false); }
  };

  const save = async () => {
    if (record === undefined) return;
    setBusy(true); setError(''); setNotice('');
    try {
      if (record) {
        // Require a snapshot this browser has actually restored/saved, rather
        // than fetching today's revision and overwriting it with stale state.
        if (localStorage.getItem(revisionKey(owner)) !== record.revision) throw new Error('conflict');
        await decryptVault(record.envelope, password, owner);
      } else if (password !== confirmation) {
        setError(t('password_mismatch')); return;
      }
      const contents = collectVault(owner, savePasswords);
      const envelope = await encryptVault(contents, password);
      const saved = await putVault(owner, envelope, record?.revision ?? null);
      rememberRevision(owner, saved.revision);
      setRecord(saved); setPassword(''); setConfirmation('');
      // Keep the local entries visible even after their session cookies expire.
      for (const account of useAccountStore.getState().accounts) {
        if (account.authMode === 'basic') useAccountStore.getState().updateAccount(account.id, { vaultManaged: true });
      }
      setNotice(t('saved'));
    } catch (err) { showError(err); }
    finally { setBusy(false); }
  };

  return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}
      className="w-full max-w-lg space-y-4 rounded-lg border border-border bg-background p-6 shadow-xl">
      <h2 id={`${id}-title`} className="text-lg font-semibold">{t('title')}</h2>
      <p className="text-sm text-muted-foreground">{t('owner', { username: owner.username })}</p>
      {record === undefined && !error && <p role="status">{t('loading')}</p>}
      {record === null && !manage && <p>{t('not_found')}</p>}
      {record !== undefined && (record || manage) && <form className="space-y-4" onSubmit={e => {
        // Portal events still bubble through React's parent login form.
        e.preventDefault(); e.stopPropagation();
        if (!busy) void (record ? unlock() : save());
      }}>
        <p className="text-sm text-muted-foreground">{t(record ? 'unlock_description' : 'create_description')}</p>
        {manage && <p className="text-sm text-muted-foreground">{t('save_description', { count: accounts.filter(a => a.authMode === 'basic').length })}</p>}
        <label className="block text-sm" htmlFor={`${id}-password`}>{t('password')}</label>
        <Input id={`${id}-password`} type="password" autoComplete={record ? 'current-password' : 'new-password'}
          value={password} onChange={e => setPassword(e.target.value)} disabled={busy} required maxLength={1024} />
        {!record && <>
          <label className="block text-sm" htmlFor={`${id}-confirmation`}>{t('confirm_password')}</label>
          <Input id={`${id}-confirmation`} type="password" autoComplete="new-password"
            value={confirmation} onChange={e => setConfirmation(e.target.value)} disabled={busy} required maxLength={1024} />
        </>}
        {manage && <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={savePasswords} onChange={e => setSavePasswords(e.target.checked)} disabled={busy} />{t('save_passwords')}
        </label>}
        {record && <>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={importPasswords} onChange={e => setImportPasswords(e.target.checked)} disabled={busy} />{t('import_passwords')}
          </label>
          <p className="text-sm text-muted-foreground">{t('passwords_hint')}</p>
        </>}
        {record && importPasswords && <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={rememberMe} onChange={e => setRememberMe(e.target.checked)} disabled={busy} />{t('remember')}
        </label>}
        <div className="flex flex-wrap gap-2">
          {record && <Button type="submit" disabled={busy || !password}>{t('unlock')}</Button>}
          {manage && <Button type={record ? 'button' : 'submit'} onClick={record ? () => void save() : undefined}
            disabled={busy || !password} variant={record ? 'outline' : 'default'}>{t('save')}</Button>}
        </div>
      </form>}
      {busy && <p role="status" className="text-sm">{t('working')}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      <Button type="button" variant="ghost" onClick={close} disabled={busy}>{t('close')}</Button>
    </div>
  </div>;
}

export function AccountVaultSettings() {
  const t = useTranslations('account_vault');
  const { settingsSyncEnabled, oauthOnly } = useConfig();
  const accounts = useAccountStore(s => s.accounts);
  const defaultId = useAccountStore(s => s.defaultAccountId);
  const [selectedId, setSelectedId] = useState('');
  const basic = accounts.filter(a => a.authMode === 'basic');
  const selected = basic.find(a => a.id === selectedId) || basic.find(a => a.id === defaultId) || basic[0];
  if (!settingsSyncEnabled || oauthOnly || !selected) return null;
  return <section className="space-y-3">
    <h3 className="font-semibold">{t('title')}</h3>
    <label className="block text-sm">{t('choose_owner')}
      <select className="mt-2 block w-full rounded-md border border-input bg-background p-2" value={selected.id} onChange={e => setSelectedId(e.target.value)}>
        {basic.map(a => <option key={a.id} value={a.id}>{a.username} — {a.serverUrl}</option>)}
      </select>
    </label>
    <div className="flex flex-wrap gap-2">
      <AccountVault owner={selected} label={t('rescan')} />
      <AccountVault owner={selected} manage />
    </div>
  </section>;
}
