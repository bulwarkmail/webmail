"use client";

import { useTranslations } from 'next-intl';
import { useThemeStore } from '@/stores/theme-store';
import { useSettingsStore, type ToolbarPosition, type Density } from '@/stores/settings-store';
import { LanguageSwitcher } from '@/components/ui/language-switcher';
import { SettingsSection, SettingItem, RadioGroup, ToggleSwitch } from './settings-section';
import { cn } from '@/lib/utils';
import { useTour } from '@/components/tour/tour-provider';
import { Button } from '@/components/ui/button';
import { PlayCircle } from 'lucide-react';
import { usePolicyStore } from '@/stores/policy-store';
import { useAccountStore } from '@/stores/account-store';

const DENSITY_PREVIEW: Record<Density, { py: string; gap: string; showAvatar: boolean; showPreview: boolean }> = {
  'extra-compact': { py: 'py-0.5', gap: 'gap-1.5', showAvatar: false, showPreview: false },
  compact:         { py: 'py-1',   gap: 'gap-2',   showAvatar: true,  showPreview: false },
  regular:         { py: 'py-2.5', gap: 'gap-3',   showAvatar: true,  showPreview: true },
  comfortable:     { py: 'py-4',   gap: 'gap-4',   showAvatar: true,  showPreview: true },
};

function DensityPreview({ density }: { density: Density }) {
  const cfg = DENSITY_PREVIEW[density];
  const rows = [
    { unread: true,  sender: 'Alice Johnson',  subject: 'Project update - Q1 roadmap', preview: 'Here are the latest numbers from…' },
    { unread: false, sender: 'Bob Smith',       subject: 'Re: Meeting notes',           preview: 'Thanks, will review and get back...' },
    { unread: true,  sender: 'Carol Lee',       subject: 'Invoice #4092',               preview: 'Please find attached the invoice…' },
  ];

  return (
    <div className="mt-3 rounded-lg border border-border overflow-hidden bg-background text-xs select-none">
      {rows.map((row, i) => (
        <div
          key={i}
          className={cn(
            "flex items-center px-3 border-b border-border last:border-b-0",
            cfg.py,
            cfg.gap
          )}
        >
          {cfg.showAvatar && (
            <div className={cn(
              "flex-shrink-0 rounded-full bg-muted",
              density === 'comfortable' ? "w-8 h-8" : "w-6 h-6"
            )} />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className={cn("truncate", row.unread ? "font-semibold text-foreground" : "text-muted-foreground")}>
                {row.sender}
              </span>
              <span className="text-[10px] text-muted-foreground flex-shrink-0 tabular-nums">12:00</span>
            </div>
            <div className={cn("truncate", row.unread ? "font-medium text-foreground" : "text-foreground/80")}>
              {row.subject}
            </div>
            {cfg.showPreview && (
              <div className="truncate text-muted-foreground/70">{row.preview}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export function AppearanceSettings() {
  const t = useTranslations('settings.appearance');
  const tTour = useTranslations('tour');
  const { theme, setTheme } = useThemeStore();
  const { fontSize, density, animationsEnabled, toolbarPosition, showToolbarLabels, hideAccountSwitcher, showRailAccountList, enableUnifiedMailbox, colorfulSidebarIcons, updateSetting } = useSettingsStore();
  const { startTour, resetTourCompletion } = useTour();
  const { isSettingLocked, isSettingHidden } = usePolicyStore();
  const accounts = useAccountStore(s => s.accounts);

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      {/* Theme */}
      <SettingItem label={t('theme.label')} description={t('theme.description')}>
        <RadioGroup
          value={theme}
          onChange={(value) => setTheme(value as 'light' | 'dark' | 'system')}
          options={[
            { value: 'light', label: t('theme.light') },
            { value: 'dark', label: t('theme.dark') },
            { value: 'system', label: t('theme.system') },
          ]}
        />
      </SettingItem>

      {/* Language */}
      <SettingItem label={t('language.label')} description={t('language.description')}>
        <LanguageSwitcher />
      </SettingItem>

      {/* Font Size */}
      {!isSettingHidden('fontSize') && (
      <SettingItem label={t('font_size.label')} description={t('font_size.description')} locked={isSettingLocked('fontSize')}>
        <RadioGroup
          value={fontSize}
          onChange={(value) => updateSetting('fontSize', value as 'small' | 'medium' | 'large')}
          options={[
            { value: 'small', label: t('font_size.small') },
            { value: 'medium', label: t('font_size.medium') },
            { value: 'large', label: t('font_size.large') },
          ]}
        />
      </SettingItem>
      )}

      {/* Density */}
      {!isSettingHidden('density') && (
      <SettingItem label={t('list_density.label')} description={t('list_density.description')} locked={isSettingLocked('density')}>
        <RadioGroup
          value={density}
          onChange={(value) =>
            updateSetting('density', value as Density)
          }
          options={[
            { value: 'extra-compact', label: t('list_density.extra_compact') },
            { value: 'compact', label: t('list_density.compact') },
            { value: 'regular', label: t('list_density.regular') },
            { value: 'comfortable', label: t('list_density.comfortable') },
          ]}
        />
        <DensityPreview density={density} />
      </SettingItem>
      )}

      {/* Toolbar Position */}
      <SettingItem label={t('toolbar_position.label')} description={t('toolbar_position.description')}>
        <RadioGroup
          value={toolbarPosition}
          onChange={(value) => updateSetting('toolbarPosition', value as ToolbarPosition)}
          options={[
            { value: 'top', label: t('toolbar_position.top') },
            { value: 'below-subject', label: t('toolbar_position.below_subject') },
          ]}
        />
      </SettingItem>

      {/* Toolbar Labels */}
      <SettingItem label={t('toolbar_labels.label')} description={t('toolbar_labels.description')}>
        <ToggleSwitch
          checked={showToolbarLabels}
          onChange={(checked) => updateSetting('showToolbarLabels', checked)}
        />
      </SettingItem>

      {/* Hide Account Switcher */}
      <SettingItem label={t('hide_account_switcher.label')} description={t('hide_account_switcher.description')}>
        <ToggleSwitch
          checked={hideAccountSwitcher}
          onChange={(checked) => updateSetting('hideAccountSwitcher', checked)}
        />
      </SettingItem>

      {/* Show Rail Account List */}
      <SettingItem label={t('show_rail_account_list.label')} description={t('show_rail_account_list.description')}>
        <ToggleSwitch
          checked={showRailAccountList}
          onChange={(checked) => updateSetting('showRailAccountList', checked)}
        />
      </SettingItem>

      {/* Colorful Sidebar Icons */}
      <SettingItem label={t('colorful_sidebar_icons.label')} description={t('colorful_sidebar_icons.description')}>
        <ToggleSwitch
          checked={colorfulSidebarIcons}
          onChange={(checked) => updateSetting('colorfulSidebarIcons', checked)}
        />
      </SettingItem>

      {/* Unified Mailbox */}
      {accounts.length > 1 && (
        <SettingItem
          label={t('unified_mailbox.label')}
          description={t('unified_mailbox.description')}
        >
          <ToggleSwitch
            checked={enableUnifiedMailbox}
            onChange={(v) => updateSetting('enableUnifiedMailbox', v)}
          />
        </SettingItem>
      )}

      {/* Animations */}
      {!isSettingHidden('animationsEnabled') && (
      <SettingItem label={t('animations.label')} description={t('animations.description')} locked={isSettingLocked('animationsEnabled')}>
        <ToggleSwitch
          checked={animationsEnabled}
          onChange={(checked) => updateSetting('animationsEnabled', checked)}
        />
      </SettingItem>
      )}

      {/* Restart Tour */}
      <SettingItem label={tTour('restart_title')} description={tTour('restart_desc')}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => { resetTourCompletion(); startTour(); }}
          className="text-xs h-7"
        >
          <PlayCircle className="w-3.5 h-3.5 mr-1" />
          {tTour('restart_button')}
        </Button>
      </SettingItem>
    </SettingsSection>
  );
}
