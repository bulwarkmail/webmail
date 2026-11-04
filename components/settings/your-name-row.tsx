'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Loader2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingItem } from './settings-section';
import { useAuthStore } from '@/stores/auth-store';
import { saveIdentityChanges } from '@/stores/identity-store';
import { toast } from '@/stores/toast-store';

/**
 * "Your name" on the Account page: the name on the primary sending address,
 * which is what recipients see next to it. It saves to that identity, so the
 * Account page and the address editor change the same name (settings-p2-2).
 * Without an identity there is nothing to save to, and the row only shows
 * the name the app knows.
 */
export function YourNameRow({ fallbackName }: { fallbackName?: string }) {
  const t = useTranslations('uxs2_ident.your_name');
  const tForm = useTranslations('identities.form');
  const tCommon = useTranslations('common');
  const client = useAuthStore((s) => s.client);
  const identity = useAuthStore((s) => s.primaryIdentity);
  const current = identity?.name ?? '';
  const [name, setName] = useState(current);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setName(current); }, [current]);

  if (!identity || !client) {
    return (
      <SettingItem label={t('label')} description={t('description')}>
        <span className="text-sm text-foreground">{fallbackName || tCommon('unknown')}</span>
      </SettingItem>
    );
  }

  const save = async () => {
    setSaving(true);
    try {
      if (!(await saveIdentityChanges(client, identity, { name: name.trim() }))) return;
      useAuthStore.getState().syncIdentities();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      toast.success(t('saved'));
    } catch (error) {
      toast.error(t('error'), error instanceof Error ? error.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingItem label={t('label')} description={t('description')}>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => { e.preventDefault(); void save(); }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={256}
          autoComplete="name"
          className="w-48"
          disabled={saving}
        />
        <Button type="submit" size="sm" disabled={saving || name.trim() === current.trim()}>
          {saved ? <Check className="w-4 h-4" /> : saving ? <Loader2 className="w-4 h-4 animate-spin" /> : tForm('save')}
        </Button>
      </form>
    </SettingItem>
  );
}
