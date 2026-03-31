"use client";

import { useState, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useSettingsStore } from '@/stores/settings-store';
import { useConfig } from '@/hooks/use-config';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import { Button } from '@/components/ui/button';
import { usePolicyStore } from '@/stores/policy-store';
import { ALL_DEBUG_CATEGORIES } from '@/stores/settings-store';

export function AdvancedSettings() {
  const t = useTranslations('settings.advanced');
  const tCommon = useTranslations('common');
  const { debugMode, debugCategories, senderFavicons, settingsSyncDisabled, updateSetting, resetToDefaults, exportSettings, importSettings } =
    useSettingsStore();
  const { settingsSyncEnabled } = useConfig();
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { isSettingLocked, isSettingHidden, isFeatureEnabled } = usePolicyStore();

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
  );
}
