'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { SettingsSection, SettingItem } from './settings-section';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';

export function AccountDisplaySettings() {
  const t = useTranslations('account_qol');
  const accounts = useAccountStore(s => s.accounts);
  const activeId = useAuthStore(s => s.activeAccountId);
  const updateAccount = useAccountStore(s => s.updateAccount);
  const [selectedId, setSelectedId] = useState(activeId ?? '');
  const [error, setError] = useState('');
  const account = accounts.find(a => a.id === selectedId) ?? accounts.find(a => a.id === activeId);
  if (!account) return null;

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
    </SettingsSection>
  </div>;
}
