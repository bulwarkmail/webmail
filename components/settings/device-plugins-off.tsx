"use client";

import { useTranslations } from 'next-intl';
import { SettingItem, SettingsSection } from './settings-section';

/**
 * The plugins part of the Add-ons page when the device's OS policy turns plugins
 * off: says so, where the list would be, instead of the section just not being there.
 */
export function DevicePluginsOff() {
  const t = useTranslations('desktop_policy');
  const tPlugins = useTranslations('plugins.settings');
  return (
    <SettingsSection title={tPlugins('title')}>
      <SettingItem label={t('plugins_label')} description={t('plugins_off')} locked>
        <span className="text-sm text-muted-foreground" data-testid="device-plugins-off">{t('off')}</span>
      </SettingItem>
    </SettingsSection>
  );
}
