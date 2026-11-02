'use client';

import { useEffect } from 'react';
import { useAdminLocation, navigateAdmin } from '@/hooks/use-admin-navigation';
import { adminPath, isAdminPageId } from '@/lib/admin/admin-nav';
import { DashboardPage } from '../_pages/dashboard';
import { SettingsPage } from '../_pages/settings';
import { BrandingPage } from '../_pages/branding';
import { AuthPage } from '../_pages/auth';
import { PolicyPage } from '../_pages/policy';
import { OrganisationPage } from '../_pages/organisation';
import { OrgSignaturesPage } from '../_pages/org-signatures';
import { OrgTemplatesPage } from '../_pages/org-templates';
import { OrgSecurityPage } from '../_pages/org-security';
import { OrgSharingPage } from '../_pages/org-sharing';
import { OrgLabelsPage } from '../_pages/org-labels';
import { OrgProofreadingPage } from '../_pages/org-proofreading';
import { OrgCalendarsPage } from '../_pages/org-calendars';
import { OrgNoticesPage } from '../_pages/org-notices';
import { OrgDevicesPage } from '../_pages/org-devices';
import { PluginsPage } from '../_pages/plugins';
import { ThemesPage } from '../_pages/themes';
import { MarketplacePage } from '../_pages/marketplace';
import { MarketplaceDetailPage } from '../_pages/marketplace-detail';
import { ExtensionDetailPage } from '../_pages/extension-detail';
import { VersionPage } from '../_pages/version';
import { TelemetryPage } from '../_pages/telemetry';
import { MonitoringPage } from '../_pages/monitoring';
import { LogsPage } from '../_pages/logs';

/**
 * Every admin page, picked from the address bar. One route for the whole
 * panel: the sidebar switches pages with history.pushState and this
 * component re-renders from `usePathname()`, so there is never a route
 * transition between pages (lib/admin/admin-nav.ts).
 */
export default function AdminPage() {
  const { page, detail } = useAdminLocation();

  // Links from before the pages had URLs: /admin?tab=settings.
  useEffect(() => {
    const url = new URL(window.location.href);
    const tab = url.searchParams.get('tab');
    if (!isAdminPageId(tab)) return;
    url.searchParams.delete('tab');
    navigateAdmin(`${adminPath(tab)}${url.search}${url.hash}`, { replace: true });
  }, []);

  switch (page ?? 'dashboard') {
    case 'dashboard': return <DashboardPage />;
    case 'settings': return <SettingsPage />;
    case 'branding': return <BrandingPage />;
    case 'auth': return <AuthPage />;
    case 'policy': return <PolicyPage />;
    case 'organisation': return <OrganisationPage />;
    case 'org-signatures': return <OrgSignaturesPage />;
    case 'org-templates': return <OrgTemplatesPage />;
    case 'org-security': return <OrgSecurityPage />;
    case 'org-sharing': return <OrgSharingPage />;
    case 'org-labels': return <OrgLabelsPage />;
    case 'org-proofreading': return <OrgProofreadingPage />;
    case 'org-calendars': return <OrgCalendarsPage />;
    case 'org-notices': return <OrgNoticesPage />;
    case 'org-devices': return <OrgDevicesPage />;
    case 'plugins': return detail ? <ExtensionDetailPage key={detail} kind="plugin" id={detail} /> : <PluginsPage />;
    case 'themes': return detail ? <ExtensionDetailPage key={detail} kind="theme" id={detail} /> : <ThemesPage />;
    case 'marketplace': return detail ? <MarketplaceDetailPage key={detail} slug={detail} /> : <MarketplacePage />;
    case 'version': return <VersionPage />;
    case 'telemetry': return <TelemetryPage />;
    case 'monitoring': return <MonitoringPage />;
    case 'logs': return <LogsPage />;
  }
}
