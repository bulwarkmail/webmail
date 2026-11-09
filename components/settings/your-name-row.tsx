'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Loader2 } from '@/components/icons';
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
  const tCommon = useTranslations('common');
  const client = useAuthStore((s) => s.client);
  const identity = useAuthStore((s) => s.primaryIdentity);
  const current = identity?.name ?? '';
  const [name, setName] = useState(current);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setName(current); }, [current]);

  // Saves like the other fields here: on Enter, when the field loses the focus, and when
  // the page goes away with a change still typed (settings-p3-10). No Save button.
  const latest = useRef({ name, current, client, identity, t });
  latest.current = { name, current, client, identity, t };
  const savingName = useRef<string | null>(null);

  const save = useCallback(async (quiet = false) => {
    const { name: typed, current: stored, client: jmap, identity: primary, t: tr } = latest.current;
    const next = typed.trim();
    if (!jmap || !primary || next === stored.trim() || savingName.current === next) return;
    savingName.current = next;
    if (!quiet) setSaving(true);
    try {
      if (!(await saveIdentityChanges(jmap, primary, { name: next }))) return;
      useAuthStore.getState().syncIdentities();
      if (quiet) return;
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      toast.success(tr('saved'));
    } catch (error) {
      toast.error(tr('error'), error instanceof Error ? error.message : undefined);
    } finally {
      savingName.current = null;
      if (!quiet) setSaving(false);
    }
  }, []);

  // Leaving for another page: what's typed is saved, not dropped.
  useEffect(() => () => { void save(true); }, [save]);

  if (!identity || !client) {
    return (
      <SettingItem label={t('label')} description={t('description')}>
        <span className="text-sm text-foreground">{fallbackName || tCommon('unknown')}</span>
      </SettingItem>
    );
  }

  return (
    <SettingItem label={t('label')} description={t('description')}>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => { e.preventDefault(); void save(); }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => { void save(); }}
          maxLength={256}
          autoComplete="name"
          aria-label={t('label')}
          className="w-48"
          readOnly={saving}
        />
        <span className="w-4 h-4 flex items-center justify-center text-muted-foreground" aria-hidden="true">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4 text-success" /> : null}
        </span>
      </form>
    </SettingItem>
  );
}
