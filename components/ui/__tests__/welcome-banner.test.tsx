import { fireEvent, render, screen } from '@testing-library/react';
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

const { WelcomeBanner } = await import('../welcome-banner');
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
      expect(screen.getByText('tip_compose_keys')).toBeInTheDocument();
      expect(screen.getByText('tip_palette_keys')).toBeInTheDocument();
      expect(screen.queryByText('tip_compose')).toBeNull();
    } finally {
      delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
    }
  });

  it('gives touch tips on a phone', () => {
    device.isMobile = true;
    render(<WelcomeBanner />);
    expect(screen.getByText('tip_compose_touch')).toBeInTheDocument();
    expect(screen.getByText('tip_sidebar_touch')).toBeInTheDocument();
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
