'use client';

import { useState, useEffect, useRef } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { usePluginStore } from '@/stores/plugin-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useConfig } from '@/hooks/use-config';
import { SettingsSection, ToggleSwitch } from './settings-section';
import { cn } from '@/lib/utils';
import { AlertTriangle, Puzzle, Lock, Server, Upload, Trash2, Loader2 } from '@/components/icons';
import { toast } from '@/stores/toast-store';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PluginPermissionList } from '@/components/plugins/plugin-permission-list';
import type { InstalledPlugin, PluginStatus, SettingFieldSchema } from '@/lib/plugin-types';
import { effectiveSettings } from '@/lib/plugin-settings';
import { PLUGIN_REFUSED_ERROR } from '@/lib/outgoing-hosts';
import { PLUGIN_POLICY_REFUSED_ERROR, pluginUploadsAllowedByDesktopPolicy, useDesktopPolicy } from '@/lib/desktop/policy';
import { OrgLockedNote } from './org-locked-note';
import { lookup } from '@/lib/plugin-sandbox/plugin-i18n';
import { forgetCredentials, listConnectedAccounts, type ConnectedAccount } from '@/lib/plugin-sandbox/connect-dialog';
import { forwardApprovals, revokeForwardApproval } from '@/lib/plugin-sandbox/forward-approvals';

const STATUS_COLORS: Record<PluginStatus, string> = {
  installed: 'bg-muted text-muted-foreground',
  enabled: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  running: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  disabled: 'bg-muted text-muted-foreground',
  error: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

/** Errors the store records as codes, so they can be shown translated. */
const ERROR_CODES = new Set(['user-plugins-off', 'approval-unavailable', 'approval-denied', 'approval-pending', 'auto-disabled']);

export function PluginsSettings() {
  const t = useTranslations('plugins.settings');
  const { plugins, installPlugin, uninstallPlugin, enablePlugin, disablePlugin, updatePluginSettings, initializePlugins, initialized } = usePluginStore();
  const { isFeatureEnabled, isPluginForceEnabled, fetchPolicy, loaded } = usePolicyStore();
  const { demoMode } = useConfig();
  const tDevicePolicyPage = useTranslations('desktop_policy');
  const devicePolicy = useDesktopPolicy();
  const [expandedPlugin, setExpandedPlugin] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<InstalledPlugin | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!loaded) {
      fetchPolicy();
    }
    initializePlugins();
  }, [fetchPolicy, initializePlugins, loaded]);

  // Listen for "expand this plugin" events fired by the settings search when
  // the user clicks a plugin-setting sub-result. Expanding the card mounts
  // the per-field rows so the highlight effect can find them.
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent<{ pluginId: string }>).detail?.pluginId;
      if (id) setExpandedPlugin(id);
    };
    window.addEventListener('settings-plugin-expand', handler);
    return () => window.removeEventListener('settings-plugin-expand', handler);
  }, []);

  if (!isFeatureEnabled('pluginsEnabled')) {
    return null;
  }

  const uploadsAllowed = isFeatureEnabled('pluginsUploadEnabled') && !demoMode && pluginUploadsAllowedByDesktopPolicy(devicePolicy);
  const requireApproval = isFeatureEnabled('requirePluginApproval');

  const handleToggle = async (plugin: InstalledPlugin) => {
    if (!initialized) return;

    if (plugin.forceEnabled || isPluginForceEnabled(plugin.id)) {
      toast.info(t('toast_forced', { name: plugin.name }));
      return;
    }

    if (plugin.enabled) {
      disablePlugin(plugin.id);
      toast.info(t('toast_disabled', { name: plugin.name }));
      return;
    }
    await enablePlugin(plugin.id);
    const after = usePluginStore.getState().plugins.find((p) => p.id === plugin.id);
    if (after?.enabled) {
      toast.success(t('toast_enabled', { name: plugin.name }));
    } else if (after?.error === 'approval-pending') {
      toast.info(t('toast_approval_requested', { name: plugin.name }));
    }
  };

  const handleInstall = async (file: File | undefined) => {
    if (!file) return;
    setInstalling(true);
    setInstallError(null);
    try {
      const result = await installPlugin(file);
      if (!result.success) {
        setInstallError(
          result.reason === 'device-policy' ? tDevicePolicyPage('install_refused')
            : result.reason === 'uploads-disabled' ? t('install_uploads_off')
            : result.reason === 'managed-id' ? t('install_managed_id')
            : t('install_invalid', { details: result.error ?? '' }),
        );
        return;
      }
      toast.success(result.approvalStatus === 'pending'
        ? t('toast_installed_pending')
        : t('toast_installed'));
    } finally {
      setInstalling(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  return (
    <SettingsSection
      id="plugins"
      title={t('title')}
      description={demoMode ? t('description_demo') : uploadsAllowed ? t('description_uploads') : t('description')}
    >
      {devicePolicy.PluginsMode.locked && devicePolicy.PluginsMode.value !== 'allowed' && (
        <div className="py-2" data-testid="plugins-device-policy">
          <p className="text-sm text-muted-foreground">
            {tDevicePolicyPage(devicePolicy.PluginsMode.value === 'off' ? 'plugins_off' : 'plugins_allowlist')}
          </p>
          <OrgLockedNote className="mt-1" />
        </div>
      )}
      {uploadsAllowed && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInput.current?.click()}
              disabled={installing}
            >
              {installing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {t('install_button')}
            </Button>
            <span className="text-xs text-muted-foreground">
              {requireApproval ? t('install_hint_approval') : t('install_hint')}
            </span>
            <input
              ref={fileInput}
              type="file"
              accept=".zip,application/zip"
              className="sr-only"
              aria-label={t('install_button')}
              onChange={(e) => handleInstall(e.target.files?.[0])}
            />
          </div>
          {installError && (
            <div role="alert" className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              <span className="break-words">{installError}</span>
            </div>
          )}
        </div>
      )}

      {plugins.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Puzzle className="mb-3 h-12 w-12 text-muted-foreground/30" />
          <p className="mb-1 text-sm text-muted-foreground">{t('empty_title')}</p>
          <p className="text-xs text-muted-foreground">
            {demoMode ? t('empty_demo') : uploadsAllowed ? t('empty_uploads') : t('empty_admin')}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {plugins.map(plugin => (
            <PluginCard
              key={plugin.id}
              plugin={plugin}
              isExpanded={expandedPlugin === plugin.id}
              isForceEnabled={plugin.forceEnabled || isPluginForceEnabled(plugin.id)}
              controlsDisabled={!initialized}
              onToggleExpand={() => setExpandedPlugin(expandedPlugin === plugin.id ? null : plugin.id)}
              onToggle={() => handleToggle(plugin)}
              onRemove={() => setRemoving(plugin)}
              onUpdateSettings={(settings) => updatePluginSettings(plugin.id, settings)}
            />
          ))}
        </div>
      )}

      {!initialized && plugins.length > 0 && (
        <p className="text-xs text-muted-foreground">{t('syncing')}</p>
      )}

      <ConfirmDialog
        isOpen={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) {
            uninstallPlugin(removing.id);
            toast.info(t('toast_removed', { name: removing.name }));
          }
          setRemoving(null);
        }}
        title={t('remove_title', { name: removing?.name ?? '' })}
        message={t('remove_message')}
        confirmText={t('remove_confirm')}
        variant="destructive"
      />
    </SettingsSection>
  );
}

// ─── Plugin Card ─────────────────────────────────────────────

interface PluginCardProps {
  plugin: InstalledPlugin;
  isExpanded: boolean;
  isForceEnabled: boolean;
  controlsDisabled: boolean;
  onToggleExpand: () => void;
  onToggle: () => void;
  onRemove: () => void;
  onUpdateSettings: (settings: Record<string, unknown>) => void;
}

function PluginCard({ plugin, isExpanded, isForceEnabled, controlsDisabled, onToggleExpand, onToggle, onRemove, onUpdateSettings }: PluginCardProps) {
  const t = useTranslations('plugins.settings');
  const tThirdParty = useTranslations('third_party');
  const tDevicePolicy = useTranslations('desktop_policy');
  const locale = useLocale();
  const isManaged = Boolean(plugin.managed);
  const awaiting = !isManaged && plugin.approvalStatus === 'pending';
  const denied = !isManaged && plugin.approvalStatus === 'denied';
  const errorText = plugin.error
    ? plugin.error === PLUGIN_POLICY_REFUSED_ERROR ? tDevicePolicy('plugin_refused')
      : plugin.error === PLUGIN_REFUSED_ERROR ? tThirdParty('plugin_refused')
      : ERROR_CODES.has(plugin.error) ? t(`error_${plugin.error.replace(/-/g, '_')}`) : plugin.error
    : null;

  return (
    <div
      data-search-label={plugin.name}
      className={cn(
        'rounded-lg border transition-colors',
        plugin.status === 'error' ? 'border-destructive/40' : 'border-border',
      )}
    >
      <div className="flex items-center gap-3 p-3">
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={onToggleExpand}
          aria-expanded={isExpanded}
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-medium text-foreground">{plugin.name}</span>
            {/* The switch says on or off; only a problem gets a word of its own. */}
            {plugin.status === 'error' && (
              <span className={cn('rounded-full px-1.5 py-0.5 text-[0.625rem] font-medium', STATUS_COLORS.error)}>
                {t('status_error')}
              </span>
            )}
            {isForceEnabled && (
              <span className="flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[0.625rem] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                <Lock className="h-2.5 w-2.5" /> {t('badge_forced')}
              </span>
            )}
            <span className={cn(
              'flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[0.625rem] font-medium',
              isManaged
                ? 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400'
                : 'bg-muted text-muted-foreground',
            )}>
              {isManaged && <Server className="h-2.5 w-2.5" />} {isManaged ? t('badge_managed') : t('badge_yours')}
            </span>
            {awaiting && (
              <span className="rounded-full bg-orange-100 px-1.5 py-0.5 text-[0.625rem] font-medium text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">
                {t('badge_awaiting')}
              </span>
            )}
          </div>
          {plugin.description && (
            <p data-testid="plugin-description" className="mt-0.5 line-clamp-2 text-xs text-foreground/80">{plugin.description}</p>
          )}
          <div className="mt-0.5 flex items-center gap-2">
            <span className="truncate text-xs text-muted-foreground">{plugin.author}</span>
            <span className="text-xs text-muted-foreground">v{plugin.version}</span>
          </div>
        </button>

        <div className="flex flex-shrink-0 items-center gap-2">
          <ToggleSwitch
            checked={plugin.enabled}
            onChange={onToggle}
            disabled={controlsDisabled || isForceEnabled || denied}
            ariaLabel={t('toggle_label', { name: plugin.name })}
          />
        </div>
      </div>

      {isExpanded && (
        <div className="space-y-3 border-t border-border p-3">
          {isForceEnabled && <p className="text-xs text-amber-600 dark:text-amber-400">{t('forced_note')}</p>}

          {errorText && (
            <div className="flex items-start gap-2 rounded bg-destructive/10 p-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              <span className="break-words">{errorText}</span>
            </div>
          )}

          <div>
            <span className="block text-xs font-medium text-foreground">
              {isManaged ? t('permissions_managed') : t('permissions')}
            </span>
            <div className="mt-1.5">
              <PluginPermissionList
                permissions={plugin.permissions}
                httpOrigins={plugin.httpOrigins}
                apiPostPaths={plugin.apiPostPaths}
                compact
              />
            </div>
          </div>

          {plugin.settingsSchema && Object.keys(plugin.settingsSchema).length > 0 && (
            <div className="space-y-2">
              <span className="block text-xs font-medium text-foreground">{t('settings')}</span>
              {Object.entries(plugin.settingsSchema).map(([key, schema]) => (
                <PluginSettingField
                  key={key}
                  fieldKey={key}
                  schema={schema}
                  translate={(text) => (plugin.locales ? lookup(plugin.locales, locale, text) ?? text : text)}
                  value={effectiveSettings(plugin)[key]}
                  onChange={(value) => onUpdateSettings({ [key]: value })}
                />
              ))}
            </div>
          )}

          {plugin.credentials && Object.values(plugin.credentials).some((c) => c.scope === 'user') && (
            <ConnectedAccounts pluginId={plugin.id} />
          )}

          {plugin.permissions.includes('email:forward') && <ForwardApprovals pluginId={plugin.id} />}

          {!isManaged && (
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" onClick={onRemove} className="text-destructive hover:text-destructive">
                <Trash2 className="h-4 w-4" />
                {t('remove')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Connected accounts ──────────────────────────────────────

/** Accounts the user connected for this plugin through the secret proxy. */
function ConnectedAccounts({ pluginId }: { pluginId: string }) {
  const t = useTranslations('plugins.settings');
  const [accounts, setAccounts] = useState<ConnectedAccount[] | null>(null);

  useEffect(() => {
    let live = true;
    void listConnectedAccounts(pluginId).then((list) => { if (live) setAccounts(list); });
    return () => { live = false; };
  }, [pluginId]);

  if (!accounts || accounts.length === 0) return null;

  const disconnect = async (account: ConnectedAccount) => {
    if (await forgetCredentials(pluginId, account.credentialId)) {
      setAccounts((list) => (list ?? []).filter((a) => a.credentialId !== account.credentialId));
    } else {
      toast.error(t('disconnect_failed', { label: account.label }));
    }
  };

  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-foreground">{t('accounts_heading')}</span>
      {accounts.map((account) => {
        const host = new URL(account.origin).host;
        return (
          <div key={account.credentialId} className="flex items-center justify-between gap-2 text-xs">
            <span className="min-w-0 truncate text-muted-foreground">
              {account.connected
                ? t('account_on', { label: account.username ? `${account.label} (${account.username})` : account.label, host })
                : t('account_waiting', { label: account.label, host })}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void disconnect(account)}>{t('disconnect')}</Button>
          </div>
        );
      })}
    </div>
  );
}

// ─── Forward addresses ───────────────────────────────────────

/** Addresses the user let this plugin forward mail to (api.email.forward). */
function ForwardApprovals({ pluginId }: { pluginId: string }) {
  const t = useTranslations('plugins.settings');
  const [addresses, setAddresses] = useState<string[]>([]);

  useEffect(() => {
    setAddresses(forwardApprovals(pluginId));
  }, [pluginId]);

  if (addresses.length === 0) return null;

  const remove = (address: string) => {
    revokeForwardApproval(pluginId, address);
    setAddresses(forwardApprovals(pluginId));
  };

  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-foreground">{t('forward_heading')}</span>
      <p className="text-[0.625rem] text-muted-foreground">{t('forward_hint')}</p>
      {addresses.map((address) => (
        <div key={address} className="flex items-center justify-between gap-2 text-xs">
          <span className="min-w-0 truncate text-muted-foreground">{address}</span>
          <Button variant="ghost" size="sm" onClick={() => remove(address)} aria-label={t('forward_remove_label', { address })}>
            {t('forward_remove')}
          </Button>
        </div>
      ))}
    </div>
  );
}

// ─── Auto-generated Setting Field ────────────────────────────

interface PluginSettingFieldProps {
  fieldKey: string;
  schema: SettingFieldSchema;
  /**
   * A label, description or option that names a key in the plugin's own
   * translations (manifest `locales`) is shown translated; other text as is.
   */
  translate?: (text: string) => string;
  value: unknown;
  onChange: (value: unknown) => void;
}

function PluginSettingField({ fieldKey, schema: raw, value, onChange, translate = (text) => text }: PluginSettingFieldProps) {
  const inputId = `plugin-setting-${fieldKey}`;
  const schema = { ...raw, label: translate(raw.label), ...(raw.description ? { description: translate(raw.description) } : {}) };
  switch (schema.type) {
    case 'boolean':
      return (
        <div data-search-label={schema.label} className="flex items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            <span className="block text-xs text-foreground">{schema.label}</span>
            {schema.description && <p className="text-[0.625rem] text-muted-foreground">{schema.description}</p>}
          </div>
          <ToggleSwitch checked={value as boolean} onChange={(v) => onChange(v)} ariaLabel={schema.label} />
        </div>
      );

    case 'select':
      return (
        <div data-search-label={schema.label} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="flex-1 min-w-40">
            <label htmlFor={inputId} className="block text-xs text-foreground">{schema.label}</label>
            {schema.description && <p className="text-[0.625rem] text-muted-foreground">{schema.description}</p>}
          </div>
          <select
            id={inputId}
            value={String(value)}
            onChange={(e) => onChange(e.target.value)}
            className="max-w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
          >
            {(Array.isArray(schema.options) ? schema.options : []).map(opt => (
              <option key={opt} value={opt}>{translate(opt)}</option>
            ))}
          </select>
        </div>
      );

    case 'string':
      return (
        <div data-search-label={schema.label}>
          <label htmlFor={inputId} className="block text-xs text-foreground">{schema.label}</label>
          {schema.description && <p className="text-[0.625rem] text-muted-foreground">{schema.description}</p>}
          <input
            id={inputId}
            type="text"
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
          />
        </div>
      );

    case 'number':
      return (
        <div data-search-label={schema.label} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="flex-1 min-w-40">
            <label htmlFor={inputId} className="block text-xs text-foreground">{schema.label}</label>
            {schema.description && <p className="text-[0.625rem] text-muted-foreground">{schema.description}</p>}
          </div>
          <input
            id={inputId}
            type="number"
            value={Number(value ?? schema.default ?? 0)}
            min={schema.min}
            max={schema.max}
            onChange={(e) => onChange(Number(e.target.value))}
            className="w-20 rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
          />
        </div>
      );

    default:
      return null;
  }
}
