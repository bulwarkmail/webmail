"use client";

import { useState, useEffect, useRef } from 'react';
import { useRouter } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import {
  ArrowLeft,
  ChevronRight,
  LogOut,
  Settings as SettingsIcon,
  Palette,
  User,
  Shield,
  UserPen,
  PalmtreeIcon,
  Calendar,
  Filter,
  FileText,
  FolderOpen,
  Tags,
  HardDrive,
  BookUser,
  KeyRound,
  PanelLeftClose,
  Bell,
  Puzzle,
  LayoutGrid,
  BookOpen,
  PenLine,
  EyeOff,
  Languages,
  Info,
  Bug,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AppearanceSettings } from '@/components/settings/appearance-settings';
import { LayoutSettings } from '@/components/settings/layout-settings';
import { LanguageSettings } from '@/components/settings/language-settings';
import { ReadingSettings } from '@/components/settings/reading-settings';
import { ComposingSettings } from '@/components/settings/composing-settings';
import { ContentSendersSettings } from '@/components/settings/content-senders-settings';
import { AccountSettings } from '@/components/settings/account-settings';
import { IdentitySettings } from '@/components/settings/identity-settings';
import { VacationSettings } from '@/components/settings/vacation-settings';
import { CalendarSettings } from '@/components/settings/calendar-settings';
import { CalendarManagementSettings } from '@/components/settings/calendar-management-settings';
import { AddressBookManagementSettings } from '@/components/settings/address-book-management-settings';
import { FilterSettings } from '@/components/settings/filter-settings';
import { TemplateSettings } from '@/components/settings/template-settings';
import { AboutDataSettings } from '@/components/settings/about-data-settings';
import { DebugSettings } from '@/components/settings/debug-settings';
import { FolderSettings } from '@/components/settings/folder-settings';
import { KeywordSettings } from '@/components/settings/keyword-settings';
import { AccountSecuritySettings } from '@/components/settings/account-security-settings';
import { FilesSettingsComponent } from '@/components/settings/files-settings';
import { ContactsSettings } from '@/components/settings/contacts-settings';
import { SmimeSettings } from '@/components/settings/smime-settings';
import { SidebarAppsSettings } from '@/components/settings/sidebar-apps-settings';
import { NotificationSettings } from '@/components/settings/notification-settings';
import { ThemesSettings } from '@/components/settings/themes-settings';
import { PluginsSettings } from '@/components/settings/plugins-settings';
import { useAuthStore, redirectToLogin } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useIsDesktop } from '@/hooks/use-media-query';
import { NavigationRail } from '@/components/layout/navigation-rail';
import { SidebarAppsModal } from '@/components/layout/sidebar-apps-modal';
import { InlineAppView } from '@/components/layout/inline-app-view';
import { useSidebarApps } from '@/hooks/use-sidebar-apps';
import { ResizeHandle } from '@/components/layout/resize-handle';
import { useConfig } from '@/hooks/use-config';
import { usePolicyStore } from '@/stores/policy-store';
import { cn } from '@/lib/utils';

type Tab =
  | 'account'
  | 'language'
  | 'notifications'
  | 'appearance'
  | 'layout'
  | 'reading'
  | 'composing'
  | 'identities'
  | 'vacation'
  | 'filters'
  | 'templates'
  | 'folders'
  | 'keywords'
  | 'security'
  | 'encryption'
  | 'content_senders'
  | 'calendar'
  | 'contacts'
  | 'files'
  | 'sidebar_apps'
  | 'about_data'
  | 'themes'
  | 'plugins'
  | 'debug';

type TabGroup = 'general' | 'appearance' | 'mail' | 'privacy' | 'apps' | 'advanced';

interface TabDef {
  id: Tab;
  label: string;
  icon: LucideIcon;
  group: TabGroup;
  experimental?: boolean;
}

const tabIcons: Record<Tab, LucideIcon> = {
  account: User,
  language: Languages,
  notifications: Bell,
  appearance: Palette,
  layout: LayoutGrid,
  reading: BookOpen,
  composing: PenLine,
  identities: UserPen,
  vacation: PalmtreeIcon,
  filters: Filter,
  templates: FileText,
  folders: FolderOpen,
  keywords: Tags,
  security: Shield,
  encryption: KeyRound,
  content_senders: EyeOff,
  calendar: Calendar,
  contacts: BookUser,
  files: HardDrive,
  sidebar_apps: PanelLeftClose,
  about_data: Info,
  themes: Palette,
  plugins: Puzzle,
  debug: Bug,
};

const tabGroupOrder: TabGroup[] = ['general', 'appearance', 'mail', 'privacy', 'apps', 'advanced'];

// Map legacy tab IDs to current ones; runs once on read of localStorage.
const LEGACY_TAB_MAP: Record<string, Tab> = {
  email: 'reading',
  advanced: 'about_data',
};

function readPersistedTab(): Tab {
  try {
    const saved = localStorage.getItem('settings-active-tab');
    if (!saved) return 'appearance';
    if (saved in LEGACY_TAB_MAP) {
      const migrated = LEGACY_TAB_MAP[saved];
      try { localStorage.setItem('settings-active-tab', migrated); } catch { /* ignore */ }
      return migrated;
    }
    return saved as Tab;
  } catch {
    return 'appearance';
  }
}

export default function SettingsPage() {
  const router = useRouter();
  const t = useTranslations('settings');
  const tSidebar = useTranslations('sidebar');
  const { client, isAuthenticated, logout, checkAuth, isLoading: authLoading } = useAuthStore();
  const { showAppsModal, inlineApp, loadedApps, handleManageApps, handleInlineApp, closeInlineApp, closeAppsModal } = useSidebarApps();
  const [initialCheckDone, setInitialCheckDone] = useState(() => useAuthStore.getState().isAuthenticated && !!useAuthStore.getState().client);
  const { quota, isPushConnected } = useEmailStore();
  const { stalwartFeaturesEnabled } = useConfig();
  const { isFeatureEnabled } = usePolicyStore();
  const [activeTab, setActiveTab] = useState<Tab>(readPersistedTab);
  const [mobileShowContent, setMobileShowContent] = useState(false);
  const isDesktop = useIsDesktop();

  // Sidebar resize state
  const [settingsSidebarWidth, setSettingsSidebarWidth] = useState(() => {
    try { const v = localStorage.getItem('settings-sidebar-width'); return v ? Number(v) : 256; } catch { return 256; }
  });
  const [isResizing, setIsResizing] = useState(false);
  const dragStartWidth = useRef(256);

  // Check auth on mount – skip when already authenticated so that navigating
  // between routes doesn't retrigger checkAuth's transient `{ client: null,
  // isLoading: true }` reset, which was flashing the spinner on every nav.
  useEffect(() => {
    const state = useAuthStore.getState();
    if (state.isAuthenticated && state.client) {
      setInitialCheckDone(true);
      return;
    }
    checkAuth().finally(() => {
      setInitialCheckDone(true);
    });
  }, [checkAuth]);

  // Listen for tab change events from child components (with legacy migration)
  useEffect(() => {
    const handler = (e: Event) => {
      const raw = (e as CustomEvent).detail as string;
      if (!raw) return;
      const tab = (LEGACY_TAB_MAP[raw] ?? raw) as Tab;
      setActiveTab(tab);
      try { localStorage.setItem('settings-active-tab', tab); } catch { /* ignore */ }
    };
    window.addEventListener('settings-tab-change', handler);
    return () => window.removeEventListener('settings-tab-change', handler);
  }, []);

  useEffect(() => {
    if (initialCheckDone && !isAuthenticated && !authLoading) {
      try { sessionStorage.setItem('redirect_after_login', window.location.pathname); } catch { /* ignore */ }
      redirectToLogin();
    }
  }, [initialCheckDone, isAuthenticated, authLoading]);

  if (!isAuthenticated) {
    return null;
  }

  const supportsVacation = client?.supportsVacationResponse() ?? false;
  const supportsCalendar = client?.supportsCalendars() ?? false;
  const supportsSieve = client?.supportsSieve() ?? false;
  const supportsFiles = client?.supportsFiles() ?? false;

  const tabs: TabDef[] = [
    // General
    { id: 'account', label: t('tabs.account'), icon: tabIcons.account, group: 'general' },
    { id: 'language', label: t('tabs.language'), icon: tabIcons.language, group: 'general' },
    { id: 'notifications', label: t('tabs.notifications'), icon: tabIcons.notifications, group: 'general' },

    // Appearance
    { id: 'appearance', label: t('tabs.appearance'), icon: tabIcons.appearance, group: 'appearance' },
    { id: 'layout', label: t('tabs.layout'), icon: tabIcons.layout, group: 'appearance' },

    // Mail
    { id: 'reading', label: t('tabs.reading'), icon: tabIcons.reading, group: 'mail' },
    { id: 'composing', label: t('tabs.composing'), icon: tabIcons.composing, group: 'mail' },
    { id: 'identities', label: t('tabs.identities'), icon: tabIcons.identities, group: 'mail' },
    ...(supportsVacation ? [{ id: 'vacation' as Tab, label: t('tabs.vacation'), icon: tabIcons.vacation, group: 'mail' as TabGroup }] : []),
    ...(supportsSieve ? [{ id: 'filters' as Tab, label: t('tabs.filters'), icon: tabIcons.filters, group: 'mail' as TabGroup }] : []),
    ...(isFeatureEnabled('templatesEnabled') ? [{ id: 'templates' as Tab, label: t('tabs.templates'), icon: tabIcons.templates, group: 'mail' as TabGroup }] : []),
    { id: 'folders', label: t('tabs.folders'), icon: tabIcons.folders, group: 'mail' },
    ...(isFeatureEnabled('customKeywordsEnabled') ? [{ id: 'keywords' as Tab, label: t('tabs.keywords'), icon: tabIcons.keywords, group: 'mail' as TabGroup }] : []),

    // Privacy & Security
    ...(stalwartFeaturesEnabled ? [{ id: 'security' as Tab, label: t('tabs.security'), icon: tabIcons.security, group: 'privacy' as TabGroup }] : []),
    ...(isFeatureEnabled('smimeEnabled') ? [{ id: 'encryption' as Tab, label: t('tabs.encryption'), icon: tabIcons.encryption, group: 'privacy' as TabGroup }] : []),
    { id: 'content_senders', label: t('tabs.content_senders'), icon: tabIcons.content_senders, group: 'privacy' },

    // Apps
    ...(supportsCalendar ? [{ id: 'calendar' as Tab, label: t('tabs.calendar'), icon: tabIcons.calendar, group: 'apps' as TabGroup }] : []),
    { id: 'contacts', label: t('tabs.contacts'), icon: tabIcons.contacts, group: 'apps' },
    ...(supportsFiles ? [{ id: 'files' as Tab, label: t('tabs.files'), icon: tabIcons.files, group: 'apps' as TabGroup }] : []),
    ...(isFeatureEnabled('sidebarAppsEnabled') ? [{ id: 'sidebar_apps' as Tab, label: t('tabs.sidebar_apps'), icon: tabIcons.sidebar_apps, group: 'apps' as TabGroup }] : []),

    // Advanced
    { id: 'about_data', label: t('tabs.about_data'), icon: tabIcons.about_data, group: 'advanced' },
    ...(isFeatureEnabled('themesEnabled') ? [{ id: 'themes' as Tab, label: 'Themes', icon: tabIcons.themes, group: 'advanced' as TabGroup, experimental: true }] : []),
    ...(isFeatureEnabled('pluginsEnabled') ? [{ id: 'plugins' as Tab, label: 'Plugins', icon: tabIcons.plugins, group: 'advanced' as TabGroup, experimental: true }] : []),
    ...(isFeatureEnabled('debugModeEnabled') ? [{ id: 'debug' as Tab, label: t('tabs.debug'), icon: tabIcons.debug, group: 'advanced' as TabGroup }] : []),
  ];

  // Group tabs by category
  const groupedTabs = tabGroupOrder
    .map((group) => ({
      group,
      label: t(`tab_groups.${group}`),
      items: tabs.filter((tab) => tab.group === group),
    }))
    .filter((g) => g.items.length > 0);

  // If active tab is not in the visible list (e.g., feature disabled), fall back.
  const isActiveVisible = tabs.some((tab) => tab.id === activeTab);
  const effectiveActiveTab: Tab = isActiveVisible ? activeTab : 'appearance';

  const handleTabSelect = (tabId: Tab) => {
    setActiveTab(tabId);
    try { localStorage.setItem('settings-active-tab', tabId); } catch { /* ignore */ }
    if (!isDesktop) {
      setMobileShowContent(true);
    }
  };

  const activeTabLabel = tabs.find((tab) => tab.id === effectiveActiveTab)?.label ?? '';

  const renderTabContent = () => (
    <>
      {effectiveActiveTab === 'account' && <AccountSettings />}
      {effectiveActiveTab === 'language' && <LanguageSettings />}
      {effectiveActiveTab === 'notifications' && <NotificationSettings />}
      {effectiveActiveTab === 'appearance' && <AppearanceSettings />}
      {effectiveActiveTab === 'layout' && <LayoutSettings />}
      {effectiveActiveTab === 'reading' && <ReadingSettings />}
      {effectiveActiveTab === 'composing' && <ComposingSettings />}
      {effectiveActiveTab === 'identities' && <IdentitySettings />}
      {effectiveActiveTab === 'vacation' && <VacationSettings />}
      {effectiveActiveTab === 'filters' && <FilterSettings />}
      {effectiveActiveTab === 'templates' && <TemplateSettings />}
      {effectiveActiveTab === 'folders' && <FolderSettings />}
      {effectiveActiveTab === 'keywords' && <KeywordSettings />}
      {effectiveActiveTab === 'security' && <AccountSecuritySettings />}
      {effectiveActiveTab === 'encryption' && <SmimeSettings />}
      {effectiveActiveTab === 'content_senders' && <ContentSendersSettings />}
      {effectiveActiveTab === 'calendar' && <><CalendarSettings /><div className="mt-8"><CalendarManagementSettings /></div></>}
      {effectiveActiveTab === 'contacts' && <><ContactsSettings /><div className="mt-8"><AddressBookManagementSettings /></div></>}
      {effectiveActiveTab === 'files' && <FilesSettingsComponent />}
      {effectiveActiveTab === 'sidebar_apps' && <SidebarAppsSettings />}
      {effectiveActiveTab === 'about_data' && <AboutDataSettings />}
      {effectiveActiveTab === 'themes' && <ThemesSettings />}
      {effectiveActiveTab === 'plugins' && <PluginsSettings />}
      {effectiveActiveTab === 'debug' && <DebugSettings />}
    </>
  );

  // Mobile layout
  if (!isDesktop) {
    if (mobileShowContent) {
      return (
        <div className="flex flex-col h-dvh bg-background">
          <div className="flex items-center gap-2 px-4 h-14 border-b border-border bg-background shrink-0">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMobileShowContent(false)}
              className="h-10 w-10"
            >
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <h1 className="font-semibold text-lg truncate">{activeTabLabel}</h1>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {renderTabContent()}
          </div>

          <NavigationRail
            orientation="horizontal"
            onManageApps={handleManageApps}
            onInlineApp={handleInlineApp}
            onCloseInlineApp={closeInlineApp}
            activeAppId={inlineApp?.id ?? null}
          />
          <SidebarAppsModal isOpen={showAppsModal} onClose={closeAppsModal} />
        </div>
      );
    }

    return (
      <div className="flex flex-col h-dvh bg-background">
        <div className="flex items-center gap-2 px-4 h-14 border-b border-border bg-background shrink-0">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.push('/')}
            className="h-10 w-10"
          >
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="flex items-center gap-2">
            <SettingsIcon className="w-5 h-5 text-muted-foreground" />
            <h1 className="font-semibold text-lg">{t('title')}</h1>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="py-2">
            {groupedTabs.map((group, groupIndex) => (
              <div key={group.group}>
                {groupIndex > 0 && <div className="mx-5 my-2 border-t border-border" />}
                <div className="px-5 pt-3 pb-1.5">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {group.label}
                  </span>
                </div>
                {group.items.map((tab) => {
                  const Icon = tab.icon;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => handleTabSelect(tab.id)}
                      className="w-full flex items-center justify-between px-5 py-3.5 text-sm text-foreground hover:bg-muted transition-colors duration-150"
                    >
                      <span className="flex items-center gap-3">
                        <Icon className="w-4 h-4 text-muted-foreground" />
                        {tab.label}
                        {tab.experimental && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-warning/15 text-warning">
                            Experimental
                          </span>
                        )}
                      </span>
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="border-t border-border px-5 py-3">
            <button
              onClick={logout}
              className="w-full flex items-center gap-3 py-2.5 text-sm text-destructive hover:bg-muted rounded-md px-2 transition-colors duration-150"
            >
              <LogOut className="w-4 h-4" />
              <span>{tSidebar('sign_out')}</span>
            </button>
          </div>
        </div>

        <NavigationRail
          orientation="horizontal"
          onManageApps={handleManageApps}
          onInlineApp={handleInlineApp}
          onCloseInlineApp={closeInlineApp}
          activeAppId={inlineApp?.id ?? null}
        />
        <SidebarAppsModal isOpen={showAppsModal} onClose={closeAppsModal} />
      </div>
    );
  }

  // Desktop layout
  return (
    <div className="flex h-dvh bg-background">
      <div className="w-14 bg-secondary flex flex-col flex-shrink-0" style={{ borderRight: '1px solid rgba(128, 128, 128, 0.3)' }}>
        <NavigationRail
          collapsed
          quota={quota}
          isPushConnected={isPushConnected}
          onLogout={logout}
          onManageApps={handleManageApps}
          onInlineApp={handleInlineApp}
          onCloseInlineApp={closeInlineApp}
          activeAppId={inlineApp?.id ?? null}
        />
      </div>

      {inlineApp && (
        <InlineAppView apps={loadedApps} activeAppId={inlineApp!.id} onClose={closeInlineApp} className="flex-1" />
      )}
      {!inlineApp && (
      <>
      <div
        className={cn(
          "border-r border-border bg-secondary flex flex-col",
          !isResizing && "transition-[width] duration-300"
        )}
        style={{ width: `${settingsSidebarWidth}px` }}
      >
        <div className="p-4 border-b border-border">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push('/')}
            className="w-full justify-start"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            {t('back_to_mail')}
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto py-2" data-tour="settings-tabs">
          <div className="px-2 space-y-0.5">
            {groupedTabs.map((group, groupIndex) => (
              <div key={group.group}>
                {groupIndex > 0 && <div className="mx-1 my-2 border-t border-border" />}
                <div className="px-3 pt-2.5 pb-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {group.label}
                  </span>
                </div>
                {group.items.map((tab) => {
                  const Icon = tab.icon;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={cn(
                        'w-full text-left px-3 py-2 rounded-md text-sm transition-colors duration-150 flex items-center gap-2.5',
                        effectiveActiveTab === tab.id
                          ? 'bg-accent text-accent-foreground font-medium'
                          : 'hover:bg-muted text-foreground'
                      )}
                    >
                      <Icon className={cn(
                        'w-4 h-4 shrink-0',
                        effectiveActiveTab === tab.id ? 'text-accent-foreground' : 'text-muted-foreground'
                      )} />
                      {tab.label}
                      {tab.experimental && (
                        <span className="ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-warning/15 text-warning shrink-0">
                          Experimental
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <ResizeHandle
        onResizeStart={() => { dragStartWidth.current = settingsSidebarWidth; setIsResizing(true); }}
        onResize={(delta) => setSettingsSidebarWidth(Math.max(180, Math.min(400, dragStartWidth.current + delta)))}
        onResizeEnd={() => {
          setIsResizing(false);
          localStorage.setItem('settings-sidebar-width', String(settingsSidebarWidth));
        }}
        onDoubleClick={() => { setSettingsSidebarWidth(256); localStorage.setItem('settings-sidebar-width', '256'); }}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6">
          {renderTabContent()}
        </div>
      </div>
      </>
      )}
      <SidebarAppsModal isOpen={showAppsModal} onClose={closeAppsModal} />
    </div>
  );
}
