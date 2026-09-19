'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAccountStore } from '@/stores/account-store';
import { SettingsSection } from './settings-section';
import { Button } from '@/components/ui/button';
import { AccountTransferDialog } from '@/components/email/account-transfer-dialog';

export function AccountMigrationSettings() {
  const t = useTranslations('account_transfer');
  const accounts = useAccountStore(s => s.accounts);
  const [open, setOpen] = useState(false);
  if (accounts.length < 2) return null;
  return <SettingsSection title={t('title')} description={t('bulk_description')}>
    <Button variant="outline" onClick={() => setOpen(true)}>{t('open')}</Button>
    {open && <AccountTransferDialog onClose={() => setOpen(false)} />}
  </SettingsSection>;
}
