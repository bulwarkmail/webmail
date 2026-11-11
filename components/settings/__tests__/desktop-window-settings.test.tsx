import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulwarkDesktopBridge } from '@/lib/desktop/types';
import { DEFAULT_POLICY_SNAPSHOT, type PolicySnapshot } from '@/lib/desktop/policy-schema';
import { readDesktopPrefs, resetDesktopPrefsCache } from '@/lib/desktop/preferences';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

const { DesktopWindowSettings } = await import('../desktop-window-settings');

function desktop(policy: Partial<PolicySnapshot> = {}) {
  const snapshot = { ...DEFAULT_POLICY_SNAPSHOT, ...policy } as PolicySnapshot;
  window.bulwarkDesktop = {
    version: 1,
    platform: 'win32',
    windows: {},
    policy: { get: () => snapshot, onChange: () => () => {} },
  } as unknown as BulwarkDesktopBridge;
}

beforeEach(() => {
  localStorage.clear();
  resetDesktopPrefsCache();
});

afterEach(() => {
  window.bulwarkDesktop = undefined;
});

describe('always write messages in a new window', () => {
  it('is off, and turning it on stays on this computer', async () => {
    desktop();
    render(<DesktopWindowSettings />);
    const toggle = await screen.findByTestId('desktop-compose-in-window');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(readDesktopPrefs().composeInWindow).toBe(true);
    expect(JSON.parse(localStorage.getItem('bulwark-desktop-window-prefs') ?? '{}').composeInWindow).toBe(true);
  });

  it('a forced policy shows its value and locks the switch', async () => {
    desktop({ ComposeInNewWindow: { value: true, source: 'forced-machine', locked: true } });
    render(<DesktopWindowSettings />);
    const toggle = await screen.findByTestId('desktop-compose-in-window');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.closest('[inert]')).not.toBeNull();
    expect(screen.getByText('org_locked')).toBeTruthy();
  });

  it('a recommendation is where it starts, and the user can change it', async () => {
    desktop({ ComposeInNewWindow: { value: true, source: 'recommended-machine', locked: false } });
    render(<DesktopWindowSettings />);
    const toggle = await screen.findByTestId('desktop-compose-in-window');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText('org_locked')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });
});
