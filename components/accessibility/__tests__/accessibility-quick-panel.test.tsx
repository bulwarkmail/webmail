import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pathname = vi.hoisted(() => ({ value: '/mail' }));
const push = vi.hoisted(() => vi.fn());
vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => `${ns}.${key}`,
}));
vi.mock('@/i18n/navigation', () => ({
  usePathname: () => pathname.value,
  useRouter: () => ({ push }),
}));

import { AccessibilityQuickPanelHost, isAccessibilityPanelShortcut, openAccessibilityPanel } from '../accessibility-quick-panel';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';

const pressAltShiftA = () =>
  fireEvent.keyDown(window, { key: 'A', code: 'KeyA', altKey: true, shiftKey: true });

beforeEach(() => {
  pathname.value = '/mail';
  push.mockReset();
  useSettingsStore.getState().resetToDefaults();
  useAuthStore.setState({ isAuthenticated: true } as never);
});

// The panel's code comes with its first open, so it shows a moment after the key.
describe('accessibility quick panel', () => {
  it('opens with Alt+Shift+A, also with single-key shortcuts off', async () => {
    useSettingsStore.getState().updateSetting('singleKeyShortcuts', false);
    render(<AccessibilityQuickPanelHost />);
    expect(screen.queryByTestId('accessibility-panel')).toBeNull();
    pressAltShiftA();
    expect(await screen.findByTestId('accessibility-panel')).toBeTruthy();
  });

  it('matches the physical key, not the character a layout produces', () => {
    expect(isAccessibilityPanelShortcut(new KeyboardEvent('keydown', { key: 'Å', code: 'KeyA', altKey: true, shiftKey: true }))).toBe(true);
    expect(isAccessibilityPanelShortcut(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', altKey: true }))).toBe(false);
    expect(isAccessibilityPanelShortcut(new KeyboardEvent('keydown', { key: 'A', code: 'KeyA', altKey: true, shiftKey: true, ctrlKey: true }))).toBe(false);
  });

  it('changes text size from the panel', async () => {
    render(<AccessibilityQuickPanelHost />);
    act(() => openAccessibilityPanel());
    const select = (await screen.findByTestId('accessibility-panel')).querySelector('select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'x-large' } });
    expect(useSettingsStore.getState().fontSize).toBe('x-large');
  });

  it('shows a button on the sign-in page with text size, contrast and motion only', async () => {
    useAuthStore.setState({ isAuthenticated: false } as never);
    pathname.value = '/login';
    render(<AccessibilityQuickPanelHost />);
    fireEvent.click(screen.getByTestId('login-accessibility-button'));
    const panel = await screen.findByTestId('accessibility-panel');
    expect(panel.textContent).toContain('settings.accessibility.text_size.label');
    expect(panel.textContent).toContain('settings.accessibility.contrast.label');
    expect(panel.textContent).not.toContain('settings.accessibility.presets.title');
    expect(panel.textContent).not.toContain('accessibility_panel.all_settings');
  });

  it('has no sign-in button inside the app', () => {
    render(<AccessibilityQuickPanelHost />);
    expect(screen.queryByTestId('login-accessibility-button')).toBeNull();
  });

  it('goes to the settings page through the app router', async () => {
    render(<AccessibilityQuickPanelHost />);
    act(() => openAccessibilityPanel());
    fireEvent.click(await screen.findByRole('button', { name: 'accessibility_panel.all_settings' }));
    expect(push).toHaveBeenCalledWith('/settings/accessibility');
  });
});
