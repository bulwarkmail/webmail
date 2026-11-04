"use client";

import { useTranslations } from 'next-intl';
import { LogOut } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/stores/auth-store';
import { SettingItem } from './settings-section';

/**
 * "Sign out" on the Account page, so searching Settings for "logout" or
 * "sign out" leads somewhere. It does what the account menu's Sign out does.
 */
export function SignOutRow() {
  const tSidebar = useTranslations('sidebar');
  const t = useTranslations('uxs_structure.sign_out');
  const logout = useAuthStore((s) => s.logout);
  return (
    <SettingItem label={tSidebar('sign_out')} description={t('description')}>
      <Button variant="outline" size="sm" onClick={() => logout()} data-testid="settings-sign-out">
        <LogOut className="w-4 h-4 me-1" />
        {tSidebar('sign_out')}
      </Button>
    </SettingItem>
  );
}
