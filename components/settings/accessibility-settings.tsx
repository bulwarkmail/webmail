"use client";

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useSettingsStore } from '@/stores/settings-store';
import { usePolicyStore } from '@/stores/policy-store';
import { SettingsSection, SettingItem, RadioGroup, Select, ToggleSwitch } from './settings-section';
import { Button } from '@/components/ui/button';
import { ChevronRight, Keyboard } from '@/components/icons';
import { useAuthStore } from '@/stores/auth-store';
import { openKeyboardShortcuts } from '@/lib/app-commands';
import { voicesForLocale } from '@/lib/read-aloud';
import { wordingFor } from '@/lib/desktop/wording';
import { percentLabel } from '@/lib/percent-label';
import { useSpeechVoices } from '@/hooks/use-read-aloud';
import {
  ACCESSIBILITY_KEYS,
  FONT_SIZES,
  MAIL_MIN_FONT_SIZES,
  MAIL_TEXT_SCALES,
  READ_ALOUD_RATES,
  TOAST_DURATIONS,
  toastDurationAtLeast,
  type FontSize,
} from '@/lib/accessibility-settings';
import {
  ACCESSIBILITY_PRESET_IDS,
  PRESET_SETTING_LABELS,
  presetChanges,
  type AccessibilityPresetId,
  type PresetChange,
} from '@/lib/accessibility-presets';
import { AccessibilityPresetPreview } from './accessibility-preset-preview';
import { FONT_SIZES as COMPOSE_FONT_SIZES } from '@/components/email/font-size';

type SettingKey = Parameters<ReturnType<typeof useSettingsStore.getState>['updateSetting']>[0];

/** What Reset gives back: the settings only this page has. */
// Do not disturb lives on Notifications now (settings-p3-6): this page's Reset leaves it.
const RESET_KEYS: SettingKey[] = [...ACCESSIBILITY_KEYS.filter((key) => key !== 'doNotDisturb'), 'fontSize', 'plainTextFont', 'sendConfirmation'];

/** Opens another settings page (and section) the way deep links do. */
function goToSettings(tab: string, section?: string) {
  window.dispatchEvent(new CustomEvent('settings-tab-change', { detail: section ? { tab, section } : tab }));
}

function LinkButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      {label}
      <ChevronRight className="w-4 h-4 ms-1" />
    </Button>
  );
}

/**
 * Settings > Accessibility: presets on top, then the options by topic. Only
 * settings about access live here; everyday preferences that help too
 * (density, conversation view, undo send, sounds…) stay on their own page,
 * and a link row in the matching section leads there. One setting, one place.
 */
export function AccessibilitySettings() {
  const t = useTranslations('settings.accessibility');
  const tRoot = useTranslations();
  const tLinks = useTranslations('uxs_structure.a11y_links');
  const tWords = useTranslations('ux_p3_words');
  const settings = useSettingsStore();
  const { updateSetting, resetSettings } = settings;
  const { isSettingLocked, isSettingHidden, getRestriction, isFeatureEnabled } = usePolicyStore();
  const calendarShown = (useAuthStore((s) => s.client)?.supportsCalendars() ?? false) && isFeatureEnabled('calendarEnabled');
  const [applied, setApplied] = useState<{ id: AccessibilityPresetId; changes: PresetChange[] } | null>(null);
  const [resetDone, setResetDone] = useState(false);
  const locale = useLocale();
  const speechVoices = useSpeechVoices();

  const toastMin = getRestriction('toastDuration')?.min;
  const allowsValue = (key: string, value: unknown) =>
    key !== 'toastDuration' || typeof toastMin !== 'number' || toastDurationAtLeast(value as number, toastMin);

  const set = (key: string, value: unknown) => updateSetting(key as SettingKey, value as never);

  const applyPreset = (id: AccessibilityPresetId) => {
    const changes = presetChanges(id, useSettingsStore.getState() as unknown as Record<string, unknown>, isSettingLocked, allowsValue);
    for (const change of changes) set(change.key, change.to);
    setApplied({ id, changes });
    setResetDone(false);
  };

  const undoPreset = () => {
    if (!applied) return;
    for (const change of applied.changes) set(change.key, change.from);
    setApplied(null);
  };

  // Forgets the user's own values, so the organisation's defaults (or
  // Bulwark's) apply again. Shared everyday settings shown here too stay.
  const resetAll = () => {
    resetSettings(RESET_KEYS.filter((key) => !isSettingLocked(key)));
    setApplied(null);
    setResetDone(true);
  };

  const systemToggle = (key: 'reduceMotion' | 'reduceTransparency' | 'pauseAnimatedImages' | 'largeTargets') => (
    <RadioGroup
      value={settings[key]}
      onChange={(value) => set(key, value)}
      options={[
        { value: 'system', label: t('system') },
        { value: 'on', label: t('on') },
        { value: 'off', label: t('off') },
      ]}
    />
  );

  // Voices for the interface language, plus the one already chosen even if
  // this browser doesn't have it (another device may).
  const localeVoices = voicesForLocale(speechVoices, locale);
  const readAloudVoiceOptions = [
    { value: '', label: wordingFor({ app: tWords('voice_default_app'), browser: t('read_aloud_voice.default') }) },
    ...localeVoices.map((voice) => ({ value: voice.voiceURI, label: voice.name })),
    ...(settings.readAloudVoice && !localeVoices.some((voice) => voice.voiceURI === settings.readAloudVoice)
      ? [{ value: settings.readAloudVoice, label: speechVoices.find((voice) => voice.voiceURI === settings.readAloudVoice)?.name ?? settings.readAloudVoice }]
      : []),
  ];

  const toastOptions = TOAST_DURATIONS
    .filter((value) => allowsValue('toastDuration', value))
    .map((value) => ({
      value: String(value),
      label: value === 0 ? t('toast_duration.until_closed') : t('toast_duration.seconds', { seconds: value }),
    }));

  return (
    <div className="space-y-8">
      <SettingsSection id="presets" title={t('presets.title')} description={t('presets.description')}>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="group" aria-label={t('presets.title')}>
          {ACCESSIBILITY_PRESET_IDS.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => applyPreset(id)}
              className="flex items-start gap-3 text-start rounded-md border border-border px-3 py-2.5 hover:bg-muted transition-colors"
            >
              <AccessibilityPresetPreview id={id} />
              <span className="min-w-0 wrap-anywhere">
                <span className="block text-sm font-medium text-foreground">{t(`presets.${id}.label`)}</span>
                <span className="block text-xs text-muted-foreground mt-0.5">{t(`presets.${id}.description`)}</span>
              </span>
            </button>
          ))}
        </div>
        <div role="status" aria-live="polite">
          {applied && (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5 space-y-2" data-testid="preset-summary">
              <p className="text-sm font-medium text-foreground">
                {applied.changes.length === 0
                  ? t('presets.nothing_changed', { name: t(`presets.${applied.id}.label`) })
                  : t('presets.applied', { name: t(`presets.${applied.id}.label`), count: applied.changes.length })}
              </p>
              {applied.changes.length > 0 && (
                <ul className="text-xs text-muted-foreground list-disc ps-5 space-y-0.5">
                  {applied.changes.map((change) => (
                    <li key={change.key}>{PRESET_SETTING_LABELS[change.key] ? tRoot(PRESET_SETTING_LABELS[change.key]) : change.key}</li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-2">
                {applied.changes.length > 0 && (
                  <Button variant="outline" size="sm" onClick={undoPreset}>{t('presets.undo')}</Button>
                )}
                {!settings.showAccessibilityButton && (
                  <Button variant="outline" size="sm" onClick={() => set('showAccessibilityButton', true)}>
                    {t('presets.show_button')}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
        <SettingItem label={t('quick_button.label')} description={t('quick_button.description')}>
          <ToggleSwitch checked={settings.showAccessibilityButton} onChange={(checked) => set('showAccessibilityButton', checked)} />
        </SettingItem>
      </SettingsSection>

      <SettingsSection id="text" title={t('sections.text')}>
        <SettingItem label={t('text_size.label')} description={wordingFor({ app: tWords('text_size_app'), browser: t('text_size.description') })}>
          <Select
            value={settings.fontSize}
            onChange={(value) => set('fontSize', value as FontSize)}
            options={FONT_SIZES.map((size) => ({ value: size, label: t(`text_size.${size}`) }))}
          />
        </SettingItem>
        <SettingItem label={t('font.label')} description={t('font.description')}>
          <Select
            value={settings.appFont}
            onChange={(value) => set('appFont', value)}
            options={[
              { value: 'default', label: t('font.default') },
              { value: 'atkinson', label: 'Atkinson Hyperlegible' },
              { value: 'lexend', label: 'Lexend' },
              { value: 'opendyslexic', label: 'OpenDyslexic' },
            ]}
          />
        </SettingItem>
        <SettingItem label={t('plain_text_font.label')} description={t('plain_text_font.description')}>
          <Select
            value={settings.plainTextFont}
            onChange={(value) => set('plainTextFont', value)}
            options={[
              { value: 'sans', label: t('plain_text_font.sans') },
              { value: 'mono', label: t('plain_text_font.mono') },
            ]}
          />
        </SettingItem>
        <SettingItem label={t('line_spacing.label')} description={t('line_spacing.description')}>
          <RadioGroup
            value={settings.lineSpacing}
            onChange={(value) => set('lineSpacing', value)}
            options={[
              { value: 'normal', label: t('spacing.normal') },
              { value: 'relaxed', label: t('spacing.relaxed') },
              { value: 'loose', label: t('spacing.loose') },
            ]}
          />
        </SettingItem>
        <SettingItem label={t('letter_spacing.label')} description={t('letter_spacing.description')}>
          <RadioGroup
            value={settings.letterSpacing}
            onChange={(value) => set('letterSpacing', value)}
            options={[
              { value: 'normal', label: t('spacing.normal') },
              { value: 'wide', label: t('spacing.wide') },
              { value: 'wider', label: t('spacing.wider') },
            ]}
          />
        </SettingItem>
        <SettingItem label={t('word_spacing.label')} description={t('word_spacing.description')}>
          <RadioGroup
            value={settings.wordSpacing}
            onChange={(value) => set('wordSpacing', value)}
            options={[
              { value: 'normal', label: t('spacing.normal') },
              { value: 'wide', label: t('spacing.wide') },
            ]}
          />
        </SettingItem>
        <SettingItem label={t('paragraph_spacing.label')} description={t('paragraph_spacing.description')}>
          <RadioGroup
            value={settings.paragraphSpacing}
            onChange={(value) => set('paragraphSpacing', value)}
            options={[
              { value: 'normal', label: t('spacing.normal') },
              { value: 'wide', label: t('spacing.wide') },
            ]}
          />
        </SettingItem>
        <SettingItem label={t('reading_width.label')} description={t('reading_width.description')}>
          <RadioGroup
            value={settings.readingWidth}
            onChange={(value) => set('readingWidth', value)}
            options={[
              { value: 'full', label: t('reading_width.full') },
              { value: 'comfortable', label: t('reading_width.comfortable') },
            ]}
          />
        </SettingItem>
        <SettingItem label={t('reading_mask.label')} description={t('reading_mask.description')}>
          <ToggleSwitch checked={settings.readingMask} onChange={(checked) => set('readingMask', checked)} />
        </SettingItem>
        <SettingItem label={tLinks('text.label')} description={tLinks('text.description')}>
          <LinkButton label={tRoot('settings.tabs.appearance')} onClick={() => goToSettings('appearance', 'text')} />
        </SettingItem>
      </SettingsSection>

      <SettingsSection id="contrast" title={t('sections.contrast')}>
        <SettingItem label={t('contrast.label')} description={t('contrast.description')}>
          <RadioGroup
            value={settings.contrast}
            onChange={(value) => set('contrast', value)}
            options={[
              { value: 'system', label: t('system') },
              { value: 'more', label: t('contrast.more') },
              { value: 'normal', label: t('contrast.normal') },
            ]}
          />
        </SettingItem>
        <SettingItem label={t('transparency.label')} description={t('transparency.description')}>
          {systemToggle('reduceTransparency')}
        </SettingItem>
        <SettingItem label={t('underline_links.label')} description={t('underline_links.description')}>
          <ToggleSwitch checked={settings.underlineLinks} onChange={(checked) => set('underlineLinks', checked)} />
        </SettingItem>
        <SettingItem label={t('color_names.label')} description={t('color_names.description')}>
          <ToggleSwitch checked={settings.showColorNames} onChange={(checked) => set('showColorNames', checked)} />
        </SettingItem>
        <SettingItem label={t('cvd_palette.label')} description={t('cvd_palette.description')}>
          <ToggleSwitch checked={settings.colorBlindPalette} onChange={(checked) => set('colorBlindPalette', checked)} />
        </SettingItem>
        <SettingItem label={t('theme_link.label')} description={t('theme_link.description')}>
          <LinkButton label={t('theme_link.button')} onClick={() => goToSettings('appearance', 'theme')} />
        </SettingItem>
        <SettingItem label={tLinks('light_mode.label')} description={tLinks('light_mode.description')}>
          <LinkButton label={tRoot('settings.tabs.reading')} onClick={() => goToSettings('reading', 'display')} />
        </SettingItem>
      </SettingsSection>

      <SettingsSection id="motion" title={t('sections.motion')}>
        <SettingItem label={t('reduce_motion.label')} description={t('reduce_motion.description')}>
          {systemToggle('reduceMotion')}
        </SettingItem>
        <SettingItem label={t('pause_images.label')} description={t('pause_images.description')}>
          {systemToggle('pauseAnimatedImages')}
        </SettingItem>
      </SettingsSection>

      <SettingsSection id="keyboard" title={t('sections.keyboard')}>
        {!isSettingHidden('singleKeyShortcuts') && (
          <SettingItem label={t('single_key_shortcuts.label')} description={t('single_key_shortcuts.description')} locked={isSettingLocked('singleKeyShortcuts')}>
            <ToggleSwitch checked={settings.singleKeyShortcuts} onChange={(checked) => set('singleKeyShortcuts', checked)} />
          </SettingItem>
        )}
        <SettingItem label={t('shortcut_list.label')} description={t('shortcut_list.description')}>
          <Button variant="outline" size="sm" onClick={openKeyboardShortcuts}>
            <Keyboard className="w-4 h-4 me-1" />
            {t('shortcut_list.button')}
          </Button>
        </SettingItem>
        <SettingItem label={t('focus_ring.label')} description={t('focus_ring.description')}>
          <RadioGroup
            value={settings.focusRing}
            onChange={(value) => set('focusRing', value)}
            options={[
              { value: 'off', label: t('focus_ring.off') },
              { value: 'normal', label: t('focus_ring.normal') },
              { value: 'thick', label: t('focus_ring.thick') },
              { value: 'extra', label: t('focus_ring.extra') },
            ]}
          />
        </SettingItem>
        <SettingItem label={t('focus_always.label')} description={t('focus_always.description')}>
          {/* Off draws no outline, after a click or otherwise. */}
          <ToggleSwitch checked={settings.focusAlwaysVisible} onChange={(checked) => set('focusAlwaysVisible', checked)} disabled={settings.focusRing === 'off'} />
        </SettingItem>
      </SettingsSection>

      <SettingsSection id="pointer" title={t('sections.pointer')}>
        <SettingItem label={t('large_targets.label')} description={t('large_targets.description')}>
          {systemToggle('largeTargets')}
        </SettingItem>
        <SettingItem label={t('large_cursor.label')} description={t('large_cursor.description')}>
          <ToggleSwitch checked={settings.largeCursor} onChange={(checked) => set('largeCursor', checked)} />
        </SettingItem>
        <SettingItem label={t('open_on_hover.label')} description={t('open_on_hover.description')}>
          <ToggleSwitch checked={settings.openOnHover} onChange={(checked) => set('openOnHover', checked)} />
        </SettingItem>
        <SettingItem label={t('row_action_button.label')} description={t('row_action_button.description')}>
          <ToggleSwitch checked={settings.showRowActionButton} onChange={(checked) => set('showRowActionButton', checked)} />
        </SettingItem>
        <SettingItem label={t('native_scrollbars.label')} description={wordingFor({ app: tWords('scrollbars_app'), browser: t('native_scrollbars.description') })}>
          <ToggleSwitch checked={settings.nativeScrollbars} onChange={(checked) => set('nativeScrollbars', checked)} />
        </SettingItem>
        <SettingItem label={t('row_actions_link.label')} description={t('row_actions_link.description')}>
          <LinkButton label={t('row_actions_link.button')} onClick={() => goToSettings('message_list', 'actions')} />
        </SettingItem>
        {calendarShown && (
          <SettingItem label={tLinks('calendar.label')} description={tLinks('calendar.description')}>
            <LinkButton label={tRoot('settings.tabs.calendar')} onClick={() => goToSettings('calendar')} />
          </SettingItem>
        )}
      </SettingsSection>

      <SettingsSection id="mail" title={t('sections.mail')}>
        <SettingItem label={t('mail_view.label')} description={t('mail_view.description')}>
          <RadioGroup
            value={settings.mailViewMode}
            onChange={(value) => set('mailViewMode', value)}
            options={[
              { value: 'html', label: t('mail_view.html') },
              { value: 'plain', label: t('mail_view.plain') },
            ]}
          />
        </SettingItem>
        <SettingItem label={t('mail_text_size.label')} description={t('mail_text_size.description')}>
          <Select
            value={String(settings.mailTextScale)}
            onChange={(value) => set('mailTextScale', Number(value))}
            options={MAIL_TEXT_SCALES.map((scale) => ({
              value: String(scale),
              label: scale === 0 ? t('mail_text_size.follow') : percentLabel(scale, locale),
            }))}
          />
        </SettingItem>
        <SettingItem label={t('mail_min_font_size.label')} description={t('mail_min_font_size.description')}>
          <Select
            value={String(settings.mailMinFontSize)}
            onChange={(value) => set('mailMinFontSize', Number(value))}
            options={MAIL_MIN_FONT_SIZES.map((size) => ({
              value: String(size),
              label: size === 0 ? t('mail_min_font_size.none') : t('mail_min_font_size.px', { size }),
            }))}
          />
        </SettingItem>
        <SettingItem label={t('mail_override.label')} description={t('mail_override.description')}>
          <Select
            value={settings.mailOverrideStyles}
            onChange={(value) => set('mailOverrideStyles', value)}
            options={[
              { value: 'never', label: t('mail_override.never') },
              { value: 'high-contrast', label: t('mail_override.high_contrast') },
              { value: 'always', label: t('mail_override.always') },
            ]}
          />
        </SettingItem>
        <SettingItem label={t('mail_fit_width.label')} description={t('mail_fit_width.description')}>
          <ToggleSwitch checked={settings.mailFitWidth} onChange={(checked) => set('mailFitWidth', checked)} />
        </SettingItem>
        <SettingItem label={t('read_aloud_rate.label')} description={t('read_aloud_rate.description')}>
          <RadioGroup
            value={String(settings.readAloudRate)}
            onChange={(value) => set('readAloudRate', Number(value))}
            options={READ_ALOUD_RATES.map((rate) => ({ value: String(rate), label: `${rate}×` }))}
          />
        </SettingItem>
        <SettingItem label={t('read_aloud_voice.label')} description={wordingFor({ app: tWords('voice_app'), browser: t('read_aloud_voice.description') })}>
          <Select
            value={settings.readAloudVoice}
            onChange={(value) => set('readAloudVoice', value)}
            options={readAloudVoiceOptions}
          />
        </SettingItem>
        <SettingItem label={t('compose_font.label')} description={t('compose_font.description')}>
          <Select
            value={settings.composeFontFamily}
            onChange={(value) => set('composeFontFamily', value)}
            options={[
              { value: '', label: t('compose_font.default') },
              { value: 'sans-serif', label: t('compose_font.sans') },
              { value: 'serif', label: t('compose_font.serif') },
              { value: 'monospace', label: t('compose_font.mono') },
            ]}
          />
        </SettingItem>
        <SettingItem label={t('compose_size.label')} description={t('compose_size.description')}>
          <Select
            value={settings.composeFontSize}
            onChange={(value) => set('composeFontSize', value)}
            options={[
              { value: '', label: t('compose_size.default') },
              // "14 px", as the smallest-text list above writes it, not "14px".
              ...COMPOSE_FONT_SIZES.map((size) => ({ value: size, label: t('mail_min_font_size.px', { size: parseInt(size, 10) }) })),
            ]}
          />
        </SettingItem>
        <SettingItem label={tLinks('list.label')} description={tLinks('list.description')}>
          <LinkButton label={tRoot('settings.tabs.message_list')} onClick={() => goToSettings('message_list', 'display')} />
        </SettingItem>
        <SettingItem label={tLinks('reading.label')} description={tLinks('reading.description')}>
          <LinkButton label={tRoot('settings.tabs.reading')} onClick={() => goToSettings('reading', 'opening')} />
        </SettingItem>
      </SettingsSection>

      <SettingsSection id="timing" title={t('sections.timing')}>
        <SettingItem label={t('toast_duration.label')} description={t('toast_duration.description')} locked={isSettingLocked('toastDuration')}>
          <Select
            value={String(settings.toastDuration)}
            onChange={(value) => set('toastDuration', Number(value))}
            options={toastOptions}
          />
        </SettingItem>
        {!isSettingHidden('sendConfirmation') && (
          <SettingItem label={t('confirm_send.label')} description={t('confirm_send.description')} locked={isSettingLocked('sendConfirmation')}>
            <ToggleSwitch checked={settings.sendConfirmation} onChange={(checked) => set('sendConfirmation', checked)} />
          </SettingItem>
        )}
        <SettingItem label={t('confirm_delete.label')} description={t('confirm_delete.description')}>
          <ToggleSwitch checked={settings.confirmDelete} onChange={(checked) => set('confirmDelete', checked)} />
        </SettingItem>
        <SettingItem label={t('confirm_archive.label')} description={t('confirm_archive.description')}>
          <ToggleSwitch checked={settings.confirmArchive} onChange={(checked) => set('confirmArchive', checked)} />
        </SettingItem>
        <SettingItem label={t('send_warnings_link.label')} description={tLinks('send_warnings_description')}>
          <LinkButton label={t('send_warnings_link.button')} onClick={() => goToSettings('composing', 'sending')} />
        </SettingItem>
        <SettingItem label={tLinks('bulk_delete.label')} description={tLinks('bulk_delete.description')}>
          <LinkButton label={tRoot('settings.tabs.message_list')} onClick={() => goToSettings('message_list', 'delete')} />
        </SettingItem>
      </SettingsSection>

      <SettingsSection id="alerts" title={t('sections.alerts')}>
        <SettingItem label={t('visual_alerts.label')} description={wordingFor({ app: tWords('visual_alerts_app'), browser: t('visual_alerts.description') })}>
          <ToggleSwitch checked={settings.visualAlerts} onChange={(checked) => set('visualAlerts', checked)} />
        </SettingItem>
        <SettingItem label={t('unread_counts.label')} description={t('unread_counts.description')}>
          <RadioGroup
            value={settings.unreadCountStyle}
            onChange={(value) => set('unreadCountStyle', value)}
            options={[
              { value: 'count', label: t('unread_counts.count') },
              { value: 'dot', label: t('unread_counts.dot') },
              { value: 'hidden', label: t('unread_counts.hidden') },
            ]}
          />
        </SettingItem>
        {/* The switch is on Notifications, next to quiet hours (settings-p3-6). */}
        <SettingItem label={tWords('dnd_title')} description={wordingFor({ app: tWords('dnd_link_app'), browser: tWords('dnd_link_browser') })}>
          <LinkButton label={tRoot('settings.tabs.notifications')} onClick={() => goToSettings('notifications', 'pause')} />
        </SettingItem>
        <SettingItem label={tLinks('sounds.label')} description={wordingFor({ app: tWords('sounds_link_app'), browser: tLinks('sounds.description') })}>
          <LinkButton label={tRoot('settings.tabs.notifications')} onClick={() => goToSettings('notifications', 'sound')} />
        </SettingItem>
      </SettingsSection>

      <SettingsSection id="screen-readers" title={t('sections.screen_readers')}>
        <SettingItem label={t('announce_new_mail.label')} description={t('announce_new_mail.description')}>
          <ToggleSwitch checked={settings.announceNewMail} onChange={(checked) => set('announceNewMail', checked)} />
        </SettingItem>
        <SettingItem label={t('announce_preview.label')} description={t('announce_preview.description')}>
          <ToggleSwitch checked={settings.announceRowPreview} onChange={(checked) => set('announceRowPreview', checked)} />
        </SettingItem>
        <SettingItem label={t('simple_mode.label')} description={t('simple_mode.description')}>
          <ToggleSwitch checked={settings.simpleMode} onChange={(checked) => set('simpleMode', checked)} />
        </SettingItem>
        {settings.simpleMode && (
          <SettingItem nested label={t('simple_mode_paged.label')} description={t('simple_mode_paged.description')}>
            <ToggleSwitch checked={settings.simpleModePagedList} onChange={(checked) => set('simpleModePagedList', checked)} />
          </SettingItem>
        )}
      </SettingsSection>

      <SettingsSection id="reset" title={t('reset.title')}>
        <SettingItem label={t('reset.label')} description={t('reset.description')}>
          <div className="flex flex-col items-end gap-1">
            <Button variant="outline" size="sm" onClick={resetAll}>{t('reset.button')}</Button>
            <p role="status" className="text-xs text-muted-foreground">{resetDone ? t('reset.done') : ''}</p>
          </div>
        </SettingItem>
      </SettingsSection>
    </div>
  );
}
