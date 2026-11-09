"use client";

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { RadioGroup, Select, SettingItem, ToggleSwitch } from '@/components/settings/settings-section';
import { useSettingsStore } from '@/stores/settings-store';
import { usePolicyStore } from '@/stores/policy-store';
import { FONT_SIZES, type FontSize } from '@/lib/accessibility-settings';
import { ACCESSIBILITY_PRESET_IDS, presetChanges, type AccessibilityPresetId, type PresetChange } from '@/lib/accessibility-presets';
import { noteSignedOutChoice } from '@/lib/signed-out-choices';

type SettingKey = Parameters<ReturnType<typeof useSettingsStore.getState>['updateSetting']>[0];

/** The quick accessibility panel itself, opened by AccessibilityQuickPanelHost. */
export function QuickPanel({ isOpen, onClose, signedIn }: { isOpen: boolean; onClose: () => void; signedIn: boolean }) {
  const t = useTranslations('accessibility_panel');
  const tA = useTranslations('settings.accessibility');
  const settings = useSettingsStore();
  const { isSettingLocked } = usePolicyStore();
  const [applied, setApplied] = useState<{ id: AccessibilityPresetId; changes: PresetChange[] } | null>(null);
  const set = (key: string, value: unknown) => {
    settings.updateSetting(key as SettingKey, value as never);
    // Chosen on the sign-in page: still there once signed in (lib/signed-out-choices.ts).
    if (!signedIn) noteSignedOutChoice(key);
  };
  const systemToggle = (key: 'reduceMotion' | 'largeTargets') => (
    <RadioGroup
      value={settings[key]}
      onChange={(value) => set(key, value)}
      options={[
        { value: 'system', label: tA('system') },
        { value: 'on', label: tA('on') },
        { value: 'off', label: tA('off') },
      ]}
    />
  );

  const applyPreset = (id: AccessibilityPresetId) => {
    const changes = presetChanges(id, useSettingsStore.getState() as unknown as Record<string, unknown>, isSettingLocked);
    for (const change of changes) set(change.key, change.to);
    setApplied({ id, changes });
  };

  const router = useRouter();
  const openSettings = () => {
    onClose();
    router.push('/settings/accessibility');
  };

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={t('title')} description={t('description')} size="md" testId="accessibility-panel">
      {/* Keeps the focus outline while it is off elsewhere (accessibility.css). */}
      <div className="space-y-1" data-keep-focus-outline>
        {/* What changes how a page looks or is used, the sign-in page included.
            The rest is on Settings > Accessibility. */}
        <SettingItem label={tA('text_size.label')} locked={isSettingLocked('fontSize')}>
          <Select
            value={settings.fontSize}
            onChange={(value) => set('fontSize', value as FontSize)}
            options={FONT_SIZES.map((size) => ({ value: size, label: tA(`text_size.${size}`) }))}
          />
        </SettingItem>
        <SettingItem label={tA('font.label')} locked={isSettingLocked('appFont')}>
          <Select
            value={settings.appFont}
            onChange={(value) => set('appFont', value)}
            options={[
              { value: 'default', label: tA('font.default') },
              { value: 'atkinson', label: 'Atkinson Hyperlegible' },
              { value: 'lexend', label: 'Lexend' },
              { value: 'opendyslexic', label: 'OpenDyslexic' },
            ]}
          />
        </SettingItem>
        <SettingItem label={tA('contrast.label')} locked={isSettingLocked('contrast')}>
          <RadioGroup
            value={settings.contrast}
            onChange={(value) => set('contrast', value)}
            options={[
              { value: 'system', label: tA('system') },
              { value: 'more', label: tA('contrast.more') },
              { value: 'normal', label: tA('contrast.normal') },
            ]}
          />
        </SettingItem>
        <SettingItem label={tA('underline_links.label')} locked={isSettingLocked('underlineLinks')}>
          <ToggleSwitch checked={settings.underlineLinks} onChange={(checked) => set('underlineLinks', checked)} />
        </SettingItem>
        <SettingItem label={tA('focus_ring.label')} locked={isSettingLocked('focusRing')}>
          <RadioGroup
            value={settings.focusRing}
            onChange={(value) => set('focusRing', value)}
            options={[
              { value: 'off', label: tA('focus_ring.off') },
              { value: 'normal', label: tA('focus_ring.normal') },
              { value: 'thick', label: tA('focus_ring.thick') },
              { value: 'extra', label: tA('focus_ring.extra') },
            ]}
          />
        </SettingItem>
        <SettingItem label={tA('large_targets.label')} locked={isSettingLocked('largeTargets')}>
          {systemToggle('largeTargets')}
        </SettingItem>
        <SettingItem label={tA('reduce_motion.label')} locked={isSettingLocked('reduceMotion')}>
          {systemToggle('reduceMotion')}
        </SettingItem>
        {signedIn && (
          <SettingItem label={tA('single_key_shortcuts.label')} locked={isSettingLocked('singleKeyShortcuts')}>
            <ToggleSwitch checked={settings.singleKeyShortcuts} onChange={(checked) => set('singleKeyShortcuts', checked)} />
          </SettingItem>
        )}
      </div>
      {signedIn && (
        <div className="mt-4 space-y-2">
          <h3 className="text-sm font-medium text-foreground">{tA('presets.title')}</h3>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={tA('presets.title')}>
            {ACCESSIBILITY_PRESET_IDS.map((id) => (
              <Button key={id} variant="outline" size="sm" onClick={() => applyPreset(id)}>
                {tA(`presets.${id}.label`)}
              </Button>
            ))}
          </div>
          <div role="status" aria-live="polite" className="text-xs text-muted-foreground">
            {applied && (
              <span className="inline-flex items-center gap-2">
                {applied.changes.length === 0
                  ? tA('presets.nothing_changed', { name: tA(`presets.${applied.id}.label`) })
                  : t('preset_applied', { name: tA(`presets.${applied.id}.label`), count: applied.changes.length })}
                {applied.changes.length > 0 && (
                  <button
                    type="button"
                    className="underline text-foreground"
                    onClick={() => {
                      for (const change of applied.changes) set(change.key, change.from);
                      setApplied(null);
                    }}
                  >
                    {tA('presets.undo')}
                  </button>
                )}
              </span>
            )}
          </div>
        </div>
      )}
      {signedIn && (
        <div className="mt-4 flex justify-end">
          <Button variant="outline" size="sm" onClick={openSettings}>{t('all_settings')}</Button>
        </div>
      )}
    </Dialog>
  );
}
