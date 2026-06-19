"use client";

import { useState, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useSettingsStore } from '@/stores/settings-store';
import { useConfig } from '@/hooks/use-config';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import { Button } from '@/components/ui/button';
import { usePolicyStore } from '@/stores/policy-store';
import { ALL_DEBUG_CATEGORIES } from '@/stores/settings-store';
import { ExternalLink } from 'lucide-react';
import { SpamSiegeGame } from './spam-siege-game';

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "0.0.0";
const GIT_COMMIT = process.env.NEXT_PUBLIC_GIT_COMMIT || "unknown";

export function AdvancedSettings() {
  const t = useTranslations('settings.advanced');
  const tCommon = useTranslations('common');
  const { debugMode, debugCategories, senderFavicons, senderAvatars, settingsSyncDisabled, updateSetting, resetToDefaults, exportSettings, importSettings } =
    useSettingsStore();
  const { settingsSyncEnabled } = useConfig();
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { isSettingLocked, isSettingHidden, isFeatureEnabled } = usePolicyStore();
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
        alert(t('../../settings.import_success'));
      } else {
        alert(t('../../settings.import_error'));
      }
    };
    reader.readAsText(file);
  };

  const handleReset = () => {
    if (showResetConfirm) {
      resetToDefaults();
      setShowResetConfirm(false);
      alert(t('../../settings.save_success'));
    } else {
      setShowResetConfirm(true);
      setTimeout(() => setShowResetConfirm(false), 5000);
    }
  };

  return (
    <>
      {showGame && <SpamSiegeGame onClose={() => setShowGame(false)} />}
      {/* About */}
      <div className="rounded-lg border border-border bg-card p-5 mb-6">
        <div className="flex items-center gap-4">
          <button onClick={handleLogoClick} className="flex items-center gap-4 flex-1 text-left focus:outline-none group/about cursor-pointer" aria-label="About">
            <div className="shrink-0">
              <img
                src="/branding/Bulwark_Logo_Color.svg"
                alt="Bulwark"
                className="w-12 h-12 object-contain dark:hidden group-hover/about:scale-105 group-active/about:scale-95 transition-transform"
              />
              <img
                src="/branding/Bulwark_Logo_White.svg"
                alt="Bulwark"
                className="w-12 h-12 object-contain hidden dark:block group-hover/about:scale-105 group-active/about:scale-95 transition-transform"
              />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">
                {t('about.title')}
              </p>
              <p className="text-xs text-muted-foreground group-hover/about:translate-x-0.5 group-active/about:translate-y-px transition-transform">
                v{APP_VERSION} <span className="text-muted-foreground/60">({GIT_COMMIT})</span>
              </p>
            </div>
          </button>
          <a
            href="https://github.com/bulwarkmail/webmail"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            GitHub <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </div>

    <SettingsSection title={t('title')} description={t('description')}>
      {/* Debug Mode */}
      {!isSettingHidden('debugMode') && isFeatureEnabled('debugModeEnabled') && (
      <SettingItem label={t('debug_mode.label')} description={t('debug_mode.description')} locked={isSettingLocked('debugMode')}>
        <ToggleSwitch checked={debugMode} onChange={(checked) => updateSetting('debugMode', checked)} />
      </SettingItem>
      )}

      {/* Debug Categories */}
      {debugMode && !isSettingHidden('debugMode') && isFeatureEnabled('debugModeEnabled') && (
        <div className="ml-4 border-l-2 border-muted pl-4 space-y-1">
          <p className="text-xs text-muted-foreground mb-2">{t('debug_categories.description')}</p>
          {ALL_DEBUG_CATEGORIES.map((cat) => (
            <SettingItem
              key={cat.id}
              label={t(`debug_categories.${cat.labelKey}`)}
              description={t(`debug_categories.${cat.labelKey}_description`)}
            >
              <ToggleSwitch
                checked={debugCategories?.[cat.id] !== false}
                onChange={(checked) => {
                  updateSetting('debugCategories', {
                    ...debugCategories,
                    [cat.id]: checked,
                  });
                }}
              />
            </SettingItem>
          ))}
        </div>
      )}

      {/* Settings Sync */}
      {settingsSyncEnabled && (
        <SettingItem label={t('settings_sync.label')} description={t('settings_sync.description')}>
          <ToggleSwitch checked={!settingsSyncDisabled} onChange={(checked) => updateSetting('settingsSyncDisabled', !checked)} />
        </SettingItem>
      )}

      {/* Sender Favicons (Experimental) */}
      <SettingItem label={t('sender_favicons.label')} description={t('sender_favicons.description')}>
        <ToggleSwitch checked={senderFavicons} onChange={(checked) => updateSetting('senderFavicons', checked)} />
      </SettingItem>

      {/* Sender Avatars / Libravatar (Experimental) */}
      <SettingItem label={t('sender_avatars.label')} description={t('sender_avatars.description')}>
        <ToggleSwitch checked={senderAvatars} onChange={(checked) => updateSetting('senderAvatars', checked)} />
      </SettingItem>

      {/* Export Settings */}
      {isFeatureEnabled('settingsExportEnabled') && (
      <SettingItem label={t('export_settings.label')} description={t('export_settings.description')}>
        <Button variant="outline" size="sm" onClick={handleExport}>
          {t('export_settings.button')}
        </Button>
      </SettingItem>
      )}

      {/* Import Settings */}
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

      {/* Reset Settings */}
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
    </>
  );
}
