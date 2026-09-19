'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useThemeStore } from '@/stores/theme-store';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';

export function SharedDisplaySettings() {
  const t = useTranslations('account_qol');
  const accounts = useAccountStore(s => s.accounts);
  const mainId = useAccountStore(s => s.defaultAccountId);
  const activeId = useAuthStore(s => s.activeAccountId);
  const sourceId = useSettingsStore(s => s.sharedDisplaySourceId);
  const profiles = useSettingsStore(s => s.displayProfiles);
  const main = accounts.find(a => a.id === mainId);
  const source = accounts.find(a => a.id === sourceId);
  if (accounts.length < 2 && !sourceId) return null;
  return <SettingsSection title={t('shared_title')} description={t('shared_description')}>
    <SettingItem label={t('shared_label', { account: source?.email || source?.username || main?.email || main?.username || '' })}
      description={sourceId ? t('shared_active', { account: source?.email || source?.username || sourceId }) : t('shared_off')}>
      <ToggleSwitch checked={!!sourceId} disabled={!sourceId && (!mainId || !profiles[mainId])}
        onChange={enabled => useSettingsStore.getState().shareDisplayFrom(enabled ? mainId : null)} />
    </SettingItem>
    {main && activeId !== main.id && !profiles[main.id] && <Button variant="outline" size="sm"
      onClick={() => void useAuthStore.getState().switchAccount(main.id)}>{t('open_main')}</Button>}
  </SettingsSection>;
}

export function AccountDisplaySettings() {
  const t = useTranslations('account_qol');
  const accounts = useAccountStore(s => s.accounts);
  const activeId = useAuthStore(s => s.activeAccountId);
  const updateAccount = useAccountStore(s => s.updateAccount);
  const [selectedId, setSelectedId] = useState(activeId ?? '');
  const [error, setError] = useState('');
  const themes = useThemeStore(s => s.installedThemes);
  const savedThemes = useSettingsStore(s => s.accountThemes);
  const activeThemeId = useThemeStore(s => s.activeThemeId);
  const account = accounts.find(a => a.id === selectedId) ?? accounts.find(a => a.id === activeId);
  if (!account) return null;
  const themeId = account.id === activeId ? activeThemeId : savedThemes[account.id]?.activeThemeId ?? null;

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setError(t('image_error')); return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 128;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas unavailable');
      const side = Math.min(bitmap.width, bitmap.height);
      context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 128, 128);
      bitmap.close();
      updateAccount(account.id, { avatarImage: canvas.toDataURL('image/webp', 0.85) });
    } catch { setError(t('image_error')); }
  };
  return <div className="space-y-8">
    <SharedDisplaySettings />
    <SettingsSection title={t('identity_title')} description={t('identity_description')}>
      <label className="block text-sm">{t('account')}
        <select className="mt-2 block w-full rounded-md border border-border bg-background p-2" value={account.id}
          onChange={e => { setSelectedId(e.target.value); setError(''); }}>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.email || a.username}</option>)}
        </select>
      </label>
      <SettingItem label={t('image')} description={t('image_description')}>
        <div className="flex items-center gap-3">
          <Avatar key={account.id + account.avatarImage} name={account.displayName || account.label} email={account.email}
            contactPhotoUri={account.avatarImage} fallbackColor={account.avatarColor} disableFavicon />
          <label className="cursor-pointer rounded-md border border-border p-2 text-sm focus-within:ring-2 focus-within:ring-ring">
            {t('upload_image')}<input className="sr-only" type="file" accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={e => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          {account.avatarImage && <Button variant="ghost" size="sm" onClick={() => updateAccount(account.id, { avatarImage: undefined })}>{t('remove_image')}</Button>}
        </div>
      </SettingItem>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <SettingItem label={t('color')} description={t('color_description')}>
        <input aria-label={t('color')} type="color" value={account.avatarColor}
          onChange={e => updateAccount(account.id, { avatarColor: e.target.value })} className="h-10 w-16 cursor-pointer" />
      </SettingItem>
      <SettingItem label={t('theme')} description={t('theme_description')}>
        <select aria-label={t('theme')} value={themeId ?? ''} className="max-w-60 rounded-md border border-border bg-background p-2 text-sm"
          onChange={e => {
            const id = e.target.value || null;
            if (account.id === activeId) useThemeStore.getState().activateTheme(id);
            else useSettingsStore.setState(s => ({ accountThemes: { ...s.accountThemes, [account.id]: {
              theme: s.accountThemes[account.id]?.theme ?? 'system', activeThemeId: id,
            } } }));
          }}>
          <option value="">{t('default_theme')}</option>
          {themes.filter(theme => theme.enabled).map(theme => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
        </select>
      </SettingItem>
    </SettingsSection>
  </div>;
}
