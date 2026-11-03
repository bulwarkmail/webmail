"use client";

import { useTranslations } from 'next-intl';
import { useSettingsStore } from '@/stores/settings-store';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import { LanguageSettings } from './language-settings';
import { DesktopKeystoreSettings } from './desktop-keystore-settings';
import { ProtocolHandlerSettings } from './protocol-handler-settings';
import { useTour } from '@/components/tour/tour-provider';
import { Button } from '@/components/ui/button';
import { PlayCircle } from '@/components/icons';
import { IS_LITE } from '@/lib/lite';

/**
 * The General page: language and time, which links the browser hands to
 * Bulwark (the former Default apps tab; its handler routes do not exist in
 * the static Lite build), and the getting-started tour.
 */
export function GeneralSettings({ supportsCalendar }: { supportsCalendar: boolean }) {
  const tTour = useTranslations('tour');
  const { showOnboardingOnNewDevices, updateSetting } = useSettingsStore();
  const { startTour, resetTourCompletion } = useTour();

  return (
    <div className="space-y-8">
      <LanguageSettings />

      {!IS_LITE && <ProtocolHandlerSettings supportsCalendar={supportsCalendar} />}
      <DesktopKeystoreSettings />

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
    </div>
  );
}
