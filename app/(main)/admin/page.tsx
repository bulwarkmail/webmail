'use client';

import { useEffect } from 'react';
import { useAdminTabStore, isAdminTab } from '@/stores/admin-tab-store';
import { DashboardTab } from './_tabs/dashboard';
import { SettingsTab } from './_tabs/settings';
import { BrandingTab } from './_tabs/branding';
import { AuthTab } from './_tabs/auth';
import { PolicyTab } from './_tabs/policy';
import { SignaturesTab } from './_tabs/signatures';
import { PluginsTab } from './_tabs/plugins';
import { ThemesTab } from './_tabs/themes';
import { MarketplaceTab } from './_tabs/marketplace';
import { VersionTab } from './_tabs/version';
import { TelemetryTab } from './_tabs/telemetry';
import { LogsTab } from './_tabs/logs';

export default function AdminPage() {
  const activeTab = useAdminTabStore((s) => s.activeTab);
  const setActiveTab = useAdminTabStore((s) => s.setActiveTab);

  // Honour deep links from the old route structure: /admin?tab=settings
  // (emitted by the redirect pages in /admin/<x>/page.tsx) sets the store
  // once on mount, then strips the param so the URL stays at /admin and
  // subsequent tab clicks don't accumulate query strings.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get('tab');
    if (isAdminTab(fromUrl)) {
      setActiveTab(fromUrl);
      url.searchParams.delete('tab');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  }, [setActiveTab]);

  switch (activeTab) {
    case 'dashboard': return <DashboardTab />;
    case 'settings': return <SettingsTab />;
    case 'branding': return <BrandingTab />;
    case 'auth': return <AuthTab />;
    case 'policy': return <PolicyTab />;
    case 'signatures': return <SignaturesTab />;
    case 'plugins': return <PluginsTab />;
    case 'themes': return <ThemesTab />;
    case 'marketplace': return <MarketplaceTab />;
    case 'version': return <VersionTab />;
    case 'telemetry': return <TelemetryTab />;
    case 'logs': return <LogsTab />;
  }
}
