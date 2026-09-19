'use client';

import { useEffect } from 'react';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useThemeStore } from '@/stores/theme-store';

export function AccountAccent() {
  const accounts = useAccountStore(s => s.accounts);
  const activeId = useAuthStore(s => s.activeAccountId);
  const viewingId = useEmailStore(s => s.viewingAccountId);
  const mode = useThemeStore(s => s.resolvedTheme);
  const account = accounts.find(a => a.id === (viewingId ?? activeId));
  const color = account?.avatarColor;
  useEffect(() => {
    if (!color || !/^#[\da-f]{6}$/i.test(color)) return;
    const root = document.documentElement;
    const props = {
      '--account-accent': color,
      '--color-sidebar': `color-mix(in srgb, ${color} ${mode === 'dark' ? '20%' : '12%'}, ${mode === 'dark' ? '#101014' : '#ffffff'})`,
      '--color-sidebar-accent': `color-mix(in srgb, ${color} 26%, ${mode === 'dark' ? '#101014' : '#ffffff'})`,
      '--color-selection': `color-mix(in srgb, ${color} 25%, ${mode === 'dark' ? '#101014' : '#ffffff'})`,
    };
    for (const [key, value] of Object.entries(props)) root.style.setProperty(key, value);
    root.dataset.accountAccent = 'true';
    return () => {
      for (const key of Object.keys(props)) root.style.removeProperty(key);
      delete root.dataset.accountAccent;
    };
  }, [color, mode]);
  return null;
}
