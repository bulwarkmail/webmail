'use client';

import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { KeyRound } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { useConfig } from '@/hooks/use-config';
import { useFocusTrap } from '@/hooks/use-focus-trap';
import { productName } from '@/lib/product-name';
import { appPasswordDescription } from '@/lib/plugin-secrets/credentials';
import { appPasswordRights, type RightArea } from '@/lib/plugin-secrets/app-password-permissions';
import { useAuthStore } from '@/stores/auth-store';
import {
  currentConnect,
  originFromInput,
  saveCredential,
  subscribeConnect,
  type SaveCredentialInput,
} from '@/lib/plugin-sandbox/connect-dialog';
import { ModalWindow } from '@/components/ui/dialog-surface';

/**
 * The host's own "Connect account" dialog (see lib/plugin-sandbox/connect-dialog.ts).
 * Everything here is rendered by the host: the plugin can't change the text,
 * and what the user types goes to the server, never to the plugin.
 */
export function PluginConnectDialog() {
  const request = useSyncExternalStore(subscribeConnect, currentConnect, () => null);
  const t = useTranslations('plugins.connect');
  const appName = productName(useConfig().appName);
  const account = useAuthStore((s) => s.username) ?? '';
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const titleId = useId();
  const [server, setServer] = useState('');
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setServer(request?.suggestedOrigin ?? '');
    setUsername(request?.suggestedUsername ?? '');
    setSecret('');
    setError(null);
    setSaving(false);
  }, [request?.id, request?.suggestedOrigin, request?.suggestedUsername]);

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') request.resolve({ connected: false });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request]);

  // Tab stays in the dialog, the first field takes the focus, and the focus
  // goes back to where it was when the dialog closes. (Escape is the
  // listener above.)
  const panelRef = useFocusTrap({
    isActive: !!request,
    restoreFocus: true,
    initialFocus: () => panelRef.current?.querySelector<HTMLElement>('input:not(:disabled)'),
  });

  if (!request) return null;

  const { spec, mode, pluginName } = request;
  // The server makes an app password on the account the user is signed in
  // to: nothing to type, and that account's server is the origin.
  const appPassword = mode === 'appPassword';
  const fixedOrigin = spec.origin ?? (appPassword && serverUrl ? originFromInput(serverUrl) ?? undefined : undefined);
  const needsUsername = mode === 'password' && spec.inject.type === 'basic';
  const needsSecret = mode === 'password' && spec.inject.type !== 'none';
  const origin = fixedOrigin ?? originFromInput(server);
  const canSubmit = (appPassword || !!origin) && (!needsSecret || !!secret) && (!needsUsername || !!username.trim()) && !saving;

  const submit = async () => {
    const base = { pluginId: request.pluginId, credentialId: request.credentialId, label: spec.label };
    const input: SaveCredentialInput | null = appPassword
      ? { ...base, appPassword: true }
      : origin
        ? {
          ...base,
          origin,
          inject: spec.inject,
          ...(needsUsername ? { username: username.trim() } : {}),
          ...(needsSecret ? { secret } : {}),
        }
        : null;
    if (!input) {
      setError(t('error_server'));
      return;
    }
    setSaving(true);
    setError(null);
    const failure = await saveCredential(input);
    setSaving(false);
    if (failure) {
      setError(t('error_save', { error: failure }));
      return;
    }
    request.resolve({ connected: mode !== 'signin', ...(origin ? { origin } : {}) });
  };

  // What the app password may do, as the manifest lists it: the user agrees
  // to exactly that.
  const rights = appPassword && Array.isArray(spec.appPassword?.permissions) ? appPasswordRights(spec.appPassword.permissions) : null;
  const rightText = (area: RightArea, access: 'read' | 'change'): string => {
    switch (area) {
      case 'mail': return access === 'read' ? t('right_mail_read') : t('right_mail_change');
      case 'send': return t('right_send');
      case 'calendars': return access === 'read' ? t('right_calendars_read') : t('right_calendars_change');
      case 'contacts': return access === 'read' ? t('right_contacts_read') : t('right_contacts_change');
      case 'files': return access === 'read' ? t('right_files_read') : t('right_files_change');
      case 'directory': return t('right_directory');
    }
  };
  const host = origin ? new URL(origin).host : null;
  const intro = appPassword
    ? t('intro_app_password', { name: pluginName, account, description: appPasswordDescription(pluginName), appName })
    : mode === 'signin'
      ? t('intro_signin', { name: pluginName, label: spec.label, appName })
      : host
        ? t('intro_password', { name: pluginName, label: spec.label, host, appName })
        : t('intro_password_any', { name: pluginName, label: spec.label, appName });

  return (
    <ModalWindow title={t('title', { label: spec.label })} onClose={() => request.resolve({ connected: false })}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-modal-backdrop="" className="fixed inset-0 z-[100001] flex items-center justify-center bg-black/50 p-4"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) request.resolve({ connected: false });
        }}
        // Escape in the dialog, also in a window of its own, where the listener above
        // hears nothing. Stopped here, so it isn't answered twice over the page.
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          request.resolve({ connected: false });
        }}
      >
        <div ref={panelRef} className="flex w-full max-w-[440px] flex-col rounded-lg border border-border bg-popover text-popover-foreground shadow-xl">
          <form className="p-5" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <div className="mb-3 flex items-center gap-2">
              <KeyRound className="h-5 w-5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
              <h2 id={titleId} className="text-lg font-semibold text-foreground">{t('title', { label: spec.label })}</h2>
            </div>
            <p className="mb-4 text-sm text-muted-foreground [overflow-wrap:anywhere]">{intro}</p>
            {rights && (
              <div className="mb-4 text-sm">
                <p className="mb-1 font-medium text-foreground">{t('rights_heading')}</p>
                <ul className="list-disc space-y-0.5 ps-5 text-muted-foreground [overflow-wrap:anywhere]">
                  {rights.areas.map(({ area, access }) => <li key={area}>{rightText(area, access)}</li>)}
                  {rights.other.length > 0 && <li>{t('right_other', { names: rights.other.join(', ') })}</li>}
                </ul>
              </div>
            )}
            <div className="mb-4 flex flex-col gap-3">
              {!fixedOrigin && !appPassword && (
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium">{t('server')}</span>
                  {/* Not type="url": the browser would refuse "cloud.example.com"
                      without https://, which originFromInput adds. */}
                  <input
                    type="text"
                    inputMode="url"
                    autoCapitalize="off"
                    spellCheck={false}
                    value={server}
                    placeholder={t('server_hint')}
                    onChange={(e) => setServer(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm text-foreground outline-none"
                  />
                </label>
              )}
              {needsUsername && (
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium">{t('username')}</span>
                  <input
                    type="text"
                    value={username}
                    autoComplete="username"
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm text-foreground outline-none"
                  />
                </label>
              )}
              {needsSecret && (
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium">{t('secret')}</span>
                  <input
                    type="password"
                    value={secret}
                    autoComplete="off"
                    onChange={(e) => setSecret(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm text-foreground outline-none"
                  />
                </label>
              )}
              {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => request.resolve({ connected: false })}>{t('cancel')}</Button>
              <Button type="submit" disabled={!canSubmit} autoFocus={appPassword}>
                {saving ? t('saving') : mode === 'signin' ? t('continue') : t('connect')}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </ModalWindow>
  );
}
