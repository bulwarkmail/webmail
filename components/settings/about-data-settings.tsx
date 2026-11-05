"use client";

import { useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useSettingsStore } from '@/stores/settings-store';
import { useConfig } from '@/hooks/use-config';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import { Button } from '@/components/ui/button';
import { usePolicyStore } from '@/stores/policy-store';
import { useUpdateStore } from '@/stores/update-store';
import { ExternalLink } from '@/components/icons';
import { cn } from '@/lib/utils';
import { getPathPrefix, withBasePath } from '@/lib/browser-navigation';
import { clearCachedData } from '@/lib/clear-cached-data';
import { SpamSiegeGame } from './spam-siege-game';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/stores/toast-store';
import { DebugSettings } from './debug-settings';
import { MailBackupSettings } from '@/components/mail-transfer/mail-backup-settings';
import { productName } from '@/lib/product-name';
import { isDesktopApp } from '@/lib/desktop/bridge';

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "0.0.0";
const GIT_COMMIT = process.env.NEXT_PUBLIC_GIT_COMMIT || "unknown";
const UPSTREAM_SOURCE_URL = "https://github.com/bulwarkmail/webmail";

function VersionUpdateTag() {
  const status = useUpdateStore((s) => s.status);
  const startPolling = useUpdateStore((s) => s.startPolling);

  useEffect(() => {
    startPolling();
  }, [startPolling]);

  if (!status?.updateAvailable) return null;
  if (status.severity === 'unknown' || status.severity === 'none') return null;

  const important = status.severity === 'security' || status.severity === 'deprecated';
  const label =
    status.severity === 'security' ? 'security'
    : status.severity === 'deprecated' ? 'deprecated'
    : status.latest ?? 'update';

  return (
    <span
      className={cn(
        "ms-2 inline-flex items-center rounded-full px-1.5 py-0.5 text-[0.625rem] font-medium align-middle",
        important
          ? "bg-red-500/15 text-red-700 dark:text-red-300"
          : "bg-amber-500/15 text-amber-700 dark:text-amber-300",
      )}
    >
      {important ? label : `update: ${label}`}
    </span>
  );
}

/**
 * The About card, on Settings > About and at the foot of the admin's list: logo, version with the
 * update tag, and the source link. A modified build must offer its own
 * source (AGPL-3.0 §13), so a configured URL replaces the upstream link.
 * Three clicks on the logo open Spam Siege, as before.
 */
export function AboutFooter() {
  const t = useTranslations('settings.advanced');
  const { sourceCodeUrl, appName, appLogoLightUrl, appLogoDarkUrl } = useConfig();
  // A branded deployment (APP_NAME / APP_LOGO_*) shows its own name and logo
  // here; without them the card keeps the Bulwark mark and title. (#1160)
  const branded = appName && appName !== 'Webmail';
  const logoLight = withBasePath(appLogoLightUrl || appLogoDarkUrl) || `${getPathPrefix()}/branding/Bulwark_Logo_Color.svg`;
  const logoDark = withBasePath(appLogoDarkUrl || appLogoLightUrl) || `${getPathPrefix()}/branding/Bulwark_Logo_White.svg`;
  const [showGame, setShowGame] = useState(false);
  const logoClickCount = useRef(0);
  const logoClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleLogoClick = () => {
    logoClickCount.current++;
    if (logoClickTimer.current) clearTimeout(logoClickTimer.current);
    if (logoClickCount.current >= 3) {
      logoClickCount.current = 0;
      setShowGame(true);
    } else {
      logoClickTimer.current = setTimeout(() => { logoClickCount.current = 0; }, 2000);
    }
  };

  return (
    <div data-testid="settings-about" className="px-3 py-2">
      {showGame && <SpamSiegeGame onClose={() => setShowGame(false)} />}
      <div className="flex items-center gap-3">
        {/* Named by what it shows (app name and version), with the focus
            ring every other stop in the sidebar has. */}
        <button
          type="button"
          onClick={handleLogoClick}
          className="flex items-center gap-3 flex-1 min-w-0 text-start rounded-md focus-visible:outline-hidden group/about cursor-pointer"
        >
          <img
            src={logoLight}
            alt={branded ? appName : 'Bulwark'}
            className="w-7 h-7 shrink-0 object-contain dark:hidden group-active/about:scale-95 transition-transform"
          />
          <img
            src={logoDark}
            alt={branded ? appName : 'Bulwark'}
            className="w-7 h-7 shrink-0 object-contain hidden dark:block group-active/about:scale-95 transition-transform"
          />
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground truncate">{branded ? appName : t('about.title')}</p>
            <p className="text-[0.6875rem] text-muted-foreground truncate">
              v{APP_VERSION} <span className="text-muted-foreground">({GIT_COMMIT})</span>
              <VersionUpdateTag />
            </p>
          </div>
        </button>
        <a
          href={sourceCodeUrl || UPSTREAM_SOURCE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 inline-flex items-center gap-1 text-[0.6875rem] text-muted-foreground hover:text-foreground transition-colors"
        >
          {sourceCodeUrl ? t('about.source_code') : 'GitHub'} <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </div>
  );
}

/**
 * Settings > About, the last entry of the page list: the About card with the
 * version and the source link. It was in the sidebar's footer, where it took
 * room from the page list on short screens.
 */
export function AboutSettings() {
  const t = useTranslations('uxs_structure.about');
  const appName = productName(useConfig().appName);
  return (
    <div className="space-y-8">
      <SettingsSection id="about" title={t('title', { appName })}>
        <div className="-mx-3">
          <AboutFooter />
        </div>
      </SettingsSection>
    </div>
  );
}

/**
 * The Backup & reset page: keep settings (sync, export, import), bring mail
 * in and save it as files, fix a stale view, start over, and (Advanced, where
 * the admin allows it) debug logging. Offline has a page of its own.
 */
export function AboutDataSettings() {
  const t = useTranslations('settings.advanced');
  const tSettings = useTranslations('settings');
  const { settingsSyncDisabled, updateSetting, resetToDefaults, exportSettings, importSettings } =
    useSettingsStore();
  const { settingsSyncEnabled } = useConfig();
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showRefreshConfirm, setShowRefreshConfirm] = useState(false);
  const tP2 = useTranslations('uxp2_settings');
  const tWords = useTranslations('ux_p3_words');
  // The app has no "other browsers" (settings-p2-4), and its Backup says only what it
  // does: a settings file to export and import (settings-p3-9).
  const [inApp, setInApp] = useState(false);
  useEffect(() => setInApp(isDesktopApp()), []);
  // A reset keeps the sync choice, so the other devices change only when sync is on (settings-p2-18).
  const syncOn = settingsSyncEnabled && !settingsSyncDisabled;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { isFeatureEnabled } = usePolicyStore();
  const handleExport = () => {
    const settingsJson = exportSettings();
    const blob = new Blob([settingsJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `webmail-settings-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImport = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const json = event.target?.result as string;
      const success = importSettings(json);
      if (success) {
        toast.success(tSettings('import_success'));
      } else {
        toast.error(tSettings('import_error'));
      }
    };
    reader.readAsText(file);
    // The same file can be picked again after fixing it.
    e.target.value = '';
  };

  const handleReset = () => {
    resetToDefaults();
    toast.success(t('reset_settings.done'));
  };

  return (
    <div className="space-y-8">
      <SettingsSection id="backup" title={t('sections.backup')} description={inApp ? tWords('backup_app') : t('sections.backup_description')}>
        {settingsSyncEnabled && (
          <SettingItem label={t('settings_sync.label')} description={inApp ? tWords('sync_app') : t('settings_sync.description')} term="sync">
            <ToggleSwitch checked={!settingsSyncDisabled} onChange={(checked) => updateSetting('settingsSyncDisabled', !checked)} />
          </SettingItem>
        )}

        {isFeatureEnabled('settingsExportEnabled') && (
        <SettingItem label={t('export_settings.label')} description={t('export_settings.description')}>
          <Button variant="outline" size="sm" onClick={handleExport}>
            {t('export_settings.button')}
          </Button>
        </SettingItem>
        )}

        {isFeatureEnabled('settingsExportEnabled') && (
        <SettingItem label={t('import_settings.label')} description={t('import_settings.description')}>
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              onChange={handleFileChange}
              className="hidden"
            />
            <Button variant="outline" size="sm" onClick={handleImport}>
              {t('import_settings.button')}
            </Button>
          </>
        </SettingItem>
        )}
      </SettingsSection>

      <MailBackupSettings />

      <SettingsSection id="fix" title={t('sections.fix')} description={t('sections.fix_description')}>
        <SettingItem label={t('refresh_cache.label')} description={t('refresh_cache.description')} term="cache">
          <Button variant="outline" size="sm" onClick={() => setShowRefreshConfirm(true)}>
            {t('refresh_cache.button')}
          </Button>
        </SettingItem>

        <SettingItem label={t('reset_settings.label')} description={t('reset_settings.description')}>
          <Button variant="outline" size="sm" onClick={() => setShowResetConfirm(true)}>
            {t('reset_settings.button')}
          </Button>
        </SettingItem>
      </SettingsSection>

      <ConfirmDialog
        isOpen={showRefreshConfirm}
        onClose={() => setShowRefreshConfirm(false)}
        onConfirm={() => clearCachedData() /* reloads the page */}
        title={t('refresh_cache.confirm_title')}
        message={t('refresh_cache.description')}
        confirmText={t('refresh_cache.button')}
      />
      <ConfirmDialog
        isOpen={showResetConfirm}
        onClose={() => setShowResetConfirm(false)}
        onConfirm={handleReset}
        title={t('reset_settings.confirm_title')}
        message={`${tP2('reset.message')} ${syncOn ? tP2('reset.sync_on') : tP2('reset.sync_off')}`}
        confirmText={t('reset_settings.button')}
        variant="destructive"
      />

      <DebugSettings />
    </div>
  );
}
