"use client";

import { SidebarAppsSettings } from './sidebar-apps-settings';
import { PluginsSettings } from './plugins-settings';
import { usePolicyStore } from '@/stores/policy-store';
import { useDesktopPolicy } from '@/lib/desktop/policy';
import { DevicePluginsOff } from './device-plugins-off';

/**
 * The Add-ons page: sidebar apps and plugins, the two ways to add things to
 * Bulwark. Plugins with a page of their own appear under this entry in the
 * sidebar instead of forming a group.
 */
export function AddonsSettings() {
  const { isFeatureEnabled } = usePolicyStore();
  const devicePolicy = useDesktopPolicy();
  return (
    <div className="space-y-8">
      {isFeatureEnabled('sidebarAppsEnabled') && <SidebarAppsSettings />}
      {isFeatureEnabled('pluginsEnabled') ? <PluginsSettings /> : devicePolicy.PluginsMode.value === 'off' && <DevicePluginsOff />}
    </div>
  );
}
