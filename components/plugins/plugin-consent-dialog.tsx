'use client';

// Modal shown the first time a plugin is enabled, listing every permission
// the plugin's manifest declares. Accepting persists the grant on the
// plugin record so future enables skip the prompt.

import React, { useId, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { head, resolveHead, subscribe } from '@/lib/plugin-sandbox/consent';
import { HIGH_RISK_PERMISSIONS } from '@/lib/plugin-sandbox/permission-text';
import { useFocusTrap } from '@/hooks/use-focus-trap';
import { Button } from '@/components/ui/button';
import { PluginPermissionList } from './plugin-permission-list';
import { ModalWindow } from '@/components/ui/dialog-surface';

export function PluginConsentDialog(): React.JSX.Element | null {
  const current = useSyncExternalStore(subscribe, head, () => null);
  const t = useTranslations('plugins.consent');
  const id = useId();
  const dialogRef = useFocusTrap({
    isActive: !!current,
    onEscape: () => resolveHead(false),
    restoreFocus: true,
  });

  if (!current) return null;
  const risky = current.permissions.some((p) => HIGH_RISK_PERMISSIONS.has(p));

  return (
    <ModalWindow title={t('title', { name: current.pluginName })} onClose={() => resolveHead(false)}>
      <div
        data-modal-backdrop="" className="fixed inset-0 z-[100001] flex items-center justify-center bg-black/50 p-4"
        onMouseDown={(e) => { if (e.target === e.currentTarget) resolveHead(false); }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${id}-title`}
          className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-lg border border-border bg-background shadow-xl"
        >
          <div className="p-5 pb-3">
            <h2 id={`${id}-title`} className="text-lg font-semibold text-foreground">
              {t('title', { name: current.pluginName })}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('intro')}</p>
            {risky && (
              <p className="mt-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-foreground">{t('high_risk_note')}</p>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5">
            <PluginPermissionList
              permissions={current.permissions}
              httpOrigins={current.httpOrigins}
              apiPostPaths={current.apiPostPaths}
            />
          </div>
          <div className="flex flex-col gap-3 p-5 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-xs text-muted-foreground">{t('revoke_hint')}</span>
            <div className="flex justify-end gap-2">
              <Button variant="outline" className="whitespace-nowrap" onClick={() => resolveHead(false)}>{t('deny')}</Button>
              <Button autoFocus className="whitespace-nowrap" onClick={() => resolveHead(true)}>{t('allow')}</Button>
            </div>
          </div>
        </div>
      </div>
    </ModalWindow>
  );
}
