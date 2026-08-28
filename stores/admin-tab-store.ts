import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const ADMIN_TABS = [
  'dashboard',
  'settings',
  'branding',
  'auth',
  'policy',
  'signatures',
  'plugins',
  'themes',
  'marketplace',
  'version',
  'telemetry',
  'logs',
] as const;

export type AdminTabId = typeof ADMIN_TABS[number];

export function isAdminTab(value: string | null | undefined): value is AdminTabId {
  return typeof value === 'string' && (ADMIN_TABS as readonly string[]).includes(value);
}

interface AdminTabState {
  activeTab: AdminTabId;
  setActiveTab: (tab: AdminTabId) => void;
}

// Tab state lives in client memory + localStorage. Sidebar clicks update
// state (no URL navigation) so React can commit the transition immediately,
// avoiding the dev-mode "Rendering…" hang we saw when each tab was its own
// route or distinguished by ?tab= search param.
export const useAdminTabStore = create<AdminTabState>()(
  persist(
    (set) => ({
      activeTab: 'dashboard',
      setActiveTab: (tab) => set({ activeTab: tab }),
    }),
    { name: 'admin_active_tab' },
  ),
);
