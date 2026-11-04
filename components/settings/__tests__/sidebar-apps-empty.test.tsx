import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/use-resolved-sidebar-apps', () => ({ useManagedSidebarApps: () => [] }));

import { SidebarAppsSettings } from '../sidebar-apps-settings';
import { useSettingsStore } from '@/stores/settings-store';

// Usability 2026-11-04, settings-36: the empty list said "Add custom apps and
// links to your sidebar" right under "Manage custom apps and links in your
// sidebar". It now says what is there: nothing yet.
describe('sidebar apps with none added', () => {
  it('says there are none instead of repeating the description', () => {
    useSettingsStore.setState({ sidebarApps: [] } as never);
    render(<SidebarAppsSettings />);
    expect(screen.getByText('no_apps')).toBeInTheDocument();
    expect(screen.queryByText('no_apps_hint')).toBeNull();
  });
});
