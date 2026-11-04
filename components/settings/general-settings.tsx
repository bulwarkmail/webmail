"use client";

import { useTranslations } from 'next-intl';
import { useSettingsStore } from '@/stores/settings-store';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import { LanguageSettings } from './language-settings';
import { AppLockSettings } from './app-lock-settings';
import { DesktopKeystoreSettings } from './desktop-keystore-settings';
import { ProtocolHandlerSettings } from './protocol-handler-settings';
import { DesktopOsSettings } from './desktop-os-settings';
import { useTour } from '@/components/tour/tour-provider';
import { Button } from '@/components/ui/button';
import { PlayCircle } from '@/components/icons';
import { IS_LITE } from '@/lib/lite';
import { DesktopUpdateSettings } from './desktop-update-settings';
import { DesktopWindowSettings } from './desktop-window-settings';
import { DesktopDevToolsSettings } from './desktop-devtools-settings';

/**
 * The General page: language and time, which links the browser hands to
 * Bulwark (the former Default apps tab; its handler routes do not exist in
 * the static Lite build, and the desktop app has its own "Default mail app"
 * row instead), and the getting-started tour. Usage info and crash reports
 * are on the Privacy page.
 */
export function GeneralSettings({ supportsCalendar }: { supportsCalendar: boolean }) {
  const tTour = useTranslations('tour');
  const { showOnboardingOnNewDevices, updateSetting } = useSettingsStore();
  const { startTour, resetTourCompletion } = useTour();

  return (
    <div className="space-y-8">
      <LanguageSettings />

      <AppLockSettings />

      <DesktopOsSettings />

      {!IS_LITE && <ProtocolHandlerSettings supportsCalendar={supportsCalendar} />}
      <DesktopKeystoreSettings />

      <DesktopWindowSettings />
      <SettingsSection id="tour" title={tTour('settings_section')}>
        <SettingItem label={tTour('restart_title')} description={tTour('restart_desc')}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { resetTourCompletion(); startTour(); }}
            className="text-xs h-7"
          >
            <PlayCircle className="w-3.5 h-3.5 me-1" />
            {tTour('restart_button')}
          </Button>
        </SettingItem>

        <SettingItem label={tTour('show_on_new_devices_title')} description={tTour('show_on_new_devices_desc')} advanced>
          <ToggleSwitch
            checked={showOnboardingOnNewDevices}
            onChange={(checked) => updateSetting('showOnboardingOnNewDevices', checked)}
          />
        </SettingItem>
      </SettingsSection>

      {!IS_LITE && <DesktopUpdateSettings />}
      <DesktopDevToolsSettings />
    </div>
  );
}
