"use client";

import { useState, useEffect } from 'react';
import { useRouter } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft, ChevronRight, LogOut, Settings as SettingsIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AppearanceSettings } from '@/components/settings/appearance-settings';
import { EmailSettings } from '@/components/settings/email-settings';
import { AccountSettings } from '@/components/settings/account-settings';
import { IdentitySettings } from '@/components/settings/identity-settings';
import { VacationSettings } from '@/components/settings/vacation-settings';
import { CalendarSettings } from '@/components/settings/calendar-settings';
import { CalendarManagementSettings } from '@/components/settings/calendar-management-settings';
import { FilterSettings } from '@/components/settings/filter-settings';
import { TemplateSettings } from '@/components/settings/template-settings';
import { AdvancedSettings } from '@/components/settings/advanced-settings';
import { FolderSettings } from '@/components/settings/folder-settings';
import { KeywordSettings } from '@/components/settings/keyword-settings';
import { AccountSecuritySettings } from '@/components/settings/account-security-settings';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useIsDesktop } from '@/hooks/use-media-query';
import { NavigationRail } from '@/components/layout/navigation-rail';
import { useConfig } from '@/hooks/use-config';
import { cn } from '@/lib/utils';

type Tab = 'appearance' | 'email' | 'account' | 'security' | 'identities' | 'vacation' | 'calendar' | 'filters' | 'templates' | 'folders' | 'keywords' | 'advanced';

export default function SettingsPage() {
  const router = useRouter();
  const t = useTranslations('settings');
  const tSidebar = useTranslations('sidebar');
  const { client, isAuthenticated, logout, checkAuth, isLoading: authLoading } = useAuthStore();
  const [initialCheckDone, setInitialCheckDone] = useState(() => useAuthStore.getState().isAuthenticated && !!useAuthStore.getState().client);
  const { quota, isPushConnected } = useEmailStore();
  const { stalwartFeaturesEnabled } = useConfig();
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    try {
      const saved = localStorage.getItem('settings-active-tab');
      if (saved) return saved as Tab;
    } catch { /* ignore */ }
    return 'appearance';
  });
  const [mobileShowContent, setMobileShowContent] = useState(false);
  const isDesktop = useIsDesktop();

  // Check auth on mount
  useEffect(() => {
    checkAuth().finally(() => {
      setInitialCheckDone(true);
    });
  }, [checkAuth]);

  useEffect(() => {
    if (initialCheckDone && !isAuthenticated && !authLoading) {
      try { sessionStorage.setItem('redirect_after_login', window.location.pathname); } catch { /* ignore */ }
      router.push('/login');
    }
  }, [initialCheckDone, isAuthenticated, authLoading, router]);

  if (!isAuthenticated) {
    return null;
  }

  const supportsVacation = client?.supportsVacationResponse() ?? false;
  const supportsCalendar = client?.supportsCalendars() ?? false;
  const supportsSieve = client?.supportsSieve() ?? false;

  const tabs: { id: Tab; label: string }[] = [
    { id: 'appearance', label: t('tabs.appearance') },
    { id: 'email', label: t('tabs.email') },
    { id: 'account', label: t('tabs.account') },
    ...(stalwartFeaturesEnabled ? [{ id: 'security' as Tab, label: t('tabs.security') }] : []),
    { id: 'identities', label: t('tabs.identities') },
    ...(supportsVacation ? [{ id: 'vacation' as Tab, label: t('tabs.vacation') }] : []),
    ...(supportsCalendar ? [{ id: 'calendar' as Tab, label: t('tabs.calendar') }] : []),
    ...(supportsSieve ? [{ id: 'filters' as Tab, label: t('tabs.filters') }] : []),
    { id: 'templates', label: t('tabs.templates') },
    { id: 'folders', label: t('tabs.folders') },
    { id: 'keywords', label: t('tabs.keywords') },
    { id: 'advanced', label: t('tabs.advanced') },
  ];

  const handleTabSelect = (tabId: Tab) => {
    setActiveTab(tabId);
    try { localStorage.setItem('settings-active-tab', tabId); } catch { /* ignore */ }
    if (!isDesktop) {
      setMobileShowContent(true);
    }
  };

  const activeTabLabel = tabs.find((tab) => tab.id === activeTab)?.label ?? '';

  const renderTabContent = () => (
    <>
      {activeTab === 'appearance' && <AppearanceSettings />}
      {activeTab === 'email' && <EmailSettings />}
      {activeTab === 'account' && <AccountSettings />}
      {activeTab === 'security' && <AccountSecuritySettings />}
      {activeTab === 'identities' && <IdentitySettings />}
      {activeTab === 'vacation' && <VacationSettings />}
      {activeTab === 'calendar' && <><CalendarSettings /><div className="mt-8"><CalendarManagementSettings /></div></>}
      {activeTab === 'filters' && <FilterSettings />}
      {activeTab === 'templates' && <TemplateSettings />}
      {activeTab === 'folders' && <FolderSettings />}
      {activeTab === 'keywords' && <KeywordSettings />}
      {activeTab === 'advanced' && <AdvancedSettings />}
    </>
  );

  // Mobile layout
  if (!isDesktop) {
    // Mobile: show content view
    if (mobileShowContent) {
      return (
        <div className="flex flex-col h-dvh bg-background">
          {/* Mobile content header */}
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

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-4">
            <div className="bg-card border border-border rounded-lg p-4">
              {renderTabContent()}
            </div>
          </div>

          {/* Bottom Navigation */}
          <NavigationRail orientation="horizontal" />
        </div>
      );
    }

    // Mobile: show tab list
    return (
      <div className="flex flex-col h-dvh bg-background">
        {/* Mobile header */}
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

        {/* Tab list */}
        <div className="flex-1 overflow-y-auto">
          <div className="py-2">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => handleTabSelect(tab.id)}
                className="w-full flex items-center justify-between px-5 py-3.5 text-sm text-foreground hover:bg-muted transition-colors duration-150"
              >
                <span>{tab.label}</span>
                <ChevronRight className="w-4 h-4 text-muted-foreground" />
              </button>
            ))}
          </div>

          {/* Logout */}
          <div className="border-t border-border px-5 py-3">
            <button
              onClick={() => { logout(); router.push('/login'); }}
              className="w-full flex items-center gap-3 py-2.5 text-sm text-destructive hover:bg-muted rounded-md px-2 transition-colors duration-150"
            >
              <LogOut className="w-4 h-4" />
              <span>{tSidebar('sign_out')}</span>
            </button>
          </div>
        </div>

        {/* Bottom Navigation */}
        <NavigationRail orientation="horizontal" />
      </div>
    );
  }

  // Desktop layout
  return (
    <div className="flex h-dvh bg-background">
      {/* Navigation Rail */}
      <div className="w-14 border-r border-border bg-secondary flex flex-col flex-shrink-0">
        <NavigationRail
          collapsed
          quota={quota}
          isPushConnected={isPushConnected}
          onLogout={() => { logout(); router.push('/login'); }}
        />
      </div>

      {/* Settings Sidebar */}
      <div className="w-64 border-r border-border bg-secondary flex flex-col">
        {/* Header */}
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

        {/* Tabs */}
        <div className="flex-1 overflow-y-auto py-2">
          <div className="px-2 space-y-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'w-full text-left px-3 py-2 rounded-md text-sm transition-colors duration-150',
                  activeTab === tab.id
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'hover:bg-muted text-foreground'
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Settings Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto p-8">
          {/* Page Header */}
          <div className="mb-6">
            <div className="flex items-center gap-2.5 mb-2">
              <SettingsIcon className="w-6 h-6 text-muted-foreground" />
              <h1 className="text-2xl font-semibold text-foreground">{t('title')}</h1>
            </div>
          </div>

          {/* Active Tab Content */}
          <div className="bg-card border border-border rounded-lg p-6">
            {renderTabContent()}
          </div>
        </div>
      </div>
    </div>
  );
}
