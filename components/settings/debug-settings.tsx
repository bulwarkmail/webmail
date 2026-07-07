"use client";

import { useTranslations } from 'next-intl';
import { useSettingsStore, ALL_DEBUG_CATEGORIES } from '@/stores/settings-store';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import { usePolicyStore } from '@/stores/policy-store';

export function DebugSettings() {
  const t = useTranslations('settings.advanced');
  const { debugMode, debugCategories, updateSetting } = useSettingsStore();
  const { isSettingLocked, isSettingHidden, isFeatureEnabled } = usePolicyStore();

  if (isSettingHidden('debugMode') || !isFeatureEnabled('debugModeEnabled')) {
    return (
      <SettingsSection title={t('debug_mode.label')} description={t('debug_mode.description')}>
        <p className="text-sm text-muted-foreground py-2">{t('debug_mode.description')}</p>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title={t('debug_mode.label')} description={t('debug_mode.description')}>
      <SettingItem label={t('debug_mode.label')} description={t('debug_mode.description')} locked={isSettingLocked('debugMode')}>
        <ToggleSwitch checked={debugMode} onChange={(checked) => updateSetting('debugMode', checked)} />
      </SettingItem>

      {debugMode && (
        <div className="ms-4 border-s-2 border-muted ps-4 space-y-1">
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
    </SettingsSection>
  );
}
