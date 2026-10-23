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
import { DebugSettings } from './debug-settings';
import { AboutAttribution } from '@/components/xenaxio/about-attribution';
import { productLogoUrls } from '@/lib/xenaxio/portal-config';

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
        "ms-2 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium align-middle",
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
 * The About card, in the settings sidebar's footer: logo, version with the
 * update tag, and the source link. A modified build must offer its own
 * source (AGPL-3.0 §13), so a configured URL replaces the upstream link.
 * Three clicks on the logo open Spam Siege, as before.
 */
export function AboutFooter() {
  const t = useTranslations('settings.advanced');
  const config = useConfig();
  const { sourceCodeUrl, appName } = config;
  // xenaxio: the card names the product, so it shows the product's logo, not the company's.
  const product = productLogoUrls();
  const appLogoLightUrl = product ? product.light : config.appLogoLightUrl;
  const appLogoDarkUrl = product ? product.dark : config.appLogoDarkUrl;
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
        <button onClick={handleLogoClick} className="flex items-center gap-3 flex-1 min-w-0 text-start focus:outline-none group/about cursor-pointer" aria-label="About">
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
            <p className="text-[11px] text-muted-foreground truncate">
              v{APP_VERSION} <span className="text-muted-foreground/60">({GIT_COMMIT})</span>
              <VersionUpdateTag />
            </p>
          </div>
        </button>
        <a
          href={sourceCodeUrl || UPSTREAM_SOURCE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {sourceCodeUrl ? t('about.source_code') : 'GitHub'} <ExternalLink className="w-3 h-3" />
        </a>
      </div>
      <AboutAttribution />
    </div>
  );
}

/**
 * The Backup & reset page: keep settings (sync, export, import), fix a stale
 * view, start over, and (Advanced, where the admin allows it) debug logging.
 * The About card moved to the settings sidebar's footer.
 */
export function AboutDataSettings() {
  const t = useTranslations('settings.advanced');
  const tCommon = useTranslations('common');
  const tSettings = useTranslations('settings');
  const { settingsSyncDisabled, updateSetting, resetToDefaults, exportSettings, importSettings } =
    useSettingsStore();
  const { settingsSyncEnabled } = useConfig();
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showRefreshConfirm, setShowRefreshConfirm] = useState(false);
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
        alert(tSettings('import_success'));
      } else {
        alert(tSettings('import_error'));
      }
    };
    reader.readAsText(file);
  };

  const handleRefreshCache = () => {
    if (showRefreshConfirm) {
      clearCachedData(); // reloads the page
    } else {
      setShowRefreshConfirm(true);
      setTimeout(() => setShowRefreshConfirm(false), 5000);
    }
  };

  const handleReset = () => {
    if (showResetConfirm) {
      resetToDefaults();
      setShowResetConfirm(false);
      alert(tSettings('save_success'));
    } else {
      setShowResetConfirm(true);
      setTimeout(() => setShowResetConfirm(false), 5000);
    }
  };

  return (
    <div className="space-y-8">
      <SettingsSection id="backup" title={t('sections.backup')} description={t('sections.backup_description')}>
        {settingsSyncEnabled && (
          <SettingItem label={t('settings_sync.label')} description={t('settings_sync.description')}>
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

      <SettingsSection id="fix" title={t('sections.fix')} description={t('sections.fix_description')}>
        <SettingItem label={t('refresh_cache.label')} description={t('refresh_cache.description')}>
          <Button
            variant={showRefreshConfirm ? 'default' : 'outline'}
            size="sm"
            onClick={handleRefreshCache}
          >
            {showRefreshConfirm ? tCommon('yes') : t('refresh_cache.button')}
          </Button>
        </SettingItem>

        <SettingItem label={t('reset_settings.label')} description={t('reset_settings.description')}>
          <Button
            variant={showResetConfirm ? 'destructive' : 'outline'}
            size="sm"
            onClick={handleReset}
          >
            {showResetConfirm ? tCommon('yes') : t('reset_settings.button')}
          </Button>
        </SettingItem>
      </SettingsSection>

      <DebugSettings />
    </div>
  );
}
