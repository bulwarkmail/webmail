import { fireEvent, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

// On a phone the banner said "Press c to compose" and pointed at a sidebar
// that the phone layout does not have.

const device = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: device.isMobile, isTablet: false, isDesktop: !device.isMobile }),
}));
vi.mock('@/components/tour/tour-provider', () => ({ useTour: () => ({ startTour: vi.fn() }) }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  useLocale: () => 'en',
}));

const { WelcomeBanner, useWelcomeBannerDue, sidebarTipApps } = await import('../welcome-banner');
const { usePolicyStore } = await import('@/stores/policy-store');
const { DEFAULT_POLICY } = await import('@/lib/admin/types');
const { useSettingsStore } = await import('@/stores/settings-store');

describe('WelcomeBanner tips', () => {
  beforeEach(() => {
    useSettingsStore.setState({ onboardingCompleted: false });
  });

  it('gives keyboard tips on a desktop', () => {
    device.isMobile = false;
    render(<WelcomeBanner />);
    expect(screen.getByText('tip_compose')).toBeInTheDocument();
    expect(screen.getByText('tip_shortcuts')).toBeInTheDocument();
  });

  it('in the desktop app, names the keys it answers: Ctrl+N and Ctrl+K, not c', () => {
    device.isMobile = false;
    (window as unknown as { bulwarkDesktop: unknown }).bulwarkDesktop = { version: 1, platform: 'win32' };
    try {
      render(<WelcomeBanner />);
      expect(screen.getByText(/^tip_compose_keys/)).toBeInTheDocument();
      expect(screen.getByText(/^tip_palette_keys/)).toBeInTheDocument();
      expect(screen.queryByText('tip_compose')).toBeNull();
    } finally {
      delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
    }
  });

  it('gives touch tips on a phone', () => {
    device.isMobile = true;
    render(<WelcomeBanner />);
    expect(screen.getByText('tip_compose_touch')).toBeInTheDocument();
    expect(screen.getByText(/^tip_sidebar_apps_touch/)).toBeInTheDocument();
    expect(screen.queryByText('tip_shortcuts')).toBeNull();
  });
});

describe('WelcomeBanner and Escape', () => {
  beforeEach(() => {
    useSettingsStore.setState({ onboardingCompleted: false });
  });

  it('stays when Escape is pressed elsewhere, and is not marked as seen', () => {
    device.isMobile = false;
    render(<WelcomeBanner />);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('complementary')).toBeInTheDocument();
    expect(useSettingsStore.getState().onboardingCompleted).toBe(false);
  });
});

// pass2 mail-p2-17: settings are per account, so a second account started
// with onboardingCompleted false and showed the tips again on the same device.
describe('WelcomeBanner once per device', () => {
  beforeEach(() => {
    localStorage.clear();
    device.isMobile = false;
  });

  it('stays away for an account added on a device that has seen the tips', () => {
    localStorage.setItem('onboarding_completed', 'true');
    useSettingsStore.setState({ onboardingCompleted: false, showOnboardingOnNewDevices: false });
    const { container } = render(<WelcomeBanner />);
    expect(container.querySelector('[data-welcome]')).toBeNull();
  });

  it('is not due for that account either, so first-start notices are not held back', () => {
    localStorage.setItem('onboarding_completed', 'true');
    useSettingsStore.setState({ onboardingCompleted: false, showOnboardingOnNewDevices: false });
    const { result } = renderHook(() => useWelcomeBannerDue());
    expect(result.current).toBe(false);
  });

  it('shows on a device that has not seen them', () => {
    useSettingsStore.setState({ onboardingCompleted: false, showOnboardingOnNewDevices: false });
    render(<WelcomeBanner />);
    expect(screen.getByRole('complementary')).toBeInTheDocument();
  });

  it('points at the bar on the left, not a sidebar menu', () => {
    useSettingsStore.setState({ onboardingCompleted: false });
    render(<WelcomeBanner />);
    expect(screen.getByText(/^tip_sidebar_apps /)).toBeInTheDocument();
  });

  it('names only the apps the policy keeps on (#1562)', () => {
    useSettingsStore.setState({ onboardingCompleted: false });
    usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, features: { ...DEFAULT_POLICY.features, calendarEnabled: false } } });
    try {
      render(<WelcomeBanner />);
      expect(screen.getByText('tip_sidebar_apps {"apps":"contacts and settings"}')).toBeInTheDocument();
    } finally {
      usePolicyStore.setState({ policy: { ...DEFAULT_POLICY } });
    }
  });

  it('lists the apps in the interface language', () => {
    expect(sidebarTipApps('en', { calendar: 'Calendar', contacts: 'Contacts', settings: 'Settings' })).toBe('Calendar, Contacts, and Settings');
    expect(sidebarTipApps('de', { calendar: 'Kalender', contacts: 'Kontakte', settings: 'Einstellungen' })).toBe('Kalender, Kontakte und Einstellungen');
    expect(sidebarTipApps('en', { settings: 'Settings' })).toBe('Settings');
  });
});
