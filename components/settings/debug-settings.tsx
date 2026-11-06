"use client";

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { getDesktopBridge } from '@/lib/desktop/bridge';
import { DesktopDevToolsSettings } from './desktop-devtools-settings';
import { useSettingsStore, ALL_DEBUG_CATEGORIES } from '@/stores/settings-store';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import { usePolicyStore } from '@/stores/policy-store';

/**
 * Debugging, on the Troubleshooting page: detailed logging where the admin
 * allows it, and in the desktop app its developer tools. Advanced, like the
 * whole page.
 */
export function DebugSettings() {
  const t = useTranslations('settings.advanced');
  const { debugMode, debugCategories, updateSetting } = useSettingsStore();
  const { isSettingLocked, isSettingHidden, isFeatureEnabled } = usePolicyStore();
  const [devTools, setDevTools] = useState(false);
  useEffect(() => setDevTools(!!getDesktopBridge()?.devTools), []);

  // Nothing to show when the admin keeps debug logging off, outside the desktop app.
  const logging = !isSettingHidden('debugMode') && isFeatureEnabled('debugModeEnabled');
  if (!logging && !devTools) return null;

  return (
    <SettingsSection id="debug" advanced title={t('debug_mode.label')} description={logging ? t('debug_mode.description') : undefined}>
      {devTools && <DesktopDevToolsSettings bare />}
      {logging && (
      <SettingItem label={t('debug_mode.toggle')} description={t('debug_mode.description')} locked={isSettingLocked('debugMode')}>
        <ToggleSwitch checked={debugMode} onChange={(checked) => updateSetting('debugMode', checked)} />
      </SettingItem>
      )}

      {logging && debugMode && (
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
