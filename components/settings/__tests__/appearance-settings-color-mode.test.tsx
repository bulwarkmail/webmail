import React from 'react';
import { render, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// #1280: the theme policy can lock the light/dark/system mode.

vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ startTour: vi.fn(), resetTourCompletion: vi.fn() }),
}));
vi.mock('../message-list-order-settings', () => ({ MessageListOrderSettings: () => null }));

const { AppearanceSettings } = await import('../appearance-settings');
const { usePolicyStore } = await import('@/stores/policy-store');
const { DEFAULT_POLICY, DEFAULT_THEME_POLICY } = await import('@/lib/admin/types');

function renderModeItem() {
  const { container } = render(<AppearanceSettings />);
  return container.querySelector('[data-search-label="settings.appearance.theme.label"]') as HTMLElement;
}

beforeEach(() => {
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY } });
});

describe('appearance settings color mode (#1280)', () => {
  it('shows the mode as managed while the theme policy locks it', () => {
    usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, themePolicy: { ...DEFAULT_THEME_POLICY, lockColorMode: true } } });
    expect(within(renderModeItem()).getByText('settings.org_locked')).toBeInTheDocument();
  });

  // desktop-p3-16: "Change how the webmail looks" in the desktop app.
  it('says the app, not the webmail, in the desktop app', () => {
    window.bulwarkDesktop = { version: 1, platform: 'win32' } as never;
    try {
      const { getByText, queryByText } = render(<AppearanceSettings />);
      expect(getByText('uxp3_desktop.appearance_description')).toBeInTheDocument();
      expect(queryByText('settings.appearance.description')).toBeNull();
    } finally {
      delete window.bulwarkDesktop;
    }
  });

  it('leaves the mode to the user otherwise, even with a default', () => {
    usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, themePolicy: { ...DEFAULT_THEME_POLICY, defaultColorMode: 'light' } } });
    expect(within(renderModeItem()).queryByText('settings.org_locked')).toBeNull();
  });
});
