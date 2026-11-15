import React from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// #1692: Mountain View shows one count per folder, so "Show total message
// count" does nothing there and is not offered.

vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
}));

const { SidebarSection } = await import('../layout-settings');
const { useSettingsStore } = await import('@/stores/settings-store');

const LABEL = 'settings.appearance.show_folder_total_count.label';

beforeEach(() => {
  useSettingsStore.setState({ interfaceLayout: 'default', showFolderTotalCount: true });
});

describe('Show total message count', () => {
  it('is offered in the default layout', () => {
    const { queryByText } = render(<SidebarSection />);
    expect(queryByText(LABEL)).not.toBeNull();
  });

  it('is not offered in Mountain View, where it changes nothing', () => {
    useSettingsStore.setState({ interfaceLayout: 'mountain-view' });
    const { queryByText } = render(<SidebarSection />);
    expect(queryByText(LABEL)).toBeNull();
  });
});
