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
import { collectVault, deleteVault, fetchVaults, putVault } from '@/lib/account-vault-client';
import { decryptVault, encryptVault, vaultIdentity, VAULT_NAME_MAX, type VaultContents, type VaultOwner, type VaultRecord } from '@/lib/account-vault';
import { generateAccountId as generateVaultAccountId } from '@/lib/account-utils';

/** Revision this browser last restored or saved, per archive: guards against overwriting a newer copy. */
function revisionKey(owner: VaultOwner, id: string): string { return `account-vault-revision:${vaultIdentity(owner)}:${id}`; }
function rememberRevision(owner: VaultOwner, record: VaultRecord): void {
  try { localStorage.setItem(revisionKey(owner, record.id), record.revision); } catch { /* storage unavailable */ }
}
function knownRevision(owner: VaultOwner, id: string): string | null {
  try { return localStorage.getItem(revisionKey(owner, id)); } catch { return null; }
}

function promptKey(owner: VaultOwner): string { return `account-vault-prompt:${vaultIdentity(owner)}`; }

/** `delete` is `update` opened straight on the confirmation step. */
export type VaultDialogMode = 'import' | 'update' | 'create' | 'delete';

/** Offer an import once per account/browser, after mail authentication succeeds. */
export function AccountVaultImportPrompt() {
  const { settingsSyncEnabled, oauthOnly } = useConfig();
  const authenticated = useAuthStore(s => s.isAuthenticated && s.authMode === 'basic' && !s.isDemoMode);
  const username = useAuthStore(s => s.username);
  const serverUrl = useAuthStore(s => s.serverUrl);
  const [found, setFound] = useState<{ owner: VaultOwner; records: VaultRecord[] } | null>(null);
  const [accepted, setAccepted] = useState<VaultRecord | null>(null);

  useEffect(() => {
    setFound(null); setAccepted(null);
    if (!settingsSyncEnabled || oauthOnly || !authenticated || !username || !serverUrl) return;
    const owner = { username, serverUrl };
    try { if (localStorage.getItem(promptKey(owner))) return; } catch { /* storage unavailable: still allow importing */ }
    let cancelled = false;
    fetchVaults(owner).then(records => {
      // Archives this browser already restored or saved need no offer.
      const fresh = records.filter(r => knownRevision(owner, r.id) === null);
      if (!cancelled && fresh.length) setFound({ owner, records: fresh });
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
    ? <VaultDialog owner={found.owner} mode="import" record={accepted} close={close} />
    : <ImportOffer owner={found.owner} records={found.records} accept={setAccepted} close={close} />, document.body);
}

function ImportOffer({ owner, records, accept, close }: { owner: VaultOwner; records: VaultRecord[]; accept: (record: VaultRecord) => void; close: () => void }) {
  const t = useTranslations('account_vault');
  const id = useId();
  const [chosen, setChosen] = useState(records[0]!.id);
  const ref = useFocusTrap({ isActive: true, onEscape: close, restoreFocus: true });
  return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
      className="w-full max-w-lg space-y-4 rounded-lg border border-border bg-background p-6 shadow-xl">
      <h2 id={`${id}-title`} className="text-lg font-semibold">{t('detected_title')}</h2>
      <p id={`${id}-description`}>{t('detected_description', { username: owner.username })}</p>
      {records.length > 1 && <label className="block text-sm">{t('archive')}
        <select className="mt-2 block w-full rounded-md border border-input bg-background p-2" value={chosen} onChange={e => setChosen(e.target.value)}>
          {records.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => accept(records.find(r => r.id === chosen) ?? records[0]!)}>{t('import')}</Button>
        <Button type="button" variant="ghost" onClick={close}>{t('not_now')}</Button>
      </div>
    </div>
  </div>;
}

function VaultDialog({ owner, mode: requested, record, close }: { owner: VaultOwner; mode: VaultDialogMode; record?: VaultRecord; close: () => void }) {
  const mode = requested === 'delete' ? 'update' : requested;
  const t = useTranslations('account_vault');
  const id = useId();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [name, setName] = useState(record?.name ?? '');
  const [rememberMe, setRememberMe] = useState(true);
  const [importPasswords, setImportPasswords] = useState(true);
  const [savePasswords, setSavePasswords] = useState(true);
  // Decrypted archive awaiting the user's pick. The owner's own account is always
  // imported: parseVaultContents refuses an archive that does not contain it.
  const [unlocked, setUnlocked] = useState<VaultContents | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(requested === 'delete');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const onEscape = useCallback(() => { if (!busy) close(); }, [busy, close]);
  const ref = useFocusTrap({ isActive: true, onEscape, restoreFocus: true });
  const accounts = useAccountStore(s => s.accounts);

  const showError = (err: unknown) => {
    const code = err instanceof Error ? err.message : '';
    const known = ['invalid_archive', 'invalid_name', 'https_required', 'password_length', 'unlock_failed', 'disabled', 'storage_failed',
      'owner_signin_required', 'conflict', 'archive_limit', 'accounts_disconnected', 'account_limit', 'account_conflict'];
    if (code === 'unlock_failed' && record) {
      // Each archive has its own password: say which one was tried, so a password
      // chosen for another archive is not mistaken for corruption.
      setError(t('errors.unlock_failed_owner', { name: record.name, username: owner.username, server: new URL(owner.serverUrl).hostname }));
      return;
    }
    setError(t(`errors.${known.includes(code) ? code : 'storage_failed'}`));
  };

  const unlock = async () => {
    if (!record) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const contents = await decryptVault(record.envelope, password, owner);
      setUnlocked(contents);
      setChosen(new Set(contents.accounts.map(vaultIdentity)));
    } catch (err) { showError(err); }
    finally { setBusy(false); }
  };

  const importChosen = async () => {
    if (!record || !unlocked) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const picked = unlocked.accounts.filter(a => chosen.has(vaultIdentity(a)) || vaultIdentity(a) === vaultIdentity(owner));
      const contents = picked.length === unlocked.accounts.length ? unlocked : {
        ...unlocked, accounts: picked,
        // Dropping the archive's default account would leave a dangling id.
        defaultAccountId: picked.some(a => generateVaultAccountId(a.username, a.serverUrl) === unlocked.defaultAccountId) ? unlocked.defaultAccountId : null,
      };
      const result = await useAuthStore.getState().restoreVault(contents, rememberMe, importPasswords);
      rememberRevision(owner, record);
      setPassword(''); setUnlocked(null);
      if (result.pending && !result.failed) {
        const message = t('imported_without_passwords', { count: contents.accounts.length, pending: result.pending });
        setNotice(message); toast.success(message); close();
      }
      else if (!result.connected) setError(t('errors.accounts_disconnected'));
      else if (result.failed) { setNotice(t('partial', result)); toast.warning(t('partial', result)); }
      else { setNotice(t('restored', result)); close(); }
    } catch (err) { showError(err); }
    finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      if (record) {
        // Require a snapshot this browser has actually restored/saved, rather
        // than fetching today's revision and overwriting it with stale state.
        if (knownRevision(owner, record.id) !== record.revision) throw new Error('conflict');
        await decryptVault(record.envelope, password, owner);
      } else if (password !== confirmation) {
        setError(t('password_mismatch')); return;
      }
      const contents = collectVault(owner, savePasswords);
      const envelope = await encryptVault(contents, password);
      const saved = await putVault(owner, { id: record?.id ?? null, name, revision: record?.revision ?? null }, envelope);
      rememberRevision(owner, saved);
      setPassword(''); setConfirmation('');
      // Keep the local entries visible even after their session cookies expire.
      for (const account of useAccountStore.getState().accounts) {
        if (account.authMode === 'basic') useAccountStore.getState().updateAccount(account.id, { vaultManaged: true });
      }
      toast.success(t('saved')); close();
    } catch (err) { showError(err); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!record) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await deleteVault(owner, { id: record.id, revision: record.revision });
      try { localStorage.removeItem(revisionKey(owner, record.id)); } catch { /* storage unavailable */ }
      toast.success(t('deleted')); close();
    } catch (err) { showError(err); }
    finally { setBusy(false); }
  };

  const basicCount = accounts.filter(a => a.authMode === 'basic').length;
  const importCount = unlocked ? unlocked.accounts.filter(a => chosen.has(vaultIdentity(a)) || vaultIdentity(a) === vaultIdentity(owner)).length : 0;
  const submit = () => { if (busy) return; if (mode === 'import') void (unlocked ? importChosen() : unlock()); else void save(); };

  return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}
      className="w-full max-w-lg space-y-4 rounded-lg border border-border bg-background p-6 shadow-xl">
      <h2 id={`${id}-title`} className="text-lg font-semibold">{record ? record.name : t('new_archive')}</h2>
      <p className="text-sm text-muted-foreground">{t('owner', { username: owner.username })}</p>
      {confirmDelete && record ? <div className="space-y-4">
        <p className="text-sm">{t('delete_confirm', { name: record.name, username: owner.username })}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="destructive" onClick={() => void remove()} disabled={busy}>{t('delete_confirm_button')}</Button>
          <Button type="button" variant="outline" onClick={() => setConfirmDelete(false)} disabled={busy}>{t('cancel')}</Button>
        </div>
      </div> : <form className="space-y-4" onSubmit={e => {
        // Portal events still bubble through React's parent login form.
        e.preventDefault(); e.stopPropagation(); submit();
      }}>
        <p className="text-sm text-muted-foreground">
          {t(mode === 'import' ? (unlocked ? 'choose_accounts_description' : 'unlock_description') : mode === 'create' ? 'create_description' : 'save_description', { count: basicCount })}
        </p>
        {mode === 'update' && <p className="text-sm text-muted-foreground">{t('owner_hint')}</p>}
        {unlocked && <fieldset className="space-y-2 rounded-md border border-border p-3">
          <legend className="px-1 text-sm font-medium">{t('choose_accounts')}</legend>
          {unlocked.accounts.map(account => {
            const key = vaultIdentity(account);
            const isOwner = key === vaultIdentity(owner);
            return <label key={key} className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" disabled={busy || isOwner} checked={isOwner || chosen.has(key)}
                onChange={e => setChosen(prev => { const next = new Set(prev); if (e.target.checked) next.add(key); else next.delete(key); return next; })} />
              <span>
                <span className="block">{account.label || account.username}</span>
                <span className="block text-xs text-muted-foreground">
                  {account.username} · {new URL(account.serverUrl).hostname}{isOwner ? ` · ${t('owner_always')}` : ''}
                </span>
              </span>
            </label>;
          })}
        </fieldset>}
        {mode !== 'import' && <>
          <label className="block text-sm" htmlFor={`${id}-name`}>{t('name')}</label>
          <Input id={`${id}-name`} type="text" value={name} onChange={e => setName(e.target.value)} disabled={busy} required maxLength={VAULT_NAME_MAX} />
          <p className="text-sm text-muted-foreground">{t('name_hint')}</p>
        </>}
        {!unlocked && <>
          <label className="block text-sm" htmlFor={`${id}-password`}>{t('password')}</label>
          <Input id={`${id}-password`} type="password" autoComplete={record ? 'current-password' : 'new-password'}
            value={password} onChange={e => setPassword(e.target.value)} disabled={busy} required maxLength={1024} />
        </>}
        {mode === 'create' && <>
          <label className="block text-sm" htmlFor={`${id}-confirmation`}>{t('confirm_password')}</label>
          <Input id={`${id}-confirmation`} type="password" autoComplete="new-password"
            value={confirmation} onChange={e => setConfirmation(e.target.value)} disabled={busy} required maxLength={1024} />
        </>}
        {mode !== 'import' && <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={savePasswords} onChange={e => setSavePasswords(e.target.checked)} disabled={busy} />{t('save_passwords')}
        </label>}
        {mode === 'import' && !unlocked && <>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={importPasswords} onChange={e => setImportPasswords(e.target.checked)} disabled={busy} />{t('import_passwords')}
          </label>
          <p className="text-sm text-muted-foreground">{t('passwords_hint')}</p>
          {importPasswords && <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={rememberMe} onChange={e => setRememberMe(e.target.checked)} disabled={busy} />{t('remember')}
          </label>}
        </>}
        <div className="flex flex-wrap gap-2">
          {mode === 'import' && unlocked && <Button type="submit" disabled={busy}>{t('import_chosen', { count: importCount })}</Button>}
          {mode === 'import' && !unlocked && <Button type="submit" disabled={busy || !password}>{t('unlock')}</Button>}
          {mode === 'create' && <Button type="submit" disabled={busy || !password || !name.trim()}>{t('create')}</Button>}
          {mode === 'update' && <>
            <Button type="submit" disabled={busy || !password || !name.trim()}>{t('manage')}</Button>
            <Button type="button" variant="outline" onClick={() => setConfirmDelete(true)} disabled={busy}>{t('delete')}</Button>
          </>}
        </div>
      </form>}
      {busy && <p role="status" className="text-sm">{t('working')}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      <Button type="button" variant="ghost" onClick={close} disabled={busy}>{t('close')}</Button>
    </div>
  </div>;
}

interface Listed { owner: VaultOwner; record: VaultRecord }
const NEW = '__new__';

/** Settings → Account: every archive of every basic-auth account in this browser, plus creation. */
export function AccountVaultSettings() {
  const t = useTranslations('account_vault');
  const { settingsSyncEnabled, oauthOnly } = useConfig();
  const accounts = useAccountStore(s => s.accounts);
  const defaultId = useAccountStore(s => s.defaultAccountId);
  const basic = accounts.filter(a => a.authMode === 'basic');
  const [listed, setListed] = useState<Listed[] | null>(null);
  const [selection, setSelection] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [open, setOpen] = useState<{ owner: VaultOwner; mode: VaultDialogMode; record?: VaultRecord } | null>(null);
  const [scan, setScan] = useState(0);
  // Plain owner objects: they travel to the API and into localStorage keys.
  const owners = basic.map(a => ({ username: a.username, serverUrl: a.serverUrl }));
  const ownersKey = basic.map(a => a.id).join('|');

  useEffect(() => {
    if (!settingsSyncEnabled || oauthOnly) return;
    let cancelled = false;
    setListed(null);
    Promise.all(owners.map(async owner => {
      try { return (await fetchVaults(owner)).map(record => ({ owner, record })); }
      catch { return [] as Listed[]; } // one unreachable account must not hide the others' archives
    })).then(groups => { if (!cancelled) setListed(groups.flat()); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsSyncEnabled, oauthOnly, ownersKey, scan]);

  if (!settingsSyncEnabled || oauthOnly || !basic.length) return null;
  const current = listed?.find(l => `${vaultIdentity(l.owner)}:${l.record.id}` === selection) ?? (selection === NEW ? null : listed?.[0] ?? null);
  const creating = selection === NEW || (listed !== null && listed.length === 0);
  const ownerAccount = basic.find(a => a.id === ownerId) || basic.find(a => a.id === defaultId) || basic[0]!;
  const key = (l: Listed) => `${vaultIdentity(l.owner)}:${l.record.id}`;

  return <section className="space-y-3">
    <h3 className="font-semibold">{t('title')}</h3>
    {listed === null && <p role="status" className="text-sm text-muted-foreground">{t('loading')}</p>}
    {listed !== null && listed.length === 0 && <p className="text-sm text-muted-foreground">{t('none')}</p>}
    {listed !== null && listed.length > 0 && <label className="block text-sm">{t('archive')}
      <select className="mt-2 block w-full rounded-md border border-input bg-background p-2" value={creating ? NEW : current ? key(current) : ''} onChange={e => setSelection(e.target.value)}>
        {listed.map(l => <option key={key(l)} value={key(l)}>{t('option', { name: l.record.name, username: l.owner.username })}</option>)}
        <option value={NEW}>{t('new_archive')}</option>
      </select>
    </label>}
    {creating && <>
      <label className="block text-sm">{t('choose_owner')}
        <select className="mt-2 block w-full rounded-md border border-input bg-background p-2" value={ownerAccount.id} onChange={e => setOwnerId(e.target.value)}>
          {basic.map(a => <option key={a.id} value={a.id}>{a.username} — {a.serverUrl}</option>)}
        </select>
      </label>
      <p className="text-sm text-muted-foreground">{t('owner_hint')}</p>
    </>}
    <div className="flex flex-wrap gap-2">
      {!creating && current && <>
        <Button type="button" variant="outline" onClick={() => setOpen({ owner: current.owner, mode: 'import', record: current.record })}>{t('import')}</Button>
        <Button type="button" variant="outline" onClick={() => setOpen({ owner: current.owner, mode: 'update', record: current.record })}>{t('manage')}</Button>
        <Button type="button" variant="outline" onClick={() => setOpen({ owner: current.owner, mode: 'delete', record: current.record })}>{t('delete')}</Button>
      </>}
      {creating && <Button type="button" onClick={() => setOpen({ owner: { username: ownerAccount.username, serverUrl: ownerAccount.serverUrl }, mode: 'create' })}>{t('create')}</Button>}
      <Button type="button" variant="ghost" onClick={() => setScan(n => n + 1)}>{t('rescan')}</Button>
    </div>
    {open && createPortal(<VaultDialog owner={open.owner} mode={open.mode} record={open.record}
      close={() => { setOpen(null); setScan(n => n + 1); }} />, document.body)}
  </section>;
}
