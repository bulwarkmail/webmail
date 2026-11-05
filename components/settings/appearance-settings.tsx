"use client";

import { useTranslations } from 'next-intl';
import { isDesktopApp } from '@/lib/desktop/bridge';
import { useThemeStore } from '@/stores/theme-store';
import { useSettingsStore, type Density } from '@/stores/settings-store';
import { SettingsSection, SettingItem, RadioGroup } from './settings-section';
import { Button } from '@/components/ui/button';
import { ChevronRight } from '@/components/icons';
import { ThemesSettings } from './themes-settings';
import { LayoutSection, SidebarSection, ExperimentalSection } from './layout-settings';
import { cn } from '@/lib/utils';
import { usePolicyStore } from '@/stores/policy-store';

const DENSITY_PREVIEW: Record<Density, { py: string; gap: string; showAvatar: boolean; showPreview: boolean }> = {
  'extra-compact': { py: 'py-0.5', gap: 'gap-1.5', showAvatar: false, showPreview: false },
  compact:         { py: 'py-1',   gap: 'gap-2',   showAvatar: true,  showPreview: false },
  regular:         { py: 'py-2.5', gap: 'gap-3',   showAvatar: true,  showPreview: true },
  comfortable:     { py: 'py-4',   gap: 'gap-4',   showAvatar: true,  showPreview: true },
};

function DensityPreview({ density }: { density: Density }) {
  const cfg = DENSITY_PREVIEW[density];
  // The list leaves the preview line out when Show preview is off, so the
  // sample does too.
  const showPreview = useSettingsStore((state) => state.showPreview) && cfg.showPreview;
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
              <span className="text-[0.625rem] text-muted-foreground flex-shrink-0 tabular-nums">12:00</span>
            </div>
            <div className={cn("truncate", row.unread ? "font-medium text-foreground" : "text-foreground")}>
              {row.subject}
            </div>
            {showPreview && (
              <div className="truncate text-muted-foreground">{row.preview}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The Appearance page: theme, text and motion, layout, sidebar, how several
 * accounts show together, and the experimental Pro interface. The former
 * Layout and Themes tabs live here as sections.
 */
export function AppearanceSettings() {
  const t = useTranslations('settings.appearance');
  const tDesktop = useTranslations('uxp3_desktop');
  const { theme, setTheme } = useThemeStore();
  const { density, updateSetting } = useSettingsStore();
  const { isSettingLocked, isSettingHidden, getColorModePolicy, isFeatureEnabled } = usePolicyStore();

  return (
    <div className="space-y-8">
      {/* The desktop app is no webmail to the person using it (desktop-p3-16). */}
      <SettingsSection id="theme" title={t('title')} description={isDesktopApp() ? tDesktop('appearance_description') : t('description')}>
        <SettingItem label={t('theme.label')} description={t('theme.description')} locked={getColorModePolicy().locked}>
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
        {isFeatureEnabled('themesEnabled') && <ThemesSettings embedded />}
      </SettingsSection>

      <SettingsSection id="text" title={t('sections.text')}>
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

        {/* Text size and motion moved to Settings > Accessibility. */}
        <SettingItem label={t('accessibility_link.label')} description={t('accessibility_link.description')}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.dispatchEvent(new CustomEvent('settings-tab-change', { detail: { tab: 'accessibility', section: 'text' } }))}
          >
            {t('accessibility_link.button')}
            <ChevronRight className="w-4 h-4 ms-1" />
          </Button>
        </SettingItem>
      </SettingsSection>

      <LayoutSection />
      <SidebarSection />

      <ExperimentalSection />
    </div>
  );
}
